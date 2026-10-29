// src/crawler.js
// 목적: 쇼핑몰별 상품 수집부터 결과 정규화·번역·아카이브 및 파일 저장까지 전체 흐름을 조율한다.

const path = require("node:path");
const { toSafeConfig } = require("./config");
const { throwIfAborted } = require("./utils/common");
const {
  createRunFiles,
  saveCsv,
  writeJson,
  writeText,
} = require("./utils/files");
const {
  translateResultData,
} = require("../translate/translate");
const {
  createConversionSnapshot,
} = require("../translate/convert");
const {
  createBackendProducts,
} = require("./utils/backend-product");
const {
  readProductArchive,
  updateProductArchive,
} = require("./utils/product-archive");
const { getProductSourceMall } = require("./utils/product-schema");
const { isFullCatalogRequested, getCompletedFullCatalogScan } = require("./utils/full-catalog-scan");
const {
  observeDetailProducts,
  recordDetailOutcomes,
} = require("./utils/detail-collection-state");

const ADAPTERS = {
  cheonyu: require("./malls/cheonyu"),
  ccdome: require("./malls/ccdome"),
};

const CSV_HEADERS = {
  inventory: [
    "sourceMall",
    "categoryCode",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "optionText",
    "barcode",
    "hasOption",
    "requestedQty",
    "maxStock",
    "stockStatus",
    "stockLimited",
    "onePrice",
    "boxPrice",
    "effectivePrice",
    "hasBoxDiscount",
    "packageQty",
    "packageUnit",
    "packageText",
    "isSoldOut",
    "msg",
    "productUrl",
  ],
  summary: [
    "sourceMall",
    "categoryCode",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "stockStatus",
    "totalStock",
    "minStock",
    "maxStock",
    "rowCount",
    "optionCount",
    "hasOptions",
    "limitedRowCount",
    "lowStockRowCount",
    "outOfStockRowCount",
    "priceMin",
    "priceMax",
    "hasBoxDiscount",
    "packageQty",
    "packageUnit",
    "packageText",
    "isSoldOut",
    "optionNames",
    "productUrl",
  ],
  products: [
    "sourceMall",
    "categoryCode",
    "page",
    "index",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "isSoldOut",
    "saleStatus",
    "price",
    "priceText",
    "consumerPrice",
    "listMaxStock",
    "listPorderMinus",
    "packageQty",
    "packageUnit",
    "packageText",
    "productUrl",
    "imageUrl",
  ],
  details: [
    "sourceMall",
    "categoryCode",
    "productId",
    "productUrl",
    "productName",
    "brandHint",
    "categoryHint",
    "categoryDepth1",
    "categoryDepth2",
    "categoryDepth3",
    "categoryDepth4",
    "categoryDepth5",
    "categoryId",
    "special",
    "productNo",
    "barcode",
    "outerBoxText",
    "outerBoxQty",
    "consumerPrice",
    "manufacturer",
    "material",
    "packageSize",
    "weight",
    "origin",
    "certification",
    "warehouse",
    "targetAge",
    "warranty",
    "asContact",
    "my3plAvailable",
    "my3plInboundFee",
    "my3plOutboundFee",
    "my3plStorageFee",
    "packageQty",
    "packageUnit",
    "packageText",
    "thumbnailImageUrlsText",
    "introImageUrlsText",
    "detailOptions",
    "detailError",
  ],
};

/** 번역 입력에 사용할 상품·옵션 row를 생성한다. */
function createTranslationInput(result, collectionMode) {
  const inventoryItems = Array.isArray(result.inventoryItems)
    ? result.inventoryItems
    : [];
  const products = Array.isArray(result.products)
    ? result.products
    : [];
  const detailItems = Array.isArray(result.detailItems)
    ? result.detailItems
    : [];
  const sourceItems =
    collectionMode === "detail" && detailItems.length > 0
      ? detailItems
      : products;
  const sourceMap = new Map(
    sourceItems
      .map((item) => [
        String(item?.productId || item?.id || item?.productNo || "").trim(),
        item,
      ])
      .filter(([id]) => Boolean(id)),
  );
  const inventoryIds = new Set();
  const rows = [];

  for (const item of inventoryItems) {
    const productId = String(item?.productId || "").trim();

    if (!productId) {
      continue;
    }

    if (collectionMode === "detail" && !sourceMap.has(productId)) {
      continue;
    }

    inventoryIds.add(productId);
    const sourceItem = sourceMap.get(productId) || {};
    const normalizedName = String(
      collectionMode === "detail"
        ? sourceItem?.normalizedName ||
          sourceItem?.nameKo ||
          sourceItem?.productName ||
          item?.normalizedName ||
          item?.nameKo ||
          item?.productName ||
          ""
        : item?.normalizedName ||
          item?.nameKo ||
          sourceItem?.normalizedName ||
          sourceItem?.nameKo ||
          sourceItem?.productName ||
          item?.productName ||
          "",
    ).trim();

    rows.push({
      ...item,
      productId,
      normalizedName,
    });
  }

  /** 재고 row가 없는 품절·장바구니 불가 상품도 상품명 번역 대상으로 남긴다. */
  for (const [productId, item] of sourceMap) {
    if (inventoryIds.has(productId)) {
      continue;
    }

    rows.push({
      ...item,
      productId,
      normalizedName: String(
        item?.normalizedName ||
          item?.nameKo ||
          item?.productName ||
          "",
      ).trim(),
      options: Array.isArray(item?.options)
        ? item.options
        : undefined,
      hasOption:
        Array.isArray(item?.options) &&
        item.options.length > 0,
      optionId: "0",
      optionText: "",
    });
  }

  return {
    inventoryItems: rows,
  };
}

/** 선택한 쇼핑몰 adapter를 실행하고 공통 CSV/JSON 파일을 저장한다. */
async function runCollection(
  config,
  { runId, onProgress = () => { }, signal, openAi },
) {
  throwIfAborted(signal);

  const adapter = ADAPTERS[config.mall];

  if (!adapter) {
    throw new Error(`수집 adapter가 없습니다: ${config.mall}`);
  }

  const files = createRunFiles(config.baseOutDir, config.mall, runId);
  const catalogScanStartedAt = new Date().toISOString();
  // 실행 중 새로 추가된 상품을 오인하지 않도록 시작 시점의 동일 쇼핑몰 상품만 비교한다.
  const missingProductCandidates = isFullCatalogRequested(config)
    ? Object.values((await readProductArchive()).products)
      .filter((product) => getProductSourceMall(product) === config.mall)
      .map((product) => String(product.id))
    : [];
  throwIfAborted(signal);
  const cycleArchivedProducts = new Map();
  const missingWholesalePriceIds = new Set();
  const missingConsumerPriceIds = new Set();
  let conversionSnapshotPromise = null;
  const getRunConversionSnapshot = () => {
    if (!conversionSnapshotPromise) {
      conversionSnapshotPromise = createConversionSnapshot({ signal }).catch((error) => {
        throwIfAborted(signal);
        onProgress({ stage: "exchange-rate", level: "warn",
          message: `환율 조회 실패: 원화 수집값은 저장하고 엔화 환산은 다음 실행에서 재시도합니다. ${error.message}` });
        return null;
      });
    }

    return conversionSnapshotPromise;
  };
  const onCycleArchive = async ({
      cycleNo,
      products = [],
      inventoryItems = [],
      coverage = null,
      pageRange = null,
    } = {}) => {
      throwIfAborted(signal);
      const cycleArchiveProducts = await createBackendProducts({
        collectionMode: "general",
        products,
        inventoryItems,
        detailItems: [],
        translatedItems: [],
        lowStockThreshold: Number(config.lowStockThreshold) || 10,
      });
      if (config.mall === "cheonyu") {
        for (const product of cycleArchiveProducts) {
          if (product.wholesalePrice > 0 || product.inventoryUnavailable) {
            missingWholesalePriceIds.delete(product.id);
          } else {
            missingWholesalePriceIds.add(product.id);
          }
          if (product.originalPrice > 0) {
            missingConsumerPriceIds.delete(product.id);
          } else {
            missingConsumerPriceIds.add(product.id);
          }
        }
        if (missingWholesalePriceIds.size > 0) {
          onProgress({ stage: "price-observation", level: "warn",
            missingWholesalePriceCount: missingWholesalePriceIds.size,
            message: `천유 ${missingWholesalePriceIds.size}개 상품의 낱개 도매가를 확인하지 못했습니다. 기존 가격은 유지하며 다음 일반 수집에서 재확인합니다.` });
        }
        if (missingConsumerPriceIds.size > 0) {
          onProgress({ stage: "price-observation", level: "warn",
            missingConsumerPriceCount: missingConsumerPriceIds.size,
            message: `천유 ${missingConsumerPriceIds.size}개 상품의 목록 소비자가를 확인하지 못했습니다. 기존 소비자가와 엔화 환산값은 유지하며 다음 수집에서 재확인합니다.` });
        }
      }
      const cycleConversion = cycleArchiveProducts.length > 0
        ? await getRunConversionSnapshot()
        : null;
      const archiveUpdate = await updateProductArchive(
        cycleArchiveProducts,
        {
          source: "general",
          conversion: cycleConversion,
        },
      );
      const detailStateObservation = config.mall === "cheonyu"
        ? await observeDetailProducts({ mall: config.mall, products })
        : { pendingProductIds: [], path: null };

      for (const product of archiveUpdate.currentProducts || []) {
        const productId = String(product?.id || product?.productId || "").trim();
        if (productId) cycleArchivedProducts.set(productId, product);
      }
      writeJson(files.resultJson, Array.from(cycleArchivedProducts.values()));

      const result = {
        cycleNo,
        productCount: cycleArchiveProducts.length,
        inventoryRowCount: inventoryItems.length,
        missingProductCount: coverage?.missingProductIds?.length || 0,
        optionMismatchProductCount: coverage?.partialProductIds?.length || 0,
        archiveNewProductCount: archiveUpdate.stats.newProductCount,
        archiveUpdatedProductCount: archiveUpdate.stats.updatedProductCount,
        archiveChangedFieldCount: archiveUpdate.stats.changedFieldCount,
        archivePath: archiveUpdate.archivePath,
        pendingDetailProductCount:
          detailStateObservation.pendingProductIds.length,
        detailStatePath: detailStateObservation.path,
      };

      onProgress({
        stage: "cycle-archived",
        message:
          `${config.mallLabel || config.mall} ${cycleNo}차 ${cycleArchiveProducts.length}개 상품의 ` +
          `일반 수집 아카이빙을 완료했습니다.`,
        cycleNo,
        pageRange,
        ...result,
      });
      return result;
    };
  const result = await adapter.run(config, {
    onProgress,
    onCycleArchive,
    signal,
  });
  result.summary.missingWholesalePriceCount = missingWholesalePriceIds.size;

  throwIfAborted(signal);

  const safeConfig = toSafeConfig(config);
  const rawPayload = {
    summary: {
      ...result.summary,
      config: safeConfig,
    },
    inventoryItems: result.inventoryItems,
    productSummaries: result.productSummaries,
    products: result.products,
    activeProducts: result.activeProducts || undefined,
    soldOutProducts: result.soldOutProducts || undefined,
    popupOptionItems: result.popupOptionItems || undefined,
  };

  onProgress({
    stage: "saving",
    message: "CSV와 수집 결과를 정리하고 있습니다.",
    pageRange: result.summary.pageRange,
    detectedTotalProductCount: result.summary.detectedTotalProductCount,
    collectedProductCount: result.summary.collectedProductCount,
    targetProductCount: result.summary.targetProductCount,
    productSummaryCount: result.summary.productSummaryCount,
    soldOutProductCount: result.summary.soldOutProductCount,
    elapsedMs: result.summary.elapsedMs,
  });

  throwIfAborted(signal);

  saveCsv(files.inventoryCsv, CSV_HEADERS.inventory, result.inventoryItems);
  saveCsv(files.summaryCsv, CSV_HEADERS.summary, result.productSummaries);
  saveCsv(files.productsCsv, CSV_HEADERS.products, result.products);

  if (result.detailItems?.length) {
    saveCsv(files.detailsCsv, CSV_HEADERS.details, result.detailItems);
  }

  for (const [fileName, content] of Object.entries(result.debugFiles || {})) {
    if (!content) continue;
    writeText(path.resolve(files.runDir, path.basename(fileName)), content);
  }
  

  const isDetailCollection = config.collectionMode === "detail";
  const translatedResultPath = isDetailCollection
    ? path.resolve(files.runDir, "result_translated.json")
    : null;
  let translationResult = {
    translatedItems: [],
    skippedOptions: [],
  };

  // 번역 API 장애와 무관하게 이미 수집한 가격·이미지·스펙을 먼저 보존한다.
  if (isDetailCollection && (result.detailItems || []).length > 0) {
    const collectedProducts = await createBackendProducts({
      collectionMode: "detail", products: result.products || [],
      inventoryItems: result.inventoryItems || [], detailItems: result.detailItems,
      lowStockThreshold: Number(config.lowStockThreshold) || 10,
    });
    const collectedArchive = await updateProductArchive(collectedProducts, {
      source: "detail", conversion: await getRunConversionSnapshot(),
    });
    writeJson(files.resultJson, collectedArchive.currentProducts);
    writeJson(files.detailResultJson, collectedArchive.currentProducts);
  }

  if (isDetailCollection && (result.detailItems || []).length > 0) {
    const translationInput = createTranslationInput(
      result,
      config.collectionMode,
    );

    onProgress({
      stage: "translating",
      message: "상품명과 옵션명을 번역하고 있습니다.",
      pageRange: result.summary.pageRange,
      detectedTotalProductCount: result.summary.detectedTotalProductCount,
      collectedProductCount: result.summary.collectedProductCount,
      targetProductCount: result.summary.targetProductCount,
      productSummaryCount: result.summary.productSummaryCount,
      soldOutProductCount: result.summary.soldOutProductCount,
      elapsedMs: result.summary.elapsedMs,
    });

    throwIfAborted(signal);

    translationResult = await translateResultData(
      translationInput,
      {
        outputPath: translatedResultPath,
        signal,
        collectionMode: config.collectionMode,
        sourceMall: config.mall,
        openAi,
      },
    );
  }

  const translatedData = translationResult.translatedItems;

  // ---1차 검수 완---
  // console.log("result.products", result.products);
  // console.log("result.detailItems", result.detailItems);

  /** 일반/상세 모두 동일한 백엔드 상품 타입으로 변환한다. */
  const backendProducts = await createBackendProducts({
    collectionMode: config.collectionMode,
    products: result.products || [],
    inventoryItems: result.inventoryItems || [],
    detailItems: result.detailItems || [],
    translatedItems: translatedData,
    lowStockThreshold: Number(config.lowStockThreshold) || 10,
  });

  throwIfAborted(signal);

  /**
   * Use one exchange-rate/time snapshot for every product in this run.
   * The archive converts each price observed in this collection after merging:
   * wholesalePrice → yenWholesalePrice, originalPrice → yenOriginalsalePrice
   * independently of collection timestamps. Unobserved prices retain their conversions.
   */
  const needsConversion =
    backendProducts.length > 0 || cycleArchivedProducts.size > 0;
  const conversion = needsConversion
    ? await getRunConversionSnapshot()
    : null;

  throwIfAborted(signal);

  /**
   * 일반·상세·번역 결과를 productId와 optionId 기준으로 통합한다.
   * 현재 수집에서 비어 있는 필드는 기존 archive 값을 유지한다.
   */
  const completedFullCatalogScan = getCompletedFullCatalogScan(config, result);
  const archiveUpdate = await updateProductArchive(
    backendProducts,
    {
      source: config.collectionMode,
      conversion,
      missingProductScan: completedFullCatalogScan
        ? { ...completedFullCatalogScan, candidateProductIds: missingProductCandidates, startedAt: catalogScanStartedAt }
        : null,
    },
  );
  Object.assign(rawPayload.summary, {
    fullCatalogScanCompleted: Boolean(completedFullCatalogScan),
    hiddenProductCount: archiveUpdate.stats.hiddenProductCount || 0,
    missingProductCount: archiveUpdate.stats.missingProductCount || 0,
  });
  if (completedFullCatalogScan) {
    onProgress({
      stage: "missing-products",
      message: `전체 목록 확인을 마쳤습니다. 미발견 상품 ${archiveUpdate.stats.missingProductCount || 0}개를 HIDDEN으로 반영합니다.`,
      hiddenProductCount: archiveUpdate.stats.hiddenProductCount || 0,
      missingProductCount: archiveUpdate.stats.missingProductCount || 0,
    });
  } else if (isFullCatalogRequested(config)) {
    onProgress({
      stage: "missing-products", level: "warn",
      message: "전체 페이지와 상품 수가 일치하는지 확인하지 못해 미발견 상품의 판매 상태를 유지합니다.",
    });
  }
  const detailMergedBackendProducts = archiveUpdate.currentProducts;
  let mergedBackendProducts = detailMergedBackendProducts;

  if (config.mall === "cheonyu" && isDetailCollection) {
    /**
     * pending 모드에서는 상세 대상이 전체 일반 수집 범위의 일부이거나 0건일 수 있다.
     * 실행 result는 선행 일반 수집 범위를 유지하고, 이번 상세 병합 결과만 교체한다.
     */
    const resultProductMap = new Map(cycleArchivedProducts);

    for (const product of detailMergedBackendProducts) {
      const productId = String(product?.id || product?.productId || "").trim();
      if (productId) resultProductMap.set(productId, product);
    }

    mergedBackendProducts = Array.from(resultProductMap.values());
  }
  const detailStateUpdate =
    config.mall === "cheonyu" && isDetailCollection
      ? await recordDetailOutcomes({
          mall: config.mall,
          detailItems: result.detailItems || [],
        })
      : null;

  /** result.json은 현재 상품의 통합 archive 결과를 저장한다. */
  writeJson(files.resultJson, mergedBackendProducts);

  const hasDetailResult =
    config.collectionMode === "detail" &&
    detailMergedBackendProducts.length > 0;

  /** detailResult에는 이번 실행에서 상세 수집을 시도한 상품만 저장한다. */
  if (hasDetailResult) {
    writeJson(files.detailResultJson, detailMergedBackendProducts);
  }

  console.log("[BACKEND PRODUCT] 변환 완료", {
    collectionMode: config.collectionMode,
    productCount: mergedBackendProducts.length,
    translatedProductCount: translatedData.length,
    skippedOptionCount: translationResult.skippedOptions.length,
    archiveNewProductCount: archiveUpdate.stats.newProductCount,
    archiveUpdatedProductCount: archiveUpdate.stats.updatedProductCount,
    archiveChangedFieldCount: archiveUpdate.stats.changedFieldCount,
    detailSucceededProductCount:
      detailStateUpdate?.succeededProductIds?.length || 0,
    detailFailedProductCount:
      detailStateUpdate?.failedProductIds?.length || 0,
    wonToYenRate: conversion?.rate ?? null,
    yenToWonRate: conversion?.revRate ?? null,
    conversionSnapshotAt: conversion?.createdAt ?? null,
    outputPath: files.resultJson,
  });

  onProgress({
    stage: "archiving",
    message:
      config.collectionMode === "detail"
        ? "상세 상품 아카이빙과 파일 저장을 완료했습니다."
        : "일반 상품 아카이빙과 파일 저장을 완료했습니다.",
    pageRange: result.summary.pageRange,
    detectedTotalProductCount: result.summary.detectedTotalProductCount,
    collectedProductCount: result.summary.collectedProductCount,
    targetProductCount: result.summary.targetProductCount,
    productSummaryCount: result.summary.productSummaryCount,
    soldOutProductCount: result.summary.soldOutProductCount,
    elapsedMs: result.summary.elapsedMs,
  });

  const uploads = {
    inventory: null,
    detail: null,
    deferredToShippingScheduler: true,
  };

  return {
    payload: {
      summary: rawPayload.summary,
      products: mergedBackendProducts,
    },
    translatedData,
    uploads,
    files: {
      inventory: files.inventoryCsv,
      summary: files.summaryCsv,
      products: files.productsCsv,
      details: result.detailItems?.length ? files.detailsCsv : null,
      result: files.resultJson,
      translatedResult: translatedResultPath,
      detailResult: hasDetailResult ? files.detailResultJson : null,
    },
  };
}

module.exports = {
  CSV_HEADERS,
  runCollection,
};

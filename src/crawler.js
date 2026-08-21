// src/crawler.js

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
  updateProductArchive,
} = require("./utils/product-archive");

const ADAPTERS = {
  cheonyu: require("./malls/cheonyu"),
  ccdome: require("./malls/ccdome"),
};

const RESULT_UPLOAD_URL =
  "https://www.web3.io.kr/joahstore/crawling/uploader";
const RESULT_UPLOAD_TIMEOUT_MS = 30000;

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

/** 객체 키로 사용할 값을 안전한 문자열로 변환한다. */
function normalizeJsonKey(value, fallback) {
  const normalized = String(value ?? "").trim();

  return normalized || fallback;
}

/** 상품 배열을 productId가 key인 객체로 변환한다. */
function toProductObject(items, transform = (item) => item) {
  const result = {};

  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    const productKey = normalizeJsonKey(
      item?.productId,
      `item_${index + 1}`,
    );

    result[productKey] = transform(item);
  }

  return result;
}

/**
 * 옵션별 재고 배열을 상품번호와 옵션 key 기준의 중첩 객체로 변환한다.
 *
 * 결과:
 * {
 *   "94236": {
 *     "default": { ... }
 *   },
 *   "92221": {
 *     "화이트 HB": { ... },
 *     "스카이블루 HB": { ... }
 *   }
 * }
 */
function toInventoryObject(items) {
  const result = {};

  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];

    const productKey = normalizeJsonKey(
      item?.productId,
      `product_${index + 1}`,
    );

    if (!result[productKey]) {
      result[productKey] = {};
    }

    const rawOptionKey =
      item?.optionId ||
      item?.optionText ||
      item?.inPIDX ||
      item?.cartCheckId ||
      "default";

    const baseOptionKey = normalizeJsonKey(
      rawOptionKey,
      "default",
    );

    let optionKey = baseOptionKey;
    let duplicateIndex = 2;

    /**
     * 같은 옵션명이 중복되어도 기존 데이터가 덮어써지지 않게 한다.
     */
    while (Object.hasOwn(result[productKey], optionKey)) {
      optionKey = `${baseOptionKey}_${duplicateIndex}`;
      duplicateIndex += 1;
    }

    result[productKey][optionKey] = item;
  }

  return result;
}

/** `/thumb/` 이미지 주소인지 확인한다. */
function isThumbnailUrl(value) {
  const url = String(value || "").trim();

  return /\/thumb\//i.test(url);
}

/**
 * 상세 row의 기존 이미지 필드를 JSON 전용 images 객체로 정리한다.
 *
 * CSV 저장용 텍스트 필드는 내부 데이터에 남겨둘 수 있지만,
 * result.json에서는 중복 이미지 필드를 제거한다.
 */
function normalizeDetailForJson(item = {}) {
  const {
    mainImageUrls,
    thumbnailImageUrls,
    introImageUrls,
    detailImageUrl,

    mainImageUrlsText,
    thumbnailImageUrlsText,
    introImageUrlsText,

    ...detail
  } = item;

  const mainImgSource =
    Array.isArray(mainImageUrls) && mainImageUrls.length > 0
      ? mainImageUrls
      : Array.isArray(thumbnailImageUrls)
        ? thumbnailImageUrls
        : [];

  const mainImg = Array.from(
    new Set(
      mainImgSource
        .map((url) => String(url || "").trim())
        .filter(Boolean)
        .filter((url) => !isThumbnailUrl(url)),
    ),
  );

  const detailImgCandidate =
    detailImageUrl ||
    (Array.isArray(introImageUrls) ? introImageUrls[0] : "") ||
    "";

  const detailImg =
    detailImgCandidate && !isThumbnailUrl(detailImgCandidate)
      ? String(detailImgCandidate).trim()
      : "";

  return {
    ...detail,

    images: {
      main_img: mainImg,
      detail_img: detailImg,
    },
  };
}

/** 중복·빈 이미지 URL과 /thumb/ 이미지를 제거한다. */
function normalizeImageUrls(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .filter((value) => !/\/thumb\//i.test(value)),
    ),
  );
}

/**
 * 상세 row를 detailResult.json 전용 구조로 정리한다.
 *
 * 두 쇼핑몰의 신규 필드와 이전 필드명을 모두 fallback으로 지원한다.
 */
function normalizeDetailResultItem(item = {}) {
  const {
    mainImageUrls,
    thumbnailImageUrls,
    introImageUrls,
    detailImageUrls,
    detailImageUrl,

    mainImageUrlsText,
    thumbnailImageUrlsText,
    introImageUrlsText,

    ...detail
  } = item;

  const mainImg = normalizeImageUrls(
    Array.isArray(mainImageUrls) && mainImageUrls.length > 0
      ? mainImageUrls
      : thumbnailImageUrls,
  );

  const detailImgCandidates = normalizeImageUrls([
    detailImageUrl,
    ...(Array.isArray(detailImageUrls) ? detailImageUrls : []),
    ...(Array.isArray(introImageUrls) ? introImageUrls : []),
  ]);

  return {
    ...detail,

    images: {
      main_img: mainImg,
      detail_img: detailImgCandidates[0] || "",
    },
  };
}

/** 빈 문자열을 null로 처리하고 유효한 숫자만 반환한다. */
function toNullableNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

/** 상품별 재고 row Map을 생성한다. */
function createInventoryMap(inventoryItems = []) {
  const map = new Map();

  for (const item of inventoryItems) {
    const productId = String(item?.productId || "").trim();

    if (!productId) continue;

    if (!map.has(productId)) {
      map.set(productId, []);
    }

    map.get(productId).push(item);
  }

  return map;
}

/** 상품별 요약 Map을 생성한다. */
function createProductSummaryMap(productSummaries = []) {
  return new Map(
    productSummaries
      .filter((item) => item?.productId)
      .map((item) => [
        String(item.productId),
        item,
      ]),
  );
}

/** 같은 옵션명이 중복되어도 덮어쓰지 않는 key를 생성한다. */
function createUniqueOptionKey(options, item, index) {
  const rawKey = String(
    item?.optionText ||
      item?.optionId ||
      item?.inPIDX ||
      "default",
  ).trim();

  const baseKey = rawKey || `option_${index + 1}`;
  let key = baseKey;
  let duplicateIndex = 2;

  while (Object.hasOwn(options, key)) {
    key = `${baseKey}_${duplicateIndex}`;
    duplicateIndex += 1;
  }

  return key;
}

/** 상품 하나의 옵션별 재고 객체를 생성한다. */
function createStockObject(
  detailItem,
  inventoryRows = [],
  productSummary = null,
) {
  const options = {};

  for (let index = 0; index < inventoryRows.length; index += 1) {
    const item = inventoryRows[index];
    const optionKey = createUniqueOptionKey(
      options,
      item,
      index,
    );

    options[optionKey] = {
      optionText: item.optionText || "",
      stockStatus: item.stockStatus || "",
      maxStock: toNullableNumber(item.maxStock),
      requestedQty: toNullableNumber(item.requestedQty),
      stockLimited: Boolean(item.stockLimited),
      isSoldOut: Boolean(item.isSoldOut),
      onePrice: toNullableNumber(item.onePrice),
      boxPrice: toNullableNumber(item.boxPrice),
      effectivePrice: toNullableNumber(item.effectivePrice),
      msg: item.msg || "",
    };
  }

  const fallbackStatus =
    productSummary?.stockStatus ||
    inventoryRows[0]?.stockStatus ||
    "";

  return {
    /**
     * 천유는 장바구니에서 실제 구매 가능 수량을 확인하고,
     * 과자생각은 목록의 판매 가능/품절 상태만 확인한다.
     */
    source:
      detailItem?.sourceMall === "cheonyu"
        ? "cart"
        : "availability",

    stockStatus: fallbackStatus,

    totalStock: toNullableNumber(
      productSummary?.totalStock,
    ),

    minStock: toNullableNumber(
      productSummary?.minStock,
    ),

    maxStock: toNullableNumber(
      productSummary?.maxStock,
    ),

    hasOptions:
      Boolean(productSummary?.hasOptions) ||
      inventoryRows.some((item) => item.hasOption),

    optionCount:
      toNullableNumber(productSummary?.optionCount) ??
      inventoryRows.filter((item) => item.hasOption).length,

    limitedRowCount:
      toNullableNumber(productSummary?.limitedRowCount) ?? 0,

    lowStockRowCount:
      toNullableNumber(productSummary?.lowStockRowCount) ?? 0,

    outOfStockRowCount:
      toNullableNumber(productSummary?.outOfStockRowCount) ?? 0,

    options,
  };
}

/**
 * 실제 상세 수집된 상품만 상품번호 key의 객체로 변환한다.
 * 각 상품에는 해당 상품의 재고 요약과 옵션별 재고를 병합한다.
 */
function createDetailResultObject(
  detailItems = [],
  inventoryItems = [],
  productSummaries = [],
) {
  const result = {};
  const inventoryMap = createInventoryMap(inventoryItems);
  const summaryMap = createProductSummaryMap(productSummaries);

  for (let index = 0; index < detailItems.length; index += 1) {
    const item = detailItems[index];

    const productId = String(
      item?.productId ||
        item?.productNo ||
        `item_${index + 1}`,
    ).trim();

    const normalizedDetail =
      normalizeDetailResultItem(item);

    result[productId] = {
      ...normalizedDetail,

      stock: createStockObject(
        item,
        inventoryMap.get(productId) || [],
        summaryMap.get(productId) || null,
      ),
    };
  }

  return result;
}

/**
 * POST 전송 데이터에서 productUrl 키만 재귀적으로 제거한다.
 * 원본 result/detailResult 객체는 변경하지 않는다.
 */
function removeProductUrlDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => removeProductUrlDeep(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (key === "productUrl") continue;

    result[key] = removeProductUrlDeep(childValue);
  }

  return result;
}

/** 응답 본문을 JSON 우선으로 변환하고, 실패하면 문자열로 반환한다. */
function parseUploadResponseText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 메모리에 완성된 결과 JSON을 uploader 서버에 한 번에 POST한다.
 *
 * body:
 * {
 *   type: "재고" | "디테일",
 *   data: productUrl이 제거된 JSON 객체
 * }
 */
async function postResultJson(
  type,
  data,
  {
    signal,
    translatedData = null,
  } = {},
) {
  throwIfAborted(signal);

  if (typeof fetch !== "function") {
    throw new Error(
      "현재 Node.js 환경에서 fetch를 사용할 수 없습니다. Node.js 18 이상이 필요합니다.",
    );
  }

  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESULT_UPLOAD_TIMEOUT_MS);

  const abortFromParent = () => {
    controller.abort();
  };

  signal?.addEventListener("abort", abortFromParent, {
    once: true,
  });

  const body = {
    type,
    data: removeProductUrlDeep(data),

    /**
     * 기존 type/data 계약은 유지하고,
     * 재고 POST에 번역 결과 JSON을 함께 전달한다.
     */
    ...(translatedData !== null
      ? {
        translatedData:
          removeProductUrlDeep(
            translatedData,
          ),
      }
      : {}),
  };

  try {
    console.log(`[RESULT POST] ${type} 전송 시작`, {
      url: RESULT_UPLOAD_URL,
      type,
    });

    const response = await fetch(RESULT_UPLOAD_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const responseData = parseUploadResponseText(responseText);

    console.log(`[RESULT POST] ${type} 응답`, {
      status: response.status,
      ok: response.ok,
      data: responseData,
    });

    if (!response.ok) {
      const message =
        responseData && typeof responseData === "object"
          ? responseData.message || responseData.error
          : responseData;

      throw new Error(
        message || `${type} 결과 POST 실패: HTTP ${response.status}`,
      );
    }

    return {
      type,
      status: response.status,
      response: responseData,
    };
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }

    if (timedOut || error?.name === "AbortError") {
      throw new Error(
        `${type} 결과 POST 요청 시간이 ${RESULT_UPLOAD_TIMEOUT_MS}ms를 초과했습니다.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

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
  const result = await adapter.run(config, { onProgress, signal });

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

  if (isDetailCollection) {
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
   * The archive applies it after merging, so yenPrice is always derived
   * from the final originalPrice written to the result.
   */
  const conversion = isDetailCollection
    ? await createConversionSnapshot({ signal })
    : null;

  throwIfAborted(signal);

  /**
   * 일반·상세·번역 결과를 productId와 optionId 기준으로 통합한다.
   * 현재 수집에서 비어 있는 필드는 기존 archive 값을 유지한다.
   */
  const archiveUpdate = await updateProductArchive(
    backendProducts,
    {
      source: config.collectionMode,
      conversion,
    },
  );
  const mergedBackendProducts = archiveUpdate.currentProducts;

  /** result.json은 현재 상품의 통합 archive 결과를 저장한다. */
  writeJson(files.resultJson, mergedBackendProducts);

  const hasDetailResult =
    config.collectionMode === "detail" &&
    mergedBackendProducts.length > 0;

  /** 기존 상세 결과 파일 경로 호환을 위해 같은 데이터 타입으로 저장한다. */
  if (hasDetailResult) {
    writeJson(files.detailResultJson, mergedBackendProducts);
  }

  console.log("[BACKEND PRODUCT] 변환 완료", {
    collectionMode: config.collectionMode,
    productCount: mergedBackendProducts.length,
    translatedProductCount: translatedData.length,
    skippedOptionCount: translationResult.skippedOptions.length,
    archiveNewProductCount: archiveUpdate.stats.newProductCount,
    archiveUpdatedProductCount: archiveUpdate.stats.updatedProductCount,
    archiveChangedFieldCount: archiveUpdate.stats.changedFieldCount,
    wonToYenRate: conversion?.rate ?? null,
    yenToWonRate: conversion?.revRate ?? null,
    convertTime: conversion?.convertTime ?? null,
    outputPath: files.resultJson,
  });

  onProgress({
    stage: "uploading",
    message:
      config.collectionMode === "detail"
        ? "상세 상품 데이터를 서버에 전송하고 있습니다."
        : "일반 상품 데이터를 서버에 전송하고 있습니다.",
    pageRange: result.summary.pageRange,
    detectedTotalProductCount: result.summary.detectedTotalProductCount,
    collectedProductCount: result.summary.collectedProductCount,
    targetProductCount: result.summary.targetProductCount,
    productSummaryCount: result.summary.productSummaryCount,
    soldOutProductCount: result.summary.soldOutProductCount,
    elapsedMs: result.summary.elapsedMs,
  });

  throwIfAborted(signal);

  const uploadType =
    config.collectionMode === "detail"
      ? "디테일"
      : "재고";
  const uploadResult = await postResultJson(
    uploadType,
    mergedBackendProducts,
    { signal },
  );
  const uploads = {
    inventory:
      config.collectionMode === "general"
        ? uploadResult
        : null,
    detail:
      config.collectionMode === "detail"
        ? uploadResult
        : null,
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

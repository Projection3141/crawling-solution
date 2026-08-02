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

/** 선택한 쇼핑몰 adapter를 실행하고 공통 CSV/JSON 파일을 저장한다. */
async function runCollection(config, { runId, onProgress = () => {}, signal }) {
  throwIfAborted(signal);

  const adapter = ADAPTERS[config.mall];

  if (!adapter) {
    throw new Error(`수집 adapter가 없습니다: ${config.mall}`);
  }

  const files = createRunFiles(config.baseOutDir, config.mall, runId);
  const result = await adapter.run(config, { onProgress, signal });

  throwIfAborted(signal);

  const safeConfig = toSafeConfig(config);
  const payload = {
    summary: {
      ...result.summary,
      config: safeConfig,
    },
    inventoryItems: result.inventoryItems,
    productSummaries: result.productSummaries,
    products: result.products,
    detailItems: result.detailItems || undefined,
    popupOptionItems: result.popupOptionItems || undefined,
    activeProducts: result.activeProducts || undefined,
    soldOutProducts: result.soldOutProducts || undefined,
  };

  onProgress({
    stage: "saving",
    message: "CSV와 결과 JSON을 저장하고 있습니다.",
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

  writeJson(files.resultJson, payload);

  return {
    payload,
    files: {
      inventory: files.inventoryCsv,
      summary: files.summaryCsv,
      products: files.productsCsv,
      details: result.detailItems?.length ? files.detailsCsv : null,
      result: files.resultJson,
    },
  };
}

module.exports = {
  CSV_HEADERS,
  runCollection,
};

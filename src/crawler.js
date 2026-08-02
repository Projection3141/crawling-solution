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

/** 선택한 쇼핑몰 adapter를 실행하고 공통 CSV/JSON 파일을 저장한다. */
async function runCollection(config, { runId, onProgress = () => { }, signal }) {
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

    /**
     * 일반 수집 결과는 기존 result.json에 저장한다.
     * 상세 수집 데이터는 detailResult.json으로 분리한다.
     */
    inventoryItems: result.inventoryItems,
    productSummaries: result.productSummaries,
    products: result.products,

    activeProducts:
      result.activeProducts || undefined,

    soldOutProducts:
      result.soldOutProducts || undefined,

    popupOptionItems:
      result.popupOptionItems || undefined,
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

  /** 일반 수집 결과 JSON */
  writeJson(files.resultJson, payload);

  /** 상세페이지까지 실제로 수집된 상품만 별도 JSON으로 저장 */
  const detailResult = createDetailResultObject(
    result.detailItems || [],
  );

  const hasDetailResult =
    Object.keys(detailResult).length > 0;

  if (hasDetailResult) {
    writeJson(
      files.detailResultJson,
      detailResult,
    );
  }
  return {
    payload,
    files: {
      inventory: files.inventoryCsv,
      summary: files.summaryCsv,
      products: files.productsCsv,
      details: result.detailItems?.length ? files.detailsCsv : null,
      result: files.resultJson,
      detailResult: hasDetailResult ? files.detailResultJson : null,
    },
  };
}

module.exports = {
  CSV_HEADERS,
  runCollection,
};

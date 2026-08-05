/** src/utils/product-archive.js */

const fs = require("node:fs/promises");
const path = require("node:path");

const ARCHIVE_PATH = path.resolve(
  __dirname,
  "../../translate/archive.json",
);

let archiveQueue = Promise.resolve();

const PRODUCT_FIELDS = [
  "id",
  "sku",
  "slug",
  "type",
  "nameKo",
  "nameJa",
  "nameEn",
  "categoryId",
  "subcategoryId",
  "brandId",
  "originalPrice",
  "salePrice",
  "discountRate",
  "currency",
  "saleStatus",
  "stockQuantity",
  "lowStockThreshold",
  "stockStatus",
  "badges",
  "imageUrls",
  "thumbnailUrl",
  "options",
  "wholesaleEnabled",
  "descriptionKo",
  "descriptionJa",
  "specs",
  "rating",
  "reviewCount",
  "salesCount",
  "status",
  "sortOrder",
  "adminMemo",
  "version",
  "createdAt",
  "updatedAt",
];

const OPTION_FIELDS = [
  "id",
  "name",
  "nameKo",
  "nameJa",
  "nameEn",
  "additionalPrice",
  "stockQuantity",
  "status",
];

const GENERAL_FIELDS = new Set([
  "type",
  "nameKo",
  "nameJa",
  "nameEn",
  "originalPrice",
  "salePrice",
  "discountRate",
  "currency",
  "saleStatus",
  "stockQuantity",
  "lowStockThreshold",
  "stockStatus",
]);

const DETAIL_FIELDS = new Set([
  "nameKo",
  "nameJa",
  "nameEn",
  "categoryId",
  "subcategoryId",
  "brandId",
  "imageUrls",
  "thumbnailUrl",
  "descriptionKo",
  "descriptionJa",
  "specs",
]);

const TRANSLATION_FIELDS = new Set([
  "nameKo",
  "nameJa",
  "nameEn",
]);

/** 문자열을 공백이 정리된 값으로 변환한다. */
function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** JSON에 저장 가능한 값으로 깊은 복사한다. */
function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

/** 두 JSON 값을 비교한다. */
function isSameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 빈 문자열이 아닌 값인지 확인한다. */
function hasText(value) {
  return normalizeText(value) !== "";
}

/** 비어 있지 않은 배열인지 확인한다. */
function hasArrayItems(value) {
  return Array.isArray(value) && value.length > 0;
}

/** 중복과 빈 값을 제거한 문자열 배열을 생성한다. */
function uniqueTextArray(value) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flat(Infinity)
        .map((item) => normalizeText(item))
        .filter(Boolean),
    ),
  );
}

/** 실제 상품 이미지가 아닌 /thumb/ 중복 URL인지 확인한다. */
function isThumbnailImageUrl(value) {
  return /\/thumb\//i.test(normalizeText(value));
}

/**
 * 메인 이미지와 상세 이미지만 보관한다.
 * 썸네일 URL은 thumbnailUrl 필드에서 별도로 관리한다.
 */
function normalizeImageUrls(value) {
  return uniqueTextArray(value).filter(
    (url) => !isThumbnailImageUrl(url),
  );
}

/** 새 상품의 전체 백엔드 구조를 생성한다. */
function createEmptyProduct(productId) {
  return {
    id: productId,
    sku: "",
    slug: "",
    type: "SINGLE",
    nameKo: "",
    nameJa: "",
    nameEn: "",
    categoryId: "",
    subcategoryId: null,
    brandId: "",
    originalPrice: null,
    salePrice: null,
    discountRate: null,
    currency: "KRW",
    saleStatus: "",
    stockQuantity: null,
    lowStockThreshold: 10,
    stockStatus: "",
    badges: [],
    imageUrls: [],
    thumbnailUrl: "",
    options: {},
    wholesaleEnabled: false,
    descriptionKo: "",
    descriptionJa: "",
    specs: [],
    rating: 0,
    reviewCount: 0,
    salesCount: 0,
    status: "PUBLISHED",
    sortOrder: 0,
    adminMemo: "",
    version: 0,
    createdAt: null,
    updatedAt: null,
  };
}

/** 새 옵션의 전체 구조를 생성한다. */
function createEmptyOption(optionId) {
  return {
    id: optionId,
    name: "",
    nameKo: "",
    nameJa: "",
    nameEn: "",
    additionalPrice: 0,
    stockQuantity: null,
    status: "",
  };
}

/** 옵션의 여러 입력 필드명을 전체 옵션 구조로 정규화한다. */
function normalizeIncomingOption(option = {}) {
  const id = normalizeText(option?.id || option?.optionId);
  const nameKo = normalizeText(
    option?.nameKo || option?.ko || option?.optionText,
  );
  const nameJa = normalizeText(
    option?.nameJa || option?.ja,
  );
  const nameEn = normalizeText(
    option?.nameEn || option?.en,
  );
  const name = normalizeText(option?.name) || nameJa;

  return {
    ...createEmptyOption(id),
    ...cloneJson(option),
    id,
    name,
    nameKo,
    nameJa,
    nameEn,
  };
}

/** 옵션 배열 또는 옵션 key 객체를 optionId key 객체로 변환한다. */
function normalizeOptions(options) {
  const result = {};
  const sourceOptions = Array.isArray(options)
    ? options
    : options && typeof options === "object"
      ? Object.values(options)
      : [];

  for (let index = 0; index < sourceOptions.length; index += 1) {
    const normalizedOption = normalizeIncomingOption(
      sourceOptions[index],
    );

    /**
     * optionId가 없는 잘못된 데이터도 버리지 않는다.
     * 내부 병합 key만 임시로 만들고 실제 id 값은 빈 문자열로 보존한다.
     */
    const optionKey = normalizedOption.id ||
      `__missing_option_${index + 1}`;

    result[optionKey] = normalizedOption;
  }

  return result;
}

/** 상품 배열 원소를 archive 내부 전체 상품 구조로 정규화한다. */
function normalizeIncomingProduct(product = {}) {
  const id = normalizeText(product?.id || product?.productId);

  if (!id) {
    return null;
  }

  const normalized = createEmptyProduct(id);

  for (const field of PRODUCT_FIELDS) {
    if (field === "options" || field === "id") {
      continue;
    }

    if (Object.hasOwn(product, field)) {
      normalized[field] = cloneJson(product[field]);
    }
  }

  normalized.id = id;
  normalized.options = normalizeOptions(product?.options);
  normalized.imageUrls = normalizeImageUrls(normalized.imageUrls);

  return normalized;
}

/** 읽은 JSON을 내부 productId key 문서 구조로 변환한다. */
function normalizeArchiveDocument(value) {
  const products = {};
  let sourceProducts = [];

  if (Array.isArray(value)) {
    sourceProducts = value;
  } else if (value && typeof value === "object") {
    const rawProducts =
      value.products && typeof value.products === "object"
        ? value.products
        : value;

    sourceProducts = Object.entries(rawProducts)
      .filter(([key]) => !["version", "updatedAt"].includes(key))
      .map(([key, item]) => ({
        ...item,
        id: item?.id || key,
      }));
  }

  for (const item of sourceProducts) {
    const normalized = normalizeIncomingProduct(item);

    if (!normalized) {
      continue;
    }

    products[normalized.id] = normalized;
  }

  return { products };
}

/** archive.json을 잠금 없이 읽는다. */
async function readArchiveUnlocked() {
  try {
    const text = await fs.readFile(ARCHIVE_PATH, "utf8");
    const normalizedText = text.replace(/^\uFEFF/, "").trim();

    if (!normalizedText) {
      return normalizeArchiveDocument([]);
    }

    return normalizeArchiveDocument(
      JSON.parse(normalizedText),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return normalizeArchiveDocument([]);
    }

    throw error;
  }
}

/** archive 작업을 순차 실행한다. */
function runWithArchiveLock(task) {
  const queued = archiveQueue.then(task);

  archiveQueue = queued.catch(() => undefined);

  return queued;
}

/** 변경 통계를 생성한다. */
function createStats(source) {
  return {
    source,
    newProductCount: 0,
    updatedProductCount: 0,
    unchangedProductCount: 0,
    newOptionCount: 0,
    updatedOptionCount: 0,
    skippedOptionCount: 0,
    changedFieldCount: 0,
    changedProductIds: [],
  };
}

/** 필드 하나를 값이 실제로 달라졌을 때만 갱신한다. */
function setChangedField(target, key, value, stats) {
  const nextValue = cloneJson(value);

  if (isSameJson(target[key], nextValue)) {
    return false;
  }

  target[key] = nextValue;
  stats.changedFieldCount += 1;

  return true;
}

/** 수집 출처가 해당 상품 필드를 갱신할 수 있는지 확인한다. */
function canUpdateProductField(source, field, value) {
  if (source === "translation") {
    return TRANSLATION_FIELDS.has(field);
  }

  if (source === "general") {
    if (GENERAL_FIELDS.has(field)) {
      if (["nameKo", "nameJa", "nameEn", "currency", "saleStatus", "stockStatus", "type"].includes(field)) {
        return hasText(value);
      }

      if (field === "originalPrice") {
        return value !== undefined && value !== null;
      }

      /**
       * salePrice, discountRate, stockQuantity은 null 자체도
       * 최신 상태를 뜻할 수 있으므로 비교 대상에 포함한다.
       */
      return value !== undefined;
    }

    /** 일반 수집의 카테고리는 기존 상세값이 없을 때만 보조로 사용한다. */
    return field === "categoryId" && hasText(value);
  }

  if (source === "detail") {
    if (!DETAIL_FIELDS.has(field)) {
      return false;
    }

    if (["imageUrls", "specs"].includes(field)) {
      return hasArrayItems(value);
    }

    if (field === "subcategoryId") {
      return value !== undefined && value !== null;
    }

    return hasText(value);
  }

  return false;
}

/** 번역에서 상품명이 바뀐 경우 이전 번역을 안전하게 초기화한다. */
function mergeTranslationProductFields(
  result,
  incoming,
  stats,
) {
  let changed = false;
  const incomingNameKo = normalizeText(incoming.nameKo);
  const nameChanged =
    incomingNameKo &&
    normalizeText(result.nameKo) !== incomingNameKo;

  if (nameChanged) {
    changed = setChangedField(
      result,
      "nameKo",
      incomingNameKo,
      stats,
    ) || changed;

    changed = setChangedField(
      result,
      "nameJa",
      normalizeText(incoming.nameJa),
      stats,
    ) || changed;

    changed = setChangedField(
      result,
      "nameEn",
      normalizeText(incoming.nameEn),
      stats,
    ) || changed;

    return changed;
  }

  for (const field of ["nameJa", "nameEn"]) {
    const value = normalizeText(incoming[field]);

    if (!value) {
      continue;
    }

    changed = setChangedField(
      result,
      field,
      value,
      stats,
    ) || changed;
  }

  return changed;
}

/** 옵션 하나를 optionId 기준으로 병합한다. */
function mergeOption(existingOption, incomingOption, stats, source) {
  const incoming = normalizeIncomingOption(incomingOption);
  const isNew = !existingOption;
  const result = existingOption
    ? cloneJson(existingOption)
    : createEmptyOption(incoming.id);
  let changed = false;

  if (source === "translation") {
    const incomingNameKo = normalizeText(incoming.nameKo);
    const nameChanged =
      incomingNameKo &&
      normalizeText(result.nameKo) !== incomingNameKo;

    if (nameChanged) {
      for (const field of ["nameKo", "nameJa", "nameEn"] ) {
        changed = setChangedField(
          result,
          field,
          normalizeText(incoming[field]),
          stats,
        ) || changed;
      }

      changed = setChangedField(
        result,
        "name",
        normalizeText(incoming.nameJa),
        stats,
      ) || changed;
    } else {
      for (const field of ["nameJa", "nameEn"]) {
        const value = normalizeText(incoming[field]);

        if (!value) {
          continue;
        }

        changed = setChangedField(
          result,
          field,
          value,
          stats,
        ) || changed;
      }

      if (hasText(incoming.nameJa)) {
        changed = setChangedField(
          result,
          "name",
          normalizeText(incoming.nameJa),
          stats,
        ) || changed;
      }
    }
  } else {
    const allowedFields = source === "general"
      ? [
          "name",
          "nameKo",
          "nameJa",
          "nameEn",
          "additionalPrice",
          "stockQuantity",
          "status",
        ]
      : [
          "name",
          "nameKo",
          "nameJa",
          "nameEn",
          "additionalPrice",
        ];

    for (const field of allowedFields) {
      const value = incoming[field];

      if (["name", "nameKo", "nameJa", "nameEn", "status"].includes(field) && !hasText(value)) {
        continue;
      }

      if (field === "additionalPrice" && value === undefined) {
        continue;
      }

      if (field === "stockQuantity" && source !== "general") {
        continue;
      }

      changed = setChangedField(
        result,
        field,
        value,
        stats,
      ) || changed;
    }
  }

  result.id = incoming.id;

  if (isNew) {
    stats.newOptionCount += 1;
  } else if (changed) {
    stats.updatedOptionCount += 1;
  }

  return {
    option: result,
    changed: isNew || changed,
  };
}

/** 상품 하나를 productId 기준으로 병합한다. */
function mergeProduct(existingProduct, incomingProduct, stats, source) {
  const incoming = normalizeIncomingProduct(incomingProduct);

  if (!incoming) {
    return {
      product: existingProduct,
      changed: false,
    };
  }

  const isNew = !existingProduct;
  const result = existingProduct
    ? cloneJson(existingProduct)
    : createEmptyProduct(incoming.id);
  let changed = false;

  if (source === "translation") {
    changed = mergeTranslationProductFields(
      result,
      incoming,
      stats,
    ) || changed;
  } else {
    for (const field of PRODUCT_FIELDS) {
      if (["id", "options"].includes(field)) {
        continue;
      }

      if (!canUpdateProductField(source, field, incoming[field])) {
        continue;
      }

      /** 상세에서 확보한 카테고리가 있으면 일반 추정값으로 덮지 않는다. */
      if (
        source === "general" &&
        field === "categoryId" &&
        hasText(result.categoryId)
      ) {
        continue;
      }

      /**
       * 상세 수집에서 확인된 메인·상세 이미지 배열을 최신값으로 반영한다.
       * /thumb/ 중복 URL은 imageUrls에서 제외하고 thumbnailUrl로만 관리한다.
       */
      const value = field === "imageUrls"
        ? normalizeImageUrls(incoming[field])
        : incoming[field];

      changed = setChangedField(
        result,
        field,
        value,
        stats,
      ) || changed;
    }
  }

  if (!result.options || typeof result.options !== "object") {
    result.options = {};
  }

  const incomingOptions = normalizeOptions(incoming.options);

  /** 일반 수집에서 SINGLE로 확인된 상품만 옵션 배열을 비운다. */
  if (
    source === "general" &&
    incoming.type === "SINGLE" &&
    Object.keys(incomingOptions).length === 0
  ) {
    if (Object.keys(result.options).length > 0) {
      result.options = {};
      stats.changedFieldCount += 1;
      changed = true;
    }
  } else {
    for (const [optionKey, incomingOption] of Object.entries(incomingOptions)) {
      const existingOption = result.options[optionKey];
      const merged = mergeOption(
        existingOption,
        incomingOption,
        stats,
        source,
      );

      result.options[optionKey] = merged.option;
      changed = merged.changed || changed;
    }
  }

  result.id = incoming.id;
  result.type = Object.keys(result.options).length > 0
    ? "OPTION"
    : normalizeText(result.type) || "SINGLE";

  if (isNew) {
    stats.newProductCount += 1;
  } else if (changed) {
    stats.updatedProductCount += 1;
  } else {
    stats.unchangedProductCount += 1;
  }

  return {
    product: result,
    changed: isNew || changed,
  };
}

/** archive 내부 옵션 객체를 전체 옵션 배열로 변환한다. */
function materializeOption(option) {
  const source = {
    ...createEmptyOption(normalizeText(option?.id)),
    ...cloneJson(option),
  };
  const result = {};

  for (const field of OPTION_FIELDS) {
    result[field] = cloneJson(source[field]);
  }

  return result;
}

/** archive 내부 상품을 요청한 전체 백엔드 객체 형식으로 변환한다. */
function materializeProduct(product) {
  const source = {
    ...createEmptyProduct(normalizeText(product?.id)),
    ...cloneJson(product),
  };
  const result = {};

  for (const field of PRODUCT_FIELDS) {
    if (field === "options") {
      result.options = Object.values(source.options || {}).map(
        (option) => materializeOption(option),
      );
      continue;
    }

    result[field] = cloneJson(source[field]);
  }

  return result;
}

/** archive 문서를 전체 백엔드 상품 배열로 변환한다. */
function archiveToProductArray(archive, productIds = null) {
  const ids = Array.isArray(productIds)
    ? productIds.map((id) => normalizeText(id)).filter(Boolean)
    : Object.keys(archive?.products || {});

  return ids
    .map((id) => archive?.products?.[id])
    .filter(Boolean)
    .map((product) => materializeProduct(product));
}

/** archive.json을 요청한 상품 객체 배열 형식 그대로 저장한다. */
async function writeArchiveUnlocked(archive) {
  await fs.mkdir(path.dirname(ARCHIVE_PATH), {
    recursive: true,
  });

  await fs.writeFile(
    ARCHIVE_PATH,
    `${JSON.stringify(archiveToProductArray(archive), null, 2)}\n`,
    "utf8",
  );
}

/** archive 문서를 번역기용 상품 배열로 변환한다. */
function archiveToTranslationItems(archive) {
  return archiveToProductArray(archive).map((product) => ({
    id: product.id,
    nameKo: normalizeText(product.nameKo),
    nameJa: normalizeText(product.nameJa),
    nameEn: normalizeText(product.nameEn),
    options: (product.options || []).map((option) => ({
      id: normalizeText(option.id),
      ko: normalizeText(option.nameKo || option.ko),
      ja: normalizeText(option.nameJa || option.ja),
      en: normalizeText(option.nameEn || option.en),
    })),
  }));
}

/** 통합 archive를 읽는다. */
function readProductArchive() {
  return runWithArchiveLock(() => readArchiveUnlocked());
}

/**
 * 상품 배열을 productId와 optionId 기준으로 통합 archive에 병합한다.
 * archive.json에는 wrapper 없이 전체 백엔드 상품 객체 배열만 저장한다.
 */
function updateProductArchive(products, {
  source = "general",
} = {}) {
  return runWithArchiveLock(async () => {
    const archive = await readArchiveUnlocked();
    const stats = createStats(source);
    const currentProductIds = [];
    let changed = false;

    for (const product of products || []) {
      const productId = normalizeText(
        product?.id || product?.productId,
      );

      if (!productId) {
        continue;
      }

      currentProductIds.push(productId);

      const merged = mergeProduct(
        archive.products[productId],
        product,
        stats,
        source,
      );

      archive.products[productId] = merged.product;
      changed = merged.changed || changed;

      if (merged.changed) {
        stats.changedProductIds.push(productId);
      }
    }

    /**
     * 이전 wrapper 형식 archive도 한 번의 실행으로
     * 전체 상품 객체 배열 형식으로 변환되도록 항상 저장한다.
     * 실제 필드값은 달라진 항목만 mergeProduct에서 갱신된다.
     */
    await writeArchiveUnlocked(archive);

    console.log(`[ARCHIVE] ${source} 병합 완료`, {
      inputProductCount: currentProductIds.length,
      newProductCount: stats.newProductCount,
      updatedProductCount: stats.updatedProductCount,
      unchangedProductCount: stats.unchangedProductCount,
      newOptionCount: stats.newOptionCount,
      updatedOptionCount: stats.updatedOptionCount,
      skippedOptionCount: stats.skippedOptionCount,
      changedFieldCount: stats.changedFieldCount,
    });

    return {
      archive,
      currentProducts: archiveToProductArray(
        archive,
        currentProductIds,
      ),
      stats,
      archivePath: ARCHIVE_PATH,
    };
  });
}

module.exports = {
  ARCHIVE_PATH,
  archiveToProductArray,
  archiveToTranslationItems,
  readProductArchive,
  updateProductArchive,
};

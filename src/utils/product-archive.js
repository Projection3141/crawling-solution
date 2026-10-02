// src/utils/product-archive.js
// 목적: 버전별 상품 아카이브를 읽고 이관·병합·저장하며 전송 및 번역용 목록으로 변환한다.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { version: PACKAGE_VERSION } = require("../../package.json");
const {
  convertWonToYen,
} = require("../../translate/convert");

const LEGACY_ARCHIVE_PATH = path.resolve(
  __dirname,
  "../../translate/archive.json",
);
const ARCHIVE_VERSION = normalizeArchiveVersion(
  process.env.PRODUCT_ARCHIVE_VERSION || PACKAGE_VERSION,
);
const ARCHIVE_DIRECTORY = path.resolve(
  process.env.PRODUCT_ARCHIVE_DIRECTORY ||
    path.join(os.homedir(), "MallCollector", "archive"),
);
const ARCHIVE_PATH = path.join(
  ARCHIVE_DIRECTORY,
  `v${ARCHIVE_VERSION}_archive.json`,
);
const VERSIONED_ARCHIVE_FILE_PATTERN =
  /^v(\d+\.\d+\.\d+)_archive\.json$/i;

let archiveQueue = Promise.resolve();

const { createProduct, PRODUCT_FIELDS, getProductSourceMall, getProductArchiveKey, normalizeProductTimestamp, normalizeProductCategory, normalizeCategoryId, applyProductSkus } = require("./product-schema");

const OPTION_FIELDS = [
  "id",
  "sku",
  "barcode",
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
  "wholesalePrice",
  "saleStatus",
  "stockQuantity",
  "lowStockThreshold",
  "stockStatus",
]);

const DETAIL_FIELDS = new Set([
  "barcode",
  "nameKo",
  "nameJa",
  "nameEn",
  "category",
  "categoryId",
  "subcategoryId",
  "brandId",
  "originalPrice",
  "wholesalePrice",
  "salePrice",
  "discountRate",
  "currency",
  "imageUrls",
  "descriptionImageUrls",
  "thumbnailUrl",
  "descriptionKo",
  "descriptionJa",
  "descriptionEn",
  "specs",
]);

const TRANSLATION_FIELDS = new Set([
  "nameKo",
  "nameJa",
  "nameEn",
]);

/** 앱 릴리즈 버전을 버전별 archive 파일명에 사용할 형식으로 정규화한다. */
function normalizeArchiveVersion(value) {
  const matched = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);

  if (!matched) {
    throw new Error(`아카이브 버전 형식이 올바르지 않습니다: ${value}`);
  }

  return matched.slice(1, 4).map(Number).join(".");
}

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

/** 기존 값을 지우지 않아야 하는 빈 값, null, 숫자 0을 걸러낸다. */
function hasMeaningfulArchiveValue(value) {
  if (value === undefined || value === null) return false;

  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  if (typeof value === "string") {
    const normalized = normalizeText(value);

    if (!normalized) return false;
    if (/^[+-]?0+(?:\.0+)?$/.test(normalized)) return false;

    return true;
  }

  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.keys(value).length > 0;

  return true;
}

/** 숫자 필드가 실제로 갱신 가능한 값인지 확인한다. */
function hasFiniteArchiveNumber(value, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") return false;

  const normalized = Number(value);

  return Number.isFinite(normalized) &&
    (allowZero ? normalized >= 0 : normalized > 0);
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
  return { ...createProduct(productId), options: {} };
}

/** 새 옵션의 전체 구조를 생성한다. */
function createEmptyOption(optionId) {
  return {
    id: optionId,
    sku: "",
    barcode: null,
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
  normalized.sourceMall = getProductSourceMall(product);
  normalized.category = normalizeProductCategory(product.category);
  normalized.categoryId = normalizeCategoryId(product.categoryId);
  // 구버전 환산 시각을 이전한다. 제거된 필드는 PRODUCT_FIELDS에 없어 출력되지 않는다.
  normalized.createdAt = normalizeProductTimestamp(product.createdAt)
    || normalizeProductTimestamp(product.convertTime);
  normalized.updatedAt = normalizeProductTimestamp(product.updatedAt);
  normalized.slug = "";
  normalized.options = normalizeOptions(product?.options);
  normalized.imageUrls = normalizeImageUrls(normalized.imageUrls);
  normalized.descriptionImageUrls = normalizeImageUrls(normalized.descriptionImageUrls);

  return applyProductSkus(normalized);
}

/** 이전 products wrapper를 쇼핑몰별 그룹과 구분한다. */
function isLegacyArchiveWrapper(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.hasOwn(value, "products") && value.products !== null &&
    typeof value.products === "object" &&
    Object.keys(value).every((key) => ["products", "version", "updatedAt"].includes(key));
}

/** 최상위에 쇼핑몰별 배열이 있는 저장 형식인지 확인한다. */
function isGroupedArchive(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !isLegacyArchiveWrapper(value) &&
    Object.values(value).some(Array.isArray);
}

/** 구형·쇼핑몰별 JSON을 내부 쇼핑몰+상품 ID 문서 구조로 변환한다. */
function normalizeArchiveDocument(value) {
  if (isLegacyArchiveWrapper(value)) value = value.products;
  const products = Object.create(null);
  const mallNames = new Set(["cheonyu", "ccdome"]);
  const grouped = isGroupedArchive(value);
  let sourceProducts = [];

  if (Array.isArray(value)) {
    sourceProducts = value;
  } else if (grouped) {
    for (const [key, items] of Object.entries(value)) {
      const mall = normalizeText(key).toLowerCase();
      if (!mall || !Array.isArray(items)) {
        throw new Error(`쇼핑몰별 아카이브 형식이 올바르지 않습니다: ${key}`);
      }
      mallNames.add(mall);
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item) ||
            !normalizeText(item.id || item.productId)) {
          throw new Error(`상품 ID가 없는 아카이브 항목입니다: ${mall}`);
        }
        const explicitMall = normalizeText(item.sourceMall).toLowerCase();
        if (explicitMall && explicitMall !== mall) {
          throw new Error(`아카이브 쇼핑몰과 sourceMall이 다릅니다: ${mall}/${item.id || item.productId}`);
        }
        sourceProducts.push({ ...item, sourceMall: mall });
      }
    }
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

    const productKey = getProductArchiveKey(normalized);
    if (grouped && Object.hasOwn(products, productKey)) {
      throw new Error(`아카이브에 중복 상품이 있습니다: ${productKey}`);
    }
    products[productKey] = normalized;
  }

  return { products, mallNames: [...mallNames] };
}

/** 두 릴리즈 버전을 숫자 단위로 비교한다. */
function compareArchiveVersions(left, right) {
  const leftParts = normalizeArchiveVersion(left).split(".").map(Number);
  const rightParts = normalizeArchiveVersion(right).split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  return 0;
}

/** 파일 존재 여부만 확인한다. */
async function archiveFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** 지정한 archive 파일을 현재 릴리즈 스키마로 정규화해 읽는다. */
async function readArchiveFileUnlocked(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const normalizedText = text.replace(/^\uFEFF/, "").trim();

  const value = normalizedText ? JSON.parse(normalizedText) : [];
  const archive = normalizeArchiveDocument(value);
  // 현재 파일의 형식을 바꾸는 경우에만 최초 저장 전 원본을 백업한다.
  archive.needsGroupedMigration = filePath === ARCHIVE_PATH && !isGroupedArchive(value);
  return archive;
}

/** 현재 버전보다 낮은 가장 최신 archive 또는 기존 단일 archive를 찾는다. */
async function findArchiveMigrationSourceUnlocked() {
  let entries = [];

  try {
    entries = await fs.readdir(ARCHIVE_DIRECTORY, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const previousVersions = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      entry,
      matched: entry.name.match(VERSIONED_ARCHIVE_FILE_PATTERN),
    }))
    .filter(({ matched }) =>
      matched && compareArchiveVersions(matched[1], ARCHIVE_VERSION) < 0,
    )
    .map(({ entry, matched }) => ({
      version: normalizeArchiveVersion(matched[1]),
      filePath: path.join(ARCHIVE_DIRECTORY, entry.name),
    }))
    .sort((left, right) =>
      compareArchiveVersions(right.version, left.version),
    );

  if (previousVersions.length > 0) {
    return previousVersions[0];
  }

  if (await archiveFileExists(LEGACY_ARCHIVE_PATH)) {
    return {
      version: "legacy",
      filePath: LEGACY_ARCHIVE_PATH,
    };
  }

  return null;
}

/** 현재 릴리즈 archive가 없으면 직전 archive를 현재 스키마로 이전한다. */
async function ensureVersionArchiveUnlocked() {
  if (await archiveFileExists(ARCHIVE_PATH)) return;

  const migrationSource = await findArchiveMigrationSourceUnlocked();
  const archive = migrationSource
    ? await readArchiveFileUnlocked(migrationSource.filePath)
    : normalizeArchiveDocument([]);

  await writeArchiveUnlocked(archive);

  console.log(
    `[ARCHIVE] v${ARCHIVE_VERSION} 초기화 완료`,
    migrationSource
      ? { migratedFrom: migrationSource.filePath, archivePath: ARCHIVE_PATH }
      : { archivePath: ARCHIVE_PATH },
  );
}

/** 현재 릴리즈 archive를 잠금 없이 읽는다. */
async function readArchiveUnlocked() {
  await ensureVersionArchiveUnlocked();
  return readArchiveFileUnlocked(ARCHIVE_PATH);
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
    return TRANSLATION_FIELDS.has(field) &&
      hasMeaningfulArchiveValue(value);
  }

  if (source === "general") {
    if (!GENERAL_FIELDS.has(field)) return false;

    /** 재고 수량은 0과 null도 최신 재고 상태이므로 그대로 반영한다. */
    if (field === "stockQuantity") return value !== undefined;

    if (field === "lowStockThreshold") {
      return hasFiniteArchiveNumber(value, { allowZero: true });
    }

    /** 잘못 읽은 0/null 가격으로 기존의 정상 가격을 지우지 않는다. */
    if (["originalPrice", "wholesalePrice"].includes(field)) {
      return hasFiniteArchiveNumber(value);
    }

    return hasMeaningfulArchiveValue(value);
  }

  if (source === "detail") {
    if (!DETAIL_FIELDS.has(field)) {
      return false;
    }

    if (["imageUrls", "descriptionImageUrls", "specs"].includes(field)) {
      return hasArrayItems(value);
    }

    // 경로 전체가 미관측이면 기존 카테고리를 보존한다.
    if (field === "category") {
      return Object.values(normalizeProductCategory(value)).some(hasText);
    }

    if (field === "categoryId") return normalizeCategoryId(value) !== null;

    if (["originalPrice", "wholesalePrice", "salePrice"].includes(field)) {
      return hasFiniteArchiveNumber(value);
    }

    if (field === "discountRate") {
      return hasFiniteArchiveNumber(value, { allowZero: true });
    }

    return hasMeaningfulArchiveValue(value);
  }

  return false;
}

/** 번역 결과의 빈 값이 기존 상품명을 지우지 않도록 병합한다. */
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
      changed = setChangedField(
        result,
        "nameKo",
        incomingNameKo,
        stats,
      ) || changed;
    }

    for (const field of ["nameJa", "nameEn"]) {
      const value = normalizeText(incoming[field]);

      if (!value) continue;

      changed = setChangedField(
        result,
        field,
        value,
        stats,
      ) || changed;
    }

    if (hasMeaningfulArchiveValue(incoming.nameJa)) {
      changed = setChangedField(
        result,
        "name",
        normalizeText(incoming.nameJa),
        stats,
      ) || changed;
    }
  } else {
    const allowedFields = source === "general"
      ? [
        "barcode",
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
        "barcode",
      ];

    for (const field of allowedFields) {
      const value = incoming[field];

      if (
        ["name", "nameKo", "nameJa", "nameEn", "status", "barcode"]
          .includes(field) &&
        !hasMeaningfulArchiveValue(value)
      ) {
        continue;
      }

      if (
        field === "additionalPrice" &&
        (
          !hasFiniteArchiveNumber(value, { allowZero: true }) ||
          (
            source === "general" &&
            incomingOption?.additionalPriceObserved !== true
          )
        )
      ) {
        continue;
      }

      if (
        field === "stockQuantity" &&
        (source !== "general" || value === undefined)
      ) {
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
function mergeProduct(
  existingProduct,
  incomingProduct,
  stats,
  source,
  conversion,
  collectedAt,
) {
  const inventoryObserved = incomingProduct?.inventoryObserved === true;
  const inventoryUnavailable =
    incomingProduct?.inventoryUnavailable === true;
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
    // 경로가 바뀌었는데 새 번호를 못 읽었다면 이전 경로의 번호를 연결하지 않는다.
    if (source === "detail" && incoming.categoryId === null &&
        Object.values(incoming.category).some(hasText) &&
        !isSameJson(result.category, incoming.category)) {
      changed = setChangedField(result, "categoryId", null, stats) || changed;
    }

    for (const field of PRODUCT_FIELDS) {
      if (["id", "options"].includes(field)) {
        continue;
      }

      if (
        source === "general" &&
        !inventoryObserved &&
        !inventoryUnavailable &&
        ["type", "stockQuantity", "stockStatus", "saleStatus"].includes(field)
      ) {
        continue;
      }

      if (!canUpdateProductField(source, field, incoming[field])) {
        continue;
      }

      /**
       * 상세 수집에서 확인된 메인·상세 이미지 배열을 최신값으로 반영한다.
       * /thumb/ 중복 URL은 imageUrls에서 제외하고 thumbnailUrl로만 관리한다.
       */
      const value = ["imageUrls", "descriptionImageUrls"].includes(field)
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
    inventoryObserved &&
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
  result.sourceMall = incoming.sourceMall || result.sourceMall;
  result.slug = "";
  result.type = Object.keys(result.options).length > 0
    ? "OPTION"
    : normalizeText(result.type) || "SINGLE";
  applyProductSkus(result);

  for (const [priceField, yenFields] of [
    ["originalPrice", ["yenOriginalsalePrice"]],
    ["wholesalePrice", ["yenWholesalePrice"]],
  ]) {
    // 이번 수집에서 관측한 가격만 환산한다. 일반·상세·번역 병합이
    // 다른 수집 시점의 원화 가격과 환산값을 함께 바꾸지 않도록 한다.
    if (!canUpdateProductField(source, priceField, incoming[priceField])) continue;

    if (conversion) {
      const yen = convertWonToYen(result[priceField], conversion.rate);
      for (const yenField of yenFields) {
        changed = setChangedField(result, yenField, yen, stats) || changed;
      }
    } else if (result[priceField] !== existingProduct?.[priceField]) {
      // 환율 조회 실패 시 변경된 원화 가격에 과거 엔화값을 붙이지 않는다.
      for (const yenField of yenFields) {
        changed = setChangedField(result, yenField, null, stats) || changed;
      }
    }
  }

  // 환율·가격 관측 여부와 무관하게 일반/상세 수집 저장 시각을 기록한다.
  // 번역 캐시 갱신은 수집 시각을 변경하지 않는다.
  if (source === "general" || source === "detail") {
    changed = setChangedField(
      result,
      result.createdAt ? "updatedAt" : "createdAt",
      collectedAt,
      stats,
    ) || changed;
  }

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
  const source = applyProductSkus({
    ...createEmptyProduct(normalizeText(product?.id)),
    ...cloneJson(product),
  });
  const result = {};
  source.category = normalizeProductCategory(source.category);
  source.categoryId = normalizeCategoryId(source.categoryId);

  for (const field of PRODUCT_FIELDS) {
    if (field === "options") {
      result.options = Object.values(source.options || {}).map(
        (option) => materializeOption(option),
      );
      continue;
    }

    result[field] = field === "slug" ? "" : cloneJson(source[field]);
  }

  return result;
}

/** archive 문서를 전체 백엔드 상품 배열로 변환한다. */
function archiveToProductArray(archive, productIds = null) {
  const ids = Array.isArray(productIds)
    ? productIds.map((id) => normalizeText(id)).filter(Boolean)
    : Object.keys(archive?.products || {});

  return ids
    .map((id) => {
      if (archive?.products?.[id]) return archive.products[id];
      const matches = Object.values(archive?.products || {}).filter((item) => item.id === id);
      if (matches.length > 1) throw new Error(`사이트 구분이 필요한 상품 ID입니다: ${id}`);
      return matches[0];
    })
    .filter(Boolean)
    .map((product) => materializeProduct(product));
}

/** 상품 스키마를 유지하면서 저장용 쇼핑몰별 배열을 만든다. */
function archiveToMallGroups(archive) {
  const groups = Object.create(null);
  for (const mall of archive.mallNames || ["cheonyu", "ccdome"]) {
    groups[mall] = [];
  }
  for (const product of archiveToProductArray(archive)) {
    const mall = getProductSourceMall(product);
    if (!mall) {
      throw new Error(`아카이브 상품의 쇼핑몰을 확인할 수 없습니다. sourceMall을 지정하세요: ${product.id}`);
    }
    if (!Object.hasOwn(groups, mall)) groups[mall] = [];
    groups[mall].push(product);
  }
  return groups;
}

/** 현재 릴리즈 archive를 sourceMall을 포함한 쇼핑몰별 배열로 저장한다. */
async function writeArchiveUnlocked(archive) {
  const grouped = archiveToMallGroups(archive);
  await fs.mkdir(ARCHIVE_DIRECTORY, {
    recursive: true,
  });

  const temporaryPath = `${ARCHIVE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath,
      `${JSON.stringify(grouped, null, 2)}\n`, "utf8");
    if (archive.needsGroupedMigration) {
      await fs.copyFile(ARCHIVE_PATH, `${ARCHIVE_PATH}.before-mall-groups.bak`, fs.constants.COPYFILE_EXCL)
        .catch((error) => { if (error.code !== "EEXIST") throw error; });
    }
    await fs.rename(temporaryPath, ARCHIVE_PATH);
    archive.needsGroupedMigration = false;
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") console.warn("[ARCHIVE] 임시 파일 정리 실패", error.message);
    });
  }
}

/** archive 문서를 번역기용 상품 배열로 변환한다. */
function archiveToTranslationItems(archive, sourceMall = "") {
  const products = archiveToProductArray(archive)
    .filter((product) => !sourceMall || product.sourceMall === sourceMall);
  const ids = new Set();
  for (const product of products) {
    if (ids.has(product.id)) throw new Error("번역 대상에 같은 상품 ID가 있습니다. sourceMall을 지정하세요.");
    ids.add(product.id);
  }
  return products.map((product) => ({
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

/** 현재 앱 버전의 통합 archive를 읽는다. */
function readProductArchive() {
  return runWithArchiveLock(() => readArchiveUnlocked());
}

/**
 * 상품 배열을 productId와 optionId 기준으로 통합 archive에 병합한다.
 * 버전별 archive에는 상품 필드를 유지한 쇼핑몰별 배열을 저장한다.
 */
function updateProductArchive(products, {
  source = "general",
  conversion = null,
  collectedAt = new Date().toISOString(),
} = {}) {
  return runWithArchiveLock(async () => {
    if ((source === "general" || source === "detail") &&
        (!collectedAt || normalizeProductTimestamp(collectedAt) !== collectedAt)) {
      throw new TypeError(`Invalid collectedAt: ${collectedAt}`);
    }
    if (conversion) {
      if (!conversion.createdAt ||
          normalizeProductTimestamp(conversion.createdAt) !== conversion.createdAt) {
        throw new TypeError(
          `Invalid conversion createdAt: ${conversion.createdAt}`,
        );
      }

      if (
        !Number.isFinite(Number(conversion.rate)) ||
        Number(conversion.rate) <= 0
      ) {
        throw new TypeError(
          `Invalid won-to-yen rate: ${conversion.rate}`,
        );
      }
    }

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

      const productKey = getProductArchiveKey(product);
      currentProductIds.push(productKey);

      const merged = mergeProduct(
        archive.products[productKey],
        product,
        stats,
        source,
        conversion,
        collectedAt,
      );

      archive.products[productKey] = merged.product;
      changed = merged.changed || changed;

      if (merged.changed) {
        stats.changedProductIds.push(productId);
      }
    }

    /**
     * 이전 배열·wrapper 형식 archive도 한 번의 실행으로
     * 쇼핑몰별 배열 형식으로 변환되도록 항상 저장한다.
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
  ARCHIVE_DIRECTORY,
  ARCHIVE_PATH,
  ARCHIVE_VERSION,
  archiveToProductArray,
  archiveToTranslationItems,
  readProductArchive,
  updateProductArchive,
};

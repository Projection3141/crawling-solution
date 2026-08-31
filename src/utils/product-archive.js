/** src/utils/product-archive.js */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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

const PRODUCT_FIELDS = [
  "id",
  "barcode",
  "hsCode",
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
  "yenPrice",
  "convertTime",
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
  "categoryId",
  "subcategoryId",
  "brandId",
  "originalPrice",
  "salePrice",
  "discountRate",
  "currency",
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
  return {
    id: productId,
    barcode: null,
    hsCode: null,
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
    yenPrice: null,
    convertTime: null,
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

  if (!normalizedText) {
    return normalizeArchiveDocument([]);
  }

  return normalizeArchiveDocument(JSON.parse(normalizedText));
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

    return hasMeaningfulArchiveValue(value);
  }

  if (source === "detail") {
    if (!DETAIL_FIELDS.has(field)) {
      return false;
    }

    if (["imageUrls", "specs"].includes(field)) {
      return hasArrayItems(value);
    }

    if (["originalPrice", "salePrice"].includes(field)) {
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
        !hasFiniteArchiveNumber(value, { allowZero: true })
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

  /**
   * A detail-only first collection has no general archive price yet.
   * Fill that empty value once so yenPrice uses the same originalPrice
   * that is materialized in the result.
   */
  if (
    source === "detail" &&
    result.originalPrice === null &&
    Number.isFinite(Number(incoming.originalPrice)) &&
    Number(incoming.originalPrice) > 0
  ) {
    changed = setChangedField(
      result,
      "originalPrice",
      Number(incoming.originalPrice),
      stats,
    ) || changed;
  }

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
  result.type = Object.keys(result.options).length > 0
    ? "OPTION"
    : normalizeText(result.type) || "SINGLE";

  if (conversion) {
    changed = setChangedField(
      result,
      "yenPrice",
      convertWonToYen(
        result.originalPrice,
        conversion.rate,
      ),
      stats,
    ) || changed;

    changed = setChangedField(
      result,
      "convertTime",
      conversion.convertTime,
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

/** 현재 릴리즈 archive를 상품 객체 배열 형식 그대로 저장한다. */
async function writeArchiveUnlocked(archive) {
  await fs.mkdir(ARCHIVE_DIRECTORY, {
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

/** 현재 앱 버전의 통합 archive를 읽는다. */
function readProductArchive() {
  return runWithArchiveLock(() => readArchiveUnlocked());
}

/**
 * 상품 배열을 productId와 optionId 기준으로 통합 archive에 병합한다.
 * 버전별 archive에는 wrapper 없이 전체 백엔드 상품 객체 배열만 저장한다.
 */
function updateProductArchive(products, {
  source = "general",
  conversion = null,
} = {}) {
  return runWithArchiveLock(async () => {
    if (conversion) {
      if (!/^\d{10}$/.test(normalizeText(conversion.convertTime))) {
        throw new TypeError(
          `Invalid convertTime: ${conversion.convertTime}`,
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

      currentProductIds.push(productId);

      const merged = mergeProduct(
        archive.products[productId],
        product,
        stats,
        source,
        conversion,
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
  ARCHIVE_DIRECTORY,
  ARCHIVE_PATH,
  ARCHIVE_VERSION,
  archiveToProductArray,
  archiveToTranslationItems,
  readProductArchive,
  updateProductArchive,
};

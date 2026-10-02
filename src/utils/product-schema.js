// src/utils/product-schema.js
// 목적: 모든 쇼핑몰에서 공유하는 상품 필드와 사이트 식별·아카이브 키·SKU 생성 규칙을 정의한다.

/** 카테고리 이름은 구분자로 나누지 않고 최대 다섯 단계의 문자열·null로 정리한다. */
function normalizeProductCategory(value) {
  return Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
    const key = `depth${index + 1}`;
    const label = value?.[key];
    return [key, typeof label === "string" ? label.replace(/\s+/g, " ").trim() || null : null];
  }));
}

/** 카테고리 코드는 앞자리 0을 보존하는 문자열로 통일하고 미확인·이름 값은 null로 둔다. */
function normalizeCategoryId(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) && /[1-9]/.test(text) ? text : null;
}

/** 특별 마크 이름은 문자열로 저장하고 미확인·빈 값은 null로 정리한다. */
function normalizeProductSpecial(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || null : null;
}

function createProduct(id = "") {
  return {
    id: String(id),
    badges: [],
    brandId: "",
    category: normalizeProductCategory(),
    categoryId: null,
    special: null,
    createdAt: null,
    currency: "KRW",
    descriptionEn: "",
    descriptionJa: "",
    descriptionKo: "",
    discountRate: null,
    thumbnailUrl: "",
    imageUrls: [],
    descriptionImageUrls: [],
    lowStockThreshold: 10,
    nameEn: "",
    nameJa: "",
    nameKo: "",
    options: [],
    originalPrice: null,
    wholesalePrice: null,
    rating: 0,
    reviewCount: 0,
    salePrice: null,
    saleStatus: "",
    salesCount: 0,
    sku: "",
    slug: "",
    sortOrder: 0,
    specs: [],
    status: "PUBLISHED",
    stockQuantity: null,
    stockStatus: "",
    subcategoryId: null,
    type: "SINGLE",
    updatedAt: null,
    version: 0,
    wholesaleEnabled: false,
    viewCount: 0,
    // 기존 수집기가 제공하던 확장 필드는 철자를 유지한다.
    barcode: null,
    hsCode: null,
    yenWholesalePrice: null,
    yenOriginalsalePrice: null,
    sourceMall: "",
  };
}

const PRODUCT_FIELDS = Object.freeze(Object.keys(createProduct()));

/** 기존 KST YYMMDDHHmm 또는 ISO UTC 시각을 비교 가능한 ISO 형식으로 정규화한다. */
function normalizeProductTimestamp(value) {
  const text = String(value ?? "").trim();
  if (/^\d{10}$/.test(text)) {
    const local = `20${text.slice(0, 2)}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(6, 8)}:${text.slice(8, 10)}:00.000`;
    const date = new Date(`${local}+09:00`);
    if (!Number.isFinite(date.getTime())) return null;
    // Date의 잘못된 날짜 자동 보정(예: 2월 30일)을 허용하지 않는다.
    if (new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString() !== `${local}Z`) return null;
    return date.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.toISOString() === text ? text : null;
}

/** 원본 상품 ID는 유지하고 저장소에서만 사이트와 함께 식별한다. */
function getProductSourceMall(product = {}) {
  const explicit = String(product.sourceMall ||
    String(product.sku || product.slug || "").match(/^(cheonyu|ccdome)[-:]/i)?.[1] || "")
    .trim().toLowerCase();
  if (explicit) return explicit;
  // 기존 아카이브에는 사이트 필드가 없으므로 사용자가 확인한 ID 범위를 적용한다.
  const id = String(product.id ?? product.productId ?? "").trim();
  if (!/^\d+$/.test(id)) return "";
  const number = BigInt(id);
  if (number > 0n && number <= 100000n) return "cheonyu";
  if (number >= 1000000000n) return "ccdome";
  return "";
}

function getProductArchiveKey(product = {}) {
  const id = String(product.id || product.productId || "").trim();
  const mall = getProductSourceMall(product);
  return mall && id ? `${mall}:${id}` : id;
}

/** SKU는 실제 재고 단위에 부여한다. 옵션 ID 미관측 시 임의 SKU를 만들지 않는다. */
function applyProductSkus(product) {
  const mall = getProductSourceMall(product);
  const id = String(product.id ?? "").trim();
  const baseSku = mall && id ? `${mall.toUpperCase()}-${id}` : "";
  const options = Object.values(product.options || {});
  const hasOptions = product.type === "OPTION" || options.length > 0;
  if (options.length > 0) product.type = "OPTION";
  product.sku = hasOptions ? "" : baseSku || product.sku || "";
  for (const option of options) {
    const optionId = String(option.id ?? "").trim();
    option.sku = baseSku && optionId && optionId !== "0" ? `${baseSku}-${optionId}` : "";
  }
  return product;
}

module.exports = { createProduct, PRODUCT_FIELDS, getProductSourceMall, getProductArchiveKey, normalizeProductTimestamp, normalizeProductCategory, normalizeCategoryId, normalizeProductSpecial, applyProductSkus };

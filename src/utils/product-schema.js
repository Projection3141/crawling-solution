/** 모든 쇼핑몰의 수집 결과·아카이브·전송에 사용하는 공통 상품 형식. */
function createProduct(id = "") {
  return {
    id: String(id),
    badges: [],
    brandId: "",
    categoryId: "",
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

module.exports = { createProduct, PRODUCT_FIELDS, getProductSourceMall, getProductArchiveKey, normalizeProductTimestamp };

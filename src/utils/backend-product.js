/** src/utils/backend-product.js */

/** 문자열을 공백이 정리된 값으로 변환한다. */
function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 비어 있지 않은 유효 숫자를 반환한다. */
function toNullableNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

/** 쉼표·통화 문자가 포함된 가격 문자열을 숫자로 변환한다. */
function toPriceNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value)
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);

  if (!normalized) {
    return null;
  }

  const number = Number(normalized[0]);

  return Number.isFinite(number) ? number : null;
}

/** 문자열 또는 배열을 문자열 배열로 변환한다. */
function toTextArray(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => toTextArray(item));
  }

  const text = normalizeText(value);

  return text ? [text] : [];
}

/** 중복과 빈 값을 제거한다. */
function uniqueText(values) {
  return Array.from(
    new Set(
      (values || [])
        .flatMap((value) => toTextArray(value))
        .map((value) => normalizeText(value))
        .filter(Boolean),
    ),
  );
}

/** 실제 원본 이미지가 아닌 /thumb/ 중복 URL인지 확인한다. */
function isThumbnailImageUrl(value) {
  return /\/thumb\//i.test(normalizeText(value));
}

/** imageUrls에 저장할 메인·상세 이미지만 정리한다. */
function uniqueImageUrls(values) {
  return uniqueText(values).filter(
    (url) => !isThumbnailImageUrl(url),
  );
}

/** 배열을 productId 기준 Map으로 변환한다. */
function createFirstItemMap(items = []) {
  const map = new Map();

  for (const item of items) {
    const productId = normalizeText(
      item?.productId || item?.id || item?.productNo,
    );

    if (!productId || map.has(productId)) {
      continue;
    }

    map.set(productId, item);
  }

  return map;
}

/** 재고 row를 productId별로 묶는다. */
function createInventoryMap(items = []) {
  const map = new Map();

  for (const item of items) {
    const productId = normalizeText(item?.productId);

    if (!productId) {
      continue;
    }

    if (!map.has(productId)) {
      map.set(productId, []);
    }

    map.get(productId).push(item);
  }

  return map;
}

/** 번역 결과를 productId 기준 Map으로 변환한다. */
function createTranslationMap(items = []) {
  return new Map(
    (items || [])
      .map((item) => [normalizeText(item?.id), item])
      .filter(([id]) => Boolean(id)),
  );
}

/** 카테고리 경로 문자열에서 마지막 카테고리명만 반환한다. */
function getLastCategory(detailItem = {}, productItem = {}) {
  const category = normalizeText(
    detailItem.categoryDepth3 ||
      detailItem.categoryDepth2 ||
      detailItem.categoryDepth1 ||
      productItem.categoryHint ||
      productItem.categoryCode ||
      "",
  );

  if (!category) {
    return "";
  }

  const parts = category
    .split(/\s*(?:>|›|»|\|)\s*/)
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return parts.at(-1) || category;
}

/** 상세 데이터의 메인 이미지와 상세 이미지를 분리해 정리한다. */
function getProductImages(detailItem, productItem) {

  const detailImagesObject =
    detailItem?.images && typeof detailItem.images === "object"
      ? detailItem.images
      : {};
      

  /**
   * main_img와 mainImageUrls만 대표 이미지 후보로 사용한다.
   * thumbnailImageUrls의 /thumb/ 주소는 imageUrls에 섞지 않는다.
   */
  const mainImages = uniqueImageUrls([
    detailImagesObject.main_img,
    detailItem.mainImageUrls,
    detailItem.thumbnailUrl,
    productItem.mainImageUrls,
    productItem.thumbnailUrl,
    productItem.imageUrl,
  ]);

  const detailImages = uniqueImageUrls([
    detailImagesObject.detail_img,
    detailItem.detailImageUrls,
    detailItem.introImageUrls,
    detailItem.detailImageUrl,
  ]);

  /** 이미 백엔드 상품 형태로 들어온 상세 결과도 그대로 지원한다. */
  const existingImages = uniqueImageUrls([
    detailItem.imageUrls,
    productItem.imageUrls,
  ]);

  const imageUrls = uniqueImageUrls([
    mainImages,
    detailImages,
    existingImages,
  ]);

  return {
    mainImages,
    detailImages,
    imageUrls,
    thumbnailUrl: mainImages[0] || imageUrls[0] || "",
  };
}

/** 상품이 목록 또는 장바구니 기준으로 판매 불가인지 판정한다. */
function isProductUnavailable(productItem = {}, detailItem = {}) {
  const soldOutByState =
    productItem?.isSoldOut === true ||
    detailItem?.isSoldOut === true ||
    productItem?.unavailableInCart === true ||
    detailItem?.unavailableInCart === true ||
    normalizeText(productItem?.saleStatus) === "SOLD_OUT" ||
    normalizeText(detailItem?.saleStatus) === "SOLD_OUT";

  if (soldOutByState) {
    return true;
  }

  if (typeof productItem?.cartAddable === "boolean") {
    return productItem.cartAddable === false;
  }

  const hasCartCapabilityFields =
    typeof productItem?.hasAddButton === "boolean" ||
    typeof productItem?.hasCountInput === "boolean";

  if (hasCartCapabilityFields) {
    return !(
      productItem?.hasAddButton === true &&
      productItem?.hasCountInput === true
    );
  }

  return false;
}

/** 상품 또는 옵션의 판매 상태를 백엔드 코드로 변환한다. */
function getSaleStatus(stockStatus, isUnavailable) {
  if (isUnavailable || stockStatus === "OUT_OF_STOCK") {
    return "SOLD_OUT";
  }

  return "ON_SALE";
}

/** 총재고와 기존 상태를 사용해 상품 재고 상태를 결정한다. */
function getProductStockStatus(
  stockQuantity,
  inventoryRows,
  lowStockThreshold,
  isUnavailable,
) {
  if (isUnavailable) {
    return "OUT_OF_STOCK";
  }

  if (stockQuantity !== null) {
    if (stockQuantity <= 0) {
      return "OUT_OF_STOCK";
    }

    if (stockQuantity <= lowStockThreshold) {
      return "LOW_STOCK";
    }

    return "IN_STOCK";
  }

  const statuses = new Set(
    inventoryRows
      .map((item) => normalizeText(item?.stockStatus))
      .filter(Boolean),
  );

  if (statuses.has("IN_STOCK") || statuses.has("LIMITED")) {
    return "IN_STOCK";
  }

  if (statuses.has("LOW_STOCK")) {
    return "LOW_STOCK";
  }

  if (statuses.has("OUT_OF_STOCK")) {
    return "OUT_OF_STOCK";
  }

  return "";
}

/** JSON 문자열 또는 객체를 일반 객체로 변환한다. */
function parseObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/** 상세 specRows/rawDetailInfo에서 지정한 항목 값을 찾는다. */
function findDetailSpecValue(detailItem = {}, keywords = []) {
  /**
   * 상세 결과에 따라 specRows 또는 최종 specs 배열로 들어올 수 있으므로
   * 두 배열을 모두 검색한다.
   */
  const rows = [
    ...(Array.isArray(detailItem?.specRows)
      ? detailItem.specRows
      : []),
    ...(Array.isArray(detailItem?.specs)
      ? detailItem.specs
      : []),
  ];

  for (const keyword of keywords) {
    const row = rows.find((item) =>
      normalizeText(item?.labelKo || item?.label || item?.key).includes(keyword),
    );

    const value = normalizeText(
      row?.valueKo || row?.value,
    );

    if (value) {
      return value;
    }
  }

  const raw = {
    ...parseObject(detailItem?.rawDetailInfo),
    ...parseObject(detailItem?.rawDetailSpec),
  };

  for (const keyword of keywords) {
    const entry = Object.entries(raw).find(([label]) =>
      normalizeText(label).includes(keyword),
    );

    const value = normalizeText(entry?.[1]);

    if (value) {
      return value;
    }
  }

  return "";
}

/** 과자생각에서 별도 상품 필드로 옮길 상세 항목인지 확인한다. */
function isCcdomeProductFieldSpec(label) {
  const normalizedLabel = normalizeText(label);

  return (
    normalizedLabel.includes("판매가") ||
    normalizedLabel.includes("총 합계금액") ||
    normalizedLabel.includes("브랜드")
  );
}

/** 스펙 row 배열을 백엔드 specs 형식으로 정규화한다. */
function normalizeSpecRows(rows = []) {
  const result = [];
  const seen = new Set();

  for (const row of rows) {
    const labelKo = normalizeText(
      row?.labelKo || row?.label || row?.key,
    );
    const valueKo = normalizeText(
      row?.valueKo || row?.value,
    );

    if (
      !labelKo ||
      !valueKo ||
      seen.has(labelKo) ||
      isCcdomeProductFieldSpec(labelKo)
    ) {
      continue;
    }

    seen.add(labelKo);

    result.push({
      labelKo,
      labelJa: normalizeText(row?.labelJa) || labelKo,
      valueKo,
      valueJa: normalizeText(row?.valueJa) || valueKo,
      sortOrder:
        toNullableNumber(row?.sortOrder) ?? result.length * 10,
    });
  }

  return result;
}

function createCheonyuSpecs(detailItem = {}) {
  const spec = {
    material: normalizeText(detailItem.material) || null,
    packagingSize: normalizeText(detailItem.packageSize) || null,
    weight: normalizeText(detailItem.weight) || null,
    countryofOrigin: normalizeText(detailItem.origin) || null,
  };

  return Object.values(spec).some(Boolean) ? [spec] : [];
}

/** 상세 수집에서 확보한 모든 명세를 백엔드 specs 배열로 변환한다. */
function createSpecs(detailItem = {}) {
  if (detailItem.sourceMall === "cheonyu") {
    return createCheonyuSpecs(detailItem);
  }

  if (Array.isArray(detailItem?.specRows)) {
    const specRows = normalizeSpecRows(detailItem.specRows);

    if (specRows.length > 0) {
      return specRows;
    }
  }

  const rawSpecs = {
    ...parseObject(detailItem?.rawDetailInfo),
    ...parseObject(detailItem?.rawDetailSpec),
  };

  const rawSpecRows = normalizeSpecRows(
    Object.entries(rawSpecs).map(([label, value]) => ({
      label,
      value,
    })),
  );

  if (rawSpecRows.length > 0) {
    return rawSpecRows;
  }

  return normalizeSpecRows([
    { label: "원산지", value: detailItem.origin },
    { label: "제조사", value: detailItem.manufacturer },
    { label: "소재", value: detailItem.material },
    { label: "포장 사이즈", value: detailItem.packageSize },
    { label: "무게", value: detailItem.weight },
    { label: "인증", value: detailItem.certification },
    { label: "사용 대상 연령", value: detailItem.targetAge },
    { label: "품질보증기준", value: detailItem.warranty },
  ]);
}

/** 옵션별 번역 Map을 생성한다. */
function createOptionTranslationMap(translationItem = {}) {
  return new Map(
    (Array.isArray(translationItem.options)
      ? translationItem.options
      : []
    )
      .map((option) => [normalizeText(option?.id), option])
      .filter(([id]) => Boolean(id)),
  );
}

/** 옵션 row를 백엔드 options 배열로 변환한다. */
function createBackendOptions(
  inventoryRows,
  translationItem,
  collectionMode,
  productUnavailable,
) {
  const translationMap = createOptionTranslationMap(
    translationItem,
  );
  const optionMap = new Map();

  for (let index = 0; index < inventoryRows.length; index += 1) {
    const row = inventoryRows[index];

    if (row?.hasOption !== true) {
      continue;
    }

    const rawOptionId = normalizeText(row?.optionId);
    const optionId = rawOptionId === "0" ? "" : rawOptionId;
    const optionText = normalizeText(row?.optionText);
    const internalKey = optionId || `missing:${optionText}:${index}`;

    if (optionMap.has(internalKey)) {
      continue;
    }

    const translation = translationMap.get(rawOptionId);
    const nameJa = normalizeText(translation?.ja);
    const nameEn =
      collectionMode === "general"
        ? normalizeText(translation?.en)
        : "";
    const stockQuantity = toNullableNumber(row?.maxStock);
    const stockStatus = normalizeText(row?.stockStatus);

    optionMap.set(internalKey, {
      id: optionId,
      barcode: normalizeText(row?.barcode) || null,

      /** 기존 백엔드 name 필드는 일본어 옵션명을 사용한다. */
      name: nameJa,

      /** 일반 수집의 영문 옵션명 전달을 위해 지역화 필드를 함께 둔다. */
      nameKo: optionText,
      nameJa,
      nameEn,

      additionalPrice:
        toNullableNumber(row?.addPrice) ?? 0,
      stockQuantity,
      status: getSaleStatus(
        stockStatus,
        productUnavailable || Boolean(row?.isSoldOut),
      ),
    });
  }

  return Array.from(optionMap.values());
}

/** 상품의 원본 가격 하나만 반환한다. */
function getOriginalPrice(
  collectionMode,
  inventoryRows,
  productItem,
  detailItem,
) {
  const firstInventoryPrice = inventoryRows
    .map((item) => toNullableNumber(item?.onePrice))
    .find((value) => value !== null && value > 0);

  const detailSalePrice = findDetailSpecValue(
    detailItem,
    ["총 상품금액", "상품금액", "판매가", "총 합계금액"],
  );
  const candidates =
    collectionMode === "detail"
      ? [
          detailItem.originalPrice,
          detailItem.salePrice,
          detailSalePrice,
          detailItem.consumerPrice,
          firstInventoryPrice,
          productItem.price,
        ]
      : [
          firstInventoryPrice,
          productItem.price,
          detailItem.originalPrice,
          detailItem.salePrice,
          detailSalePrice,
          detailItem.consumerPrice,
        ];

  for (const candidate of candidates) {
    const number = toPriceNumber(candidate);

    if (number !== null && number > 0) {
      return number;
    }
  }

  return null;
}

/** 옵션 또는 단일 상품의 총재고를 계산한다. */
function getTotalStock(type, options, inventoryRows) {
  if (type === "OPTION") {
    const values = options
      .map((option) => option.stockQuantity)
      .filter((value) => value !== null);

    if (values.length < 1) {
      return null;
    }

    return values.reduce((sum, value) => sum + value, 0);
  }

  const value = inventoryRows
    .map((item) => toNullableNumber(item?.maxStock))
    .find((item) => item !== null);

  return value ?? null;
}

/**
 * 일반/상세 수집 데이터를 백엔드 상품 데이터 타입으로 변환한다.
 *
 * 상세 수집:
 * - 상품명은 영문만 사용하고 nameJa는 비운다.
 * - 옵션은 일본어만 사용하고 nameEn은 비운다.
 *
 * 일반 수집:
 * - 상품명과 옵션에 일본어·영어를 모두 포함한다.
 */
async function createBackendProducts({
  collectionMode,
  products = [],
  inventoryItems = [],
  detailItems = [],
  translatedItems = [],
  lowStockThreshold = 10,
}) {
  const isDetail = collectionMode === "detail";
  const productMap = createFirstItemMap(products);

  // ---2차 검수 완---

  const detailMap = createFirstItemMap(detailItems);
  const inventoryMap = createInventoryMap(inventoryItems);
  const translationMap = createTranslationMap(translatedItems);
  const ids = [];
  const seenIds = new Set();

/**
 * 상세 수집은 실제 detailItems에 존재하는 상품만 변환한다.
 * inventoryItems 전체를 합치면 상세 수집되지 않은 상품까지 detailItem={}
 * 상태로 생성되어 이미지·설명·스펙이 빈 상품이 만들어진다.
 */
const baseItems = isDetail ? detailItems : products;

for (const item of baseItems) {
  const productId = normalizeText(
    item?.productId || item?.id || item?.productNo,
  );

  if (!productId || seenIds.has(productId)) {
    continue;
  }

  seenIds.add(productId);
  ids.push(productId);
}

/**
 * 일반 수집에서만 목록 누락 재고 상품을 보존한다.
 * 상세 수집에서는 상세 결과가 없는 재고 상품을 추가하지 않는다.
 */
if (!isDetail) {
  for (const productId of inventoryMap.keys()) {
    if (seenIds.has(productId)) {
      continue;
    }

    seenIds.add(productId);
    ids.push(productId);
  }
}
  return ids.map((productId) => {
    const inventoryRows = inventoryMap.get(productId) || [];
    const productItem =
      productMap.get(productId) ||
      inventoryRows[0] ||
      {};
    const detailItem = detailMap.get(productId) || {};
    const translationItem = translationMap.get(productId) || {};
    const productUnavailable = isProductUnavailable(
      productItem,
      detailItem,
    );
    const hasOption = inventoryRows.some(
      (item) => item?.hasOption === true,
    );
    const type = hasOption ? "OPTION" : "SINGLE";
    const options = hasOption
      ? createBackendOptions(
          inventoryRows,
          translationItem,
          collectionMode,
          productUnavailable,
        )
      : [];
    const stockQuantity = getTotalStock(
      type,
      options,
      inventoryRows,
    );
    const stockStatus = getProductStockStatus(
      stockQuantity,
      inventoryRows,
      lowStockThreshold,
      productUnavailable,
    );


    const images = getProductImages(
      detailItem,
      productItem,
    );
    const nameKo = normalizeText(
      translationItem?.nameKo ||
        detailItem?.normalizedName ||
        detailItem?.productName ||
        productItem?.normalizedName ||
        productItem?.productName,
    );
    const nameEn = normalizeText(
      translationItem?.nameEn,
    );
    const nameJa = normalizeText(
      translationItem?.nameJa,
    );

    return {
      id: productId,
      barcode: normalizeText(detailItem?.barcode) || null,
      hsCode: null,
      sku: "",
      slug: "",
      type,
      nameKo,
      nameJa,
      nameEn,
      categoryId: getLastCategory(
        detailItem,
        productItem,
      ),
      subcategoryId: null,

      /** 상세 수집에서 확보한 brandHint 값을 백엔드 brandId로 전달한다. */
      brandId: normalizeText(
        detailItem?.brandId ||
          detailItem?.brandHint ||
          findDetailSpecValue(detailItem, ["브랜드"]) ||
          productItem?.brandHint ||
          detailItem?.brandCode,
      ),

      originalPrice: getOriginalPrice(
        collectionMode,
        inventoryRows,
        productItem,
        detailItem,
      ),
      salePrice: null,
      discountRate: null,
      currency: "KRW",
      saleStatus: getSaleStatus(
        stockStatus,
        productUnavailable,
      ),
      stockQuantity : stockQuantity,
      lowStockThreshold,
      stockStatus,
      badges: [],
      imageUrls: images.imageUrls,
      thumbnailUrl: images.thumbnailUrl,
      options,
      wholesaleEnabled: false,
      descriptionKo: "",
      descriptionJa: "",
      specs: createSpecs(detailItem),
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
  });
}

module.exports = {
  createBackendProducts,
};
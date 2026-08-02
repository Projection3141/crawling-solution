// src/utils/inventory.js

const { normalizeWhitespace } = require("./common");

const KNOWN_BRANDS = [
  "크라운볼펜",
  "뷰티박스",
  "스케이터",
  "Brunch Brother",
  "산리오",
  "헬로키티",
  "시나모롤",
  "쿠로미",
  "마이멜로디",
  "포차코",
  "한교동",
  "짱구",
  "카카오프렌즈",
  "포켓몬",
  "피카츄",
  "스누피",
  "톰보",
  "무민",
  "에스더버니",
  "리락쿠마",
  "코리락쿠마",
  "주토피아",
  "스파이더맨",
  "커비",
  "위시캣",
  "캐치티니핑",
  "헬로카봇",
  "신비아파트",
];

const CATEGORY_RULES = [
  {
    category: "문구/필기구",
    keywords: [
      "볼펜",
      "샤프",
      "샤프심",
      "연필",
      "지우개",
      "노트",
      "메모",
      "바인더",
      "화이트보드",
      "필기구",
    ],
  },
  {
    category: "캐릭터/완구/취미",
    keywords: [
      "스퀴시",
      "말랑이",
      "피규어",
      "토이",
      "장난감",
      "게임",
      "랜덤",
      "가챠",
      "워터볼",
      "스티커북",
      "미로놀이",
    ],
  },
  {
    category: "패션잡화/파우치",
    keywords: ["파우치", "지갑", "가방", "키링", "가방고리", "조리개", "런치백"],
  },
  {
    category: "수납/정리",
    keywords: ["바스켓", "수납", "정리", "보관함", "박스", "케이스", "홀더"],
  },
  {
    category: "주방/도시락/식기",
    keywords: [
      "도시락",
      "텀블러",
      "컵",
      "식판",
      "밥그릇",
      "볼",
      "스푼",
      "젓가락",
      "찜기",
      "음료 홀더",
      "푸드용기",
    ],
  },
  {
    category: "도서/학습",
    keywords: ["백과", "도감", "수수께끼", "속담", "한자", "색칠놀이", "포스터북", "POSTER BOOK"],
  },
  {
    category: "생활/리빙",
    keywords: ["계산기", "거울", "샤워 가운", "홀더", "케이스"],
  },
];

/** 상품명의 공백과 링크용 접미사를 정리한다. */
function normalizeProductName(name) {
  return normalizeWhitespace(name).replace(/\s*바로가기\s*$/g, "").trim();
}

/** 대괄호 표기 또는 브랜드 사전으로 브랜드를 추정한다. */
function inferBrand(productName) {
  const name = normalizeProductName(productName);
  const bracketMatch = name.match(/^\[([^\]]+)\]/);

  if (bracketMatch) return bracketMatch[1].trim();

  for (const brand of KNOWN_BRANDS) {
    if (name.includes(brand)) return brand;
  }

  return "";
}

/** 키워드 규칙으로 추천 카테고리를 추정한다. */
function inferCategory(productName) {
  const name = normalizeProductName(productName).toLowerCase();

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => name.includes(keyword.toLowerCase()))) {
      return rule.category;
    }
  }

  return "미분류";
}

/** 상품명에서 세트·타·입수 정보를 추정한다. */
function parsePackageInfo(productName) {
  const name = normalizeProductName(productName);
  const match = name.match(/(\d+)\s*개\s*(?:1\s*)?(세트|타|입|P)?/i);

  if (!match) {
    return {
      packageQty: 1,
      packageUnit: "",
      packageText: "",
    };
  }

  return {
    packageQty: Number(match[1]),
    packageUnit: match[2] || "개",
    packageText: match[0],
  };
}

/** 옵션 row의 재고 상태를 표준 코드로 변환한다. */
function normalizeStockStatus({ maxStock, stockLimited, lowStockThreshold }) {
  if (maxStock <= 0) return "OUT_OF_STOCK";
  if (maxStock <= lowStockThreshold) return "LOW_STOCK";
  if (stockLimited) return "LIMITED";
  return "IN_STOCK";
}

/** 박스 가격이 존재하면 우선하고, 없으면 낱개 가격을 사용한다. */
function normalizeEffectivePrice(onePrice, boxPrice) {
  return boxPrice > 0 ? boxPrice : onePrice;
}

/** 옵션 row를 카테고리·브랜드·상품명·옵션명 순으로 정렬한다. */
function sortInventoryItems(items) {
  return [...items].sort(compareItems);
}

/** 천유 옵션 row를 상품 ID별 요약 데이터로 집계한다. */
function buildProductSummaries(optionItems) {
  const groups = new Map();

  for (const item of optionItems) {
    if (!item.productId) continue;

    if (!groups.has(item.productId)) {
      groups.set(item.productId, {
        sourceMall: item.sourceMall,
        categoryCode: item.categoryCode,
        productId: item.productId,
        productUrl: item.productUrl,
        productName: item.productName,
        brandHint: item.brandHint,
        categoryHint: item.categoryHint,
        packageQty: item.packageQty,
        packageUnit: item.packageUnit,
        packageText: item.packageText,
        optionCount: 0,
        totalStock: 0,
        minStock: null,
        maxStock: null,
        requestedQtyTotal: 0,
        priceMin: null,
        priceMax: null,
        hasOptions: false,
        hasBoxDiscount: false,
        limitedRowCount: 0,
        lowStockRowCount: 0,
        outOfStockRowCount: 0,
        rowCount: 0,
        isSoldOut: false,
        optionNames: [],
      });
    }

    const group = groups.get(item.productId);

    group.rowCount += 1;
    group.optionCount += item.hasOption ? 1 : 0;
    group.hasOptions ||= item.hasOption;
    group.hasBoxDiscount ||= item.hasBoxDiscount;
    group.totalStock += Number(item.maxStock) || 0;
    group.requestedQtyTotal += Number(item.requestedQty) || 0;
    group.minStock =
      group.minStock == null ? item.maxStock : Math.min(group.minStock, item.maxStock);
    group.maxStock =
      group.maxStock == null ? item.maxStock : Math.max(group.maxStock, item.maxStock);
    group.priceMin =
      group.priceMin == null ? item.effectivePrice : Math.min(group.priceMin, item.effectivePrice);
    group.priceMax =
      group.priceMax == null ? item.effectivePrice : Math.max(group.priceMax, item.effectivePrice);

    if (item.stockLimited) group.limitedRowCount += 1;
    if (item.stockStatus === "LOW_STOCK") group.lowStockRowCount += 1;
    if (item.stockStatus === "OUT_OF_STOCK") group.outOfStockRowCount += 1;
    if (item.optionText) group.optionNames.push(item.optionText);
  }

  return Array.from(groups.values())
    .map((group) => {
      let stockStatus = "IN_STOCK";

      if (group.outOfStockRowCount === group.rowCount) {
        stockStatus = "OUT_OF_STOCK";
      } else if (group.lowStockRowCount > 0) {
        stockStatus = "LOW_STOCK";
      } else if (group.limitedRowCount > 0) {
        stockStatus = "LIMITED";
      }

      return {
        ...group,
        stockStatus,
        isSoldOut: stockStatus === "OUT_OF_STOCK",
        optionNames: Array.from(new Set(group.optionNames)).join(" / "),
      };
    })
    .sort(compareItems);
}

/** 품절 여부만 확인 가능한 목록 상품을 재고 CSV row로 변환한다. */
function buildAvailabilityInventory(products) {
  return products.map((product) => ({
    sourceMall: product.sourceMall,
    categoryCode: product.categoryCode,
    productId: product.productId,
    productName: product.productName,
    brandHint: product.brandHint || inferBrand(product.productName),
    categoryHint: product.categoryHint || inferCategory(product.productName),
    optionText: "",
    hasOption: false,
    requestedQty: "",
    maxStock: "",
    stockStatus: product.isSoldOut ? "OUT_OF_STOCK" : "IN_STOCK",
    stockLimited: false,
    onePrice: product.price || 0,
    boxPrice: 0,
    effectivePrice: product.price || 0,
    hasBoxDiscount: false,
    packageQty: product.packageQty || 1,
    packageUnit: product.packageUnit || "",
    packageText: product.packageText || "",
    isSoldOut: product.isSoldOut,
    msg: product.soldOutText || "",
    productUrl: product.productUrl,
  }));
}

/** 품절 여부만 확인 가능한 상품을 상품 요약 CSV row로 변환한다. */
function buildAvailabilitySummaries(products) {
  return products
    .map((product) => ({
      sourceMall: product.sourceMall,
      categoryCode: product.categoryCode,
      productId: product.productId,
      productName: product.productName,
      brandHint: product.brandHint || inferBrand(product.productName),
      categoryHint: product.categoryHint || inferCategory(product.productName),
      stockStatus: product.isSoldOut ? "OUT_OF_STOCK" : "IN_STOCK",
      totalStock: "",
      minStock: "",
      maxStock: "",
      rowCount: 1,
      optionCount: 0,
      hasOptions: false,
      limitedRowCount: 0,
      lowStockRowCount: 0,
      outOfStockRowCount: product.isSoldOut ? 1 : 0,
      priceMin: product.price || 0,
      priceMax: product.price || 0,
      hasBoxDiscount: false,
      packageQty: product.packageQty || 1,
      packageUnit: product.packageUnit || "",
      packageText: product.packageText || "",
      isSoldOut: product.isSoldOut,
      optionNames: "",
      productUrl: product.productUrl,
    }))
    .sort(compareItems);
}

/** 공통 재고·상품 정렬 기준이다. */
function compareItems(a, b) {
  return (
    String(a.categoryHint || "").localeCompare(String(b.categoryHint || ""), "ko") ||
    String(a.brandHint || "").localeCompare(String(b.brandHint || ""), "ko") ||
    String(a.productName || "").localeCompare(String(b.productName || ""), "ko") ||
    String(a.optionText || "").localeCompare(String(b.optionText || ""), "ko") ||
    String(a.productId || "").localeCompare(String(b.productId || ""), "ko", { numeric: true })
  );
}

module.exports = {
  buildAvailabilityInventory,
  buildAvailabilitySummaries,
  buildProductSummaries,
  inferBrand,
  inferCategory,
  normalizeEffectivePrice,
  normalizeProductName,
  normalizeStockStatus,
  parsePackageInfo,
  sortInventoryItems,
};

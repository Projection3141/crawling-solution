// src/config.js

const path = require("node:path");
const {
  hasValue,
  toBoolean,
  toInteger,
} = require("./utils/common");

const MALLS = Object.freeze({
  cheonyu: {
    key: "cheonyu",
    label: "천유닷컴",
    baseUrl: "https://www.cheonyu.com",
    defaultCategory: "-1",
    categoryLabel: "카테고리 IDX",
    categoryPlaceholder: "-1 또는 천유 상품 목록 URL",
    defaultPageSize: 150,
  },

  ccdome: {
    key: "ccdome",
    label: "과자생각",
    baseUrl: "https://www.ccdome.co.kr",
    defaultCategory: "017",
    categoryLabel: "카테고리 코드",
    categoryPlaceholder: "017 또는 과자생각 상품 목록 URL",
    defaultPageSize: 40,
  },
});

function pickValue(input, inputKey, env, envKey, fallback) {
  if (hasValue(input?.[inputKey])) return input[inputKey];
  if (hasValue(env?.[envKey])) return env[envKey];
  return fallback;
}

function pickBoolean(input, inputKey, env, envKey, fallback) {
  const inputValue = input?.[inputKey];

  if (typeof inputValue === "boolean") return inputValue;
  if (hasValue(inputValue)) return toBoolean(inputValue, fallback);
  if (hasValue(env?.[envKey])) return toBoolean(env[envKey], fallback);

  return fallback;
}

function pickInteger(input, inputKey, env, envKey, fallback, min) {
  const raw = pickValue(input, inputKey, env, envKey, fallback);
  return toInteger(raw, fallback, min);
}

/** 쇼핑몰별 전용 카테고리 환경변수를 우선 읽는다. */
function pickMallSpecificCategory(env, mall) {
  if (mall === "cheonyu") {
    return (
      env.CHEONYU_CATEGORY ||
      env.CHEONYU_CATEGORY_CODE ||
      env.CHEONYU_CATE_IDX ||
      ""
    );
  }

  if (mall === "ccdome") {
    return (
      env.CCDOME_CATEGORY ||
      env.CCDOME_CATEGORY_CODE ||
      env.CCDOME_CATE_CD ||
      ""
    );
  }

  return "";
}

/**
 * 카테고리 값 결정.
 *
 * 우선순위:
 * 1. UI에서 직접 입력한 category
 * 2. 쇼핑몰 전용 env
 * 3. 공통 CATEGORY는 env.MALL과 현재 mall이 같을 때만 사용
 * 4. 쇼핑몰 기본값
 */
function resolveCategoryValue(input, env, mall, mallInfo) {
  if (hasValue(input?.category)) {
    return input.category;
  }

  const mallSpecificCategory = pickMallSpecificCategory(env, mall);

  if (hasValue(mallSpecificCategory)) {
    return mallSpecificCategory;
  }

  const envMall = String(env?.MALL || "").trim().toLowerCase();

  if ((!envMall || envMall === mall) && hasValue(env?.CATEGORY)) {
    return env.CATEGORY;
  }

  return mallInfo.defaultCategory;
}

function normalizeCategory(value, mall) {
  const raw = String(value ?? "").trim();

  if (!raw) return MALLS[mall].defaultCategory;

  try {
    const url = new URL(raw);

    if (mall === "cheonyu") {
      return url.searchParams.get("cateIDX") || MALLS[mall].defaultCategory;
    }

    if (mall === "ccdome") {
      return url.searchParams.get("cateCd") || MALLS[mall].defaultCategory;
    }
  } catch {
    /** 일반 카테고리 코드면 원문을 그대로 사용한다. */
  }

  return raw;
}

function resolveOutputDir(
  input = {},
  env = process.env,
  defaultOutputDir = path.resolve(process.cwd(), "out"),
) {
  if (hasValue(input.outDir)) return path.resolve(String(input.outDir));

  if (hasValue(env.OUT_DIR)) {
    const envPath = String(env.OUT_DIR).trim();
    return path.isAbsolute(envPath)
      ? path.normalize(envPath)
      : path.resolve(defaultOutputDir, envPath);
  }

  return path.resolve(defaultOutputDir);
}

function resolveRunConfig(
  input = {},
  env = process.env,
  defaultOutputDir = path.resolve(process.cwd(), "out"),
) {
  const mall = String(pickValue(input, "mall", env, "MALL", "cheonyu"))
    .trim()
    .toLowerCase();

  if (!MALLS[mall]) throw new Error(`지원하지 않는 쇼핑몰입니다: ${mall}`);

  const mallInfo = MALLS[mall];
  const category = normalizeCategory(
    resolveCategoryValue(input, env, mall, mallInfo),
    mall,
  );

  const accountId = String(pickValue(input, "accountId", env, "ACCOUNT_ID", "")).trim();
  const accountPw = String(pickValue(input, "accountPw", env, "ACCOUNT_PW", ""));
  const showBrowser = pickBoolean(input, "showBrowser", env, "SHOW_BROWSER", false);
  const pageStart = pickInteger(input, "pageStart", env, "PAGE_START", 1, 1);
  const pageEnd = pickInteger(input, "pageEnd", env, "PAGE_END", 0, 0);
  const rawPageSize = pickInteger(
    input,
    "pageSize",
    env,
    "PAGE_SIZE",
    mallInfo.defaultPageSize,
    1,
  );
  const pageSize =
    mall === "ccdome"
      ? Math.min(rawPageSize, 40)
      : rawPageSize;

  const collectionMode = String(
    pickValue(input, "collectionMode", env, "COLLECTION_MODE", "general"),
  )
    .trim()
    .toLowerCase();

  if (!["general", "detail"].includes(collectionMode)) {
    throw new Error(`지원하지 않는 수집 방식입니다: ${collectionMode}`);
  }

  if (!accountId || !accountPw) {
    throw new Error(
      "계정 정보가 없습니다. 화면에서 계정을 선택하거나 " +
      "ACCOUNT_ID / ACCOUNT_PW를 공통 .env에 설정하세요.",
    );
  }

  if (pageEnd > 0 && pageEnd < pageStart) {
    throw new Error(`PAGE_END(${pageEnd})는 PAGE_START(${pageStart})보다 작을 수 없습니다.`);
  }

  const maxSafePages = pickInteger(input, "maxSafePages", env, "MAX_SAFE_PAGES", 1000, 1);

  if (pageEnd > maxSafePages) {
    throw new Error(`PAGE_END(${pageEnd})가 MAX_SAFE_PAGES(${maxSafePages})를 초과했습니다.`);
  }

  return {
    mall,
    mallLabel: mallInfo.label,
    baseUrl: mallInfo.baseUrl,
    category,
    accountId,
    accountPw,
    accountName: String(input.accountName || ""),
    collectionMode,
    showBrowser,
    headless: !showBrowser,
    pageStart,
    pageEnd,
    pageSize,

    maxPerPage: pickInteger(input, "maxPerPage", env, "MAX_PER_PAGE", pageSize, 1),
    cartQty: pickInteger(input, "cartQty", env, "CART_QTY", 999, 1),
    optionCartQty: pickInteger(input, "optionCartQty", env, "OPTION_CART_QTY", 1, 1),

    clearCartBefore: pickBoolean(input, "clearCartBefore", env, "CLEAR_CART_BEFORE", true),
    clearCartAfter: pickBoolean(input, "clearCartAfter", env, "CLEAR_CART_AFTER", false),
    lowStockThreshold: pickInteger(input, "lowStockThreshold", env, "LOW_STOCK_THRESHOLD", 10, 0),
    requestDelayMs: pickInteger(input, "requestDelayMs", env, "REQUEST_DELAY_MS", 300, 0),
    detailRequestDelayMs: pickInteger(
      input,
      "detailRequestDelayMs",
      env,
      "DETAIL_REQUEST_DELAY_MS",
      300,
      0,
    ),
    detailMaxProducts: pickInteger(input, "detailMaxProducts", env, "DETAIL_MAX_PRODUCTS", 0, 0),
    maxSafePages,
    navigationTimeoutMs: pickInteger(
      input,
      "navigationTimeoutMs",
      env,
      "NAVIGATION_TIMEOUT_MS",
      60000,
      1000,
    ),

    viewport: { width: 1440, height: 1000 },
    userAgent: hasValue(env.USER_AGENT) ? String(env.USER_AGENT) : undefined,
    baseOutDir: resolveOutputDir(input, env, defaultOutputDir),
  };
}

function toSafeConfig(config) {
  return {
    mall: config.mall,
    mallLabel: config.mallLabel,
    baseUrl: config.baseUrl,
    category: config.category,
    collectionMode: config.collectionMode,
    accountName: config.accountName || "",
    showBrowser: config.showBrowser,
    pageStart: config.pageStart,
    pageEnd: config.pageEnd,
    pageSize: config.pageSize,
    maxPerPage: config.maxPerPage,
    cartQty: config.cartQty,
    optionCartQty: config.optionCartQty,
    clearCartBefore: config.clearCartBefore,
    clearCartAfter: config.clearCartAfter,
    lowStockThreshold: config.lowStockThreshold,
    requestDelayMs: config.requestDelayMs,
    detailRequestDelayMs: config.detailRequestDelayMs,
    detailMaxProducts: config.detailMaxProducts,
    maxSafePages: config.maxSafePages,
    navigationTimeoutMs: config.navigationTimeoutMs,
  };
}

function getPublicDefaults(env = process.env, outputDirectory = "") {
  const envMall = String(env.MALL || "cheonyu").trim().toLowerCase();
  const mall = MALLS[envMall] ? envMall : "cheonyu";

  return {
    malls: Object.values(MALLS).map((item) => ({
      key: item.key,
      label: item.label,
      baseUrl: item.baseUrl,
      defaultCategory: item.defaultCategory,
      categoryLabel: item.categoryLabel,
      categoryPlaceholder: item.categoryPlaceholder,
      defaultPageSize: item.defaultPageSize,
    })),

    envDefaults: {
      mall,
      category: hasValue(env.CATEGORY)
        ? normalizeCategory(env.CATEGORY, mall)
        : MALLS[mall].defaultCategory,
      collectionMode: hasValue(env.COLLECTION_MODE)
        ? String(env.COLLECTION_MODE).trim().toLowerCase()
        : "general",
      showBrowser: toBoolean(env.SHOW_BROWSER, false),
      pageStart: toInteger(env.PAGE_START, 1, 1),
      pageEnd: toInteger(env.PAGE_END, 0, 0),
      pageSize: MALLS[mall].defaultPageSize,
      hasAccountId: hasValue(env.ACCOUNT_ID),
      hasAccountPw: hasValue(env.ACCOUNT_PW),
    },

    outputDirectory,
  };
}

function resolveServerConfig(env = process.env) {
  return {
    host: String(env.HOST || "127.0.0.1"),
    port: toInteger(env.PORT, 5173, 1),
  };
}

module.exports = {
  MALLS,
  getPublicDefaults,
  normalizeCategory,
  resolveOutputDir,
  resolveRunConfig,
  resolveServerConfig,
  toSafeConfig,
};

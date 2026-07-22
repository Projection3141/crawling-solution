const path = require("node:path");
const {
  hasValue,
  toBoolean,
  toInteger,
} = require("./utils/common");

/**
 * 지원 쇼핑몰 메타데이터다.
 *
 * 계정·페이지·브라우저 설정은 공통 키를 사용하고,
 * 쇼핑몰마다 달라지는 주소와 전체 카테고리 기본값만 관리한다.
 */
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

/** 사용자 입력이 있으면 우선하고, 없으면 환경변수와 기본값을 사용한다. */
function pickValue(
  input,
  inputKey,
  env,
  envKey,
  fallback,
) {
  if (hasValue(input?.[inputKey])) {
    return input[inputKey];
  }

  if (hasValue(env?.[envKey])) {
    return env[envKey];
  }

  return fallback;
}

/** boolean 입력도 사용자 입력 → 환경변수 → 기본값 순서로 결정한다. */
function pickBoolean(
  input,
  inputKey,
  env,
  envKey,
  fallback,
) {
  const inputValue = input?.[inputKey];

  if (typeof inputValue === "boolean") {
    return inputValue;
  }

  if (hasValue(inputValue)) {
    return toBoolean(
      inputValue,
      fallback,
    );
  }

  if (hasValue(env?.[envKey])) {
    return toBoolean(
      env[envKey],
      fallback,
    );
  }

  return fallback;
}

/** 숫자 입력도 사용자 입력 → 환경변수 → 기본값 순서로 결정한다. */
function pickInteger(
  input,
  inputKey,
  env,
  envKey,
  fallback,
  min,
) {
  const raw = pickValue(
    input,
    inputKey,
    env,
    envKey,
    fallback,
  );

  return toInteger(
    raw,
    fallback,
    min,
  );
}

/** URL이 입력된 경우 쇼핑몰별 query string에서 카테고리 값을 추출한다. */
function normalizeCategory(value, mall) {
  const raw = String(
    value ?? "",
  ).trim();

  if (!raw) {
    return MALLS[mall].defaultCategory;
  }

  try {
    const url = new URL(raw);

    if (mall === "cheonyu") {
      return (
        url.searchParams.get("cateIDX") ||
        MALLS[mall].defaultCategory
      );
    }

    if (mall === "ccdome") {
      return (
        url.searchParams.get("cateCd") ||
        MALLS[mall].defaultCategory
      );
    }
  } catch {
    /** 일반 카테고리 코드면 원문을 그대로 사용한다. */
  }

  return raw;
}

/**
 * 실행 결과 기본 폴더를 결정한다.
 *
 * 우선순위:
 * 1. Electron 폴더 선택 결과 또는 직접 전달한 outDir
 * 2. 공통 OUT_DIR
 * 3. Electron 문서 폴더 또는 CLI 기본 폴더
 */
function resolveOutputDir(
  input = {},
  env = process.env,
  defaultOutputDir = path.resolve(
    process.cwd(),
    "out",
  ),
) {
  if (hasValue(input.outDir)) {
    return path.resolve(
      String(input.outDir),
    );
  }

  if (hasValue(env.OUT_DIR)) {
    const envPath = String(
      env.OUT_DIR,
    ).trim();

    return path.isAbsolute(envPath)
      ? path.normalize(envPath)
      : path.resolve(
          defaultOutputDir,
          envPath,
        );
  }

  return path.resolve(
    defaultOutputDir,
  );
}

/**
 * UI 또는 CLI 입력을 실제 수집 설정으로 변환한다.
 *
 * 우선순위:
 * 1. 사용자 입력
 * 2. 공통 .env 환경변수
 * 3. 쇼핑몰별 코드 기본값
 */
function resolveRunConfig(
  input = {},
  env = process.env,
  defaultOutputDir = path.resolve(
    process.cwd(),
    "out",
  ),
) {
  const mall = String(
    pickValue(
      input,
      "mall",
      env,
      "MALL",
      "cheonyu",
    ),
  )
    .trim()
    .toLowerCase();

  if (!MALLS[mall]) {
    throw new Error(
      `지원하지 않는 쇼핑몰입니다: ${mall}`,
    );
  }

  const mallInfo = MALLS[mall];

  const category = normalizeCategory(
    pickValue(
      input,
      "category",
      env,
      "CATEGORY",
      mallInfo.defaultCategory,
    ),
    mall,
  );

  const accountId = String(
    pickValue(
      input,
      "accountId",
      env,
      "ACCOUNT_ID",
      "",
    ),
  ).trim();

  const accountPw = String(
    pickValue(
      input,
      "accountPw",
      env,
      "ACCOUNT_PW",
      "",
    ),
  );

  const showBrowser = pickBoolean(
    input,
    "showBrowser",
    env,
    "SHOW_BROWSER",
    false,
  );

  const pageStart = pickInteger(
    input,
    "pageStart",
    env,
    "PAGE_START",
    1,
    1,
  );

  const pageEnd = pickInteger(
    input,
    "pageEnd",
    env,
    "PAGE_END",
    0,
    0,
  );

  const pageSize = pickInteger(
    input,
    "pageSize",
    env,
    "PAGE_SIZE",
    mallInfo.defaultPageSize,
    1,
  );

  if (!accountId || !accountPw) {
    throw new Error(
      "계정 정보가 없습니다. 화면에서 입력하거나 " +
        "ACCOUNT_ID / ACCOUNT_PW를 공통 .env에 설정하세요.",
    );
  }

  if (
    pageEnd > 0 &&
    pageEnd < pageStart
  ) {
    throw new Error(
      `PAGE_END(${pageEnd})는 ` +
        `PAGE_START(${pageStart})보다 작을 수 없습니다.`,
    );
  }

  const maxSafePages = pickInteger(
    input,
    "maxSafePages",
    env,
    "MAX_SAFE_PAGES",
    1000,
    1,
  );

  if (pageEnd > maxSafePages) {
    throw new Error(
      `PAGE_END(${pageEnd})가 ` +
        `MAX_SAFE_PAGES(${maxSafePages})를 초과했습니다.`,
    );
  }

  return {
    mall,
    mallLabel: mallInfo.label,
    baseUrl: mallInfo.baseUrl,
    category,
    accountId,
    accountPw,
    showBrowser,
    headless: !showBrowser,
    pageStart,
    pageEnd,
    pageSize,

    maxPerPage: pickInteger(
      input,
      "maxPerPage",
      env,
      "MAX_PER_PAGE",
      pageSize,
      1,
    ),

    cartQty: pickInteger(
      input,
      "cartQty",
      env,
      "CART_QTY",
      999,
      1,
    ),

    clearCartBefore: pickBoolean(
      input,
      "clearCartBefore",
      env,
      "CLEAR_CART_BEFORE",
      true,
    ),

    clearCartAfter: pickBoolean(
      input,
      "clearCartAfter",
      env,
      "CLEAR_CART_AFTER",
      false,
    ),

    lowStockThreshold: pickInteger(
      input,
      "lowStockThreshold",
      env,
      "LOW_STOCK_THRESHOLD",
      10,
      0,
    ),

    requestDelayMs: pickInteger(
      input,
      "requestDelayMs",
      env,
      "REQUEST_DELAY_MS",
      300,
      0,
    ),

    maxSafePages,

    navigationTimeoutMs: pickInteger(
      input,
      "navigationTimeoutMs",
      env,
      "NAVIGATION_TIMEOUT_MS",
      60000,
      1000,
    ),

    viewport: {
      width: 1440,
      height: 1000,
    },

    /**
     * USER_AGENT가 비어 있으면 Playwright가
     * 현재 번들 Chromium에 맞는 기본 User-Agent를 사용한다.
     */
    userAgent: hasValue(env.USER_AGENT)
      ? String(env.USER_AGENT)
      : undefined,

    baseOutDir: resolveOutputDir(
      input,
      env,
      defaultOutputDir,
    ),
  };
}

/** 결과 JSON에 저장해도 되는 설정만 반환한다. */
function toSafeConfig(config) {
  return {
    mall: config.mall,
    mallLabel: config.mallLabel,
    baseUrl: config.baseUrl,
    category: config.category,
    showBrowser: config.showBrowser,
    pageStart: config.pageStart,
    pageEnd: config.pageEnd,
    pageSize: config.pageSize,
    maxPerPage: config.maxPerPage,
    cartQty: config.cartQty,
    clearCartBefore: config.clearCartBefore,
    clearCartAfter: config.clearCartAfter,
    lowStockThreshold: config.lowStockThreshold,
    requestDelayMs: config.requestDelayMs,
    maxSafePages: config.maxSafePages,
    navigationTimeoutMs:
      config.navigationTimeoutMs,
  };
}

/** Electron Renderer에서 사용할 쇼핑몰 목록과 민감하지 않은 기본값이다. */
function getPublicDefaults(
  env = process.env,
  outputDirectory = "",
) {
  const envMall = String(
    env.MALL || "cheonyu",
  )
    .trim()
    .toLowerCase();

  const mall = MALLS[envMall]
    ? envMall
    : "cheonyu";

  return {
    malls: Object.values(MALLS).map(
      (item) => ({
        key: item.key,
        label: item.label,
        baseUrl: item.baseUrl,
        defaultCategory:
          item.defaultCategory,
        categoryLabel:
          item.categoryLabel,
        categoryPlaceholder:
          item.categoryPlaceholder,
        defaultPageSize:
          item.defaultPageSize,
      }),
    ),

    envDefaults: {
      mall,

      category: hasValue(env.CATEGORY)
        ? normalizeCategory(
            env.CATEGORY,
            mall,
          )
        : MALLS[mall].defaultCategory,

      showBrowser: toBoolean(
        env.SHOW_BROWSER,
        false,
      ),

      pageStart: toInteger(
        env.PAGE_START,
        1,
        1,
      ),

      pageEnd: toInteger(
        env.PAGE_END,
        0,
        0,
      ),

      pageSize: hasValue(env.PAGE_SIZE)
        ? toInteger(
            env.PAGE_SIZE,
            MALLS[mall].defaultPageSize,
            1,
          )
        : MALLS[mall].defaultPageSize,

      hasAccountId:
        hasValue(env.ACCOUNT_ID),

      hasAccountPw:
        hasValue(env.ACCOUNT_PW),
    },

    outputDirectory,
  };
}

module.exports = {
  MALLS,
  getPublicDefaults,
  normalizeCategory,
  resolveOutputDir,
  resolveRunConfig,
  toSafeConfig,
};
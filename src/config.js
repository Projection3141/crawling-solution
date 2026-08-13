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
    categoryPlaceholder: "-1(전체) 또는 천유 상품 목록 URL",
    defaultPageSize: 150,
  },

  ccdome: {
    key: "ccdome",
    label: "과자생각",
    baseUrl: "https://www.ccdome.co.kr",
    defaultCategory: "017",
    categoryLabel: "카테고리 코드",
    categoryPlaceholder: "017(전체) 또는 과자생각 상품 목록 URL",
    defaultPageSize: 40,
  },
});

const CHEONYU_PROXY_SLOT_COUNT = 5;
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "socks5:",
]);

/** 천유 전용 프록시가 설정된 슬롯 번호만 반환한다. */
function getConfiguredCheonyuProxySlots(env = process.env) {
  return Array.from(
    { length: CHEONYU_PROXY_SLOT_COUNT },
    (_, index) => index + 1,
  ).filter((slot) => hasValue(env?.[`CHEONYU_PROXY_${slot}_SERVER`]));
}

/** 화면이나 환경변수에서 받은 프록시 슬롯 번호를 검증한다. */
function normalizeCheonyuProxySlot(value, label = "천유 프록시 슬롯") {
  const slot = Number(value);

  if (
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > CHEONYU_PROXY_SLOT_COUNT
  ) {
    throw new Error(`${label}은 1~${CHEONYU_PROXY_SLOT_COUNT} 사이의 정수여야 합니다.`);
  }

  return slot;
}

/** 프록시 주소를 Playwright가 지원하는 형식으로 검증한다. */
function normalizeProxyServer(value, slot) {
  const server = String(value || "").trim();
  let url;

  try {
    url = new URL(server);
  } catch {
    throw new Error(
      `천유 프록시 슬롯 ${slot} 주소가 올바르지 않습니다. ` +
      "http://호스트:포트 형식으로 설정하세요.",
    );
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `천유 프록시 슬롯 ${slot}은 HTTP 또는 SOCKS5 주소만 지원합니다.`,
    );
  }

  if (url.username || url.password) {
    throw new Error(
      `천유 프록시 슬롯 ${slot}의 인증정보는 주소에 넣지 말고 ` +
      "USERNAME/PASSWORD 항목에 분리해서 설정하세요.",
    );
  }

  return server;
}

/** 선택된 천유 프록시 슬롯을 Playwright BrowserContext 설정으로 변환한다. */
function resolveCheonyuProxy(input, env, mall) {
  if (mall !== "cheonyu") {
    return {
      cheonyuProxySlot: 0,
      proxy: undefined,
    };
  }

  const configuredSlots = getConfiguredCheonyuProxySlots(env);
  const requestedValue = hasValue(input?.cheonyuProxySlot)
    ? input.cheonyuProxySlot
    : env?.CHEONYU_PROXY_SLOT;

  if (configuredSlots.length < 1) {
    if (hasValue(requestedValue)) {
      throw new Error(
        "천유 프록시 슬롯이 선택됐지만 CHEONYU_PROXY_n_SERVER 설정이 없습니다.",
      );
    }

    return {
      cheonyuProxySlot: 0,
      proxy: undefined,
    };
  }

  const slot = hasValue(requestedValue)
    ? normalizeCheonyuProxySlot(requestedValue)
    : configuredSlots[0];

  if (!configuredSlots.includes(slot)) {
    throw new Error(`천유 프록시 슬롯 ${slot}이 .env에 설정되어 있지 않습니다.`);
  }

  const prefix = `CHEONYU_PROXY_${slot}`;
  const server = normalizeProxyServer(env[`${prefix}_SERVER`], slot);
  const username = String(env[`${prefix}_USERNAME`] || "").trim();
  const password = String(env[`${prefix}_PASSWORD`] || "");

  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      `천유 프록시 슬롯 ${slot}의 USERNAME과 PASSWORD는 둘 다 설정하거나 ` +
      "둘 다 비워야 합니다.",
    );
  }

  if (new URL(server).protocol === "socks5:" && username) {
    throw new Error(
      `천유 프록시 슬롯 ${slot}의 사용자 인증은 HTTP/HTTPS 프록시 주소를 사용하세요.`,
    );
  }

  return {
    cheonyuProxySlot: slot,
    proxy: {
      server,
      ...(username ? { username, password } : {}),
    },
  };
}

function pickValue(input, inputKey, env, envKey, fallback) {
  if (hasValue(input?.[inputKey])) return input[inputKey];
  if (hasValue(env?.[envKey])) return env[envKey];
  return fallback;
}

/** User-Agent 헤더에 사용할 수 있는 한 줄 문자열로 검증한다. */
function normalizeUserAgent(value, label = "User-Agent") {
  const userAgent = String(value || "").trim();

  if (!userAgent) return undefined;
  if (userAgent.length > 512) {
    throw new Error(`${label}는 512자 이하여야 합니다.`);
  }
  if (/[\r\n\0]/.test(userAgent)) {
    throw new Error(`${label}에는 줄바꿈이나 NUL 문자를 사용할 수 없습니다.`);
  }

  return userAgent;
}

/** 화면 입력은 천유에만 적용하고 기존 공통 USER_AGENT 설정은 유지한다. */
function resolveUserAgent(input, env, mall) {
  if (mall === "cheonyu" && hasValue(input?.cheonyuUserAgent)) {
    return normalizeUserAgent(input.cheonyuUserAgent, "천유 User-Agent");
  }

  if (mall === "cheonyu" && hasValue(env?.CHEONYU_USER_AGENT)) {
    return normalizeUserAgent(env.CHEONYU_USER_AGENT, "CHEONYU_USER_AGENT");
  }

  return hasValue(env?.USER_AGENT)
    ? normalizeUserAgent(env.USER_AGENT, "USER_AGENT")
    : undefined;
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

  const cheonyuProxy = resolveCheonyuProxy(input, env, mall);

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
      1000,
      0,
    ),
    detailMaxProducts: pickInteger(input, "detailMaxProducts", env, "DETAIL_MAX_PRODUCTS", 0, 0),
    detailConcurrency:
      mall === "cheonyu"
        ? pickInteger(
          input,
          "detailConcurrency",
          env,
          "CHEONYU_DETAIL_CONCURRENCY",
          3,
          1,
        )
        : 5,
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
    userAgent: resolveUserAgent(input, env, mall),
    cheonyuProxySlot: cheonyuProxy.cheonyuProxySlot,
    proxy: cheonyuProxy.proxy,
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
    detailConcurrency: config.detailConcurrency,
    maxSafePages: config.maxSafePages,
    navigationTimeoutMs: config.navigationTimeoutMs,
    proxyEnabled: Boolean(config.proxy),
    cheonyuProxySlot: config.cheonyuProxySlot || 0,
  };
}

function getPublicDefaults(env = process.env, outputDirectory = "") {
  const envMall = String(env.MALL || "cheonyu").trim().toLowerCase();
  const mall = MALLS[envMall] ? envMall : "cheonyu";
  const configuredProxySlots = getConfiguredCheonyuProxySlots(env);
  const defaultProxySlot = configuredProxySlots.length > 0
    ? hasValue(env.CHEONYU_PROXY_SLOT)
      ? normalizeCheonyuProxySlot(
        env.CHEONYU_PROXY_SLOT,
        "CHEONYU_PROXY_SLOT",
      )
      : configuredProxySlots[0]
    : 0;

  if (
    defaultProxySlot > 0 &&
    !configuredProxySlots.includes(defaultProxySlot)
  ) {
    throw new Error(
      `기본 천유 프록시 슬롯 ${defaultProxySlot}이 .env에 설정되어 있지 않습니다.`,
    );
  }

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

    proxyDefaults: {
      cheonyu: {
        configuredSlots: configuredProxySlots,
        defaultSlot: defaultProxySlot,
      },
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

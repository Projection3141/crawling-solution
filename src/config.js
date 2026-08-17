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

const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

const DEFAULT_RUN_CONFIG = Object.freeze({
  mall: "cheonyu",
  showBrowser: false,
  pageStart: 1,
  pageEnd: 0,
  maxPerPage: 150,
  cartQty: 999,
  clearCartBefore: true,
  clearCartAfter: false,
  lowStockThreshold: 10,
  requestDelayMs: 300,
  maxSafePages: 1000,
  navigationTimeoutMs: 60000,
  cheonyuUserAgent: undefined,
  openaiModel: DEFAULT_OPENAI_MODEL,
});

const DEFAULT_SERVER_CONFIG = Object.freeze({
  host: "127.0.0.1",
  port: 3210,
});

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "socks5:",
]);

/** 프록시 주소를 Playwright가 지원하는 형식으로 검증한다. */
function normalizeProxyServer(value, label = "천유 프록시") {
  const server = String(value || "").trim();
  let url;

  if (server.length > 2048 || /[\r\n\0]/.test(server)) {
    throw new Error(`${label} 주소 형식이 올바르지 않습니다.`);
  }

  try {
    url = new URL(server);
  } catch {
    throw new Error(
      `${label} 주소가 올바르지 않습니다. ` +
      "http://호스트:포트 형식으로 설정하세요.",
    );
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `${label}는 HTTP 또는 SOCKS5 주소만 지원합니다.`,
    );
  }

  if (url.username || url.password) {
    throw new Error(
      `${label} 인증정보는 주소에 넣지 말고 ` +
      "USERNAME/PASSWORD 항목에 분리해서 설정하세요.",
    );
  }

  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(
      `${label} 주소에는 경로, 쿼리, 해시를 넣을 수 없습니다. ` +
      "http://호스트:포트 형식으로 설정하세요.",
    );
  }

  return `${url.protocol}//${url.host}`;
}

function normalizeProxyCredentials(
  { server: rawServer, username: rawUsername, password: rawPassword },
  label,
) {
  const server = normalizeProxyServer(rawServer, label);
  const username = String(rawUsername || "").trim();
  const password = String(rawPassword || "");

  if (
    username.length > 512 ||
    password.length > 2048 ||
    /[\r\n\0]/.test(username) ||
    /[\r\n\0]/.test(password)
  ) {
    throw new Error(`${label} 인증정보 형식이 올바르지 않습니다.`);
  }

  if (Boolean(username) !== Boolean(password)) {
    throw new Error(
      `${label} USERNAME과 PASSWORD는 둘 다 설정하거나 둘 다 비워야 합니다.`,
    );
  }

  if (new URL(server).protocol === "socks5:" && username) {
    throw new Error(
      `${label} 사용자 인증은 HTTP 프록시 주소를 사용하세요.`,
    );
  }

  return {
    server,
    ...(username ? { username, password } : {}),
  };
}

/** UI에서 선택한 천유 프록시 프로필을 BrowserContext 설정으로 변환한다. */
function resolveCheonyuProxy(input, _env, mall) {
  if (mall !== "cheonyu") {
    return {
      proxySource: "none",
      proxy: undefined,
    };
  }

  const directProxyRequested = [
    input?.cheonyuProxyServer,
    input?.cheonyuProxyUsername,
    input?.cheonyuProxyPassword,
  ].some(hasValue);

  if (!directProxyRequested) {
    return {
      proxySource: "none",
      proxy: undefined,
    };
  }

  if (!hasValue(input?.cheonyuProxyServer)) {
    throw new Error("선택한 천유 프록시 주소가 없습니다.");
  }

  return {
    proxySource: input?.cheonyuProxyProfileId ? "profile" : "input",
    proxyProfileId: String(input?.cheonyuProxyProfileId || ""),
    proxyProfileName: String(input?.cheonyuProxyProfileName || ""),
    proxy: normalizeProxyCredentials(
      {
        server: input.cheonyuProxyServer,
        username: input.cheonyuProxyUsername,
        password: input.cheonyuProxyPassword,
      },
      "선택한 천유 프록시",
    ),
  };
}

function pickValue(input, inputKey, env, envKey, fallback) {
  if (hasValue(input?.[inputKey])) return input[inputKey];
  if (hasValue(env?.[envKey])) return env[envKey];
  return fallback;
}

function pickInputValue(input, inputKey, fallback) {
  return hasValue(input?.[inputKey]) ? input[inputKey] : fallback;
}

function pickInputBoolean(input, inputKey, fallback) {
  const value = input?.[inputKey];

  if (typeof value === "boolean") return value;
  return hasValue(value) ? toBoolean(value, fallback) : fallback;
}

function pickInputInteger(input, inputKey, fallback, min) {
  return toInteger(pickInputValue(input, inputKey, fallback), fallback, min);
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

/** 천유 화면 입력, 기존 공통 USER_AGENT, 코드 기본값 순서로 적용한다. */
function resolveUserAgent(input, env, mall) {
  if (mall === "cheonyu" && hasValue(input?.cheonyuUserAgent)) {
    return normalizeUserAgent(input.cheonyuUserAgent, "천유 User-Agent");
  }

  if (hasValue(env?.USER_AGENT)) {
    return normalizeUserAgent(env.USER_AGENT, "USER_AGENT");
  }

  return DEFAULT_RUN_CONFIG.cheonyuUserAgent;
}

function pickInteger(input, inputKey, env, envKey, fallback, min) {
  const raw = pickValue(input, inputKey, env, envKey, fallback);
  return toInteger(raw, fallback, min);
}

/**
 * 카테고리 값 결정.
 *
 * 우선순위:
 * 1. UI에서 직접 입력한 category
 * 2. 쇼핑몰 코드 기본값
 */
function resolveCategoryValue(input, mallInfo) {
  if (hasValue(input?.category)) {
    return input.category;
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
  const mall = String(pickInputValue(input, "mall", DEFAULT_RUN_CONFIG.mall))
    .trim()
    .toLowerCase();

  if (!MALLS[mall]) throw new Error(`지원하지 않는 쇼핑몰입니다: ${mall}`);

  const mallInfo = MALLS[mall];
  const category = normalizeCategory(
    resolveCategoryValue(input, mallInfo),
    mall,
  );

  const accountId = String(pickValue(input, "accountId", env, "ACCOUNT_ID", "")).trim();
  const accountPw = String(pickValue(input, "accountPw", env, "ACCOUNT_PW", ""));
  const showBrowser = pickInputBoolean(
    input,
    "showBrowser",
    DEFAULT_RUN_CONFIG.showBrowser,
  );
  const pageStart = pickInputInteger(
    input,
    "pageStart",
    DEFAULT_RUN_CONFIG.pageStart,
    1,
  );
  const pageEnd = pickInputInteger(
    input,
    "pageEnd",
    DEFAULT_RUN_CONFIG.pageEnd,
    0,
  );
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

  const maxSafePages = pickInputInteger(
    input,
    "maxSafePages",
    DEFAULT_RUN_CONFIG.maxSafePages,
    1,
  );

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

    maxPerPage: pickInputInteger(
      input,
      "maxPerPage",
      DEFAULT_RUN_CONFIG.maxPerPage,
      1,
    ),
    cartQty: pickInputInteger(
      input,
      "cartQty",
      DEFAULT_RUN_CONFIG.cartQty,
      1,
    ),
    optionCartQty: pickInteger(input, "optionCartQty", env, "OPTION_CART_QTY", 1, 1),

    clearCartBefore: pickInputBoolean(
      input,
      "clearCartBefore",
      DEFAULT_RUN_CONFIG.clearCartBefore,
    ),
    clearCartAfter: pickInputBoolean(
      input,
      "clearCartAfter",
      DEFAULT_RUN_CONFIG.clearCartAfter,
    ),
    lowStockThreshold: pickInputInteger(
      input,
      "lowStockThreshold",
      DEFAULT_RUN_CONFIG.lowStockThreshold,
      0,
    ),
    requestDelayMs: pickInputInteger(
      input,
      "requestDelayMs",
      DEFAULT_RUN_CONFIG.requestDelayMs,
      0,
    ),
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
    navigationTimeoutMs: pickInputInteger(
      input,
      "navigationTimeoutMs",
      DEFAULT_RUN_CONFIG.navigationTimeoutMs,
      1000,
    ),

    viewport: { width: 1440, height: 1000 },
    userAgent: resolveUserAgent(input, env, mall),
    proxySource: cheonyuProxy.proxySource || "none",
    proxyProfileId: cheonyuProxy.proxyProfileId || "",
    proxyProfileName: cheonyuProxy.proxyProfileName || "",
    proxy: cheonyuProxy.proxy,
    baseOutDir: resolveOutputDir(input, env, defaultOutputDir),
  };
}

/** UI에서 선택한 OpenAI 인증정보를 일반 수집 설정과 분리해 고정한다. */
function resolveOpenAiConfig(input = {}) {
  return {
    apiKey: String(input?.openaiApiKey || "").trim(),
    model: DEFAULT_RUN_CONFIG.openaiModel,
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
    proxySource: config.proxySource || "none",
    proxyProfileName: config.proxyProfileName || "",
  };
}

function getPublicDefaults(env = process.env, outputDirectory = "") {
  const mall = DEFAULT_RUN_CONFIG.mall;

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
      category: MALLS[mall].defaultCategory,
      collectionMode: hasValue(env.COLLECTION_MODE)
        ? String(env.COLLECTION_MODE).trim().toLowerCase()
        : "general",
      showBrowser: DEFAULT_RUN_CONFIG.showBrowser,
      pageStart: DEFAULT_RUN_CONFIG.pageStart,
      pageEnd: DEFAULT_RUN_CONFIG.pageEnd,
      pageSize: MALLS[mall].defaultPageSize,
      hasAccountId: hasValue(env.ACCOUNT_ID),
      hasAccountPw: hasValue(env.ACCOUNT_PW),
    },

    outputDirectory,
  };
}

function resolveServerConfig(_env = process.env) {
  return { ...DEFAULT_SERVER_CONFIG };
}

module.exports = {
  DEFAULT_OPENAI_MODEL,
  MALLS,
  getPublicDefaults,
  normalizeCategory,
  normalizeProxyCredentials,
  resolveOutputDir,
  resolveOpenAiConfig,
  resolveRunConfig,
  resolveServerConfig,
  toSafeConfig,
};

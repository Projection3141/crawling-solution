// src/cart-uploader.js

const {
  chromium,
} = require("playwright");
const {
  installDialogAutoAccept,
  getLightweightLaunchArgs,
  installLightweightNetworkPolicy,
} = require("./utils/browser");
const {
  throwIfAborted,
} = require("./utils/common");
const { installHttpBlockGuard } = require("./utils/site-safety");
const {
  parseCartHtml,
  readCartHtml,
} = require("./malls/cheonyu/cart");
const {
  addCheonyuProductsToCart,
} = require("./malls/cheonyu/cart-stock");
const {
  loginCheonyu,
} = require("./malls/cheonyu/site");
const {
  addCcdomeProductsToCart,
  parseCcdomeCartHtml,
  readCcdomeCartHtml,
} = require("./malls/ccdome/cart-stock");
const {
  loginCcdome,
} = require("./malls/ccdome/site");

/** 공통 Playwright context를 생성한다. */
async function createCartBrowser(config, browserType) {
  const browser = await browserType.launch({
    headless: config.headless,
    args: getLightweightLaunchArgs({ showBrowser: config.showBrowser }),
  });
  let context = null;

  try {
    context = await browser.newContext({
      viewport: config.viewport,
      userAgent: config.userAgent,
      ...(config.proxy ? { proxy: config.proxy } : {}),
    });

    await installLightweightNetworkPolicy(context, {
      showBrowser: config.showBrowser,
    });

    const page = await context.newPage();
    installDialogAutoAccept(page);

    return {
      browser,
      context,
      page,
    };
  } catch (error) {
    if (context) await context.close().catch(() => null);
    await browser.close().catch(() => null);
    throw error;
  }
}

/** 천유 상품 여러 개를 한 로그인 세션에서 처리한다. */
async function runCheonyuCartUpload(
  config,
  items,
  {
    browserType = chromium,
    onProgress = () => {},
    signal,
  } = {},
) {
  const blockController = new AbortController();
  const runSignal = signal
    ? AbortSignal.any([signal, blockController.signal])
    : blockController.signal;
  let browser = null;
  let context = null;
  let blockGuard = null;

  try {
    throwIfAborted(runSignal);

    const created = await createCartBrowser(config, browserType);
    browser = created.browser;
    context = created.context;
    const page = created.page;

    blockGuard = installHttpBlockGuard(context, {
      hostname: new URL(config.baseUrl).hostname,
      label: "천유",
      onBlocked: () => {
        blockController.abort();
        return browser.close();
      },
    });

    onProgress({
      stage: "cart-login",
      message: "천유닷컴에 로그인하고 있습니다.",
    });
    await loginCheonyu(page, config, runSignal);
    throwIfAborted(runSignal);

    const addResult = await addCheonyuProductsToCart(
      page,
      context,
      config,
      items,
      {
        clearBefore: false,
        onProgress,
        signal: runSignal,
      },
    );
    const cartHtml = await readCartHtml(page, config);
    throwIfAborted(runSignal);
    const cartItems = parseCartHtml(cartHtml, config);
    const requestedIds = new Set(
      items.map((item) => String(item.productId)),
    );
    const matchingCartItems = cartItems.filter((item) =>
      requestedIds.has(String(item.productId)),
    );

    if (matchingCartItems.length < 1) {
      throw new Error("천유 장바구니에서 요청 상품을 확인하지 못했습니다.");
    }

    throwIfAborted(runSignal);

    return {
      success: true,
      site: "cheonyu",
      requestCount: items.length,
      addResult,
      cartItems: matchingCartItems,
    };
  } catch (error) {
    throw blockGuard?.getError() || error;
  } finally {
    blockGuard?.dispose();
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
  }
}

/** 과자생각 상품 여러 개를 한 로그인 세션에서 처리한다. */
async function runCcdomeCartUpload(
  config,
  items,
  {
    browserType = chromium,
    onProgress = () => {},
    signal,
  } = {},
) {
  let browser = null;
  let context = null;

  try {
    throwIfAborted(signal);

    const created = await createCartBrowser(config, browserType);
    browser = created.browser;
    context = created.context;
    const page = created.page;

    onProgress({
      stage: "cart-login",
      message: "과자생각에 로그인하고 있습니다.",
    });
    await loginCcdome(page, config);

    /**
     * 과자생각은 여러 상품을 한 번에 넘기지 않고
     * 상품 한 건씩 addCcdomeProductsToCart()에 전달한다.
     */
    const individualResults = [];

    for (let index = 0; index < items.length; index += 1) {
      throwIfAborted(signal);

      const item = items[index];
      const oneResult = await addCcdomeProductsToCart(
        page,
        context,
        config,
        [item],
        {
          onProgress: (progress) => {
            onProgress({
              ...progress,
              batchIndex: index + 1,
              batchCount: items.length,
            });
          },
          signal,
        },
      );

      individualResults.push(...oneResult.results);
    }

    const addResult = {
      requestedCount: items.length,
      successCount: individualResults.length,
      mode: "one-by-one",
      results: individualResults,
    };
    const cartHtml = await readCcdomeCartHtml(page, config);
    const cartItems = parseCcdomeCartHtml(cartHtml, config);
    const requestedIds = new Set(
      items.map((item) => String(item.productId)),
    );
    const matchingCartItems = cartItems.filter((item) =>
      requestedIds.has(String(item.productId)),
    );
    const missingIds = Array.from(requestedIds).filter(
      (productId) =>
        !matchingCartItems.some(
          (item) => String(item.productId) === productId,
        ),
    );

    if (missingIds.length > 0) {
      throw new Error(
        `과자생각 장바구니에서 확인하지 못한 상품: ${missingIds.join(", ")}`,
      );
    }

    return {
      success: true,
      site: "ccdome",
      requestCount: items.length,
      addResult,
      cartItems: matchingCartItems,
    };
  } finally {
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
  }
}

/** site별 장바구니 실행기를 선택한다. */
async function runCartUpload(config, items, options = {}) {
  if (!Array.isArray(items) || items.length < 1) {
    throw new Error("실행할 장바구니 상품이 없습니다.");
  }

  if (config.mall === "cheonyu") {
    return runCheonyuCartUpload(config, items, options);
  }

  if (config.mall === "ccdome") {
    return runCcdomeCartUpload(config, items, options);
  }

  throw new Error(`지원하지 않는 사이트입니다: ${config.mall}`);
}

module.exports = {
  runCartUpload,
  runCcdomeCartUpload,
  runCheonyuCartUpload,
};

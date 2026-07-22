const { performance } = require("node:perf_hooks");
const { chromium } = require("playwright");
const {
  bindAbortToBrowser,
  installDialogAutoAccept,
  installLightweightRouting,
} = require("../../utils/browser");
const {
  formatMs,
  getMemoryMb,
  throwIfAborted,
} = require("../../utils/common");
const {
  buildProductSummaries,
  sortInventoryItems,
} = require("../../utils/inventory");
const {
  clearCartAll,
  clearCartByCartIds,
  parseCartHtml,
  readCartHtml,
} = require("./cart");
const { bulkAddPages, loginCheonyu } = require("./site");

/** 천유닷컴 장바구니 기반 재고 수집을 실행한다. */
async function runCheonyu(
  config,
  {
    browserType = chromium,
    onProgress = () => {},
    signal,
  } = {},
) {
  const startedAt = performance.now();
  const memoryStart = getMemoryMb();
  let browser = null;
  let context = null;
  let releaseAbort = () => {};

  try {
    throwIfAborted(signal);
    onProgress({
      stage: "starting",
      message: "천유닷컴 브라우저를 준비하고 있습니다.",
    });

    browser = await browserType.launch({
      headless: config.headless,
    });
    releaseAbort = bindAbortToBrowser(signal, browser);
    throwIfAborted(signal);

    context = await browser.newContext({
      viewport: config.viewport,
      userAgent: config.userAgent,
    });

    await installLightweightRouting(context, {
      showBrowser: config.showBrowser,
    });

    const page = await context.newPage();

    installDialogAutoAccept(page);

    onProgress({
      stage: "login",
      message: "천유닷컴에 로그인하고 있습니다.",
    });
    await loginCheonyu(page, config);
    throwIfAborted(signal);

    let clearBeforeResult = null;

    if (config.clearCartBefore) {
      onProgress({
        stage: "preparing",
        message: "기존 장바구니를 정리하고 있습니다.",
      });
      clearBeforeResult = await clearCartAll(page, context, config);
      throwIfAborted(signal);
    }

    const { allTargets, allProducts, pageResults, pageRange } = await bulkAddPages(
      page,
      config,
      (progress) => {
        onProgress({
          ...progress,
          elapsedMs: performance.now() - startedAt,
        });
      },
      signal,
    );

    throwIfAborted(signal);

    const targetProducts = Array.from(
      new Map(allTargets.map((item) => [String(item.productId), item])).values(),
    );

    onProgress({
      stage: "inventory",
      message: "장바구니에서 옵션별 재고를 파싱하고 있습니다.",
      pageRange,
      detectedTotalProductCount: pageRange.detectedTotalProductCount,
      collectedProductCount: allProducts.length,
      targetProductCount: targetProducts.length,
      elapsedMs: performance.now() - startedAt,
    });

    const cartHtml = await readCartHtml(page, config);
    throwIfAborted(signal);

    const allCartItems = parseCartHtml(cartHtml, config);
    const targetIds = new Set(
      targetProducts.map((item) => String(item.productId)),
    );
    const inventoryItems = sortInventoryItems(
      allCartItems.filter((item) => targetIds.has(String(item.productId))),
    );
    const productSummaries = buildProductSummaries(inventoryItems);

    let clearAfterResult = null;

    if (config.clearCartAfter) {
      const cartIds = inventoryItems
        .map((item) => item.cartCheckId || item.inPIDX)
        .filter(Boolean);

      clearAfterResult = await clearCartByCartIds(context, cartIds, config);
      throwIfAborted(signal);
    }

    const elapsedMs = performance.now() - startedAt;
    const soldOutIds = new Set(
      allProducts
        .filter((item) => item.isSoldOut)
        .map((item) => String(item.productId)),
    );

    for (const item of productSummaries) {
      if (item.stockStatus === "OUT_OF_STOCK") {
        soldOutIds.add(String(item.productId));
      }
    }

    const soldOutProductCount = soldOutIds.size;

    const summary = {
      mall: config.mall,
      mallLabel: config.mallLabel,
      category: config.category,
      startedAt: new Date(Date.now() - elapsedMs).toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: +elapsedMs.toFixed(2),
      elapsedText: formatMs(elapsedMs),
      memoryStart,
      memoryEnd: getMemoryMb(),
      pageRange,
      collectedPages: pageResults.map((item) => item.page),
      detectedTotalProductCount: pageRange.detectedTotalProductCount,
      collectedProductCount: allProducts.length,
      targetProductCount: targetProducts.length,
      productSummaryCount: productSummaries.length,
      inventoryRowCount: inventoryItems.length,
      soldOutProductCount,
      clearBeforeResult,
      clearAfterResult,
    };

    onProgress({
      stage: "completed",
      message: "천유닷컴 수집이 완료되었습니다.",
      pageRange,
      detectedTotalProductCount: summary.detectedTotalProductCount,
      collectedProductCount: summary.collectedProductCount,
      targetProductCount: summary.targetProductCount,
      productSummaryCount: summary.productSummaryCount,
      soldOutProductCount,
      elapsedMs,
      elapsedText: summary.elapsedText,
    });

    return {
      summary,
      inventoryItems,
      productSummaries,
      products: allProducts,
      debugFiles: {
        "debug-cart.html": cartHtml,
      },
    };
  } finally {
    releaseAbort();
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
  }
}

module.exports = {
  run: runCheonyu,
  runCheonyu,
};
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
  buildAvailabilityInventory,
  buildAvailabilitySummaries,
} = require("../../utils/inventory");
const { collectCcdomeProducts, loginCcdome } = require("./site");

/** 과자생각 전체·판매중·품절 상품 수집을 실행한다. */
async function runCcdome(
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
      message: "과자생각 브라우저를 준비하고 있습니다.",
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
      message: "과자생각에 로그인하고 있습니다.",
    });
    await loginCcdome(page, config);
    throwIfAborted(signal);

    const result = await collectCcdomeProducts(
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

    onProgress({
      stage: "summarizing",
      message: "재고 상태와 상품 요약을 생성하고 있습니다.",
      pageRange: result.pageRange,
      detectedTotalProductCount:
        result.pageRange.detectedTotalProductCount,
      collectedProductCount: result.allProducts.length,
      targetProductCount: result.activeProducts.length,
      productSummaryCount: result.allProducts.length,
      soldOutProductCount: result.soldOutProducts.length,
      elapsedMs: performance.now() - startedAt,
    });

    const inventoryItems = buildAvailabilityInventory(result.allProducts);
    const productSummaries = buildAvailabilitySummaries(result.allProducts);
    const elapsedMs = performance.now() - startedAt;
    const fullRangeCollected =
      result.pageRange.pageStart === 1 &&
      result.pageRange.collectedLastPage === result.pageRange.pageEnd &&
      result.pageRange.stopReason === "completed-range";
    const detectedTotalProductCount =
      result.pageRange.detectedTotalProductCount;

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
      pageRange: result.pageRange,
      collectedPages: result.pageResults.map((item) => item.page),
      detectedTotalProductCount,
      collectedProductCount: result.allProducts.length,
      targetProductCount: result.activeProducts.length,
      productSummaryCount: productSummaries.length,
      inventoryRowCount: inventoryItems.length,
      soldOutProductCount: result.soldOutProducts.length,
      countMatched:
        detectedTotalProductCount != null && fullRangeCollected
          ? detectedTotalProductCount === result.allProducts.length
          : null,
    };

    onProgress({
      stage: "completed",
      message: "과자생각 수집이 완료되었습니다.",
      pageRange: result.pageRange,
      detectedTotalProductCount,
      collectedProductCount: summary.collectedProductCount,
      targetProductCount: summary.targetProductCount,
      productSummaryCount: summary.productSummaryCount,
      soldOutProductCount: summary.soldOutProductCount,
      elapsedMs,
      elapsedText: summary.elapsedText,
    });

    return {
      summary,
      inventoryItems,
      productSummaries,
      products: result.allProducts,
      activeProducts: result.activeProducts,
      soldOutProducts: result.soldOutProducts,
      debugFiles: result.debugFiles,
    };
  } finally {
    releaseAbort();
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
  }
}

module.exports = {
  run: runCcdome,
  runCcdome,
};
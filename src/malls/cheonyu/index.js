// src/malls/cheonyu/index.js

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
const { clearCartAll } = require("./cart");
const { probeCheonyuCartStock } = require("./cart-stock");
const { collectCheonyuDetails } = require("./detail");
const { bulkAddPages, loginCheonyu } = require("./site");

/** 천유닷컴 장바구니 기반 재고/상세 수집을 실행한다. */
async function runCheonyu(
  config,
  {
    browserType = chromium,
    onProgress = () => { },
    signal,
  } = {},
) {
  const startedAt = performance.now();
  const memoryStart = getMemoryMb();
  let browser = null;
  let context = null;
  let releaseAbort = () => { };

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

    const {
      allTargets,
      allPopupOptionRows,
      allProducts,
      pageResults,
      pageRange,
    } = await bulkAddPages(
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

    console.log("[CHEONYU] collectionMode:", config.collectionMode);
    console.log("[CHEONYU] allProducts:", allProducts.length);
    console.log("[CHEONYU] targetProducts:", targetProducts.length);

    onProgress({
      stage: "inventory",
      message: "장바구니에서 옵션별 재고를 파싱하고 있습니다.",
      pageRange,
      detectedTotalProductCount: pageRange.detectedTotalProductCount,
      collectedProductCount: allProducts.length,
      targetProductCount: targetProducts.length,
      elapsedMs: performance.now() - startedAt,
    });

    const {
      cartHtml,
      inventoryItems,
      clearAfterResult,
    } = await probeCheonyuCartStock(
      page,
      context,
      config,
      targetProducts,
      {
        probeQty: config.cartQty || 999,
        clearAfter: config.clearCartAfter,
        popupOptionRows: allPopupOptionRows,
        onProgress: (progress) => {
          onProgress({
            ...progress,
            elapsedMs: performance.now() - startedAt,
          });
        },
        signal,
      },
    );

    throwIfAborted(signal);

    const productSummaries = buildProductSummaries(inventoryItems);
    let detailItems = [];

    if (config.collectionMode === "detail") {
      onProgress({
        stage: "detail",
        message: "상품 상세페이지 정보를 수집하고 있습니다.",
        pageRange,
        detectedTotalProductCount: pageRange.detectedTotalProductCount,
        collectedProductCount: allProducts.length,
        targetProductCount: targetProducts.length,
        productSummaryCount: productSummaries.length,
        elapsedMs: performance.now() - startedAt,
      });

      detailItems = await collectCheonyuDetails(
        page,
        allProducts,
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

    const detailTargetCount =
      config.collectionMode === "detail"
        ? config.detailMaxProducts > 0
          ? Math.min(config.detailMaxProducts, allProducts.length)
          : allProducts.length
        : 0;

    const summary = {
      mall: config.mall,
      mallLabel: config.mallLabel,
      category: config.category,
      collectionMode: config.collectionMode,
      detailTargetCount,
      detailItemCount: detailItems.length,
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
      popupOptionRowCount: allPopupOptionRows.length,
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
      detailItems,
      popupOptionItems: allPopupOptionRows,
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

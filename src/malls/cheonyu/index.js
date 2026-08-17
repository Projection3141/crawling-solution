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
const { installHttpBlockGuard } = require("../../utils/site-safety");
const {
  buildProductSummaries,
  sortInventoryItems,
} = require("../../utils/inventory");
const { clearCartAll } = require("./cart");
const { probeCheonyuCartStock } = require("./cart-stock");
const { collectCheonyuDetails } = require("./detail");
const { bulkAddPages, loginCheonyu } = require("./site");

function createCheonyuCollectionWarnings(excludedProducts = []) {
  const groups = new Map();

  for (const item of excludedProducts) {
    const page = Number(item?.page) || 0;
    const reasonCode = String(item?.reasonCode || "LIST_CONTROLS_DISABLED");
    const key = `${page}:${reasonCode}`;
    const group = groups.get(key) || {
      code: reasonCode,
      page,
      reason: String(
        item?.reason || "상품 체크박스 또는 수량 입력 비활성화",
      ),
      productIds: [],
    };
    const productId = String(item?.productId || "");

    if (productId && !group.productIds.includes(productId)) {
      group.productIds.push(productId);
    }

    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    count: group.productIds.length,
    message:
      `${group.page}페이지에서 ${group.reason} 상태인 ` +
      `${group.productIds.length}개 상품(${group.productIds.join(", ")})의 ` +
      `장바구니 재고 수집을 제외하고 나머지 상품을 수집했습니다.`,
  }));
}

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
  const blockController = new AbortController();
  const runSignal = signal
    ? AbortSignal.any([signal, blockController.signal])
    : blockController.signal;
  let browser = null;
  let context = null;
  let blockGuard = null;
  let releaseAbort = () => { };

  try {
    throwIfAborted(runSignal);
    onProgress({
      stage: "starting",
      message: "천유닷컴 브라우저를 준비하고 있습니다.",
    });

    browser = await browserType.launch({
      headless: config.headless,
    });
    releaseAbort = bindAbortToBrowser(runSignal, browser);
    throwIfAborted(runSignal);

    context = await browser.newContext({
      viewport: config.viewport,
      userAgent: config.userAgent,
      ...(config.proxy ? { proxy: config.proxy } : {}),
    });

    blockGuard = installHttpBlockGuard(context, {
      hostname: new URL(config.baseUrl).hostname,
      label: "천유",
      onBlocked: (error) => {
        blockController.abort();
        onProgress({
          stage: "blocked",
          message: error.message,
        });
      },
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
    const verifyLoginWhilePreparingCart =
      config.collectionMode === "general" &&
      Boolean(config.clearCartBefore);
    const loginResult = await loginCheonyu(
      page,
      config,
      runSignal,
      {
        verificationTarget: verifyLoginWhilePreparingCart ? "cart" : "list",
      },
    );
    throwIfAborted(runSignal);

    let clearBeforeResult = null;

    if (config.clearCartBefore) {
      onProgress({
        stage: "preparing",
        message: "기존 장바구니를 정리하고 있습니다.",
      });
      clearBeforeResult = await clearCartAll(page, context, config, {
        cachedCartHtml:
          loginResult?.verificationTarget === "cart"
            ? loginResult.html
            : null,
      });
      throwIfAborted(runSignal);
    }

    const {
      allTargets,
      allPopupOptionRows,
      allProducts,
      allExcludedProducts,
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
      runSignal,
    );

    throwIfAborted(runSignal);

    const collectionWarnings = createCheonyuCollectionWarnings(
      allExcludedProducts,
    );
    const excludedProductCount = allExcludedProducts.length;

    const targetProducts = Array.from(
      new Map(allTargets.map((item) => [String(item.productId), item])).values(),
    );
    const bulkResults = pageResults
      .map((item) => item.bulkResult)
      .filter(Boolean);
    const unavailableProductIds = Array.from(new Set(
      bulkResults.flatMap(
        (result) => result.unavailableProductIds || [],
      ).map(String),
    ));

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
      excludedProductCount,
      excludedProducts: allExcludedProducts,
      collectionWarnings,
      elapsedMs: performance.now() - startedAt,
    });

    const {
      cartHtml,
      inventoryItems,
      clearAfterResult,
      coverage,
    } = await probeCheonyuCartStock(
      page,
      context,
      config,
      targetProducts,
      {
        probeQty: config.cartQty || 999,
        clearAfter: config.clearCartAfter,
        popupOptionRows: allPopupOptionRows,
        unavailableProductIds,
        onProgress: (progress) => {
          onProgress({
            ...progress,
            elapsedMs: performance.now() - startedAt,
          });
        },
        signal: runSignal,
      },
    );

    throwIfAborted(runSignal);

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
        excludedProductCount,
        excludedProducts: allExcludedProducts,
        collectionWarnings,
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
        runSignal,
      );

      throwIfAborted(runSignal);
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
      excludedProductCount,
      excludedProducts: allExcludedProducts,
      collectionWarnings,
      productSummaryCount: productSummaries.length,
      inventoryRowCount: inventoryItems.length,
      popupOptionRowCount: allPopupOptionRows.length,
      cartCoverage: coverage,
      soldOutProductCount,
      clearBeforeResult,
      clearAfterResult,
    };

    onProgress({
      stage: "completed",
      message: excludedProductCount > 0
        ? `천유닷컴 수집이 완료되었습니다. 장바구니 재고 수집에서 ` +
          `${excludedProductCount}개 상품을 제외한 사유를 확인하세요.`
        : "천유닷컴 수집이 완료되었습니다.",
      pageRange,
      detectedTotalProductCount: summary.detectedTotalProductCount,
      collectedProductCount: summary.collectedProductCount,
      targetProductCount: summary.targetProductCount,
      productSummaryCount: summary.productSummaryCount,
      soldOutProductCount,
      excludedProductCount,
      excludedProducts: allExcludedProducts,
      collectionWarnings,
      elapsedMs,
      elapsedText: summary.elapsedText,
    });

    throwIfAborted(runSignal);

    return {
      summary,
      inventoryItems,
      productSummaries,
      products: allProducts,
      detailItems,
      popupOptionItems: allPopupOptionRows,
      debugFiles: {
        "debug-cart.html": cartHtml,
        ...(excludedProductCount > 0
          ? {
              "collection-warnings.json": JSON.stringify(
                {
                  excludedProductCount,
                  excludedProducts: allExcludedProducts,
                  collectionWarnings,
                },
                null,
                2,
              ),
            }
          : {}),
      },
    };
  } catch (error) {
    throw blockGuard?.getError() || error;
  } finally {
    blockGuard?.dispose();
    releaseAbort();
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
  }
}

module.exports = {
  run: runCheonyu,
  runCheonyu,
};

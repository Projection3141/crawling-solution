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
const { installHttpBlockGuard, replacePage } = require("../../utils/site-safety");
const { buildProductSummaries } = require("../../utils/inventory");
const { clearCartAll } = require("./cart");
const { probeCheonyuCartStock } = require("./cart-stock");
const { collectCheonyuDetails } = require("./detail");
const { bulkAddPages, loginCheonyu } = require("./site");

const CHEONYU_LOG_COLORS = {
  reset: "\x1b[0m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  success: "\x1b[32m",
  info: "\x1b[90m",
};
const CHEONYU_LOG_LABELS = {
  error: "[ERROR]",
  warn: "[WARN]",
  success: "[SUCCESS]",
  info: "[INFO]",
};
const CHEONYU_LOG_ENABLED_COLOR = process.stdout?.isTTY;

function logCheonyu(level, message, details) {
  const color = CHEONYU_LOG_ENABLED_COLOR ? CHEONYU_LOG_COLORS[level] : "";
  const reset = CHEONYU_LOG_ENABLED_COLOR ? CHEONYU_LOG_COLORS.reset : "";
  const label = CHEONYU_LOG_LABELS[level] || "[INFO]";
  const line = `${color}${label} ${message}${reset}`;

  if (details !== undefined) {
    if (level === "error" && console.error) {
      console.error(line, details);
      return;
    }

    console.log(line, details);
    return;
  }

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

const logCheonyuError = (message, details) => logCheonyu("error", message, details);
const logCheonyuWarn = (message, details) => logCheonyu("warn", message, details);
const logCheonyuSuccess = (message, details) => logCheonyu("success", message, details);
const logCheonyuInfo = (message, details) => logCheonyu("info", message, details);

const CHEONYU_COLLECTION_CHUNK_SIZE = 2000;
const CHEONYU_CYCLE_RELOAD_HEALTH_WINDOW = 5;
const CHEONYU_CYCLE_SLOWDOWN_WARN_RATIO = 2.2;
const CHEONYU_CYCLE_DOM_NODE_GROWTH_RATIO = 1.6;
const CHEONYU_CYCLE_DOM_NODE_SPIKE_THRESHOLD = 15000;
const CHEONYU_CYCLE_HEAP_GROWTH_RATIO = 1.45;
const CHEONYU_CYCLE_HEAP_SPIKE_MB = 120;
const CHEONYU_FORCE_REFRESH_EVERY_CYCLES = 6;

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

function summarizeCheonyuCycleHealth(cycleResults = []) {
  const normalized = cycleResults
    .map((item) => ({
      page: Number(item?.page) || 0,
      elapsedMs: Number(item?.elapsedMs) || 0,
      domNodeCountAfter: Number(item?.health?.after?.domNodeCount || 0),
      domNodeCountBefore: Number(item?.health?.before?.domNodeCount || 0),
      visibleNodeCountAfter: Number(item?.health?.after?.visibleNodeCount || 0),
      visibleNodeCountBefore: Number(item?.health?.before?.visibleNodeCount || 0),
      heapUsedMBAfter: Number(item?.health?.after?.memory?.usedJSHeapSizeMB || 0),
      heapUsedMBBefore: Number(item?.health?.before?.memory?.usedJSHeapSizeMB || 0),
    }))
    .filter(
      (value) =>
        value.domNodeCountAfter > 0 || value.heapUsedMBAfter > 0 || value.elapsedMs > 0,
    );

  if (normalized.length < 1) return null;

  const byDomAfter = normalized.map((item) => item.domNodeCountAfter);
  const byHeapAfter = normalized.map((item) => item.heapUsedMBAfter);

  const maxDomNodes = Math.max(...byDomAfter);
  const maxHeapUsedMB = Math.max(...byHeapAfter);
  const avgDomNodes = +(
    byDomAfter.reduce((a, b) => a + b, 0) / byDomAfter.length
  ).toFixed(2);
  const avgHeapUsedMB = +(
    byHeapAfter.reduce((a, b) => a + b, 0) / byHeapAfter.length
  ).toFixed(2);
  const totalElapsedMs = normalized.reduce((acc, item) => acc + item.elapsedMs, 0);
  const maxVisibleNodes = Math.max(
    ...normalized.map((item) => item.visibleNodeCountAfter),
  );

  return {
    pageCount: normalized.length,
    totalElapsedMs: +totalElapsedMs.toFixed(2),
    maxDomNodes,
    maxVisibleNodes,
    avgDomNodes,
    avgHeapUsedMB,
    maxHeapUsedMB,
    firstPageDomNodes: normalized[0].domNodeCountAfter,
    lastPageDomNodes: normalized[normalized.length - 1].domNodeCountAfter,
  };
}

function getAverageMsPerProduct(cycleHealth = []) {
  const withData = cycleHealth.filter((item) => item && item.msPerProduct > 0);
  if (withData.length < 2) return 0;

  return +(
    withData.slice(0, withData.length - 1).reduce((sum, item) => sum + item.msPerProduct, 0) /
    (withData.length - 1)
  ).toFixed(2);
}

function buildCheonyuCycleProfile({
  cycleNo,
  requestCount,
  collectedNow,
  cycleResult,
  elapsedMs,
  stopReason,
}) {
  const pageResults = Array.isArray(cycleResult?.pageResults)
    ? cycleResult.pageResults
    : [];
  const firstHealth = pageResults[0]?.health?.before || {};
  const lastHealth = pageResults[pageResults.length - 1]?.health?.after || {};
  const cycleHealthSummary = summarizeCheonyuCycleHealth(pageResults);

  return {
    cycleNo,
    requestCount,
    collectedNow,
    stopReason: String(stopReason || ""),
    elapsedMs: +elapsedMs.toFixed(2),
    msPerProduct: collectedNow > 0 ? +(elapsedMs / collectedNow).toFixed(2) : 0,
    collectedPageCount: pageResults.length,
    cycleStartDomNodes: Number(firstHealth.domNodeCount || 0),
    cycleEndDomNodes: Number(lastHealth.domNodeCount || 0),
    cycleStartVisibleNodes: Number(firstHealth.visibleNodeCount || 0),
    cycleEndVisibleNodes: Number(lastHealth.visibleNodeCount || 0),
    cycleStartUsedHeapMB: Number(firstHealth?.memory?.usedJSHeapSizeMB || 0),
    cycleEndUsedHeapMB: Number(lastHealth?.memory?.usedJSHeapSizeMB || 0),
    cycleHealthSummary,
  };
}

function detectCheonyuCycleRiskSignals(cycleHealthHistory = []) {
  if (cycleHealthHistory.length < 2) return [];

  const window = cycleHealthHistory.slice(
    -Math.min(CHEONYU_CYCLE_RELOAD_HEALTH_WINDOW, cycleHealthHistory.length),
  );
  const latest = window[window.length - 1];
  const previous = window.slice(0, -1);

  if (!latest || previous.length < 2) return [];

  const reasons = [];
  const previousAvgMsPerProduct = getAverageMsPerProduct(window);
  if (
    previousAvgMsPerProduct > 0 &&
    latest.msPerProduct > 0 &&
    latest.msPerProduct > previousAvgMsPerProduct * CHEONYU_CYCLE_SLOWDOWN_WARN_RATIO
  ) {
    reasons.push("slowdown");
  }

  const prevMaxDomNodes = Math.max(
    ...previous.map((item) => Number(item.cycleHealthSummary?.maxDomNodes || 0)),
  );
  if (
    prevMaxDomNodes > 0 &&
    latest.cycleHealthSummary?.maxDomNodes > CHEONYU_CYCLE_DOM_NODE_SPIKE_THRESHOLD &&
    latest.cycleHealthSummary.maxDomNodes > prevMaxDomNodes * CHEONYU_CYCLE_DOM_NODE_GROWTH_RATIO
  ) {
    reasons.push("dom-node-growth");
  }

  const prevMaxHeapMB = Math.max(
    ...previous.map((item) =>
      Number(item.cycleHealthSummary?.maxHeapUsedMB || 0),
    ),
  );
  if (
    prevMaxHeapMB > CHEONYU_CYCLE_HEAP_SPIKE_MB &&
    latest.cycleHealthSummary?.maxHeapUsedMB >
      prevMaxHeapMB * CHEONYU_CYCLE_HEAP_GROWTH_RATIO
  ) {
    reasons.push("js-heap-growth");
  }

  return reasons;
}

function formatCycleRiskReason(reasons = [], isForcedRefresh = false) {
  const tags = new Set(
    reasons
      .map((reason) => String(reason || "").trim())
      .filter(Boolean),
  );
  const list = Array.from(tags);

  if (isForcedRefresh) {
    list.unshift("periodic-refresh");
  }

  if (list.length < 1) return "";

  return list.join(", ");
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
  const cycleHealthHistory = [];
  const maintenanceHistory = [];
  let page = null;

  const clearClientCaches = async (targetPage) => {
    await targetPage.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // no-op
      }

      if (
        typeof window.caches !== "object" ||
        !window.caches ||
        typeof window.caches.keys !== "function"
      ) {
        return;
      }

      return window.caches.keys().then((keys) =>
        Promise.all((keys || []).map((key) => window.caches.delete(key))),
      );
    }).catch(() => null);
  };
  const recycleCheonyuPage = async (targetPage, cycleNo, reason) => {
    logCheonyuWarn(
      `[RUN] 차수 ${cycleNo} 수집 상태 이상 감지(${reason})로 ` +
        `브라우저 탭을 교체해 상태를 정리합니다.`,
    );

    try {
      const recycled = await replacePage(targetPage, {
        signal: runSignal,
        closeOldPage: true,
        setupPage: async (nextPage) => {
          installDialogAutoAccept(nextPage);
          await clearClientCaches(nextPage);
        },
      });

      maintenanceHistory.push({
        cycleNo,
        reason,
        action: "replacePage",
        at: new Date().toISOString(),
      });

      return recycled;
    } catch (error) {
      logCheonyuWarn(
        `[RUN] 차수 ${cycleNo}에서 탭 교체 실패: ${error?.message || error}` +
          " - 페이지 새로고침으로 대체합니다.",
      );
      await targetPage.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await clearClientCaches(targetPage);
      return targetPage;
    }
  };

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

    page = await context.newPage();

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

    let allTargets = [];
    let allPopupOptionRows = [];
    const allProductsMap = new Map();
    const allExcludedProductsMap = new Map();
    const allPageResults = [];
    let pageRange = null;
    let detectedTotalProductCount = null;
    const seenProductIds = new Set();
    let loop = 0;

    while (true) {
      loop += 1;

      const totalDetectedForLoop = Number(detectedTotalProductCount);
      const remainingForDetectedCount = totalDetectedForLoop > 0
        ? Math.max(0, totalDetectedForLoop - seenProductIds.size)
        : CHEONYU_COLLECTION_CHUNK_SIZE;
      const requestCount = totalDetectedForLoop > 0
        ? Math.min(CHEONYU_COLLECTION_CHUNK_SIZE, remainingForDetectedCount)
        : CHEONYU_COLLECTION_CHUNK_SIZE;

      if (requestCount < 1) {
        break;
      }

      const cycleNo = loop;

      onProgress({
        stage: "collecting",
        message: `천유 상품 수집 ${cycleNo}차: 이번 차수 ${requestCount}개 처리`,
        pageRange,
        detectedTotalProductCount: detectedTotalProductCount || 0,
        collectedProductCount: seenProductIds.size,
      });

      const cycleStartAt = performance.now();
      const cycleResult = await bulkAddPages(
        page,
        config,
        (progress) => {
          onProgress({
            ...progress,
            cycleNo,
            elapsedMs: performance.now() - startedAt,
          });
        },
        runSignal,
        {
          maxProductCount: requestCount,
          skipProductIds: Array.from(seenProductIds),
        },
      );
      const cycleElapsedMs = performance.now() - cycleStartAt;
      const cycleProfile = buildCheonyuCycleProfile({
        cycleNo,
        requestCount,
        collectedNow: Number(cycleResult?.collectedProductCount || 0),
        cycleResult,
        elapsedMs: cycleElapsedMs,
        stopReason: cycleResult?.pageRange?.stopReason,
      });
      const collectedNow = Number(cycleResult?.collectedProductCount || 0);
      const cycleStopReason = String(cycleResult?.pageRange?.stopReason || "");
      const cycleRiskSignals = detectCheonyuCycleRiskSignals(
        cycleHealthHistory.concat(cycleProfile),
      );
      const isForcedRefresh = cycleNo > 0
        ? cycleNo % CHEONYU_FORCE_REFRESH_EVERY_CYCLES === 0
        : false;
      const cycleRiskLabel = formatCycleRiskReason(
        cycleRiskSignals,
        isForcedRefresh,
      );

      pageRange = cycleResult.pageRange;

      const detectedFromCycle = Number(
        cycleResult?.pageRange?.detectedTotalProductCount,
      );
      if (Number.isFinite(detectedFromCycle) && detectedFromCycle > 0) {
        detectedTotalProductCount = detectedFromCycle;
      }

      for (const product of cycleResult.allProducts || []) {
        const productId = String(product?.productId || "").trim();

        if (!productId) continue;

        if (!allProductsMap.has(productId)) {
          allProductsMap.set(productId, product);
        }

        seenProductIds.add(productId);
      }

      for (const product of cycleResult.allTargets || []) {
        allTargets.push(product);
      }

      for (const product of cycleResult.allExcludedProducts || []) {
        const productId = String(product?.productId || "").trim();

        if (!productId) continue;

        if (!allExcludedProductsMap.has(productId)) {
          allExcludedProductsMap.set(productId, product);
        }
      }

      allPopupOptionRows = [
        ...allPopupOptionRows,
        ...(cycleResult.allPopupOptionRows || []),
      ];
      allPageResults.push(...(cycleResult.pageResults || []));
      cycleHealthHistory.push(cycleProfile);
      const cycleHealthHistoryLimit = CHEONYU_CYCLE_RELOAD_HEALTH_WINDOW * 3;
      if (cycleHealthHistory.length > cycleHealthHistoryLimit) {
        cycleHealthHistory.splice(
          0,
          cycleHealthHistory.length - cycleHealthHistoryLimit,
        );
      }

      onProgress({
        stage: "collecting",
        message: `천유 ${cycleNo}차 완료 · 수집=${collectedNow}개, ` +
          `평균 ${cycleProfile.msPerProduct}ms/개`,
        cycleNo,
        cycleHealthProfile: cycleProfile,
        cycleRiskSignals,
        cycleRiskLabel,
        pageRange,
        detectedTotalProductCount: detectedTotalProductCount || 0,
        collectedProductCount: seenProductIds.size,
      });

      if (
        cycleRiskLabel &&
        cycleStopReason === "limit-reached" &&
        collectedNow > 0
      ) {
        logCheonyuWarn(
          `[RUN] 차수 ${cycleNo} 건강도 이상 감지: ${cycleRiskLabel}`,
          cycleProfile,
        );

        page = await recycleCheonyuPage(page, cycleNo, cycleRiskLabel);
      }

      if (collectedNow < 1) {
        break;
      }

      const isCompletedByDetectLimit = Number.isFinite(
        Number(detectedTotalProductCount),
      ) && Number(detectedTotalProductCount) > 0
        ? seenProductIds.size >= Number(detectedTotalProductCount)
        : false;
      if (isCompletedByDetectLimit) break;

      if (cycleStopReason !== "limit-reached") {
        break;
      }
    }

    const allProducts = Array.from(allProductsMap.values());
    const allExcludedProducts = Array.from(allExcludedProductsMap.values());

    if (!pageRange) {
      throw new Error("천유 상품 목록 수집에 실패했습니다.");
    }

    throwIfAborted(runSignal);

    const collectionWarnings = createCheonyuCollectionWarnings(
      allExcludedProducts,
    );
    const excludedProductCount = allExcludedProducts.length;
    const exclusionReasons = new Map();
    for (const item of allExcludedProducts) {
      const reasonCode = String(item?.reasonCode || "UNKNOWN");
      const reason = String(item?.reason || reasonCode);
      const current = exclusionReasons.get(reasonCode) || {
        reasonCode,
        reason,
        count: 0,
        sampleProductIds: [],
      };

      current.count += 1;
      const productId = String(item?.productId || "").trim();

      if (productId && current.sampleProductIds.length < 3) {
        current.sampleProductIds.push(productId);
      }

      exclusionReasons.set(reasonCode, current);
    }
    const exclusionReasonSummary = Array.from(exclusionReasons.values())
      .sort((a, b) => b.count - a.count)
      .map((item) =>
        `${item.reason} ${item.count}건` +
        (item.sampleProductIds.length > 0
          ? ` (${item.sampleProductIds.join(", ")})`
          : ""),
      )
      .join("; ");
    const collectionWarningReasonStats = Array.from(exclusionReasons.values())
      .sort((a, b) => b.count - a.count)
      .map((item) => ({
        reasonCode: item.reasonCode,
        reason: item.reason,
        count: item.count,
        sampleProductIds: item.sampleProductIds,
      }));
    const targetProducts = Array.from(
      new Map(allTargets.map((item) => [String(item.productId), item])).values(),
    );
    const disabledExclusionCount = allExcludedProducts
      .filter((item) => String(item?.reasonCode || "") === "LIST_CONTROLS_DISABLED")
      .length;
    const totalProductCountForFailureThreshold =
      Number.isFinite(Number(pageRange?.detectedTotalProductCount)) &&
      Number(pageRange.detectedTotalProductCount) > 0
        ? Number(pageRange.detectedTotalProductCount)
        : allProducts.length;
    const disabledExclusionRate = totalProductCountForFailureThreshold > 0
      ? disabledExclusionCount / totalProductCountForFailureThreshold
      : 0;
    const disabledExclusionRateLimit = 0.001; // 0.1%

    if (
      disabledExclusionCount > 0 &&
      totalProductCountForFailureThreshold > 0 &&
      disabledExclusionRate >= disabledExclusionRateLimit
    ) {
      throw new Error(
        `체크박스 또는 수량 입력 비활성화로 제외된 상품이 ` +
          `전체 ${Math.round(totalProductCountForFailureThreshold)}개 중 ` +
          `${disabledExclusionCount}개(약 ${(disabledExclusionRate * 100).toFixed(3)}%)로 ` +
          `0.1%(=${(disabledExclusionRateLimit * 100).toFixed(1)}%) 이상이어서 수집을 중단합니다.`,
      );
    }

    const bulkResults = allPageResults
      .map((item) => item.bulkResult)
      .filter(Boolean);
    const unavailableProductIds = Array.from(new Set(
      bulkResults.flatMap(
        (result) => result.unavailableProductIds || [],
      ).map(String),
    ));

    logCheonyuInfo("[CHEONYU] collectionMode:", config.collectionMode);
    logCheonyuInfo("[CHEONYU] allProducts:", allProducts.length);
    logCheonyuInfo("[CHEONYU] targetProducts:", targetProducts.length);

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
      collectedPages: Array.from(
        new Set(allPageResults.map((item) => item.page)),
      ).sort((a, b) => a - b),
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
      cycleCount: cycleHealthHistory.length,
      cycleHealthHistory,
      maintenanceHistory,
      maintenanceCount: maintenanceHistory.length,
    };

    onProgress({
      stage: "completed",
      message: excludedProductCount > 0
        ? `천유닷컴 수집이 완료되었습니다. 장바구니 재고 수집에서 ` +
          `${excludedProductCount}개 상품을 제외했으며 사유는 [${exclusionReasonSummary}]`
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

    if (excludedProductCount > 0) {
      logCheonyuWarn(
        `천유 수집 완료: 제외된 상품 ${excludedProductCount}건` +
          (exclusionReasonSummary
            ? `. 사유별 처리 내역: ${exclusionReasonSummary}`
            : ""),
      );
    } else {
      logCheonyuSuccess("천유 수집 완료: 제외된 상품 없음");
    }

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
        "collection-performance.json": JSON.stringify(
          {
            cycleHealthHistory,
            maintenanceHistory,
            maintenanceCount: maintenanceHistory.length,
            cycleCount: cycleHealthHistory.length,
            chunkSize: CHEONYU_COLLECTION_CHUNK_SIZE,
            thresholds: {
              cycleSlowdownWarnRatio: CHEONYU_CYCLE_SLOWDOWN_WARN_RATIO,
              domGrowthRatio: CHEONYU_CYCLE_DOM_NODE_GROWTH_RATIO,
              domSpikeThreshold: CHEONYU_CYCLE_DOM_NODE_SPIKE_THRESHOLD,
              heapGrowthRatio: CHEONYU_CYCLE_HEAP_GROWTH_RATIO,
              heapSpikeMB: CHEONYU_CYCLE_HEAP_SPIKE_MB,
              forceRefreshEveryCycles: CHEONYU_FORCE_REFRESH_EVERY_CYCLES,
            },
          },
          null,
          2,
        ),
        ...(excludedProductCount > 0
          ? {
              "collection-warnings.json": JSON.stringify(
                {
                  excludedProductCount,
                  excludedProducts: allExcludedProducts,
                  collectionWarnings,
                  collectionWarningReasonStats,
                  cycleHealthHistory,
                  maintenanceHistory,
                },
                null,
                2,
              ),
            }
          : {}),
      },
    };
  } catch (error) {
    logCheonyuError(
      "천유 컬렉션 실행 실패",
      error && String(error.message || error),
    );
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

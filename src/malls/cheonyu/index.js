// src/malls/cheonyu/index.js

const { performance } = require("node:perf_hooks");
const { chromium } = require("playwright");
const {
  bindAbortToBrowser,
  installDialogAutoAccept,
  getLightweightLaunchArgs,
  installLightweightNetworkPolicy,
} = require("../../utils/browser");
const {
  formatMs,
  getMemoryMb,
  throwIfAborted,
} = require("../../utils/common");
const { installHttpBlockGuard, replacePage } = require("../../utils/site-safety");
const { createNetworkUsageTracker } = require("../../utils/network-usage");
const { buildProductSummaries } = require("../../utils/inventory");
const {
  recordDetailAttempts,
  selectPendingDetailProductIds,
} = require("../../utils/detail-collection-state");
const { clearCartAll } = require("./cart");
const {
  createCheonyuPopupInventoryItems,
  probeCheonyuCartStock,
} = require("./cart-stock");
const { collectCheonyuDetails } = require("./detail");
const {
  bulkAddPages,
  loginCheonyu,
  resetCheonyuPopupWorkloadTracker,
} = require("./site");

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

function getCheonyuExclusionDisplayReason(item = {}) {
  const reasonCode = String(item?.reasonCode || "");
  const reason = String(item?.reason || "").trim();

  if (reasonCode === "LIST_CONTROLS_DISABLED") {
    return "상품 체크박스 또는 수량 입력 비활성화";
  }

  if (
    reasonCode === "CHEONYU_POPUP_PARTIAL_DEFERRED_FAILED" ||
    reason.includes("팝업에 생성되지")
  ) {
    return "팝업에 생성되지 않음";
  }

  return reason || reasonCode || "사유 미확인";
}

function createCheonyuCollectionWarnings(excludedProducts = []) {
  const groups = new Map();

  for (const item of excludedProducts) {
    const page = Number(item?.page) || 0;
    const reason = getCheonyuExclusionDisplayReason(item);
    const reasonCode = String(item?.reasonCode || "UNKNOWN");
    const group = groups.get(reason) || {
      code: reasonCode,
      reason,
      pages: new Map(),
      productIds: new Set(),
    };
    const pageGroup = group.pages.get(page) || {
      page,
      productIds: new Set(),
      unknownCount: 0,
    };
    const productId = String(item?.productId || "").trim();

    if (productId) {
      pageGroup.productIds.add(productId);
      group.productIds.add(productId);
    } else {
      pageGroup.unknownCount += 1;
    }

    group.pages.set(page, pageGroup);
    groups.set(reason, group);
  }

  return Array.from(groups.values()).map((group) => {
    const pages = Array.from(group.pages.values())
      .map((pageGroup) => ({
        page: pageGroup.page,
        count: pageGroup.productIds.size + pageGroup.unknownCount,
        productIds: Array.from(pageGroup.productIds),
      }))
      .sort((a, b) => {
        if (a.page === 0) return 1;
        if (b.page === 0) return -1;
        return a.page - b.page;
      });
    const pageSummary = pages
      .map((item) =>
        item.page > 0
          ? `${item.page}페이지(${item.count})`
          : `페이지 미확인(${item.count})`,
      )
      .join(", ");

    return {
      code: group.code,
      reason: group.reason,
      page: 0,
      pages,
      count: pages.reduce((sum, item) => sum + item.count, 0),
      productIds: Array.from(group.productIds),
      message: `장바구니 재고 수집 제외 : ${group.reason} (${pageSummary})`,
    };
  });
}

/** 2,000개 단위 장바구니 판독 결과를 전체 실행 결과로 합친다. */
function mergeCheonyuCycleCoverages(cycleCoverages = []) {
  const entries = cycleCoverages
    .map((item) => item?.coverage)
    .filter(Boolean);
  const uniqueIds = (field) => Array.from(new Set(
    entries.flatMap((coverage) => coverage?.[field] || []).map(String),
  ));
  const rowCountsAvailable =
    entries.length > 0 &&
    entries.every((coverage) => Number.isFinite(coverage.expectedRowCount));

  return {
    complete: entries.every((coverage) => coverage.complete === true),
    optionCoverageComplete: entries.every(
      (coverage) => coverage.optionCoverageComplete === true,
    ),
    expectedProductCount: entries.reduce(
      (sum, coverage) => sum + (Number(coverage.expectedProductCount) || 0),
      0,
    ),
    actualProductCount: entries.reduce(
      (sum, coverage) => sum + (Number(coverage.actualProductCount) || 0),
      0,
    ),
    expectedRowCount: rowCountsAvailable
      ? entries.reduce(
        (sum, coverage) => sum + (Number(coverage.expectedRowCount) || 0),
        0,
      )
      : null,
    actualRowCount: entries.reduce(
      (sum, coverage) => sum + (Number(coverage.actualRowCount) || 0),
      0,
    ),
    rowCoverageAvailable: entries.some(
      (coverage) => coverage.rowCoverageAvailable === true,
    ),
    expectedProductIds: uniqueIds("expectedProductIds"),
    actualProductIds: uniqueIds("actualProductIds"),
    missingProductIds: uniqueIds("missingProductIds"),
    partialProductIds: uniqueIds("partialProductIds"),
    missingOptionRows: entries.flatMap(
      (coverage) => coverage.missingOptionRows || [],
    ),
    extraOptionRows: entries.flatMap(
      (coverage) => coverage.extraOptionRows || [],
    ),
    unavailableProductIds: uniqueIds("unavailableProductIds"),
  };
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
    onCycleArchive = null,
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
  let lightweightNetworkPolicy = null;
  let releaseAbort = () => { };
  const cycleHealthHistory = [];
  const maintenanceHistory = [];
  let page = null;
  const networkUsageTracker = createNetworkUsageTracker({
    label: "천유 수집",
  });
  const initialProxyUsage = {
    proxyProfileId: config.proxyProfileId,
    proxyProfileName: config.proxyProfileName,
    proxy: config.proxy,
  };
  const proxyRotation = Array.isArray(config.proxyRotation)
    ? config.proxyRotation.filter((item) => item?.proxy)
    : [];
  let currentProxyRotationIndex = 0;
  let proxyRotationPageStart = null;
  resetCheonyuPopupWorkloadTracker(runSignal);
  logCheonyuInfo(
    "[RUN] 새 수집 실행 상태 초기화: 프록시 순번 1, 새 브라우저·컨텍스트, " +
      "팝업 누적량 0, 2,000개 사이클 0",
  );

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
      const activeProxyUsage =
        proxyRotation[currentProxyRotationIndex] || initialProxyUsage;
      const recycled = await replacePage(targetPage, {
        signal: runSignal,
        closeOldPage: true,
        setupPage: async (nextPage) => {
          await Promise.all([
            networkUsageTracker.trackPage(nextPage, activeProxyUsage),
            lightweightNetworkPolicy?.configurePage?.(nextPage),
          ]);
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

  const resetCheonyuPageKeepingContext = async ({
    currentPage,
    pageNo,
    pageOffset,
  }) => {
    throwIfAborted(runSignal);
    logCheonyuInfo(
      `[TAB] ${pageNo}페이지 시작 전 5페이지 누적 상태를 정리합니다. ` +
        "프록시·세션·컨텍스트 캐시는 유지합니다.",
    );
    onProgress({
      stage: "page-reset",
      message:
        `${pageNo}페이지 시작 전 기존 탭을 닫고 ` +
        "같은 프록시 세션에서 새 탭을 준비합니다.",
      currentPage: pageNo,
    });

    try {
      const activeProxyUsage =
        proxyRotation[currentProxyRotationIndex] || initialProxyUsage;
      const recycled = await replacePage(currentPage, {
        signal: runSignal,
        closeOldPage: true,
        setupPage: async (nextPage) => {
          await Promise.all([
            networkUsageTracker.trackPage(nextPage, activeProxyUsage),
            lightweightNetworkPolicy?.configurePage?.(nextPage),
          ]);
          installDialogAutoAccept(nextPage);
        },
      });
      page = recycled;
      maintenanceHistory.push({
        pageNo,
        pageOffset,
        action: "replacePageKeepContext",
        proxyProfileId: activeProxyUsage?.proxyProfileId,
        proxyProfileName: activeProxyUsage?.proxyProfileName,
        at: new Date().toISOString(),
      });
      return recycled;
    } catch (error) {
      logCheonyuWarn(
        `[TAB] ${pageNo}페이지 시작 전 탭 교체 실패: ` +
          `${error?.message || error} - 기존 탭으로 계속 진행합니다.`,
      );
      return currentPage;
    }
  };

  const rotateCheonyuProxyPage = async ({
    currentPage,
    pageNo,
    rotationIndex,
    forceRestart = false,
  }) => {
    if (proxyRotation.length < 1 && !forceRestart) return currentPage;

    const rotationPool = proxyRotation.length > 0
      ? proxyRotation
      : [initialProxyUsage];

    const normalizedRotationIndex = Math.max(0, Number(rotationIndex) || 0);
    const nextIndex = forceRestart
      ? (currentProxyRotationIndex + 1) % rotationPool.length
      : normalizedRotationIndex % rotationPool.length;
    const nextProxy = rotationPool[nextIndex];
    const nextProxyName = nextProxy.proxyProfileName || "직접 연결";

    if (!forceRestart && nextIndex === currentProxyRotationIndex) {
      if (!Number.isFinite(Number(proxyRotationPageStart))) {
        proxyRotationPageStart = pageNo;
      }
      return currentPage;
    }

    throwIfAborted(runSignal);
    onProgress({
      stage: "proxy-rotation",
      message:
        `${pageNo}페이지부터 현재 사용 프록시의 다음 순번 · ` +
        `${nextProxyName}으로 변경 후 브라우저 세션을 재실행합니다.`,
      currentPage: pageNo,
      proxyProfileName: nextProxyName,
    });
    logCheonyuInfo(
      `[PROXY] ${pageNo}페이지부터 ${nextProxyName} 사용 ` +
        `(${nextIndex + 1}/${rotationPool.length})`,
    );

    const previousContext = context;
    const previousBlockGuard = blockGuard;
    let nextContext = null;
    let nextBlockGuard = null;
    let nextNetworkPolicy = null;
    let nextPage = null;

    try {
      nextContext = await browser.newContext({
        viewport: config.viewport,
        userAgent: config.userAgent,
        ...(nextProxy.proxy ? { proxy: nextProxy.proxy } : {}),
      });
      await networkUsageTracker.trackContext(nextContext, nextProxy);
      nextBlockGuard = installHttpBlockGuard(nextContext, {
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
      nextNetworkPolicy = await installLightweightNetworkPolicy(nextContext, {
        showBrowser: config.showBrowser,
      });
      nextPage = await nextContext.newPage();
      await Promise.all([
        networkUsageTracker.trackPage(nextPage, nextProxy),
        nextNetworkPolicy?.configurePage?.(nextPage),
      ]);
      installDialogAutoAccept(nextPage);
      await loginCheonyu(
        nextPage,
        config,
        runSignal,
        {
          verificationTarget: "list",
        },
      );
    } catch (error) {
      await Promise.resolve(nextBlockGuard?.dispose?.()).catch(() => null);
      await nextContext?.close().catch(() => null);
      throw error;
    }

    await Promise.resolve(previousBlockGuard?.dispose?.()).catch(() => null);
    await previousContext?.close().catch(() => null);
    context = nextContext;
    blockGuard = nextBlockGuard;
    lightweightNetworkPolicy = nextNetworkPolicy;
    page = nextPage;
    currentProxyRotationIndex = nextIndex;
    proxyRotationPageStart = pageNo;
    maintenanceHistory.push({
      pageNo,
      action: "rotateProxyContext",
      proxyProfileId: nextProxy.proxyProfileId,
      proxyProfileName: nextProxyName,
      rotationIndex: normalizedRotationIndex,
      at: new Date().toISOString(),
    });

    return page;
  };

  const recoverCheonyuListPage = async ({
    currentPage,
    pageNo,
    mode,
    error,
  }) => {
    throwIfAborted(runSignal);

    if (mode === "replace-tab" || mode === "popup-overload") {
      const isPopupOverloadRecovery = mode === "popup-overload";
      const activeProxyUsage =
        proxyRotation[currentProxyRotationIndex] || initialProxyUsage;
      onProgress({
        stage: "page-recovery",
        message: isPopupOverloadRecovery
          ? `${pageNo}페이지 팝업 누락률이 10%를 초과해 새 탭에서 누락 상품만 재시도합니다.`
          : `${pageNo}페이지 이동 실패로 같은 프록시 컨텍스트에서 수집 탭을 교체합니다.`,
        currentPage: pageNo,
      });
      const nextPage = await replacePage(currentPage, {
        signal: runSignal,
        closeOldPage: true,
        setupPage: async (replacementPage) => {
          await Promise.all([
            networkUsageTracker.trackPage(
              replacementPage,
              activeProxyUsage,
            ),
            lightweightNetworkPolicy?.configurePage?.(replacementPage),
          ]);
          installDialogAutoAccept(replacementPage);
        },
      });
      page = nextPage;
      maintenanceHistory.push({
        pageNo,
        action: isPopupOverloadRecovery
          ? "recoverPopupMissingWithNewTab"
          : "recoverListWithNewTab",
        reason: error?.message || String(error),
        proxyProfileId: activeProxyUsage?.proxyProfileId,
        proxyProfileName: activeProxyUsage?.proxyProfileName,
        at: new Date().toISOString(),
      });
      return nextPage;
    }

    if (mode === "next-proxy" || mode === "popup-overload-next-proxy") {
      const isPopupOverloadRecovery = mode === "popup-overload-next-proxy";
      if (proxyRotation.length < 1) {
        if (isPopupOverloadRecovery) {
          logCheonyuWarn(
            `[BULK ${pageNo}] 다음 프록시가 없어 같은 컨텍스트의 새 탭으로 복구합니다.`,
          );
          return recoverCheonyuListPage({
            currentPage,
            pageNo,
            mode: "popup-overload",
            error,
          });
        }
        throw new Error(
          "목록 복구에 사용할 다음 프록시가 등록되어 있지 않습니다.",
        );
      }

      const nextRotationIndex = currentProxyRotationIndex + 1;
      onProgress({
        stage: "page-recovery",
        message: isPopupOverloadRecovery
          ? `${pageNo}페이지 팝업 누락률이 10%를 초과해 다음 프록시의 새 컨텍스트에서 누락 상품만 재시도합니다.`
          : `${pageNo}페이지를 다음 프록시 컨텍스트에서 재시도합니다.`,
        currentPage: pageNo,
      });
      try {
        return await rotateCheonyuProxyPage({
          currentPage,
          pageNo,
          rotationIndex: nextRotationIndex,
          forceRestart: true,
        });
      } catch (proxyRecoveryError) {
        if (!isPopupOverloadRecovery) throw proxyRecoveryError;

        logCheonyuWarn(
          `[BULK ${pageNo}] 다음 프록시의 새 컨텍스트 준비 실패 ` +
            `(${proxyRecoveryError?.message || proxyRecoveryError}) · ` +
            "기존 컨텍스트의 새 탭으로 누락 상품 재시도를 계속합니다.",
        );
        return recoverCheonyuListPage({
          currentPage,
          pageNo,
          mode: "popup-overload",
          error: proxyRecoveryError,
        });
      }
    }

    throw new Error(`지원하지 않는 천유 목록 복구 방식입니다: ${mode}`);
  };

  try {
    throwIfAborted(runSignal);
    onProgress({
      stage: "starting",
      message: "천유닷컴 브라우저를 준비하고 있습니다.",
    });

    browser = await browserType.launch({
      headless: config.headless,
      args: getLightweightLaunchArgs({ showBrowser: config.showBrowser }),
    });
    releaseAbort = bindAbortToBrowser(runSignal, browser);
    throwIfAborted(runSignal);

    context = await browser.newContext({
      viewport: config.viewport,
      userAgent: config.userAgent,
      ...(config.proxy ? { proxy: config.proxy } : {}),
    });
    await networkUsageTracker.trackContext(context, initialProxyUsage);

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

    lightweightNetworkPolicy = await installLightweightNetworkPolicy(context, {
      showBrowser: config.showBrowser,
    });

    page = await context.newPage();
    await Promise.all([
      networkUsageTracker.trackPage(page, initialProxyUsage),
      lightweightNetworkPolicy?.configurePage?.(page),
    ]);

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
    const inventoryItems = [];
    const cycleCartCoverages = [];
    const cycleArchiveHistory = [];
    const cycleClearResults = [];
    let cartHtml = "";
    let clearAfterResult = null;
    let pageRange = null;
    let resolvedPageRange = null;
    let detectedTotalProductCount = null;
    const seenProductIds = new Set();
    let loop = 0;
    const reversePageOrder = config.pageOrder === "reverse";
    const pageStep = reversePageOrder ? -1 : 1;
    let nextCyclePageStart = reversePageOrder ? null : config.pageStart;
    let proxyTraversalStart = reversePageOrder ? null : config.pageStart;
    let waitBeforeCycleFirstPage = false;
    let nextCyclePageNotBeforeAt = 0;

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
        {
          ...config,
        },
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
          rotatePage:
            proxyRotation.length > 0
              ? rotateCheonyuProxyPage
              : null,
          resetPage: resetCheonyuPageKeepingContext,
          recoverListPage: recoverCheonyuListPage,
          proxyPageStart: proxyTraversalStart,
          startPage: nextCyclePageStart,
          waitBeforeFirstPage: waitBeforeCycleFirstPage,
          pagePacingNotBeforeAt: nextCyclePageNotBeforeAt,
          resolvedPageRange,
          getProxyPageStart:
            proxyRotation.length > 0
              ? () => proxyRotationPageStart
              : null,
        },
      );
      if (!resolvedPageRange) {
        const detectedRange = cycleResult?.pageRange;
        const detectedPageStart = Number(detectedRange?.pageStart);
        const detectedPageEnd = Number(detectedRange?.pageEnd);

        if (
          Number.isInteger(detectedPageStart) &&
          Number.isInteger(detectedPageEnd) &&
          detectedPageStart >= 1 &&
          detectedPageEnd >= detectedPageStart
        ) {
          resolvedPageRange = { ...detectedRange };
          for (const transientKey of [
            "collectedLastPage",
            "collectedPageCount",
            "pageOrder",
            "resumePage",
            "stopReason",
            "traversalStartPage",
          ]) {
            delete resolvedPageRange[transientKey];
          }
          Object.freeze(resolvedPageRange);
          logCheonyuSuccess(
            `[PAGE DETECT] 이번 실행 범위를 ${detectedPageStart}~${detectedPageEnd}페이지로 확정했습니다. 이후 차수와 프록시 교체에서 재사용합니다.`,
          );
        }
      }
      nextCyclePageNotBeforeAt = Math.max(
        0,
        Number(cycleResult?.nextPageNotBeforeAt) || 0,
      );
      const cycleProxyPageStart = Number(cycleResult?.proxyPageStart);
      if (Number.isFinite(cycleProxyPageStart)) {
        proxyTraversalStart = cycleProxyPageStart;
      } else if (
        proxyTraversalStart === null ||
        proxyTraversalStart === undefined ||
        !Number.isFinite(Number(proxyTraversalStart))
      ) {
        proxyTraversalStart = Number(cycleResult?.pageRange?.traversalStartPage);
      }
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

      const cycleProducts = Array.from(
        new Map(
          (cycleResult.allProducts || []).map((item) => [
            String(item?.productId || ""),
            item,
          ]),
        ).values(),
      ).filter((item) => String(item?.productId || "").trim());
      const cycleTargets = Array.from(
        new Map(
          (cycleResult.allTargets || []).map((item) => [
            String(item?.productId || ""),
            item,
          ]),
        ).values(),
      ).filter((item) => String(item?.productId || "").trim());
      const cyclePopupOptionRows = cycleResult.allPopupOptionRows || [];
      const cycleBulkResults = (cycleResult.pageResults || [])
        .map((item) => item.bulkResult)
        .filter(Boolean);
      const cycleUnavailableProductIds = Array.from(new Set(
        cycleBulkResults.flatMap(
          (result) => result.unavailableProductIds || [],
        ).map(String),
      ));
      const cyclePopupDirectProductIds = Array.from(new Set(
        cycleBulkResults.flatMap(
          (result) => result.popupDirectProductIds || [],
        ).map(String),
      ));
      const cycleCartSubmittedProductIds = Array.from(new Set(
        cycleBulkResults.flatMap(
          (result) => result.cartSubmittedProductIds || [],
        ).map(String),
      ));
      const cycleCartSubmittedProductIdSet = new Set(
        cycleCartSubmittedProductIds,
      );
      const cycleFallbackTargets = cycleTargets.filter((product) =>
        cycleCartSubmittedProductIdSet.has(String(product.productId || "")),
      );
      const cyclePopupInventoryItems = createCheonyuPopupInventoryItems({
        products: cycleProducts,
        popupOptionRows: cyclePopupOptionRows,
        directProductIds: cyclePopupDirectProductIds,
        config,
      });
      const popupInventoryProductIdSet = new Set(
        cyclePopupInventoryItems.map((item) => String(item.productId || "")),
      );
      const popupCoverage = {
        complete: cyclePopupDirectProductIds.every((productId) =>
          popupInventoryProductIdSet.has(String(productId)),
        ),
        optionCoverageComplete: true,
        expectedProductCount: cyclePopupDirectProductIds.length,
        actualProductCount: popupInventoryProductIdSet.size,
        expectedRowCount: cyclePopupInventoryItems.length,
        actualRowCount: cyclePopupInventoryItems.length,
        rowCoverageAvailable: true,
        expectedProductIds: cyclePopupDirectProductIds,
        actualProductIds: Array.from(popupInventoryProductIdSet),
        missingProductIds: cyclePopupDirectProductIds.filter(
          (productId) => !popupInventoryProductIdSet.has(String(productId)),
        ),
        partialProductIds: [],
        missingOptionRows: [],
        extraOptionRows: [],
        unavailableProductIds: [],
      };

      onProgress({
        stage: "cycle-inventory",
        message:
          `천유 ${cycleNo}차 재고를 정리하고 있습니다. ` +
          `팝업 직독 ${cyclePopupDirectProductIds.length}개, ` +
          `장바구니 보완 ${cycleFallbackTargets.length}개`,
        cycleNo,
        collectedProductCount: seenProductIds.size,
        targetProductCount: cycleTargets.length,
        elapsedMs: performance.now() - startedAt,
      });

      const cycleCartResult = await probeCheonyuCartStock(
        page,
        context,
        config,
        cycleFallbackTargets,
        {
          probeQty: config.cartQty || 999,
          clearAfter: false,
          popupOptionRows: cyclePopupOptionRows.filter((row) =>
            cycleCartSubmittedProductIdSet.has(String(row.productId || "")),
          ),
          unavailableProductIds: cycleUnavailableProductIds,
          onProgress: (progress) => {
            onProgress({
              ...progress,
              cycleNo,
              elapsedMs: performance.now() - startedAt,
            });
          },
          signal: runSignal,
        },
      );

      cartHtml = cycleCartResult.cartHtml || cartHtml;
      const cycleInventoryItems = [
        ...cyclePopupInventoryItems,
        ...(cycleCartResult.inventoryItems || []),
      ];
      const cycleCoverage = mergeCheonyuCycleCoverages([
        { coverage: popupCoverage },
        cycleCartResult,
      ]);
      inventoryItems.push(...cycleInventoryItems);
      cycleCartCoverages.push({
        cycleNo,
        coverage: cycleCoverage,
      });

      let cycleArchiveResult = null;
      if (typeof onCycleArchive === "function") {
        onProgress({
          stage: "cycle-archiving",
          message:
            `천유 ${cycleNo}차 ${cycleProducts.length}개 상품을 ` +
            `아카이브에 저장하고 있습니다.`,
          cycleNo,
          collectedProductCount: seenProductIds.size,
          targetProductCount: cycleTargets.length,
          inventoryRowCount: cycleInventoryItems.length,
          elapsedMs: performance.now() - startedAt,
        });
        cycleArchiveResult = await onCycleArchive({
          cycleNo,
          products: cycleProducts,
          inventoryItems: cycleInventoryItems,
          coverage: cycleCoverage,
          pageRange: cycleResult.pageRange,
        });
      }
      cycleArchiveHistory.push({
        cycleNo,
        productCount: cycleProducts.length,
        inventoryRowCount: cycleInventoryItems.length,
        archived: Boolean(cycleArchiveResult),
        archiveResult: cycleArchiveResult || null,
        at: new Date().toISOString(),
      });

      if (cycleFallbackTargets.length > 0) {
        onProgress({
          stage: "cycle-cart-clear",
          message:
            `천유 ${cycleNo}차 아카이빙 완료 후 장바구니를 비우고 있습니다.`,
          cycleNo,
          elapsedMs: performance.now() - startedAt,
        });
        clearAfterResult = await clearCartAll(page, context, config, {
          cachedCartHtml: cycleCartResult.cartHtml || null,
        });
        cycleClearResults.push({
          cycleNo,
          result: clearAfterResult,
          at: new Date().toISOString(),
        });
      }
      logCheonyuSuccess(
        `[RUN] 천유 ${cycleNo}차 혼합 재고 수집·아카이브 완료 ` +
          `(${cycleProducts.length}상품, ${cycleInventoryItems.length} 재고행, ` +
          `팝업 ${cyclePopupDirectProductIds.length} / ` +
          `장바구니 ${cycleFallbackTargets.length})`,
      );

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

      const resumePage = Number(
        cycleResult?.resumePage || cycleResult?.pageRange?.resumePage,
      );
      const lastCollectedPage = Number(
        cycleResult?.pageRange?.collectedLastPage,
      );
      const cyclePageEnd = Number(cycleResult?.pageRange?.pageEnd);
      const cyclePageStart = Number(cycleResult?.pageRange?.pageStart);
      const resumePageOutsideRange = reversePageOrder
        ? resumePage < cyclePageStart
        : resumePage > cyclePageEnd;

      if (
        !Number.isFinite(resumePage) ||
        !Number.isFinite(cyclePageStart) ||
        !Number.isFinite(cyclePageEnd) ||
        resumePageOutsideRange
      ) {
        break;
      }

      waitBeforeCycleFirstPage =
        Number.isFinite(lastCollectedPage) &&
        resumePage === lastCollectedPage + pageStep;
      nextCyclePageStart = resumePage;
      logCheonyuInfo(
        `[RUN] 다음 ${cycleNo + 1}차는 ${nextCyclePageStart}페이지부터 ` +
          `${reversePageOrder ? "역순" : "정순"}으로 이어서 수집합니다.` +
          (waitBeforeCycleFirstPage
            ? " 이전 페이지의 2분 처리 예산 중 남은 시간만 대기 후 진행합니다."
            : " 현재 페이지의 미처리 상품부터 즉시 이어서 진행합니다."),
      );
    }

    const allProducts = Array.from(allProductsMap.values());
    const allExcludedProducts = Array.from(allExcludedProductsMap.values());
    const coverage = mergeCheonyuCycleCoverages(cycleCartCoverages);

    if (!pageRange) {
      throw new Error("천유 상품 목록 수집에 실패했습니다.");
    }

    throwIfAborted(runSignal);

    const collectionWarnings = createCheonyuCollectionWarnings(
      allExcludedProducts,
    );
    if ((coverage?.missingProductIds || []).length > 0) {
      collectionWarnings.push({
        code: "CART_COVERAGE_INCOMPLETE",
        page: 0,
        count: coverage.missingProductIds.length,
        productIds: coverage.missingProductIds,
        message:
          `장바구니 분할 판독에서 확인되지 않은 ` +
          `${coverage.missingProductIds.length}개 상품의 재고 수집을 제외하고 ` +
          `나머지 결과를 저장했습니다. ` +
          `(${coverage.missingProductIds.slice(0, 10).join(", ")})`,
      });
    }
    if ((coverage?.partialProductIds || []).length > 0) {
      collectionWarnings.push({
        code: "CART_OPTION_COVERAGE_MISMATCH",
        page: 0,
        count: coverage.partialProductIds.length,
        productIds: coverage.partialProductIds,
        message:
          `장바구니 분할 판독에서 옵션 행이 일치하지 않은 ` +
          `${coverage.partialProductIds.length}개 상품은 확인된 장바구니 행 기준으로 ` +
          `저장했습니다. ` +
          `(${coverage.partialProductIds.slice(0, 10).join(", ")})`,
      });
    }
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
      const message =
        `체크박스 또는 수량 입력 비활성화로 제외된 상품이 ` +
          `전체 ${Math.round(totalProductCountForFailureThreshold)}개 중 ` +
          `${disabledExclusionCount}개(약 ${(disabledExclusionRate * 100).toFixed(3)}%)로 ` +
          `0.1%(=${(disabledExclusionRateLimit * 100).toFixed(1)}%) 이상이지만 ` +
          `해당 상품만 제외하고 수집을 계속합니다.`;
      console.warn(`[WARN] ${message}`);
      onProgress({
        stage: "collection-warning",
        level: "warn",
        message,
      });
    }

    logCheonyuInfo("[CHEONYU] collectionMode:", config.collectionMode);
    logCheonyuInfo("[CHEONYU] allProducts:", allProducts.length);
    logCheonyuInfo("[CHEONYU] targetProducts:", targetProducts.length);

    throwIfAborted(runSignal);

    const productSummaries = buildProductSummaries(inventoryItems);
    let detailItems = [];
    let detailTargetCount = 0;
    let detailCandidateCount = 0;

    if (config.collectionMode === "detail") {
      const uniqueDetailTargets = Array.from(
        new Map(
          allProducts
            .filter((item) => item?.productUrl)
            .map((item) => [String(item.productId), item]),
        ).values(),
      );
      detailCandidateCount = uniqueDetailTargets.length;
      const pendingProductIds =
        config.detailTargetMode === "pending"
          ? new Set(
              await selectPendingDetailProductIds(
                config.mall,
                uniqueDetailTargets,
              ),
            )
          : null;
      const detailTargets = pendingProductIds
        ? uniqueDetailTargets.filter((product) =>
            pendingProductIds.has(String(product.productId || "")),
          )
        : uniqueDetailTargets;
      detailTargetCount = detailTargets.length;

      await recordDetailAttempts({
        mall: config.mall,
        products: detailTargets,
      });

      onProgress({
        stage: "detail",
        message:
          config.detailTargetMode === "pending"
            ? `신규·상세 미수집 상품 ${detailTargetCount}개의 상세페이지를 수집합니다.`
            : `범위 내 전체 상품 ${detailTargetCount}개의 상세페이지를 수집합니다.`,
        pageRange,
        detectedTotalProductCount: pageRange.detectedTotalProductCount,
        collectedProductCount: allProducts.length,
        targetProductCount: detailTargetCount,
        detailCandidateCount,
        detailTargetCount,
        excludedProductCount,
        excludedProducts: allExcludedProducts,
        collectionWarnings,
        productSummaryCount: productSummaries.length,
        elapsedMs: performance.now() - startedAt,
      });

      const detailPageGroups = new Map();

      for (let index = 0; index < detailTargets.length; index += 1) {
        const product = detailTargets[index];
        const sourcePage = Number(product.page);
        const pageNo = Number.isInteger(sourcePage) && sourcePage > 0
          ? sourcePage
          : Number(pageRange.pageStart) +
            Math.floor(index / Math.max(1, Number(config.pageSize) || 150));

        if (!detailPageGroups.has(pageNo)) {
          detailPageGroups.set(pageNo, []);
        }

        detailPageGroups.get(pageNo).push(product);
      }

      let completedDetailTargetCount = 0;
      let detailGroupIndex = 0;

      for (const [detailPageNo, pageProducts] of detailPageGroups) {
        detailGroupIndex += 1;
        throwIfAborted(runSignal);

        onProgress({
          stage: "detail-context-rotation",
          message:
            `상세 ${detailPageNo}페이지 수집 전 다음 프록시의 ` +
            "새 브라우저 컨텍스트를 준비합니다.",
          currentPage: detailPageNo,
          currentDetailIndex: completedDetailTargetCount,
          detailTargetCount: detailTargets.length,
          elapsedMs: performance.now() - startedAt,
        });

        page = await rotateCheonyuProxyPage({
          currentPage: page,
          pageNo: detailPageNo,
          rotationIndex: detailGroupIndex,
          forceRestart: true,
        });

        const pageDetailItems = await collectCheonyuDetails(
          page,
          pageProducts,
          config,
          (progress) => {
            const currentInPage = Math.max(
              0,
              Number(progress.currentDetailIndex) || 0,
            );
            const currentDetailIndex = Math.min(
              detailTargets.length,
              completedDetailTargetCount + currentInPage,
            );

            onProgress({
              ...progress,
              message:
                `${progress.message} · 전체 ` +
                `${currentDetailIndex}/${detailTargets.length}`,
              currentPage: detailPageNo,
              currentDetailIndex,
              detailTargetCount: detailTargets.length,
              elapsedMs: performance.now() - startedAt,
            });
          },
          runSignal,
        );

        detailItems.push(...pageDetailItems);
        completedDetailTargetCount += pageProducts.length;
      }

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

    const summary = {
      mall: config.mall,
      mallLabel: config.mallLabel,
      category: config.category,
      collectionMode: config.collectionMode,
      detailTargetMode: config.detailTargetMode,
      detailCandidateCount,
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
      cycleArchiveHistory,
      cycleClearResults,
      maintenanceHistory,
      maintenanceCount: maintenanceHistory.length,
    };

    onProgress({
      stage: "completed",
      message: excludedProductCount > 0
        ? `천유닷컴 수집이 완료되었습니다. 장바구니 재고 수집 제외 ` +
          `${excludedProductCount}개`
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
            cycleArchiveHistory,
            cycleClearResults,
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
    resetCheonyuPopupWorkloadTracker(runSignal, page);
    blockGuard?.dispose();
    releaseAbort();
    if (context) await context.close().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    await networkUsageTracker.finishAndLog();
  }
}

module.exports = {
  run: runCheonyu,
  runCheonyu,
};

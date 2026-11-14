const { chromium } = require("playwright");
const { performance } = require("node:perf_hooks");
const { resolvePageRange, collectListCandidates } = require("./site");
const { collectCheonyuDetails } = require("./detail");
const { bindAbortToBrowser, getLightweightLaunchArgs, installLightweightNetworkPolicy } = require("../../utils/browser");
const { installHttpBlockGuard, sleepWithSignal } = require("../../utils/site-safety");
const { throwIfAborted, formatMs } = require("../../utils/common");
const { readProductArchive } = require("../../utils/product-archive");
const { getProductSourceMall } = require("../../utils/product-schema");
const { readDetailCollectionState, recordDetailAttempts, recordDetailOutcomes,
  DETAIL_DATA_SCHEMA_VERSION } = require("../../utils/detail-collection-state");

function selectLifecycleTargets(products, states, existingIds, config, now = Date.now()) {
  return products.filter(product => {
    const id = String(product.productId);
    const state = states.products[`cheonyu:${id}`];
    const lastSuccess = Date.parse(state?.lastDetailSuccessAt || "");
    const complete = existingIds.has(id) && state?.detailStatus === "success" &&
      state.detailDataSchemaVersion >= DETAIL_DATA_SCHEMA_VERSION && Number.isFinite(lastSuccess);
    if (config.collectionKind === "initial") return !complete;
    return existingIds.has(id) && (!complete || now - lastSuccess >= config.longTermDays * 86400000);
  });
}

async function runCheonyuPublic(config, { browserType = chromium, onProgress = () => {},
  onListPage, onDetailPage, signal, deferDetailSuccess = false } = {}) {
  const startedAt = performance.now();
  const blocked = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, blocked.signal]) : blocked.signal;
  const label = config.collectionKind === "initial" ? "최초 등록" : "장기 갱신";
  const [archive, states] = await Promise.all([readProductArchive(), readDetailCollectionState()]);
  const existingIds = new Set(Object.values(archive.products)
    .filter(product => getProductSourceMall(product) === "cheonyu").map(product => String(product.id)));
  throwIfAborted(runSignal);
  const browser = await browserType.launch({ headless: config.headless, args: getLightweightLaunchArgs(config) });
  const release = bindAbortToBrowser(runSignal, browser);
  let guard;
  try {
    const context = await browser.newContext({ viewport: config.viewport, userAgent: config.userAgent, proxy: config.proxy });
    guard = installHttpBlockGuard(context, { hostname: new URL(config.baseUrl).hostname,
      statusCodes: [403, 407, 429], onBlocked: error => blocked.abort(error) });
    const policy = await installLightweightNetworkPolicy(context, config);
    const page = await context.newPage();
    await policy.configurePage(page);
    await context.addCookies([{ name: "is_korean_mode", value: "Y", url: config.baseUrl }]);
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    onProgress({ stage: "collecting", message: `${label} · 비로그인으로 상품 목록을 확인합니다.` });
    const { pageRange, firstPageHtml } = await resolvePageRange(page, config, runSignal);
    const products = [];
    const detailItems = [];
    const seen = new Set();
    let targetCount = 0;
    const reverse = config.pageOrder === "reverse";
    const step = reverse ? -1 : 1;
    for (let pageNo = reverse ? pageRange.pageEnd : pageRange.pageStart;
      reverse ? pageNo >= pageRange.pageStart : pageNo <= pageRange.pageEnd; pageNo += step) {
      throwIfAborted(runSignal);
      if (products.length) await sleepWithSignal(config.requestDelayMs, runSignal);
      const listing = await collectListCandidates(page, pageNo, config, pageNo === 1 ? firstPageHtml : null, runSignal);
      if (!listing.candidates.length) throw new Error(`${pageNo}페이지에서 공개 상품 목록을 확인하지 못했습니다.`);
      const unique = listing.candidates.filter(product => !seen.has(String(product.productId)));
      if (!unique.length) throw new Error(`${pageNo}페이지에서 같은 상품 목록이 반복되었습니다.`);
      for (const product of unique) seen.add(String(product.productId));
      products.push(...unique);
      pageRange.collectedLastPage = pageNo;
      pageRange.collectedPageCount++;
      await onListPage?.({ pageNo, pageRange, products: unique, targets: [] });
      const targets = selectLifecycleTargets(unique, states, existingIds, config);
      targetCount += targets.length;
      await recordDetailAttempts({ mall: config.mall, products: targets });
      onProgress({ stage: "detail", message: `${label} · ${pageNo}페이지 대상 ${targets.length}개`,
        currentPage: pageNo, pageRange, collectedProductCount: products.length,
        detailTargetCount: targetCount, currentDetailIndex: detailItems.length });
      const details = await collectCheonyuDetails(page, targets, config, progress => onProgress({ ...progress,
        currentPage: pageNo, pageRange, detailTargetCount: targetCount,
        currentDetailIndex: detailItems.length + (Number(progress.currentDetailIndex) || 0),
      }), runSignal);
      await onDetailPage?.({ pageNo, pageRange, products: targets, inventoryItems: [], detailItems: details });
      // When translation is selected, finalization marks success after it finishes.
      if (onDetailPage && !deferDetailSuccess) await recordDetailOutcomes({ mall: config.mall, detailItems: details });
      detailItems.push(...details);
    }
    const elapsedMs = performance.now() - startedAt;
    return {
      products, detailItems, inventoryItems: [], productSummaries: [], popupOptionItems: [],
      summary: { mall: config.mall, collectionKind: config.collectionKind, collectionMode: "detail",
        anonymousCollection: true, pageRange, collectedProductCount: products.length,
        detectedTotalProductCount: pageRange.detectedTotalProductCount,
        targetProductCount: targetCount, detailTargetCount: targetCount, detailCandidateCount: products.length,
        detailItemCount: detailItems.length, productSummaryCount: 0, elapsedMs, elapsedText: formatMs(elapsedMs) },
    };
  } catch (error) {
    throw blocked.signal.reason || error;
  } finally {
    release();
    guard?.dispose();
    await browser.close().catch(() => {});
  }
}

module.exports = { runCheonyuPublic, selectLifecycleTargets };

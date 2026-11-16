const cheerio = require("cheerio");
const { chromium } = require("playwright");
const { performance } = require("node:perf_hooks");
const { parseListHtml, collectCheonyuPopupStock } = require("./site");
const { collectCheonyuDetails } = require("./detail");
const { createCheonyuPopupInventoryItems } = require("./cart-stock");
const { createNewProductOptionProbe, getDetailOptionHints } = require("./new-product-options");
const { bindAbortToBrowser, getLightweightLaunchArgs } = require("../../utils/browser");
const { gotoWithSiteRetry, sleepWithSignal } = require("../../utils/site-safety");
const { createLifecycleConnection, requireLifecycleLogin } = require("./lifecycle-connection");
const { readProductArchive } = require("../../utils/product-archive");
const { getProductSourceMall } = require("../../utils/product-schema");
const { createCollectionProxy } = require("../../utils/collection-proxy");
const { recordDetailAttempts, recordDetailOutcomes } = require("../../utils/detail-collection-state");
const { throwIfAborted, formatMs } = require("../../utils/common");

const BEST_COLLECTIONS = Object.freeze({
  attention: { label: "주목받는 베스트", path: "/product/bests.html" },
  stationery: { label: "문구점 베스트", path: "/product/bests_offline.html" },
  snack: { label: "과자 베스트", path: "/product/bests_snack.html" },
});

function getRecentMonths(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric" })
    .formatToParts(now);
  const year = Number(parts.find(part => part.type === "year").value);
  const month = Number(parts.find(part => part.type === "month").value);
  return [`${year}-${month}`, month === 1 ? `${year - 1}-12` : `${year}-${month - 1}`];
}

// Read the actual anchor on the home page; do not silently fall back to the full catalog.
function findLifecycleEntry(html, config) {
  const $ = cheerio.load(html);
  const best = BEST_COLLECTIONS[config.inventoryBest];
  const isNew = config.collectionKind === "newProducts";
  let found;
  $(isNew ? "a:has(img[alt])" : "a[href]").each((_, element) => {
    const anchor = $(element);
    if (isNew && !anchor.find("img").toArray().some(img => /신상품\s*더보기/.test($(img).attr("alt") || ""))) return;
    try {
      const url = new URL(anchor.attr("href"), config.baseUrl);
      if (url.origin !== new URL(config.baseUrl).origin || url.username || url.password) return;
      if (url.pathname !== (isNew ? "/product/news.html" : best?.path)) return;
      found ||= url.toString();
    } catch {}
  });
  if (!found) throw new Error(`천유 메인 페이지에서 ${isNew ? "신상품 더보기" : best?.label || "베스트"} 링크를 찾지 못했습니다.`);
  return found;
}

function buildLifecycleListUrl(entry, month, pageNo, pageSize) {
  const url = new URL(entry);
  url.search = "";
  url.hash = "";
  url.searchParams.set("cateIDX", "ALL");
  if (month) url.searchParams.set("searchDate", month);
  url.searchParams.set("page", String(pageNo));
  url.searchParams.set("listSize", String(pageSize));
  return url.toString();
}

function parseLifecyclePage(html, url, pageNo, config) {
  const $ = cheerio.load(html);
  const current = new URL(url);
  const products = parseListHtml(html, pageNo, { ...config, category: "ALL" });
  let lastPage = pageNo;
  $(".pagination a[href], .paging a[href], a[rel='last']").each((_, element) => {
    try {
      const next = new URL($(element).attr("href"), current);
      if (next.origin !== current.origin || next.pathname !== current.pathname ||
          next.searchParams.get("searchDate") !== current.searchParams.get("searchDate") ||
          (next.searchParams.get("cateIDX") || "ALL") !== "ALL") return;
      const number = Number(next.searchParams.get("page"));
      if (Number.isSafeInteger(number) && number > lastPage) lastPage = number;
    } catch {}
  });
  if (lastPage > config.maxSafePages) throw new Error(`목록 페이지 ${lastPage}가 안전 한도 ${config.maxSafePages}를 초과했습니다.`);
  const text = $("#sub_list, .m_list").text().replace(/\s+/g, " ");
  const empty = /(?:상품|제품)(?:이|은|가|\s)*없습니다|(?:등록된|검색된|검색 결과).*없습니다/.test(text) ||
    ($("#ProductCount").length > 0 && /^0$/.test($("#ProductCount").text().trim()));
  if (!products.length && (!empty || pageNo !== 1 || lastPage > 1)) {
    throw new Error(`${current.searchParams.get("searchDate") || "베스트"} ${pageNo}페이지의 상품 목록을 확인하지 못했습니다.`);
  }
  return { products, lastPage, empty };
}

async function openPage(page, url, config, signal) {
  await gotoWithSiteRetry(page, url, { signal, label: "천유 신규 수집 목록", waitUntil: "domcontentloaded",
    timeoutMs: config.navigationTimeoutMs, maxAttempts: 2, handoffProxyFailure: config.collectionKind === "inventory" });
  throwIfAborted(signal);
  const html = await page.content();
  if (config.collectionKind === "inventory") requireLifecycleLogin(html, "베스트 목록에서 로그인 상태가 해제되었습니다.");
  const current = new URL(page.url());
  const expected = new URL(url);
  if (current.origin !== expected.origin || current.pathname !== expected.pathname ||
      ["searchDate", "page", "cateIDX"].some(key => current.searchParams.get(key) !== expected.searchParams.get(key))) {
    throw new Error("요청한 천유 목록 대신 다른 페이지로 이동했습니다. 로그인과 목록 주소를 확인하세요.");
  }
  return html;
}

async function collectBestInventory(connection, config, { label, onProgress, onCycleArchive, startedAt }) {
  const entry = await connection.read(1, ({ home }) => findLifecycleEntry(home, config));
  const products = [], inventoryItems = [], popupOptionItems = [];
  const seen = new Set(), signatures = new Set();
  const pageRange = { mode: "auto", pageStart: 1, pageEnd: 1, requestedPageEnd: 0,
    collectedPageCount: 0, collectedLastPage: null, stopReason: "completed-range",
    scope: config.inventoryBest, months: [] };
  for (let pageNo = 1; pageNo <= pageRange.pageEnd; pageNo++) {
    if (pageNo > 1) await sleepWithSignal(config.requestDelayMs, connection.signal);
    const url = buildLifecycleListUrl(entry, null, pageNo, config.pageSize);
    const { listing, signature, unique, popup, rows } = await connection.read(pageNo, async ({ page, signal }) => {
      const html = await openPage(page, url, config, signal);
      const listing = parseLifecyclePage(html, url, pageNo, config);
      const signature = listing.products.map(product => String(product.productId)).sort().join(",");
      if (signature && signatures.has(signature)) throw new Error(`${label} ${pageNo}페이지에서 같은 상품 목록이 반복되었습니다.`);
      const unique = listing.products.filter(product => !seen.has(String(product.productId)))
        .map(product => ({ ...product, page: pageNo, sourcePage: pageNo, sourceMonth: null, listUrl: url }));
      onProgress({ stage: "collecting", message: `${label} · ${pageNo}페이지 ${unique.length}개 확인`,
        currentPage: pageNo, pageRange: { ...pageRange, pageEnd: Math.max(pageRange.pageEnd, listing.lastPage) },
        collectedProductCount: products.length + unique.length });
      const available = unique.filter(product => !product.isSoldOut);
      const popup = await collectCheonyuPopupStock(page, pageNo, { ...config, listUrl: url }, available, signal);
      const rows = createCheonyuPopupInventoryItems({ products: unique, popupOptionRows: popup.popupOptionRows,
        directProductIds: popup.popupDirectProductIds, config });
      return { listing, signature, unique, popup, rows };
    });
    const confirmed = new Set(rows.map(row => String(row.productId)));
    const unavailable = new Set((popup.unavailableProductIds || []).map(String));
    const missing = unique.filter(product => !confirmed.has(String(product.productId)) &&
      !product.isSoldOut && !unavailable.has(String(product.productId)));
    Object.assign(pageRange, { pageEnd: Math.max(pageRange.pageEnd, listing.lastPage),
      collectedLastPage: pageNo, collectedPageCount: pageNo });
    const checkpointRange = { ...pageRange, sourceMonth: null, sourcePage: pageNo, sourceUrl: url };
    throwIfAborted(connection.signal);
    await onCycleArchive?.({ cycleNo: pageNo, pageRange: checkpointRange,
      products: unique.filter(product => !missing.includes(product)), inventoryItems: rows });
    if (missing.length) throw new Error(`팝업에서 ${missing.length}개 상품의 재고를 확인하지 못했습니다 (${missing.map(p => p.productId).join(", ")}). 확인한 재고는 저장했습니다.`);
    signatures.add(signature);
    for (const product of unique) seen.add(String(product.productId));
    products.push(...unique);
    inventoryItems.push(...rows);
    popupOptionItems.push(...popup.popupOptionRows);
  }
  throwIfAborted(connection.signal);
  const elapsedMs = performance.now() - startedAt;
  return { products, inventoryItems, detailItems: [], popupOptionItems, productSummaries: [],
    summary: { mall: config.mall, collectionKind: config.collectionKind, collectionMode: config.collectionMode,
      anonymousCollection: false, inventoryBest: config.inventoryBest, months: [], pageRange,
      collectedProductCount: products.length, targetProductCount: products.length,
      detailTargetCount: 0, detailCandidateCount: 0, detailItemCount: 0, productSummaryCount: 0,
      elapsedMs, elapsedText: formatMs(elapsedMs) } };
}

async function runCheonyuLifecycle(config, { browserType = chromium, signal, onProgress = () => {},
  onListPage, onDetailPage, onCycleArchive, deferDetailSuccess = false, now = () => new Date(), probeTunnel } = {}) {
  if (!["inventory", "newProducts", "changes"].includes(config.collectionKind)) throw new Error("실행할 수 없는 신규 수집 분류입니다.");
  const inventory = config.collectionKind === "inventory";
  const loggedInCollection = config.collectionKind !== "newProducts";
  const label = inventory ? `재고 파악 · ${BEST_COLLECTIONS[config.inventoryBest]?.label}` : config.collectionKind === "changes" ? "상품 변동 확인" : "새 제품 수집";
  const startedAt = performance.now();
  throwIfAborted(signal);
  const archive = loggedInCollection ? null : await readProductArchive();
  const existingIds = new Set(Object.values(archive?.products || {})
    .filter(product => getProductSourceMall(product) === "cheonyu").map(product => String(product.id)));
  const browser = await browserType.launch({ headless: config.headless, args: getLightweightLaunchArgs(config) });
  const release = bindAbortToBrowser(signal, browser);
  const connection = createLifecycleConnection(browser, config, { signal, label, onProgress, probeTunnel });
  let optionConnection;
  try {
    if (inventory) return await collectBestInventory(connection, config, { label, onProgress, onCycleArchive, startedAt });
    if (config.collectionKind === "changes") {
      return await require("./product-changes").collectProductChanges(connection, config, { onProgress, onCycleArchive, now });
    }
    const { page, signal: runSignal } = await connection.read(1, current => current);
    const months = getRecentMonths(now());
    const home = await openPage(page, new URL("/", config.baseUrl).toString(), config, runSignal);
    const entry = findLifecycleEntry(home, config);
    const scopes = [];
    // Pin the two calendar months once per run, including across New Year's Day.
    for (const month of months) {
      const url = buildLifecycleListUrl(entry, month, 1, config.pageSize);
      const html = await openPage(page, url, config, runSignal);
      scopes.push({ month, url, html, ...parseLifecyclePage(html, url, 1, config) });
    }
    const pageRange = { mode: "auto", pageStart: 1, pageEnd: scopes.reduce((sum, scope) => sum + scope.lastPage, 0),
      requestedPageEnd: 0, collectedPageCount: 0, collectedLastPage: null, stopReason: "completed-range",
      scope: "recent-months", months };
    const products = [], detailItems = [], inventoryItems = [], popupOptionItems = [], optionReviewItems = [];
    const seen = new Set();
    let pageNo = 0, targetCount = 0, optionTargetCount = 0, optionPendingCount = 0;
    for (const scope of scopes) {
      const pageSignatures = new Set();
      for (let sourcePage = 1; sourcePage <= scope.lastPage; sourcePage++) {
        throwIfAborted(runSignal);
        if (pageNo) await sleepWithSignal(config.requestDelayMs, runSignal);
        const url = buildLifecycleListUrl(entry, scope.month, sourcePage, config.pageSize);
        const html = sourcePage === 1 ? scope.html : await openPage(page, url, config, runSignal);
        const listing = parseLifecyclePage(html, url, sourcePage, config);
        if (listing.lastPage > scope.lastPage) {
          pageRange.pageEnd += listing.lastPage - scope.lastPage;
          scope.lastPage = listing.lastPage;
        }
        if (pageRange.pageEnd > config.maxSafePages) throw new Error("수집할 전체 페이지가 안전 한도를 초과했습니다.");
        const signature = listing.products.map(product => String(product.productId)).sort().join(",");
        if (signature && pageSignatures.has(signature)) throw new Error(`${scope.month || label} ${sourcePage}페이지에서 같은 상품 목록이 반복되었습니다.`);
        pageSignatures.add(signature);
        pageNo++;
        const unique = listing.products.filter(product => !seen.has(String(product.productId)))
          .map(product => ({ ...product, page: pageNo, sourcePage, sourceMonth: scope.month, listUrl: url }));
        for (const product of unique) seen.add(String(product.productId));
        products.push(...unique);
        pageRange.collectedLastPage = pageNo;
        pageRange.collectedPageCount = pageNo;
        const checkpointRange = { ...pageRange, sourceMonth: scope.month, sourcePage, sourceUrl: url };
        onProgress({ stage: "collecting", message: `${label} · ${scope.month ? `${scope.month} · ` : ""}${sourcePage}페이지 ${unique.length}개 확인`,
          currentPage: pageNo, pageRange: checkpointRange, collectedProductCount: products.length });
        const targets = unique.filter(product => !existingIds.has(String(product.productId)));
        await onListPage?.({ pageNo, pageRange: checkpointRange, products: unique, targets });
        targetCount += targets.length;
        await recordDetailAttempts({ mall: config.mall, products: targets });
        const details = await collectCheonyuDetails(page, targets, config, progress => onProgress({ ...progress,
          message: `${scope.month} · ${progress.message || "새 제품 상세정보 수집"}`,
          currentPage: pageNo, pageRange: checkpointRange, detailTargetCount: targetCount,
          currentDetailIndex: detailItems.length + (Number(progress.currentDetailIndex) || 0) }), runSignal);
        throwIfAborted(runSignal);
        const successful = details.filter(detail => !detail.detailError);
        const failures = details.filter(detail => detail.detailError);
        const detailsById = new Map(successful.map(detail => [String(detail.productId), detail]));
        const optionTargets = [];
        for (const product of targets) {
          const detail = detailsById.get(String(product.productId));
          if (!detail || (!product.hasOptionHint && !getDetailOptionHints(detail).length)) continue;
          optionTargets.push({ ...product, detailOptions: detail.detailOptions,
            isSoldOut: product.isSoldOut || detail.saleStatus === "SOLD_OUT" });
        }
        optionTargetCount += optionTargets.length;
        const optionProductIds = new Set(optionTargets.map(product => String(product.productId)));
        const optionCandidates = optionTargets.filter(product => product.isSoldOut
          ? getDetailOptionHints(product).length > 0 : config.newProductOptionAccount);
        let pageOptions = { inventoryItems: [], popupOptionItems: [], optionReviewItems: [] };
        let optionFailure;
        if (optionCandidates.length) {
          const cartConfig = { ...config, anonymousCollection: false };
          const readOptions = createNewProductOptionProbe(cartConfig, { listUrl: url, sourcePage, products: optionCandidates,
            onProgress: progress => onProgress({ ...progress, currentPage: pageNo, pageRange: checkpointRange }) });
          try {
            if (optionCandidates.some(product => !product.isSoldOut)) {
              optionConnection ||= createLifecycleConnection(browser, {
                ...cartConfig, proxy: createCollectionProxy(config.proxy, true, config.proxyProvider),
              }, { signal: runSignal, label: "새 제품 옵션", onProgress, probeTunnel, loggedIn: true });
              pageOptions = await optionConnection.read(pageNo, readOptions);
            } else {
              pageOptions = await readOptions({});
            }
          } catch (error) {
            optionFailure = error;
            if (readOptions.hasPendingCart()) {
              optionFailure = Object.assign(new Error("새 제품 옵션 확인 중 추가한 장바구니 행의 정리를 확인하지 못했습니다. 장바구니를 확인하세요.", { cause: error }),
                { code: "CART_CLEANUP_INCOMPLETE" });
              onProgress({ stage: "inventory", level: "warn", currentPage: pageNo, message: optionFailure.message });
            }
          }
        }
        if (runSignal.aborted && optionFailure?.code === "CART_CLEANUP_INCOMPLETE") throw optionFailure;
        throwIfAborted(runSignal);
        const pageReview = new Map((pageOptions.optionReviewItems || []).map(item => [item.productId, item]));
        optionReviewItems.push(...pageReview.values());
        const verified = new Set(pageOptions.inventoryItems.map(row => String(row.productId)));
        const completed = [], pending = [];
        for (const detail of successful) {
          const id = String(detail.productId);
          if (optionProductIds.has(id) && !verified.has(id)) {
            pending.push({ ...detail, detailError: pageReview.has(id)
              ? "옵션 정보를 검토할 때까지 상품 저장을 보류했습니다."
              : "옵션 바코드 확인을 완료하지 못했습니다." });
          } else completed.push(detail);
        }
        optionPendingCount += pending.length;
        if (pending.length) onProgress({ stage: "option-pending", level: "warn", currentPage: pageNo, optionPendingCount,
          message: `옵션 정보 확인을 마치지 못한 상품 ${pending.length}개를 보류했습니다.` });
        // Keep pending option products out of the archive so the next run can retry them.
        await onDetailPage?.({ pageNo, pageRange: checkpointRange, products: targets,
          inventoryItems: pageOptions.inventoryItems, detailItems: completed });
        if (onDetailPage) await recordDetailOutcomes({ mall: config.mall,
          detailItems: [...failures, ...pending, ...(deferDetailSuccess ? [] : completed)] });
        if (optionFailure) throw optionFailure;
        if (failures.length) throw new Error(`${scope.month} ${sourcePage}페이지 새 상품 ${failures.length}개의 상세 수집에 실패했습니다. 다음 실행에서 다시 확인합니다.`);
        detailItems.push(...completed);
        inventoryItems.push(...pageOptions.inventoryItems);
        popupOptionItems.push(...pageOptions.popupOptionItems);
      }
    }
    const elapsedMs = performance.now() - startedAt;
    return { products, inventoryItems, detailItems, popupOptionItems, productSummaries: [],
      summary: { mall: config.mall, collectionKind: config.collectionKind, collectionMode: config.collectionMode,
        anonymousCollection: true, inventoryBest: config.inventoryBest, months, pageRange,
        collectedProductCount: products.length, targetProductCount: targetCount,
        optionTargetCount, optionPendingCount, optionBarcodeCount: inventoryItems.filter(row => row.barcode).length,
        optionReviewCount: optionReviewItems.length, optionReviewItems,
        detailTargetCount: targetCount, detailCandidateCount: products.length,
        detailItemCount: detailItems.length, productSummaryCount: 0, elapsedMs, elapsedText: formatMs(elapsedMs) } };
  } catch (error) {
    throw connection.getBlockError() || error;
  } finally {
    await optionConnection?.close();
    await connection.close();
    release();
    await browser.close().catch(() => {});
  }
}

module.exports = { BEST_COLLECTIONS, getRecentMonths, findLifecycleEntry, buildLifecycleListUrl,
  parseLifecyclePage, runCheonyuLifecycle };

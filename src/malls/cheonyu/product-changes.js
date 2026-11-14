const cheerio = require("cheerio");
const { performance } = require("node:perf_hooks");
const { resolvePageRange, collectListCandidates, collectCheonyuRestockPopup } = require("./site");
const { requireLifecycleLogin } = require("./lifecycle-connection");
const { createCheonyuPopupInventoryItems } = require("./cart-stock");
const { gotoWithSiteRetry, sleepWithSignal, withSiteRetry } = require("../../utils/site-safety");
const { describeDiagnosticPage } = require("../../utils/collection-diagnostics");
const { throwIfAborted, formatMs } = require("../../utils/common");
const { readRestockCursor, isNewRestock, createRestockCheckpoint } = require("../../utils/restock-collection-state");

function sameSite(url, base) {
  const expected = new URL(base);
  return !url.username && !url.password && url.protocol === expected.protocol && url.port === expected.port &&
    url.hostname.replace(/^www\./, "") === expected.hostname.replace(/^www\./, "");
}

function productLink(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (!sameSite(url, baseUrl) || url.pathname !== "/product/view.html") return null;
    const id = url.searchParams.get("qIDX");
    return /^\d+$/.test(id || "") ? { id, url: url.toString() } : null;
  } catch { return null; }
}

function parseSoldOutPage(html, pageNo, config) {
  const $ = cheerio.load(html);
  const products = new Map();
  $('li a[href*="/product/view.html"]').each((_, element) => {
    const link = productLink($(element).attr("href"), config.baseUrl);
    if (!link || products.has(link.id)) return;
    const item = $(element).closest("li");
    const isSoldOut = item.children("div.soldout_bg").length > 0;
    products.set(link.id, { productId: link.id, productUrl: link.url, sourceMall: config.mall,
      page: pageNo, isSoldOut, saleStatus: isSoldOut ? "SOLD_OUT" : null });
  });
  return [...products.values()];
}

function findPageLink(html, config, kind) {
  const $ = cheerio.load(html);
  let result;
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    try {
      const url = new URL(anchor.attr("href"), config.baseUrl);
      if (!sameSite(url, config.baseUrl)) return;
      const label = [anchor.text(), anchor.attr("title"), anchor.attr("aria-label"), anchor.find("img").attr("alt")].join(" ");
      const matches = kind === "restock" ? url.pathname === "/mypage/restock.html"
        : url.pathname.startsWith("/mypage/") && (/마이\s*페이지/.test(label) || /^\/mypage\/(?:index|mypage|my_page)\.html$/.test(url.pathname));
      if (matches) result ||= url.toString();
    } catch {}
  });
  if (!result) throw new Error(`${kind === "restock" ? "마이페이지의 인기 재입고상품" : "메인 페이지의 마이페이지"} 링크를 찾지 못했습니다.`);
  return result;
}

function normalizeRestockDate(value) {
  const match = String(value || "").match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?:일)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, y, m, d, h = "0", min = "0", s = "0"] = match;
  const values = [y, m, d, h, min, s].map(Number);
  const [year, month, day, hour, minute, second] = values;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const pad = number => String(number).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;
}

function restockDateFromItem($, item) {
  for (const raw of [item.attr("data-restock-date"), item.attr("data-restocked-at"),
    ...item.find('[data-restock-date], [data-restocked-at], .restock-date, .restock_date, .restock-date-cell, [class*="restock"][class*="date"]').toArray()
      .map(node => $(node).attr("data-restock-date") || $(node).attr("data-restocked-at") || $(node).text())]) {
    const date = normalizeRestockDate(raw);
    if (date) return date;
  }
  if (item.is("tr")) {
    const headings = item.closest("table").find("thead tr").last().find("th,td").toArray();
    const index = headings.findIndex(node => /(?:재)?입고\s*(?:일|날짜|시간)/.test($(node).text()));
    if (index >= 0) return normalizeRestockDate(item.children("td").eq(index).text());
  }
  const labelled = item.text().match(/(?:재)?입고\s*(?:일|날짜|시간)?\s*[:：]?\s*(20\d{2}[\s\S]{0,30})/);
  if (labelled) return normalizeRestockDate(labelled[1]);
  // Use an unlabelled date only when there is a single standalone date cell;
  // never confuse a date embedded in a product name with its restock date.
  const dates = item.find("time, td, span, small, em").toArray()
    .filter(node => !$(node).find("a, img, input, select, button").length && !$(node).closest(".m_pdt_list_name").length)
    .map(node => $(node).text().trim()).filter(text => /^20\d{2}[.\-/]/.test(text) && text.length <= 25)
    .map(normalizeRestockDate).filter(Boolean);
  return new Set(dates).size === 1 ? dates[0] : null;
}

function buildRestockUrl(entry, days, pageNo) {
  if (![30, 90].includes(days)) throw new Error("재입고 확인 기간은 30일 또는 90일이어야 합니다.");
  const url = new URL(entry);
  url.search = "";
  url.hash = "";
  url.searchParams.set("page", String(pageNo));
  url.searchParams.set("keyword", "");
  url.searchParams.set("days", String(days));
  url.searchParams.set("sort", "recent");
  return url.toString();
}

function parseRestockPage(html, url, pageNo, config) {
  const $ = cheerio.load(html);
  const current = new URL(url);
  for (const name of ["days", "sort"]) {
    const select = $(`select[name='${name}'], select#${name}`).first();
    if (select.length && String(select.val()) !== current.searchParams.get(name)) throw new Error("재입고 검색 기간 또는 최신 재입고순 조건이 적용되지 않았습니다.");
  }
  const products = new Map();
  const scope = $("#restockList, .restock-list, .restock_list, #sub_list");
  const anchors = scope.length ? scope.find('a[href*="/product/view.html"]') : $('a[href*="/product/view.html"]');
  anchors.each((_, element) => {
    const link = productLink($(element).attr("href"), config.baseUrl);
    if (!link || products.has(link.id)) return;
    const anchor = $(element);
    const item = anchor.closest("tr").length ? anchor.closest("tr") : anchor.closest("li");
    if (!item.length) return;
    const restockedAt = restockDateFromItem($, item);
    // Some layouts expose only latest-first ordering, without a restock date.
    // In that layout the saved product number marks the previous boundary.
    products.set(link.id, { productId: link.id, productUrl: link.url, sourceMall: config.mall,
      page: pageNo, restockedAt,
      productName: item.find(".m_pdt_list_name, .product_name, .product-name").first().text().trim() || anchor.attr("title") || anchor.text().trim() });
  });
  let lastPage = pageNo;
  $("a[href]").each((_, element) => {
    try {
      const next = new URL($(element).attr("href"), current);
      if (!sameSite(next, current) || next.pathname !== current.pathname ||
          ["days", "sort", "keyword"].some(key => next.searchParams.has(key) && next.searchParams.get(key) !== current.searchParams.get(key))) return;
      const number = Number(next.searchParams.get("page"));
      if (Number.isSafeInteger(number) && number > lastPage) lastPage = number;
    } catch {}
  });
  if (lastPage > config.maxSafePages) throw new Error("재입고 목록 페이지가 안전 한도를 초과했습니다.");
  const content = $("main, #contents, #content, #wrap, .restock-list, .restock_list, #restockList").text();
  const empty = /(?:상품|내역|결과|제품)(?:이|은|가|\s)*없습니다|(?:등록된|검색된|검색 결과).*없습니다/.test(content);
  if (!products.size && (!empty || pageNo !== 1 || lastPage > 1)) throw new Error("재입고 상품 목록을 확인하지 못했습니다.");
  return { products: [...products.values()], lastPage };
}

async function navigate(page, url, config, signal) {
  await gotoWithSiteRetry(page, url, { signal, label: "천유 상품 변동 확인", waitUntil: "domcontentloaded",
    timeoutMs: config.navigationTimeoutMs, maxAttempts: 2, handoffProxyFailure: true });
  throwIfAborted(signal);
  const html = await page.content();
  requireLifecycleLogin(html, "상품 변동 확인 중 로그인 상태가 해제되었습니다.");
  const actual = new URL(page.url()), expected = new URL(url);
  if (!sameSite(actual, expected) || actual.pathname !== expected.pathname ||
      ["page", "days", "sort", "keyword"].some(key => actual.searchParams.get(key) !== expected.searchParams.get(key))) {
    throw new Error("요청한 상품 변동 목록 대신 다른 페이지로 이동했습니다.");
  }
  return html;
}

function restockPageSignature(listing) {
  return listing.products.map(product => `${product.productId}:${product.restockedAt}`).join("|");
}

async function collectProductChanges(connection, config, { onProgress, onCycleArchive, now = () => new Date() }) {
  const startedAt = performance.now();
  const { signal } = connection;
  const products = [], inventoryItems = [];
  let scannedCount = 0, restockCheckpoint = null;
  let pageRange;
  const seen = new Set(), signatures = new Set();
  if (config.changeType === "soldOut") {
    const listConfig = { ...config, category: "-1", pageStart: 1, pageEnd: 0 };
    const detection = await connection.read(1, current =>
      resolvePageRange(current.page, listConfig, current.signal));
    pageRange = detection.pageRange;
    for (let pageNo = 1; pageNo <= pageRange.pageEnd; pageNo++) {
      throwIfAborted(signal);
      if (pageNo > 1) await sleepWithSignal(config.requestDelayMs, signal);
      const all = await connection.read(pageNo, async current => {
        const listing = await collectListCandidates(current.page, pageNo, listConfig,
          pageNo === 1 ? detection.firstPageHtml : null, current.signal);
        requireLifecycleLogin(listing.html, "품절 확인 중 로그인 상태가 해제되었습니다.");
        return parseSoldOutPage(listing.html, pageNo, config);
      });
      if (!all.length) throw new Error(`${pageNo}페이지에서 전체 상품 목록을 확인하지 못했습니다.`);
      const unique = all.filter(product => !seen.has(product.productId));
      if (!unique.length) throw new Error("전체 상품 목록이 반복되었습니다.");
      for (const product of unique) seen.add(product.productId);
      scannedCount += unique.length;
      const soldOut = unique.filter(product => product.isSoldOut);
      products.push(...soldOut);
      Object.assign(pageRange, { collectedLastPage: pageNo, collectedPageCount: pageNo });
      onProgress({ stage: "collecting", currentPage: pageNo, pageRange: { ...pageRange }, collectedProductCount: scannedCount,
        soldOutProductCount: products.length, message: `상품 변동 · 품절 · ${pageNo}페이지 품절 ${soldOut.length}개 확인` });
      throwIfAborted(signal);
      await onCycleArchive?.({ cycleNo: pageNo, pageRange: { ...pageRange }, products: soldOut, inventoryItems: [] });
    }
  } else {
    const days = config.changeType === "restock90" ? 90 : 30;
    const state = await readRestockCursor(config);
    const checkedAt = now().toISOString();
    const entry = await connection.read(1, async current => {
      const myPage = findPageLink(current.home, config, "mypage");
      const myHtml = await navigate(current.page, myPage, config, current.signal);
      return findPageLink(myHtml, config, "restock");
    });
    const newestDateProducts = [];
    let lastDate = Infinity;
    pageRange = { mode: "auto", pageStart: 1, pageEnd: 1, requestedPageEnd: 0,
      collectedLastPage: null, collectedPageCount: 0, stopReason: "completed-range", days, sort: "recent" };
    for (let pageNo = 1; pageNo <= pageRange.pageEnd; pageNo++) {
      throwIfAborted(signal);
      if (pageNo > 1) await sleepWithSignal(config.requestDelayMs, signal);
      const url = buildRestockUrl(entry, days, pageNo);
      const result = await connection.read(pageNo, async ({ page, signal: attemptSignal, monitor }) => {
        const html = await navigate(page, url, config, attemptSignal);
        let listing = parseRestockPage(html, url, pageNo, config);
        const signature = restockPageSignature(listing);
        if (signature && signatures.has(signature)) throw new Error("재입고 목록이 반복되었습니다. 확인 기록은 갱신하지 않습니다.");
        let reachedBoundary = false;
        let nextLastDate = lastDate;
        const targets = [], scanned = [], newestOnPage = [];
        for (const product of listing.products) {
          const date = Date.parse(product.restockedAt);
          if (product.restockedAt && date > nextLastDate) throw new Error("재입고 목록이 최신 재입고순이 아닙니다. 확인 기록은 갱신하지 않습니다.");
          if (product.restockedAt) nextLastDate = date;
          const newest = newestDateProducts[0] || newestOnPage[0];
          if (!newest || date === Date.parse(newest.restockedAt)) newestOnPage.push(product);
          if (state.cursor) {
            const dated = product.restockedAt && state.cursor.lastRestockedAt;
            if (dated ? date < Date.parse(state.cursor.lastRestockedAt) : product.productId === state.cursor.lastProductId) {
              reachedBoundary = true;
              break;
            }
          }
          if (seen.has(product.productId)) continue;
          scanned.push(product);
          if (isNewRestock(product, state.cursor)) targets.push(product);
        }
        const rows = [];
        for (const product of targets) {
          throwIfAborted(attemptSignal);
          onProgress({ stage: "collecting", currentPage: pageNo, pageRange: { ...pageRange },
            collectedProductCount: scannedCount + scanned.length,
            message: `상품 변동 · 재입고 ${days}일 · 상품 ${product.productId} 팝업 재고 확인` });
          const popup = await withSiteRetry(
            () => collectCheonyuRestockPopup(page, product, config, attemptSignal),
            {
              label: "천유 재입고 옵션 팝업",
              diagnosticDetails: { ...describeDiagnosticPage(page), pageNo, productId: product.productId },
              signal: attemptSignal,
              maxAttempts: 3,
              baseDelayMs: config.requestDelayMs,
              shouldRetry: error => error.code === "CHEONYU_RESTOCK_POPUP_TIMEOUT",
              onRetry: ({ nextAttempt, maxAttempts }) => {
                const action = nextAttempt < maxAttempts ? "팝업을 다시 엽니다." : `${pageNo}페이지를 새로고침한 뒤 다시 확인합니다.`;
                onProgress({ stage: "collecting", currentPage: pageNo,
                  message: `재입고 상품 ${product.productId} 팝업 대기 시간 초과 · ${action}` });
              },
              beforeAttempt: async ({ attempt, maxAttempts }) => {
                await monitor.check();
                if (attempt < maxAttempts) return;
                const refreshedHtml = await navigate(page, url, config, attemptSignal);
                const refreshed = parseRestockPage(refreshedHtml, url, pageNo, config);
                // Keep inventory already read on this page only if its ordered listing is still the same.
                if (restockPageSignature(refreshed) !== signature) {
                  throw new Error(`새로고침 후 재입고 ${pageNo}페이지 목록이 달라졌습니다. 확인 기록은 갱신하지 않습니다.`);
                }
                listing = refreshed;
              },
            },
          );
          rows.push(...createCheonyuPopupInventoryItems({ products: [product], popupOptionRows: popup.popupOptionRows,
            directProductIds: popup.popupDirectProductIds, config }));
          await sleepWithSignal(config.requestDelayMs, attemptSignal);
        }
        return { lastPage: listing.lastPage, signature, reachedBoundary, nextLastDate, targets, scanned, newestOnPage, rows };
      });
      throwIfAborted(signal);
      Object.assign(pageRange, { pageEnd: Math.max(pageRange.pageEnd, result.lastPage),
        collectedLastPage: pageNo, collectedPageCount: pageNo,
        stopReason: result.reachedBoundary ? "restock-boundary" : "completed-range" });
      await onCycleArchive?.({ cycleNo: pageNo, pageRange: { ...pageRange },
        products: result.targets, inventoryItems: result.rows });
      signatures.add(result.signature);
      lastDate = result.nextLastDate;
      newestDateProducts.push(...result.newestOnPage);
      for (const product of result.scanned) seen.add(product.productId);
      scannedCount += result.scanned.length;
      products.push(...result.targets);
      inventoryItems.push(...result.rows);
      if (result.reachedBoundary) break;
    }
    restockCheckpoint = createRestockCheckpoint(state, newestDateProducts, checkedAt);
  }
  throwIfAborted(signal);
  const elapsedMs = performance.now() - startedAt;
  return { products, inventoryItems, detailItems: [], popupOptionItems: [], productSummaries: [], restockCheckpoint,
    summary: { mall: config.mall, collectionKind: "changes", changeType: config.changeType, collectionMode: "general",
      pageRange, collectedProductCount: scannedCount, targetProductCount: products.length,
      soldOutProductCount: config.saleStatusOnly ? products.length : 0, productSummaryCount: 0,
      elapsedMs, elapsedText: formatMs(elapsedMs) } };
}

module.exports = { parseSoldOutPage, findPageLink, normalizeRestockDate, buildRestockUrl, parseRestockPage, collectProductChanges };

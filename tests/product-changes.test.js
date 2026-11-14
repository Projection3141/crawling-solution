process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { test, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cheonyu-changes-"));
process.env.PRODUCT_ARCHIVE_DIRECTORY = path.join(root, "archive");
after(() => {
  assert.ok(root.startsWith(path.join(os.tmpdir(), "cheonyu-changes-")));
  fs.rmSync(root, { recursive: true, force: true });
});
mock.method(require("../translate/convert"), "createConversionSnapshot", async () => { throw new Error("Stock runs must not request exchange rates"); });
const { resolveRunConfig, toSafeConfig } = require("../src/config");
const { runCollection } = require("../src/crawler");
const { createCollectionDiagnostics } = require("../src/utils/collection-diagnostics");
const { readProductArchive, updateProductArchive } = require("../src/utils/product-archive");
const { parseSoldOutPage, findPageLink, normalizeRestockDate, buildRestockUrl, parseRestockPage } = require("../src/malls/cheonyu/product-changes");
const { readRestockCursor, createRestockCheckpoint, commitRestockCursor, RESTOCK_STATE_PATH } = require("../src/utils/restock-collection-state");
const logout = '<a href="/member/logout.html">로그아웃</a>';
const home = logout + '<a href="/mypage/index.html"><img alt="마이페이지"></a>';
const mypage = logout + '<a href="/mypage/restock.html?page=1&keyword=&days=14&sort=popular"><img alt="인기 재입고상품 더보기"></a>';
function config(changeType, extra = {}) {
  return { ...resolveRunConfig({ mall: "cheonyu", collectionKind: "changes", changeType, showBrowser: false,
    cheonyuProxyServer: "http://gate.decodo.com:7000", cheonyuProxyUsername: "fixture", cheonyuProxyPassword: "fixture",
    accountId: "changes-fixture", accountPw: "fixture-secret", pageSize: 3, maxPerPage: 1,
    requestDelayMs: 0, navigationTimeoutMs: 3000, outDir: root, ...extra }, {}, root), inventoryPopupWaitMs: 500 };
}
function listItem(id, sold = false) {
  return `<li><div ${sold ? 'class="soldout_bg"' : ''}><a class="pLink" href="/product/view.html?qIDX=${id}">상품 ${id}</a>
    <input id="inPcheck" name="inPcheck" type="checkbox" value="${id}"></div></li>`;
}
function optionRow(id, stock) {
  return `<tr id="inOptionTR"><td class="option_txt">옵션 ${id}</td><td>
    <input type="checkbox" id="optionCHKPOP" value="${id}"><input id="inOPcount" value="1">
    <input id="inOPMaxStock" value="${stock}"><input id="inOPidx" value="${id || 0}"></td></tr>`;
}
function restockPage(rows, days, lastPage = 1) {
  const popups = Object.fromEntries(rows.map(row => [row.id, `<div class="many_add" data-product-id="${row.id}">
    <div class="subject"><p>상품 ${row.id}</p></div><table id="opSelectedList"><tbody>
    ${(row.options || [["", row.stock ?? 5]]).map(([id, stock]) => optionRow(id, stock)).join("")}</tbody></table></div>`]));
  const popupTimeouts = Object.fromEntries(rows.filter(row => row.popupTimeouts).map(row => [row.id, row.popupTimeouts]));
  return logout + `<main id="restockList"><select name="days"><option selected>${days}</option></select>
    <select name="sort"><option value="recent" selected>최신 재입고순</option></select><ul>${rows.map(row =>
    `<li ${row.date ? `data-restock-date="${row.date}"` : ""}><div>
    <a href="/product/view.html?qIDX=${row.id}">상품 ${row.id}</a><div class="m_pdt_list_name">상품 ${row.id}</div>
    <button id="btn_addCart" onclick="showPopup('${row.id}')">담기</button></div></li>`).join("")}</ul>
    ${rows.length ? `<a href="?page=${lastPage}&keyword=&days=${days}&sort=recent">끝</a>` : "검색된 상품이 없습니다."}</main>
    <div id="popups"></div><script>window.popupHtml = ${JSON.stringify(popups)};
    const popupTimeouts = ${JSON.stringify(popupTimeouts)};
    window.showPopup = id => {
      window.fixtureOpened(id);
      if (popupTimeouts[id] > 0) {
        popupTimeouts[id]--;
        return;
      }
      document.querySelector('#popups').innerHTML = window.popupHtml[id];
    };
    window.setOption = () => window.fixtureSubmitted();
    window.closeCartIn = () => { document.querySelector('#popups').innerHTML = ''; };</script>`;
}
function fixture(handler, { getProbeIp = () => "192.0.2.1", onPopupTimeout } = {}) {
  const requests = [], opened = [], unexpected = [], proxies = [];
  let submitted = 0;
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return { close: () => browser.close(), async newContext(options) {
      const contextNo = proxies.push(options.proxy);
      const context = await browser.newContext({ ...options, proxy: undefined });
      if (onPopupTimeout) {
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          const waitForFunction = page.waitForFunction.bind(page);
          page.waitForFunction = async (predicate, arg, options) => {
            if (!String(predicate).includes("input#inOPMaxStock")) {
              return waitForFunction(predicate, arg, options);
            }
            // Let Playwright raise its own timeout on the missing popup.
            try {
              return await waitForFunction(predicate, arg, { ...options, timeout: 250 });
            } catch (error) {
              if (error.name === "TimeoutError") onPopupTimeout(page.url());
              throw error;
            }
          };
          return page;
        };
      }
      context.request.get = async url => {
        const ip = await getProbeIp(contextNo, opened, url);
        return { ok: () => true, json: async () => ({ ip }), dispose: async () => {} };
      };
      await context.exposeFunction("fixtureOpened", id => opened.push(id));
      await context.exposeFunction("fixtureSubmitted", () => { submitted++; });
      let loggedIn = false;
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        requests.push(url);
        let body;
        if (url.pathname === "/member/login.html") body = '<form method="post" action="/member/loginResult.html"><input name="inMID"><input name="inMPW" type="password"><button type="submit">로그인</button></form>';
        else if (url.pathname === "/member/loginResult.html") { loggedIn = true; body = logout; }
        else if (!loggedIn) { unexpected.push(url.pathname); body = "로그인 필요"; }
        else if (url.pathname === "/") body = home;
        else if (url.pathname === "/mypage/index.html") body = mypage;
        else body = handler(url);
        if (body === undefined) { unexpected.push(url.pathname); body = "Unexpected request"; }
        await route.fulfill(typeof body === "string" ? { body, contentType: "text/html; charset=utf-8" } : body);
      });
      return context;
    } };
  } };
  return { browserType, requests, opened, proxies, assertReadOnly() {
    assert.equal(submitted, 0);
    assert.deepEqual(unexpected, []);
    assert.ok(!requests.some(url => /cart|order|product\/view/i.test(url.pathname)));
  } };
}
async function archived(id) {
  return Object.values((await readProductArchive()).products).find(item => item.id === String(id) && item.sourceMall === "cheonyu");
}
function restockFixture(getPages, days = 30, options) {
  return fixture(url => {
    assert.equal(url.pathname, "/mypage/restock.html");
    assert.equal(url.searchParams.get("sort"), "recent");
    assert.equal(url.searchParams.get("keyword"), "");
    assert.equal(url.searchParams.get("days"), String(days));
    const pages = getPages(url);
    return restockPage(pages[Number(url.searchParams.get("page")) - 1], days, pages.length);
  }, options);
}

test("restock retries an interrupted popup page without repeating the saved page or skipping its products", async () => {
  const cfg = config("restock30", { accountId: "restock-recovery-fixture" });
  const pages = [
    [{ id: 87901, date: "2026-11-11" }],
    [{ id: 87902, date: "2026-11-10" }, { id: 87903, date: "2026-11-09" }],
  ];
  const site = restockFixture(() => pages, 30, {
    getProbeIp(contextNo, opened) {
      return contextNo > 1 || opened.includes("87902") ? "192.0.2.2" : "192.0.2.1";
    },
  });
  const archivedPages = [], recoveryPages = [];
  const result = await runCollection(cfg, { runId: "restock-ip-change", browserType: site.browserType,
    onProgress(event) {
      if (event.stage === "cycle-archived") archivedPages.push(event.cycleNo);
      if (event.stage === "proxy-session") recoveryPages.push(event.currentPage);
    },
  });
  assert.deepEqual(recoveryPages, [2]);
  assert.deepEqual(archivedPages, [1, 2]);
  assert.deepEqual(site.requests.filter(url => url.pathname === "/mypage/restock.html")
    .map(url => Number(url.searchParams.get("page"))), [1, 2, 2]);
  assert.deepEqual(site.opened, ["87901", "87902", "87902", "87903"]);
  assert.deepEqual(result.payload.products.map(product => product.id), ["87901", "87902", "87903"]);
  assert.notEqual(site.proxies[0].username, site.proxies[1].username);
  assert.equal(site.requests.filter(url => url.pathname === "/member/loginResult.html").length, 2);
  assert.equal((await readRestockCursor(cfg)).cursor.lastProductId, "87901");
  site.assertReadOnly();
});

test("restock retries a failed DataImpulse IP request in the same session before reconnecting at page 2", async () => {
  const runId = "restock-probe-request-failure";
  const cfg = config("restock30", {
    accountId: runId,
    cheonyuProxyServer: "http://gw.dataimpulse.com:823",
  });
  const pages = [
    [{ id: 88301, date: "2026-11-11" }],
    [{ id: 88302, date: "2026-11-10" }, { id: 88303, date: "2026-11-09" }],
  ];
  const resultDir = path.join(root, "cheonyu", runId);
  const readResult = filename => JSON.parse(fs.readFileSync(path.join(resultDir, filename), "utf8"));
  const failedProbes = [];
  const site = restockFixture(() => pages, 30, {
    getProbeIp(contextNo, opened, url) {
      if (contextNo === 1 && opened.includes("88302")) {
        failedProbes.push({
          contextNo,
          url,
          savedPages: readResult("general-checkpoint.json").savedPages,
          productIds: readResult("result.json").map(product => product.id),
        });
        throw Object.assign(new Error("Fixture request failed\nAuthorization: Basic fixture-request-secret"), {
          code: "ERR_HTTP2_STREAM_ERROR",
        });
      }
      return contextNo === 1 ? "192.0.2.1" : "192.0.2.2";
    },
  });
  const diagnostics = createCollectionDiagnostics({ directory: path.join(root, "diagnostics"), runId });
  const archivedPages = [], recoveryPages = [];
  const result = await diagnostics.run(() => runCollection(cfg, {
    runId,
    browserType: site.browserType,
    onProgress(event) {
      if (event.stage === "cycle-archived") archivedPages.push(event.cycleNo);
      if (event.stage === "proxy-session") recoveryPages.push(event.currentPage);
    },
  }));
  await diagnostics.flush();

  assert.deepEqual(failedProbes, Array.from({ length: 3 }, () => ({
    contextNo: 1, url: "https://api.ipify.org?format=json", savedPages: [1], productIds: ["88301"],
  })));
  assert.deepEqual(recoveryPages, [2]);
  assert.deepEqual(archivedPages, [1, 2]);
  assert.deepEqual(site.requests.filter(url => url.pathname === "/mypage/restock.html")
    .map(url => Number(url.searchParams.get("page"))), [1, 2, 2]);
  assert.deepEqual(site.opened, ["88301", "88302", "88302", "88303"]);
  assert.equal(site.proxies.length, 2);
  assert.notEqual(new URL(site.proxies[0].server).port, new URL(site.proxies[1].server).port);
  assert.equal(site.requests.filter(url => url.pathname === "/member/loginResult.html").length, 2);
  assert.deepEqual(readResult("general-checkpoint.json").savedPages, [1, 2]);
  assert.deepEqual(result.payload.products.map(product => product.id), ["88301", "88302", "88303"]);
  assert.equal((await readRestockCursor(cfg)).cursor.lastProductId, "88301");
  site.assertReadOnly();

  const log = fs.readFileSync(diagnostics.filePath, "utf8");
  assert.doesNotMatch(log, /fixture-request-secret/);
  const events = log.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const failures = events.filter(row => ["sticky-session-check-retry", "sticky-session-failed"].includes(row.event));
  assert.deepEqual(failures.map(({ event, details }) => [event, details.contextId, details.attempt, details.reason]), [
    ["sticky-session-check-retry", "context-1", 1, "PROBE_REQUEST_FAILED"],
    ["sticky-session-check-retry", "context-1", 2, "PROBE_REQUEST_FAILED"],
    ["sticky-session-failed", "context-1", 3, "PROBE_REQUEST_FAILED"],
  ]);
  for (const { details } of failures) {
    assert.equal(details.requestErrorType, "Error");
    assert.equal(details.requestErrorCode, "ERR_HTTP2_STREAM_ERROR");
    assert.equal(details.probeHost, "api.ipify.org");
  }
  const renewal = events.find(row => row.event === "sticky-checkpoint-renewal");
  assert.equal(renewal.details.pageNo, 2);
  assert.equal(renewal.details.reason, "PROBE_REQUEST_FAILED");
  assert.ok(failures.at(-1).sequence < renewal.sequence);
  assert.deepEqual(events.filter(row => row.event === "login-succeeded").map(row => row.details.contextId),
    ["context-1", "context-2"]);
});

for (const { popupTimeouts, reloadPage, firstProductId, description } of [
  { popupTimeouts: 1, reloadPage: false, firstProductId: 88101, description: "reopens the popup without reloading" },
  { popupTimeouts: 2, reloadPage: true, firstProductId: 88201, description: "reloads page 6 when reopening also times out" },
]) {
  test(`restock popup timeout after saving page 5 ${description}`, async () => {
    const runId = `restock-page-six-timeout-${popupTimeouts}`;
    const cfg = config("restock30", { accountId: runId });
    const pageNumbers = [1, 2, 3, 4, 5, 6, 7];
    const pages = pageNumbers.map((page, index) => [{
      id: firstProductId + index,
      date: `2026-11-${String(12 - page).padStart(2, "0")}`,
    }]);
    const failedProductId = firstProductId + 10;
    const pageSix = pages[5];
    pageSix.push(
      { id: failedProductId, date: pageSix[0].date, stock: 19 },
      { id: firstProductId + 11, date: pageSix[0].date },
    );
    const pagesWithTimeouts = pages.slice();
    pagesWithTimeouts[5] = pageSix.map(product =>
      product.id === failedProductId ? { ...product, popupTimeouts } : product);

    const timeoutSnapshots = [];
    const resultDirectory = path.join(root, "cheonyu", runId);
    const readCheckpoint = () => JSON.parse(fs.readFileSync(path.join(resultDirectory, "general-checkpoint.json"), "utf8"));
    const readSavedProducts = () => JSON.parse(fs.readFileSync(path.join(resultDirectory, "result.json"), "utf8"));
    let pageSixVisits = 0;
    const site = restockFixture(url => {
      if (url.searchParams.get("page") === "6") pageSixVisits++;
      return pageSixVisits <= 1 ? pagesWithTimeouts : pages;
    }, 30, {
      onPopupTimeout(url) {
        const checkpoint = readCheckpoint();
        timeoutSnapshots.push({
          page: new URL(url).searchParams.get("page"),
          savedThroughPage: checkpoint.savedThroughPage,
          savedPages: checkpoint.savedPages,
          productIds: readSavedProducts().map(product => product.id),
        });
      },
    });
    const archivedPages = [];
    const result = await runCollection(cfg, {
      runId,
      browserType: site.browserType,
      onProgress(event) {
        if (event.stage === "cycle-archived") archivedPages.push(event.cycleNo);
      },
    });

    const productIds = pages.flat().map(product => String(product.id));
    assert.deepEqual(timeoutSnapshots, Array.from({ length: popupTimeouts }, () => ({
      page: "6",
      savedThroughPage: 5,
      savedPages: [1, 2, 3, 4, 5],
      productIds: productIds.slice(0, 5),
    })));
    const listingRequests = site.requests.filter(url => url.pathname === "/mypage/restock.html");
    assert.deepEqual(listingRequests.map(url => Number(url.searchParams.get("page"))),
      reloadPage ? [1, 2, 3, 4, 5, 6, 6, 7] : pageNumbers);
    if (reloadPage) assert.equal(listingRequests[5].href, listingRequests[6].href);
    assert.equal(site.proxies.length, 1, "popup recovery keeps the browser context and proxy session");
    assert.equal(site.requests.filter(url => url.pathname === "/member/loginResult.html").length, 1);

    const expectedOpened = productIds.slice();
    const retryProductId = String(failedProductId);
    expectedOpened.splice(expectedOpened.indexOf(retryProductId), 0, ...Array(popupTimeouts).fill(retryProductId));
    assert.deepEqual(site.opened, expectedOpened);
    assert.deepEqual(archivedPages, pageNumbers);
    assert.deepEqual(readCheckpoint().savedPages, pageNumbers);
    assert.equal(readCheckpoint().savedThroughPage, 7);
    assert.deepEqual(readSavedProducts().map(product => product.id), productIds);
    assert.deepEqual(result.payload.products.map(product => product.id), productIds);
    assert.equal(result.payload.products.find(product => product.id === retryProductId).stockQuantity, 19);
    assert.equal((await readRestockCursor(cfg)).cursor.lastProductId, productIds[0]);
    site.assertReadOnly();
  });
}

test("change modes require login, preserve the subtype and ignore partial catalog settings", () => {
  for (const changeType of ["soldOut", "restock30", "restock90"]) {
    const cfg = config(changeType, { category: "12", pageStart: 3, pageEnd: 7, pageOrder: "reverse" });
    assert.equal(cfg.collectionKind, "changes");
    assert.equal(cfg.changeType, changeType);
    assert.equal(cfg.inventoryOnly, true);
    assert.equal(cfg.saleStatusOnly, changeType === "soldOut");
    assert.equal(cfg.inventoryBest, "");
    assert.equal(cfg.pageStart, 1);
    assert.equal(cfg.pageEnd, 0);
    assert.equal(cfg.pageOrder, "forward");
    assert.equal(toSafeConfig(cfg).changeType, changeType);
    assert.doesNotMatch(JSON.stringify(toSafeConfig(cfg)), /fixture-secret/);
    assert.throws(() => config(changeType, { accountId: "", accountPw: "" }), /계정 정보/);
  }
  assert.throws(() => config("restock14"), /세부항목/);
});

test("sold-out selection uses only a direct div badge and an exact product idx", () => {
  const html = listItem(81001, true) + listItem(81002) +
    '<li><div><section class="soldout_bg"><a href="/product/view.html?qIDX=81003">중첩 배지</a></section></div></li>' +
    '<li class="soldout_bg"><div><a href="/product/view.html?qIDX=81004">li 배지</a></div></li>' +
    '<li><div class="soldout_bg"><a href="https://other.invalid/product/view.html?qIDX=81005">외부</a></div></li>';
  const products = parseSoldOutPage(html, 4, config("soldOut"));
  assert.deepEqual(products.filter(p => p.isSoldOut).map(p => p.productId), ["81001"]);
  assert.equal(products.length, 4);
  assert.ok(products.every(p => p.page === 4));
});

test("sold-out scans the full catalog and only changes existing products' sale status", async () => {
  await updateProductArchive([81001, 81002, 81003, 81004, 81005].map(id => ({ id: String(id), sourceMall: "cheonyu",
    nameKo: `보존 ${id}`, originalPrice: 1200, inventoryObserved: true, type: "OPTION", saleStatus: "ON_SALE",
    options: [{ id: "10", nameKo: "빨강", barcode: "8800000000010", stockQuantity: 8 }] })), { source: "general" });
  const before = new Map(await Promise.all([81001, 81002, 81003, 81004, 81005].map(async id => [id, await archived(id)])));
  const site = fixture(url => {
    assert.equal(url.pathname, "/product/list.html");
    assert.equal(url.searchParams.get("cateIDX"), "-1");
    const ids = url.searchParams.get("page") === "1" ? [81001, 81002, 81999] : [81003, 81004];
    return logout + `<span id="ProductCount">5</span><div id="sub_list"><ul>${ids.map(id => listItem(id, [81001, 81003, 81999].includes(id))).join("")}</ul></div>
      <div class="pagination"><a href="?page=2&cateIDX=-1&listSize=3">끝</a></div>`;
  });
  const result = await runCollection(config("soldOut"), { runId: "sold-out", browserType: site.browserType });
  assert.equal(result.payload.summary.collectedProductCount, 5);
  assert.equal(result.payload.summary.soldOutProductCount, 3);
  assert.deepEqual(result.payload.products.map(p => p.id).sort(), ["81001", "81003"]);
  assert.ok(result.payload.products.every(p => Object.keys(p).sort().join() === "id,saleStatus,sourceMall"));
  for (const id of [81001, 81002, 81003, 81004, 81005]) {
    const saved = await archived(id);
    if ([81001, 81003].includes(id)) {
      assert.equal(saved.saleStatus, "SOLD_OUT");
      assert.deepEqual({ ...saved, saleStatus: before.get(id).saleStatus, updatedAt: before.get(id).updatedAt }, before.get(id));
    } else assert.deepEqual(saved, before.get(id));
  }
  assert.equal(await archived(81999), undefined);
  assert.equal(site.opened.length, 0);
  site.assertReadOnly();
});

test("restock links, exact query filters, dates and scoped pagination are parsed", () => {
  const cfg = config("restock30");
  assert.equal(new URL(findPageLink(home, cfg, "mypage")).pathname, "/mypage/index.html");
  const entry = findPageLink(mypage, cfg, "restock");
  assert.throws(() => findPageLink(mypage.replace('/mypage/restock.html', 'https://other.invalid/mypage/restock.html'), cfg, "restock"), /링크/);
  assert.equal(new URL(findPageLink(mypage.replace('/mypage/restock.html', 'https://cheonyu.com/mypage/restock.html'), cfg, "restock")).hostname, "cheonyu.com");
  const url = buildRestockUrl(entry, 30, 1);
  assert.equal(new URL(url).search, "?page=1&keyword=&days=30&sort=recent");
  assert.equal(normalizeRestockDate("2026. 11. 10 09:30"), "2026-11-10T09:30:00+09:00");
  assert.equal(normalizeRestockDate("2026-02-30"), null);
  const html = '<aside><ul>' + listItem(99999) + '</ul></aside>' + restockPage([{ id: 82001, date: "2026-11-10" }], 30, 2) + '<a href="?page=99&days=90&sort=popular">다른 조건</a>';
  assert.equal(parseRestockPage(html, url, 1, cfg).lastPage, 2);
  assert.deepEqual(parseRestockPage(html, url, 1, cfg).products.map(p => p.productId), ["82001"]);
  const table = '<main><table><thead><tr><th>상품</th><th>재입고일</th></tr></thead><tbody><tr><td><a href="/product/view.html?qIDX=82002">상품</a></td><td>2026/11/09</td></tr></tbody></table></main>';
  assert.equal(parseRestockPage(table, url, 1, cfg).products[0].restockedAt, "2026-11-09T00:00:00+09:00");
  assert.equal(parseRestockPage(restockPage([{ id: 82003 }], 30), url, 1, cfg).products[0].restockedAt, null);
  assert.throws(() => parseRestockPage(html.replace('<option selected>30', '<option selected>90'), url, 1, cfg), /검색 기간/);
  assert.throws(() => parseRestockPage("<main>오류</main>", url, 1, cfg), /상품 목록/);
});

test("first restock run reads every page and saves a date boundary including same-day products across pages", async () => {
  await updateProductArchive([{ id: "82001", sourceMall: "cheonyu", nameKo: "보존 이름", originalPrice: 4500,
    inventoryObserved: true, type: "OPTION", options: [{ id: "21", nameKo: "기존 옵션", barcode: "8800000000021", stockQuantity: 99 }] }], { source: "general" });
  let pages = [[{ id: 82001, date: "2026-11-10", options: [["21", 7], ["22", 0]] }],
    [{ id: 82002, date: "2026-11-10" }, { id: 82003, date: "2026-11-09" }]];
  const site = restockFixture(() => pages);
  const cfg = config("restock30", { accountId: "dated-fixture" });
  const first = await runCollection(cfg, { runId: "restock-first", browserType: site.browserType });
  assert.deepEqual(site.opened, ["82001", "82002", "82003"]);
  assert.deepEqual(first.payload.products.map(p => p.id), ["82001", "82002", "82003"]);
  assert.equal(first.payload.products[0].stockQuantity, 7);
  const saved = await archived(82001);
  assert.equal(saved.nameKo, "보존 이름");
  assert.equal(saved.originalPrice, 4500);
  assert.equal(Object.values(saved.options).find(p => p.id === "21").barcode, "8800000000021");
  assert.doesNotMatch(JSON.stringify(first.payload.products), /nameKo|barcode|Price/);
  let state = await readRestockCursor(cfg);
  assert.equal(state.cursor.lastProductId, "82001");
  assert.deepEqual(state.cursor.boundaryProductIds, ["82001", "82002"]);
  assert.equal(state.cursor.lastRestockedAt, "2026-11-10T00:00:00+09:00");
  assert.ok(Number.isFinite(Date.parse(state.cursor.lastCheckedAt)));
  const requested = site.requests.map(url => url.pathname);
  assert.ok(requested.indexOf("/mypage/index.html") < requested.indexOf("/mypage/restock.html"));

  // A new product can have a lower idx and the same displayed restock date.
  pages = [[{ id: 82002, date: "2026-11-10" }, { id: 82000, date: "2026-11-10" }],
    [{ id: 82001, date: "2026-11-10" }, { id: 82003, date: "2026-11-09" }], [{ id: 81990, date: "2026-11-08" }]];
  site.opened.length = 0;
  site.requests.length = 0;
  const next = await runCollection(cfg, { runId: "restock-next", browserType: site.browserType });
  assert.deepEqual(site.opened, ["82000"]);
  assert.deepEqual(next.payload.products.map(p => p.id), ["82000"]);
  assert.ok(!site.requests.some(url => url.searchParams.get("page") === "3"));
  assert.equal(next.payload.summary.pageRange.stopReason, "restock-boundary");
  state = await readRestockCursor(cfg);
  assert.deepEqual(state.cursor.boundaryProductIds.sort(), ["82000", "82001", "82002"]);

  // The same product restocked on a later day is observed again.
  pages = [[{ id: 82001, date: "2026-11-11", stock: 13 }, { id: 82002, date: "2026-11-10" }]];
  site.opened.length = 0;
  await runCollection(cfg, { runId: "restock-again", browserType: site.browserType });
  assert.deepEqual(site.opened, ["82001"]);
  assert.equal((await readRestockCursor(cfg)).cursor.lastRestockedAt, "2026-11-11T00:00:00+09:00");
  assert.equal((await readRestockCursor(config("restock90", { accountId: "dated-fixture" }))).cursor, null);
  assert.equal((await readRestockCursor(config("restock30", { accountId: "other-fixture" }))).cursor, null);
  assert.doesNotMatch(fs.readFileSync(RESTOCK_STATE_PATH, "utf8"), /dated-fixture|fixture-secret/);
  site.assertReadOnly();
});

test("90-day lists without displayed dates persist the latest idx and stop at it on the next run", async () => {
  const cfg = config("restock90", { accountId: "undated-fixture" });
  let pages = [[{ id: 83002 }], [{ id: 83001 }]];
  const site = restockFixture(() => pages, 90);
  await runCollection(cfg, { runId: "undated-first", browserType: site.browserType });
  assert.deepEqual(site.opened, ["83002", "83001"]);
  assert.equal((await readRestockCursor(cfg)).cursor.lastProductId, "83002");
  pages = [[{ id: 83003 }, { id: 83002 }], [{ id: 83001 }]];
  site.opened.length = 0;
  site.requests.length = 0;
  await runCollection(cfg, { runId: "undated-next", browserType: site.browserType });
  assert.deepEqual(site.opened, ["83003"]);
  assert.ok(!site.requests.some(url => url.searchParams.get("page") === "2"));
  pages = [[{ id: 83003 }, { id: 83002 }]];
  site.opened.length = 0;
  const unchanged = await runCollection(cfg, { runId: "undated-unchanged", browserType: site.browserType });
  assert.deepEqual(site.opened, []);
  assert.deepEqual(unchanged.payload.products, []);
  site.assertReadOnly();
});

test("incomplete popup stock preserves prior state and already saved pages for a full retry", async () => {
  const cfg = config("restock30", { accountId: "failure-fixture" });
  const baseline = createRestockCheckpoint(await readRestockCursor(cfg), [{ productId: "84000", restockedAt: "2026-11-08T00:00:00+09:00" }], new Date().toISOString());
  await commitRestockCursor(baseline);
  const before = await readRestockCursor(cfg);
  const pages = [[{ id: 84001, date: "2026-11-10" }], [{ id: 84002, date: "2026-11-09", stock: "" }]];
  const site = restockFixture(() => pages);
  await assert.rejects(runCollection(cfg, { runId: "partial-failure", browserType: site.browserType }), /재고가 불완전/);
  assert.deepEqual(await readRestockCursor(cfg), before);
  assert.equal((await archived(84001)).stockQuantity, 5);
  assert.equal(await archived(84002), undefined);
  const partial = JSON.parse(fs.readFileSync(path.join(root, "cheonyu", "partial-failure", "result.json"), "utf8"));
  assert.deepEqual(partial.map(p => p.id), ["84001"]);
  pages[1][0].stock = 9;
  site.opened.length = 0;
  await runCollection(cfg, { runId: "partial-retry", browserType: site.browserType });
  assert.deepEqual(site.opened, ["84001", "84002"]);
  assert.equal((await readRestockCursor(cfg)).cursor.lastProductId, "84001");
  site.assertReadOnly();
});

test("empty, unsorted, repeated and canceled runs never advance unverified restock boundaries", async () => {
  for (const mode of ["empty", "unsorted", "repeated", "cancel"]) {
    const cfg = config("restock30", { accountId: `safety-${mode}` });
    const pages = mode === "empty" ? [[]] : mode === "unsorted" ? [[{ id: 85001, date: "2026-11-09" }, { id: 85002, date: "2026-11-10" }]]
      : [[{ id: 85001, date: "2026-11-10" }], [{ id: 85001, date: "2026-11-10" }]];
    const site = restockFixture(() => pages);
    const controller = new AbortController();
    const run = runCollection(cfg, { runId: `safety-${mode}`, browserType: site.browserType, signal: controller.signal,
      onProgress: event => { if (mode === "cancel" && event.stage === "cycle-archived") controller.abort(); } });
    if (mode === "empty") assert.deepEqual((await run).payload.products, []);
    else await assert.rejects(run, mode === "unsorted" ? /최신 재입고순/ : mode === "repeated" ? /반복/ : { name: "AbortError" });
    assert.equal((await readRestockCursor(cfg)).cursor, null);
    site.assertReadOnly();
  }
});

test("result write failures and cancellation after archiving cannot advance the restock boundary", async t => {
  for (const mode of ["write-failed", "canceled"]) {
    const cfg = config("restock30", { accountId: `final-${mode}` });
    const checkpoint = createRestockCheckpoint(await readRestockCursor(cfg), [{ productId: "86001", restockedAt: "2026-11-10T00:00:00+09:00" }], new Date().toISOString());
    const controller = new AbortController();
    const adapterMock = t.mock.method(require("../src/malls/cheonyu/lifecycle-collection"), "runCheonyuLifecycle", async () => ({
      products: [], inventoryItems: [], productSummaries: [], detailItems: [], restockCheckpoint: checkpoint,
      summary: { collectedProductCount: 0, pageRange: { pageStart: 1, pageEnd: 1 } },
    }));
    const originalWrite = fs.writeFileSync;
    const writeMock = mode === "write-failed" ? t.mock.method(fs, "writeFileSync", (filename, ...args) => {
      if (String(filename).endsWith(`${path.sep}result.json`)) throw new Error("Fixture disk write failed");
      return originalWrite(filename, ...args);
    }) : null;
    try {
      await assert.rejects(runCollection(cfg, { runId: `final-${mode}`, signal: controller.signal,
        onProgress: event => { if (mode === "canceled" && event.stage === "archiving") controller.abort(); } }),
      mode === "write-failed" ? /disk write failed/ : { name: "AbortError" });
      assert.equal((await readRestockCursor(cfg)).cursor, null);
    } finally { adapterMock.mock.restore(); writeMock?.mock.restore(); }
  }
});

test("restock state survives module reload and rejects competing or regressing updates", async () => {
  const cfg = config("restock90", { accountId: "state-fixture" });
  const start = await readRestockCursor(cfg);
  const checkpoint = createRestockCheckpoint(start, [{ productId: "87001", restockedAt: "2026-11-10T00:00:00+09:00" }], new Date().toISOString());
  await commitRestockCursor(checkpoint);
  await assert.rejects(commitRestockCursor(checkpoint), /다른 실행/);
  delete require.cache[require.resolve("../src/utils/restock-collection-state")];
  const reopened = await require("../src/utils/restock-collection-state").readRestockCursor(cfg);
  assert.equal(reopened.cursor.lastProductId, "87001");
  await assert.rejects(commitRestockCursor({ ...checkpoint, expectedRevision: reopened.cursor.revision,
    next: { ...checkpoint.next, lastRestockedAt: "2026-11-09T00:00:00+09:00" } }), /이전으로/);
});

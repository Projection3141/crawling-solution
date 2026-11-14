process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { test, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cheonyu-workflows-"));
process.env.PRODUCT_ARCHIVE_DIRECTORY = path.join(root, "archive");
after(() => fs.rmSync(root, { recursive: true, force: true }));
mock.method(require("../translate/convert"), "createConversionSnapshot", async () => null);
const { resolveRunConfig } = require("../src/config");
const { runCollection } = require("../src/crawler");
const { readProductArchive, updateProductArchive } = require("../src/utils/product-archive");
const { BEST_COLLECTIONS, getRecentMonths, findLifecycleEntry, buildLifecycleListUrl,
  parseLifecyclePage, runCheonyuLifecycle } = require("../src/malls/cheonyu/lifecycle-collection");

function config(kind, extra = {}) {
  return resolveRunConfig({ mall: "cheonyu", collectionKind: kind, showBrowser: false,
    cheonyuProxyServer: "http://gate.decodo.com:7000", cheonyuProxyUsername: "fixture", cheonyuProxyPassword: "fixture",
    ...(kind === "inventory" ? { accountId: "member", accountPw: "fixture" } : {}),
    pageSize: 2, detailRequestDelayMs: 0, requestDelayMs: 0, navigationTimeoutMs: 3000,
    outDir: root, ...extra }, {}, root);
}
const home = `<a href="/product/news.html"><img alt="신상품 더보기"></a>` +
  Object.values(BEST_COLLECTIONS).map(best => `<a href="${best.path}">더보기</a>`).join("");
const logout = '<a href="/member/logout.html">로그아웃</a>';
const product = (id, sold = false) => `<li><div ${sold ? 'class="soldout_bg"' : ''}>
  <a class="pLink" href="/product/view.html?qIDX=${id}">상품</a><div class="m_pdt_list_name">상품 ${id}</div>
  <input name="inPcheck" id="inPcheck" type="checkbox" value="${id}">
  <input name="inPcount" id="inPcount" value="1"><button id="btn_addCart">담기</button></div></li>`;
function newsPage(ids, month, lastPage = 2) {
  return `<div id="sub_list"><div class="m_list"><ul>${ids.map(id => product(id)).join("")}</ul></div>
    <div class="pagination"><a href="/product/news.html?cateIDX=ALL&searchDate=${month}&page=${lastPage}">끝</a></div></div>`;
}
function detail(id) {
  return `<div id="productView"><div class="info_wrap"><div class="pdt_name"><span>상품 ${id}</span></div></div>
    <div class="pdt-top-info"><span class="info-number">${id}</span><span class="info-number">8800000000001</span></div>
    <div class="pdt_code"><div class="pdt_code_last"><strong>12,000</strong></div></div>
    <div id="tab_01"><img src="https://image1.cheonyu.com/image/product/detail.jpg"></div></div>`;
}
function browserFixture(handler, { beforeGoto, getProbeIp = () => "192.0.2.1" } = {}) {
  const requests = [], contexts = [], pages = [];
  let popupSubmissions = 0;
  return { requests, contexts, get popupSubmissions() { return popupSubmissions; },
    browserType: { async launch(options) {
      const browser = await chromium.launch(options);
      return { close: () => browser.close(), async newContext(options) {
        contexts.push(options);
        const contextNo = contexts.length;
        const context = await browser.newContext({ ...options, proxy: undefined });
        context.request.get = async url => {
          assert.equal(url, "https://ip.decodo.com/json");
          return { ok: () => true, json: async () => ({ proxy: { ip: getProbeIp(contextNo) } }), dispose: async () => {} };
        };
        await context.exposeFunction("fixtureCartSubmission", () => { popupSubmissions++; });
        context.on("page", page => {
          pages.push(page);
          if (beforeGoto) {
            const goto = page.goto.bind(page);
            page.goto = (url, options) => {
              beforeGoto(new URL(url), contextNo);
              return goto(url, options);
            };
          }
        });
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          requests.push(url);
          if (/\.(png|jpg)$/.test(url.pathname)) return route.fulfill({ body: "", contentType: "image/jpeg" });
          const result = await handler(url, route.request());
          return route.fulfill(typeof result === "string" ? { body: result, contentType: "text/html; charset=utf-8" } : result);
        });
        return context;
      } };
    } } };
}

test("new classifications enforce login and fixed complete scope", () => {
  const guest = config("newProducts", { category: "1", pageStart: 8, pageEnd: 9, pageOrder: "reverse" });
  assert.equal(guest.accountId, "");
  assert.equal(guest.accountPw, "");
  assert.equal(guest.collectionMode, "detail");
  assert.equal(guest.category, "ALL");
  assert.equal(guest.pageStart, 1);
  assert.equal(guest.pageEnd, 0);
  assert.equal(guest.pageOrder, "forward");
  assert.equal(guest.proxy.username, "user-fixture");
  assert.equal(guest.newProductOptionAccount, false);
  const optionRun = config("newProducts", { accountId: "member", accountPw: "fixture" });
  assert.equal(optionRun.anonymousCollection, true);
  assert.equal(optionRun.newProductOptionAccount, true);
  assert.equal(optionRun.accountId, "member");
  assert.equal(optionRun.proxy.username, guest.proxy.username, "public discovery keeps its rotating connection");
  assert.throws(() => config("inventory", { accountId: "", accountPw: "" }), /계정 정보/);
  assert.throws(() => config("inventory", { inventoryBest: "bad" }), /세부항목/);
  assert.throws(() => config("restock"), /계정 정보/);
  assert.equal(config("restock", { accountId: "member", accountPw: "fixture" }).collectionKind, "changes");
  assert.equal(config("inventory").inventoryBest, "attention");
});

test("months use Seoul calendar boundaries, and entry links and pagination stay within the requested scope", () => {
  assert.deepEqual(getRecentMonths(new Date("2026-12-31T15:00:00Z")), ["2027-1", "2026-12"]);
  assert.deepEqual(getRecentMonths(new Date("2026-11-01T00:00:00+09:00")), ["2026-11", "2026-10"]);
  assert.deepEqual(getRecentMonths(new Date("2026-10-31T14:59:59Z")), ["2026-10", "2026-9"]);
  for (const [key, best] of Object.entries(BEST_COLLECTIONS)) {
    assert.equal(new URL(findLifecycleEntry(home, config("inventory", { inventoryBest: key }))).pathname, best.path);
  }
  const cfg = config("newProducts");
  const entry = findLifecycleEntry(home, cfg);
  assert.throws(() => findLifecycleEntry(home.replace('/product/news.html', 'https://evil.invalid/product/news.html'), cfg), /링크/);
  const url = buildLifecycleListUrl(entry, "2027-1", 1, 2);
  const html = newsPage(["1"], "2027-1", 3) + '<div class="pagination"><a href="?page=99&searchDate=2026-12">다른 달</a></div>';
  assert.equal(parseLifecyclePage(html, url, 1, cfg).lastPage, 3);
  assert.equal(parseLifecyclePage('<div id="sub_list">등록된 상품이 없습니다.</div>', url, 1, cfg).empty, true);
  assert.throws(() => parseLifecyclePage('<div id="sub_list"></div>', url, 1, cfg), /상품 목록/);
  assert.throws(() => parseLifecyclePage(newsPage(["1"], "2027-1", 1001), url, 1, cfg), /안전 한도/);
});

test("new products traverse both full months, skip archived IDs, deduplicate and persist distinct page checkpoints", async () => {
  await updateProductArchive([{ id: "72001", sourceMall: "cheonyu", nameKo: "보존", originalPrice: 777, stockQuantity: 9 }], { source: "detail" });
  await updateProductArchive([{ id: "72004", sourceMall: "ccdome", nameKo: "다른 쇼핑몰" }], { source: "detail" });
  const before = Object.values((await readProductArchive()).products).find(item => item.id === "72001");
  const [current, previous] = getRecentMonths();
  const fixture = browserFixture(url => {
    if (url.pathname === "/") return home;
    if (url.pathname === "/product/news.html") {
      assert.equal(url.searchParams.get("cateIDX"), "ALL");
      const month = url.searchParams.get("searchDate");
      assert.ok([current, previous].includes(month));
      const ids = month === current ? [[72001, 72002], [72003]] : [[72002, 72004], [72005]];
      return newsPage(ids[Number(url.searchParams.get("page")) - 1], month);
    }
    if (url.pathname === "/product/view.html") return detail(url.searchParams.get("qIDX"));
    throw new Error("Unexpected request " + url.pathname);
  });
  const result = await runCollection(config("newProducts"), { runId: "months", browserType: fixture.browserType });
  assert.equal(result.payload.summary.detailTargetCount, 4);
  assert.equal(result.payload.summary.collectedProductCount, 5);
  assert.deepEqual(result.payload.products.map(p => p.id).sort(), ["72002", "72003", "72004", "72005"]);
  const details = fixture.requests.filter(url => url.pathname === "/product/view.html").map(url => url.searchParams.get("qIDX"));
  assert.deepEqual(details.sort(), ["72002", "72003", "72004", "72005"]);
  assert.ok(!fixture.requests.some(url => /member|order|cart/i.test(url.pathname)));
  assert.equal(fixture.contexts[0].storageState, undefined);
  assert.equal(fixture.contexts[0].proxy.username, "user-fixture");
  for (const [number, month, sourcePage] of [[1, current, 1], [2, current, 2], [3, previous, 1], [4, previous, 2]]) {
    for (const type of ["list", "detail"]) {
      const saved = JSON.parse(fs.readFileSync(path.join(root, "cheonyu", "months", `${type}-pages`, `page-${String(number).padStart(6, "0")}.json`)));
      assert.equal(saved.pageRange.sourceMonth, month);
      assert.equal(saved.pageRange.sourcePage, sourcePage);
    }
  }
  const after = Object.values((await readProductArchive()).products).find(item => item.id === "72001");
  assert.deepEqual(after, before, "existing products must not be rewritten from list observations");
  fixture.requests.length = 0;
  const again = await runCollection(config("newProducts"), { runId: "months-again", browserType: fixture.browserType });
  assert.equal(again.payload.products.length, 0);
  assert.ok(!fixture.requests.some(url => url.pathname === "/product/view.html"));
});

test("failed new details remain absent from the archive and are retried while successful details are preserved", async () => {
  let fail = true;
  const fixture = browserFixture(url => {
    if (url.pathname === "/") return home;
    if (url.pathname === "/product/news.html") return newsPage([76001, 76002], url.searchParams.get("searchDate"), 1);
    if (url.pathname === "/product/view.html") {
      const id = url.searchParams.get("qIDX");
      if (id === "76002" && fail) return { status: 404, body: '<div id="productView">없음</div>', contentType: "text/html" };
      return detail(id);
    }
    throw new Error("Unexpected request " + url.pathname);
  });
  await assert.rejects(runCollection(config("newProducts"), { runId: "detail-failure", browserType: fixture.browserType }), /상세 수집에 실패/);
  const archived = Object.values((await readProductArchive()).products);
  assert.ok(archived.some(product => product.id === "76001"));
  assert.ok(!archived.some(product => product.id === "76002"));
  fail = false;
  fixture.requests.length = 0;
  const result = await runCollection(config("newProducts"), { runId: "detail-retry", browserType: fixture.browserType });
  assert.deepEqual(result.payload.products.map(product => product.id), ["76002"]);
  assert.deepEqual(fixture.requests.filter(url => url.pathname === "/product/view.html").map(url => url.searchParams.get("qIDX")), ["76002"]);
});

test("empty months complete, repeated pages and HTTP blocks fail, and cancellation closes the browser", async () => {
  const [current] = getRecentMonths();
  for (const mode of ["empty", "repeat", "blocked", "cancel"]) {
    const controller = new AbortController();
    const fixture = browserFixture(url => {
      if (url.pathname === "/") return home;
      if (mode === "blocked") return { status: 403, body: "blocked" };
      if (mode === "empty" || mode === "cancel") return '<div id="sub_list">등록된 상품이 없습니다.</div>';
      return newsPage([72001], url.searchParams.get("searchDate"), 2);
    });
    const run = runCheonyuLifecycle(config("newProducts"), { browserType: fixture.browserType, signal: controller.signal,
      onProgress: () => { if (mode === "cancel") controller.abort(new Error("fixture canceled")); } });
    if (mode === "empty") assert.equal((await run).summary.collectedProductCount, 0);
    else await assert.rejects(run, mode === "repeat" ? /같은 상품 목록/ : mode === "blocked" ? /403/ : { name: "AbortError" });
    if (mode === "repeat") assert.ok(fixture.requests.some(url => url.searchParams.get("searchDate") === current && url.searchParams.get("page") === "2"));
  }
});

function popupRow(optionId, stock) {
  return `<tr id="inOptionTR"><td class="option_txt">옵션 ${optionId}</td><td>
    <input type="checkbox" id="optionCHKPOP" value="${optionId}"><input id="inOPcount" value="1">
    <input id="inOPMaxStock" value="${stock}"><input id="inOPidx" value="${optionId || 0}"></td></tr>`;
}
function bestPage(incomplete = false) {
  const popups = [73001, 73002].map(id => `<div class="many_add" data-product-id="${id}">
    <div class="subject"><p>상품 ${id}</p></div><table id="opSelectedList"><tbody>
    ${id === 73001 ? popupRow("11", incomplete ? "" : 7) + popupRow("12", incomplete ? "" : 0) : popupRow("", 5)}</tbody></table></div>`).join("");
  return logout + `<div id="sub_list"><ul>${product(73001)}${product(73002)}${product(73003, true)}</ul></div>
    <button class="all_add_btn" onclick="document.querySelector('#popups').innerHTML = window.popupHtml">팝업 열기</button>
    <div id="popups"></div><script>window.popupHtml = ${JSON.stringify(popups)};
    window.setOption = () => window.fixtureCartSubmission();
    window.closeCartIn = () => { document.querySelector('#popups').innerHTML = ''; };</script>`;
}

function memberFixture(best, html = bestPage(), options) {
  let loggedIn = false;
  return browserFixture((url, request) => {
    if (url.pathname === "/member/login.html") return '<form method="post" action="/member/loginResult.html"><input name="inMID"><input name="inMPW" type="password"><button type="submit">로그인</button></form>';
    if (url.pathname === "/member/loginResult.html") { assert.equal(request.method(), "POST"); loggedIn = true; return logout; }
    assert.equal(loggedIn, true);
    if (url.pathname === "/") return logout + home;
    if (url.pathname === best.path) return typeof html === "function" ? html(url) : html;
    throw new Error("Unexpected request " + url.pathname);
  }, options);
}

test("best inventory resumes the unfinished page after a verified tunnel fault and stops on CONNECT 407", async () => {
  const best = BEST_COLLECTIONS.attention;
  for (const statusCode of [502, 407]) {
    const archivedPages = [], attemptedPages = [], progress = [], probes = [];
    const site = memberFixture(best, url => logout +
      `<div id="sub_list"><ul>${product(73900 + Number(url.searchParams.get("page")), true)}</ul></div>
      <div class="pagination"><a href="${best.path}?cateIDX=ALL&page=2">끝</a></div>`, {
      beforeGoto(url, contextNo) {
        if (url.pathname !== best.path) return;
        const pageNo = Number(url.searchParams.get("page"));
        attemptedPages.push([contextNo, pageNo]);
        if (contextNo === 1 && pageNo === 2) throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED");
      },
    });
    const cfg = config("inventory");
    const run = runCheonyuLifecycle(cfg, {
      browserType: site.browserType,
      probeTunnel: async ({ proxy, url }) => {
        probes.push({ proxy, url });
        return { statusCode };
      },
      onProgress: event => progress.push(event),
      onCycleArchive: event => archivedPages.push(event.cycleNo),
    });
    if (statusCode === 407) {
      await assert.rejects(run, { code: "PROXY_AUTHENTICATION_REQUIRED" });
      assert.deepEqual(archivedPages, [1]);
      assert.deepEqual(attemptedPages, [[1, 1], [1, 2]]);
    } else {
      const result = await run;
      assert.deepEqual(archivedPages, [1, 2]);
      assert.deepEqual(attemptedPages, [[1, 1], [1, 2], [2, 2]]);
      assert.deepEqual(result.products.map(p => String(p.productId)), ["73901", "73902"]);
      assert.notEqual(site.contexts[1].proxy.username, site.contexts[0].proxy.username);
      assert.ok(progress.some(event => event.stage === "proxy-session" && event.currentPage === 2));
    }
    assert.equal(site.requests.filter(url => url.pathname === "/member/loginResult.html").length, statusCode === 407 ? 1 : 2);
    assert.equal(site.popupSubmissions, 0);
    assert.deepEqual(probes, [{ proxy: cfg.proxy, url: cfg.baseUrl }]);
  }
});

test("a logged-out list triggers an IP check and resumes only when the proxy session changed", async () => {
  const best = BEST_COLLECTIONS.attention;
  for (const ipChanges of [true, false]) {
    let loggedOutList = false;
    let ip = "192.0.2.1";
    const saved = [];
    const site = memberFixture(best, url => {
      if (loggedOutList) {
        loggedOutList = false;
        if (ipChanges) ip = "192.0.2.2";
        return "<p>로그인 필요</p>";
      }
      const pageNo = Number(url.searchParams.get("page"));
      return logout + `<div id="sub_list"><ul>${product(73800 + pageNo, true)}</ul></div>
        <div class="pagination"><a href="${best.path}?cateIDX=ALL&page=2">끝</a></div>`;
    }, {
      getProbeIp: () => ip,
      beforeGoto(url, contextNo) {
        if (url.pathname === best.path && url.searchParams.get("page") === "2" && contextNo === 1) loggedOutList = true;
      },
    });
    const run = runCheonyuLifecycle(config("inventory"), {
      browserType: site.browserType, onCycleArchive: event => saved.push(event.cycleNo),
    });
    if (ipChanges) {
      assert.equal((await run).summary.collectedProductCount, 2);
      assert.deepEqual(saved, [1, 2]);
      assert.equal(site.contexts.length, 2);
    } else {
      await assert.rejects(run, { code: "CHEONYU_LOGIN_REQUIRED" });
      assert.deepEqual(saved, [1]);
      assert.equal(site.contexts.length, 1);
    }
  }
});

test("all three best lists log in, read complete popup stock and never submit or clear a cart", async () => {
  await updateProductArchive([{ id: "73001", sourceMall: "cheonyu", nameKo: "기존 이름", originalPrice: 1200,
    inventoryObserved: true, type: "OPTION", options: [{ id: "11", barcode: "8800000000011", nameKo: "빨강", stockQuantity: 99 }] }], { source: "general" });
  for (const [key, best] of Object.entries(BEST_COLLECTIONS)) {
    const fixture = memberFixture(best);
    const result = await runCollection(config("inventory", { inventoryBest: key }), { runId: `best-${key}`, browserType: fixture.browserType });
    assert.equal(result.payload.summary.collectedProductCount, 3);
    const optionProduct = result.payload.products.find(item => item.id === "73001");
    assert.equal(optionProduct.stockQuantity, 7);
    assert.equal(optionProduct.options.find(option => option.id === "12").stockQuantity, 0);
    assert.equal(result.payload.products.find(item => item.id === "73002").stockQuantity, 5);
    assert.equal(result.payload.products.find(item => item.id === "73003").saleStatus, "SOLD_OUT");
    assert.equal(fixture.popupSubmissions, 0);
    assert.ok(!fixture.requests.some(url => /order|cart|product\/list|product\/view/.test(url.pathname)));
    assert.match(fixture.contexts[0].proxy.username, /sessionduration-60$/);
    assert.doesNotMatch(JSON.stringify(result.payload.products), /nameKo|barcode|Price/);
  }
  const saved = Object.values((await readProductArchive()).products).find(item => item.id === "73001");
  assert.equal(saved.nameKo, "기존 이름");
  assert.equal(saved.originalPrice, 1200);
  assert.equal(Object.values(saved.options).find(option => option.id === "11").barcode, "8800000000011");
});

test("incomplete popup stock is not marked sold out and does not fall back to submitting a cart", async () => {
  const fixture = memberFixture(BEST_COLLECTIONS.attention, bestPage(true));
  await assert.rejects(runCollection({ ...config("inventory"), inventoryPopupWaitMs: 500 },
    { runId: "incomplete-stock", browserType: fixture.browserType }), /재고를 확인하지 못했습니다/);
  assert.equal(fixture.popupSubmissions, 0);
  assert.ok(!fixture.requests.some(url => /order|cart|product\/list/.test(url.pathname)));
  const partial = JSON.parse(fs.readFileSync(path.join(root, "cheonyu", "incomplete-stock", "result.json")));
  assert.deepEqual(partial.map(product => product.id).sort(), ["73002", "73003"]);
  const saved = Object.values((await readProductArchive()).products).find(item => item.id === "73001");
  assert.equal(saved.stockQuantity, 7);
  assert.equal(saved.saleStatus, "ON_SALE");
});

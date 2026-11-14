process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { test, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
process.env.PRODUCT_ARCHIVE_DIRECTORY = path.join(root, "archive");
after(() => {
  assert.ok(root.startsWith(path.join(os.tmpdir(), "lifecycle-test-")));
  fs.rmSync(root, { recursive: true, force: true });
});
const { resolveRunConfig, toSafeConfig } = require("../src/config");
const { createDecodoProxy, monitorDecodoSession } = require("../src/utils/decodo");
const { createCollectionProxy, monitorCollectionSession } = require("../src/utils/collection-proxy");
const { classifyCollectionFailure } = require("../src/utils/collection-failure");
const { keepConsumerPrices } = require("../src/utils/consumer-price");
const { createBackendProducts } = require("../src/utils/backend-product");
const { updateProductArchive, readProductArchive } = require("../src/utils/product-archive");
const { getCheonyuCartFallbackProductIds, parseListHtml } = require("../src/malls/cheonyu/site");
const { selectLifecycleTargets } = require("../src/malls/cheonyu/public-collection");
const { DETAIL_DATA_SCHEMA_VERSION, readDetailCollectionState } = require("../src/utils/detail-collection-state");
const conversion = require("../translate/convert");
mock.method(conversion, "createConversionSnapshot", async () => null);
const { runCollection } = require("../src/crawler");

const proxyInput = { cheonyuProxyServer: "http://gate.decodo.com:7000", cheonyuProxyUsername: "user-fixture-country-kr-session-old-sessionduration-10", cheonyuProxyPassword: "proxy-secret" };
function config(kind, extra = {}) {
  return resolveRunConfig({ mall: "cheonyu", collectionKind: kind, ...proxyInput,
    pageStart: 1, pageEnd: 0, pageSize: 2, showBrowser: false, detailRequestDelayMs: 0,
    requestDelayMs: 0, outDir: root, ...extra }, {}, root);
}

test("new collection enforces authentication and Decodo policies at the backend", () => {
  const initial = config("initial", { accountId: "unused", accountPw: "unused-secret", collectionMode: "general" });
  assert.equal(initial.accountId, "");
  assert.equal(initial.accountPw, "");
  assert.equal(initial.collectionMode, "detail");
  assert.equal(initial.proxy.username, "user-fixture-country-kr");
  assert.deepEqual(initial.proxyRotation, []);
  assert.equal(config("longTerm").longTermDays, 90);
  assert.throws(() => config("shortTerm"), /계정 정보/);
  const short = config("shortTerm", { accountId: "member", accountPw: "member-secret" });
  assert.match(short.proxy.username, /-session-[a-f0-9]{24}-sessionduration-60$/);
  assert.notEqual(short.proxy.username, createDecodoProxy(short.proxy, true).username);
  assert.equal(short.consumerPriceOnly, true);
  assert.doesNotMatch(JSON.stringify(toSafeConfig(short)), /proxy-secret|member-secret|user-fixture/);
  assert.throws(() => config("initial", { cheonyuProxyServer: "http://example.com:7000" }), /gate.decodo/);
  assert.throws(() => config("bad"), /새 수집/);
});

test("sticky sessions stop on IP changes and deadline instead of retrying cart mutations", async () => {
  let ip = "192.0.2.1";
  let now = 0;
  const failures = [];
  const context = { request: { get: async () => ({ ok: () => true, json: async () => ({ proxy: { ip } }), dispose: async () => {} }) } };
  const session = await monitorDecodoSession(context, error => failures.push(error), { now: () => now });
  try {
    await session.check();
    now = 50 * 60000;
    assert.equal(session.needsRenewal(), true);
    ip = "192.0.2.2";
    await assert.rejects(session.check(), { code: "DECODO_SESSION_LOST" });
    assert.equal(classifyCollectionFailure(failures[0]).stopAutoRepeat, true);
  } finally { session.stop(); }
  now = 0;
  const expired = await monitorDecodoSession(context, error => failures.push(error), { now: () => now });
  try {
    now = 59 * 60000;
    await assert.rejects(expired.check(), { code: "DECODO_SESSION_LOST" });
  } finally { expired.stop(); }
});

test("DataImpulse preserves targeting, removes old session settings and isolates 60-minute ports", () => {
  const input = { cheonyuProxyProvider: "dataimpulse", cheonyuProxyServer: "http://gw.dataimpulse.com:10001",
    cheonyuProxyUsername: "fixture__cr.kr;asn.123;sessid.old;sessttl.30", cheonyuProxyPassword: "proxy-secret" };
  for (const kind of ["initial", "longTerm"]) {
    const run = config(kind, input);
    assert.equal(run.proxyProvider, "dataimpulse");
    assert.equal(run.proxy.server, "http://gw.dataimpulse.com:823");
    assert.equal(run.proxy.username, "fixture__cr.kr;asn.123");
    assert.equal(run.accountId, "");
    assert.deepEqual(run.proxyRotation, []);
  }
  const run = config("shortTerm", { ...input, accountId: "member", accountPw: "member-secret" });
  assert.equal(run.proxy.username, "fixture__cr.kr;asn.123;sessttl.60");
  const port = Number(new URL(run.proxy.server).port);
  assert.ok(port >= 10000 && port <= 20000);
  assert.notEqual(port, 10001);
  const ports = new Set([port]);
  for (let i = 0; i < 30; i++) ports.add(Number(new URL(createCollectionProxy(run.proxy, true, "dataimpulse").server).port));
  assert.equal(ports.size, 31, "parallel and renewed sessions must not share ports");
  assert.equal(toSafeConfig(run).proxyProvider, "dataimpulse");
  assert.doesNotMatch(JSON.stringify(toSafeConfig(run)), /proxy-secret|member-secret|fixture__/);
  assert.throws(() => config("initial", { ...input, cheonyuProxyProvider: "decodo" }), /Decodo Residential/);
  assert.throws(() => config("initial", { ...input, cheonyuProxyServer: "http://gw.dataimpulse.com:824" }), /gw.dataimpulse/);
});

test("DataImpulse IP checks use the selected session and stop repetition on IP loss or expiry", async () => {
  let now = 0;
  let ip = "192.0.2.1";
  let disposed = 0;
  const failures = [];
  const context = { request: { get: async url => {
    assert.equal(url, "https://api.ipify.org?format=json");
    return { ok: () => true, json: async () => ({ ip }), dispose: async () => { disposed++; } };
  } } };
  const session = await monitorCollectionSession(context, error => failures.push(error), "dataimpulse", { now: () => now });
  try {
    now = 49 * 60000;
    assert.equal(session.needsRenewal(), false);
    now = 50 * 60000;
    assert.equal(session.needsRenewal(), true);
    ip = "192.0.2.2";
    await assert.rejects(session.check(), { code: "DATAIMPULSE_SESSION_LOST", retryable: false });
    assert.equal(classifyCollectionFailure(failures[0]).stopAutoRepeat, true);
    assert.match(failures[0].message, /DataImpulse/);
    assert.equal(disposed, 2);
  } finally { session.stop(); }
  now = 0;
  const expired = await monitorCollectionSession(context, () => {}, "dataimpulse", { now: () => now });
  try {
    now = 59 * 60000;
    await assert.rejects(expired.check(), { code: "DATAIMPULSE_SESSION_LOST" });
  } finally { expired.stop(); }
});

test("initial and long-term selection use detail success time, not recent inventory updates", () => {
  const now = Date.now();
  const success = days => ({ detailStatus: "success", detailDataSchemaVersion: DETAIL_DATA_SCHEMA_VERSION,
    lastDetailSuccessAt: new Date(now - days * 86400000).toISOString() });
  const state = { products: { "cheonyu:1": success(100), "cheonyu:2": success(1), "cheonyu:3": { detailStatus: "failed" } } };
  const items = [1,2,3,4].map(id => ({ productId: String(id) }));
  const ids = new Set(["1", "2", "3"]);
  assert.deepEqual(selectLifecycleTargets(items, state, ids, config("initial"), now).map(x => x.productId), ["3", "4"]);
  assert.deepEqual(selectLifecycleTargets(items, state, ids, config("longTerm"), now).map(x => x.productId), ["1", "3"]);
});

test("short-term cart fallback includes newly discovered option barcodes only", () => {
  const rows = [{ productId: "1", optionId: "11", hasOption: true, selectable: true },
    { productId: "2", optionId: "22", hasOption: true, selectable: true },
    { productId: "3", optionId: "33", hasOption: true, selectable: false }];
  assert.deepEqual(getCheonyuCartFallbackProductIds({ collectionMode: "general",
    selectableProducts: ["1","2","3","4"].map(productId => ({ productId })),
    popupOptionRows: rows, completePopupProductIds: ["1","2","3"], knownOptionBarcodes: new Set(["1:11"]),
  }), ["2", "4"]);
  assert.deepEqual(getCheonyuCartFallbackProductIds({ collectionMode: "general",
    selectableProducts: ["1", "2", "3", "4"].map(productId => ({ productId })),
    popupOptionRows: rows, completePopupProductIds: ["1", "2", "3"],
  }), ["4"], "inventory-only does not add stock-complete options just to retrieve a barcode");
});

test("consumer-only results preserve existing inventory, barcodes and unobserved prices", async () => {
  await updateProductArchive([{ id: "92001", sourceMall: "cheonyu", inventoryObserved: true, type: "OPTION",
    nameKo: "기존", originalPrice: 1000, wholesalePrice: 700, stockQuantity: 9,
    options: [{ id: "11", barcode: "8800000000011", nameKo: "빨강", stockQuantity: 9, additionalPrice: 100, additionalPriceObserved: true }],
  }], { source: "general" });
  const products = await createBackendProducts({ collectionMode: "detail", consumerPriceOnly: true,
    detailItems: [{ productId: "92001", sourceMall: "cheonyu", productName: "갱신", consumerPrice: 1200 }],
  });
  const updated = await updateProductArchive(products, { source: "detail" });
  const result = updated.currentProducts[0];
  assert.equal(result.originalPrice, 1200);
  assert.equal(result.wholesalePrice, 700);
  assert.equal(result.stockQuantity, 9);
  assert.equal(result.options[0].barcode, "8800000000011");
  const short = await createBackendProducts({ collectionMode: "general", consumerPriceOnly: true,
    products: [{ productId: "92001", sourceMall: "cheonyu", consumerPrice: 1300 }],
    inventoryItems: [{ productId: "92001", sourceMall: "cheonyu", hasOption: true, optionId: "11", maxStock: 5,
      onePrice: 800, addPrice: 200, addPriceObserved: true }],
  });
  assert.equal(short[0].wholesalePrice, null);
  assert.equal(short[0].originalPrice, 1300);
  assert.equal(Object.hasOwn(short[0].options[0], "additionalPrice"), false);
  const shortArchive = await updateProductArchive(short, { source: "general" });
  assert.equal(shortArchive.currentProducts[0].options[0].additionalPrice, 100);
  assert.equal(shortArchive.currentProducts[0].wholesalePrice, 700);
  assert.deepEqual(keepConsumerPrices({ rows: [{ consumerPrice: 1300, onePrice: 800, addPrice: 200, maxStock: 5 }] }),
    { rows: [{ consumerPrice: 1300, maxStock: 5 }] });
});

test("short-term checkpoints and CSVs contain consumer prices without wholesale summaries", async t => {
  const products = [{ productId: "94001", page: 1, sourceMall: "cheonyu", productName: "상품", consumerPrice: 1200 }];
  const inventoryItems = [{ productId: "94001", sourceMall: "cheonyu", hasOption: true, optionId: "11", optionText: "옵션",
    maxStock: 5, barcode: "8800000000011", onePrice: 800, effectivePrice: 750, addPrice: 200 }];
  const pageRange = { pageStart: 1, pageEnd: 1, collectedLastPage: 1, collectedPageCount: 1 };
  t.mock.method(require("../src/malls/cheonyu"), "run", async (_config, callbacks) => {
    await callbacks.onListPage({ pageNo: 1, pageRange, products, popupOptionItems: inventoryItems });
    await callbacks.onCycleArchive({ cycleNo: 1, pageRange, products, inventoryItems });
    return { products, inventoryItems, detailItems: [], popupOptionItems: inventoryItems,
      productSummaries: [{ productId: "94001", priceMin: 750, priceMax: 800 }],
      summary: { pageRange, collectedProductCount: 1 }, debugFiles: { "debug-cart.html": "wholesale HTML" } };
  });
  const result = await runCollection(config("shortTerm", { accountId: "fixture", accountPw: "fixture", pageEnd: 1 }), { runId: "short-prices" });
  assert.equal(result.payload.products[0].originalPrice, 1200);
  assert.equal(result.payload.products[0].wholesalePrice, null);
  const runDirectory = path.join(root, "cheonyu", "short-prices");
  for (const name of ["inventory.csv", "summary.csv", "products.csv", "list-pages/page-000001.json"]) {
    const content = fs.readFileSync(path.join(runDirectory, name), "utf8");
    assert.doesNotMatch(content, /onePrice|effectivePrice|priceMin|priceMax|addPrice/);
  }
  assert.equal(fs.existsSync(path.join(runDirectory, "debug-cart.html")), false);
});

test("inventory-only updates stock while preserving catalog data and exporting only inventory", async t => {
  assert.throws(() => config("inventory"), /계정 정보/);
  const runConfig = config("inventory", { accountId: "fixture", accountPw: "fixture", pageEnd: 1 });
  assert.equal(runConfig.collectionMode, "general");
  assert.equal(runConfig.anonymousCollection, false);
  assert.equal(runConfig.inventoryOnly, true);
  assert.match(runConfig.proxy.username, /sessionduration-60$/);
  const id = "95001";
  await updateProductArchive([{ id, sourceMall: "cheonyu", inventoryObserved: true,
    type: "OPTION", nameKo: "보존 상품", originalPrice: 1200, wholesalePrice: 700,
    options: [{ id: "11", nameKo: "보존 옵션", barcode: "8800000000011", additionalPrice: 100,
      additionalPriceObserved: true, stockQuantity: 9, status: "ON_SALE" }] }], { source: "general" });
  await updateProductArchive([{ id, sourceMall: "cheonyu", barcode: "8800000000022",
    imageUrls: ["https://fixture.invalid/original.jpg"], specs: [{ key: "original" }] }], { source: "detail" });
  const before = Object.values((await readProductArchive()).products).find(p => p.id === id);
  const products = [{ productId: id, sourceMall: "cheonyu", page: 1, productName: "새 이름 제외", consumerPrice: 9999, imageUrl: "https://fixture.invalid/new.jpg" }];
  const inventoryItems = [{ productId: id, sourceMall: "cheonyu", optionId: "11", hasOption: true,
    optionText: "새 옵션명 제외", maxStock: 0, stockStatus: "OUT_OF_STOCK", isSoldOut: true,
    onePrice: 999, barcode: "8800000000099", addPrice: 999, addPriceObserved: true }];
  const pageRange = { pageStart: 1, pageEnd: 1, collectedLastPage: 1, collectedPageCount: 1 };
  const conversionsBefore = conversion.createConversionSnapshot.mock.calls.length;
  t.mock.method(require("../src/malls/cheonyu/lifecycle-collection"), "runCheonyuLifecycle", async (passedConfig, callbacks) => {
    assert.equal(passedConfig.inventoryOnly, true);
    assert.equal(callbacks.onListPage, null);
    await callbacks.onCycleArchive({ cycleNo: 1, pageRange, products, inventoryItems });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(root, "cheonyu", "inventory-only", "result.json"), "utf8"));
    assert.equal(checkpoint[0].stockQuantity, 0);
    assert.equal(Object.hasOwn(checkpoint[0], "originalPrice"), false);
    return { products, inventoryItems, detailItems: [], productSummaries: [{ productId: id, totalStock: 0, priceMin: 999 }],
      summary: { pageRange, collectedProductCount: 1 }, debugFiles: { "debug-cart.html": "price and barcode HTML" } };
  });
  const result = await runCollection(runConfig, { runId: "inventory-only" });
  assert.equal(conversion.createConversionSnapshot.mock.calls.length, conversionsBefore);
  assert.equal(result.payload.products[0].stockQuantity, 0);
  assert.equal(result.payload.products[0].options[0].stockQuantity, 0);
  assert.equal(result.payload.products[0].options[0].status, "SOLD_OUT");
  assert.doesNotMatch(JSON.stringify(result.payload.products), /nameKo|barcode|Price|imageUrl|specs/);
  const after = Object.values((await readProductArchive()).products).find(p => p.id === id);
  for (const key of ["nameKo", "originalPrice", "wholesalePrice", "barcode", "imageUrls", "specs"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  const oldOption = Object.values(before.options)[0];
  const newOption = Object.values(after.options)[0];
  for (const key of ["nameKo", "barcode", "additionalPrice"]) assert.deepEqual(newOption[key], oldOption[key], key);
  assert.equal(newOption.stockQuantity, 0);
  assert.equal(after.stockQuantity, 0);
  assert.equal((await readDetailCollectionState()).products[`cheonyu:${id}`], undefined);
  const runDirectory = path.join(root, "cheonyu", "inventory-only");
  for (const name of ["inventory.csv", "summary.csv", "products.csv", "result.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(runDirectory, name), "utf8"), /productName|optionText|barcode|Price|priceMin|imageUrl|새 이름/);
  }
  assert.equal(fs.existsSync(path.join(runDirectory, "debug-cart.html")), false);
});

test("normal collection pipeline browses public pages without login or cart and saves progress", async () => {
  const requests = [];
  const contexts = [];
  const events = [];
  let failDetail = false;
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return { close: () => browser.close(), async newContext(options) {
      contexts.push(options);
      const context = await browser.newContext({ ...options, proxy: undefined });
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        requests.push(url.pathname);
        if (url.pathname === "/product/list.html") return route.fulfill({ contentType: "text/html; charset=utf-8", body:
          '<span id="ProductCount">2</span><ul>' + [93001,93002].map(id => `<li><a class="pLink" href="/product/view.html?qIDX=${id}"><span class="m_pdt_list_name">공개 상품 ${id}</span></a></li>`).join("") + '</ul>' });
        if (url.pathname === "/product/view.html") {
          if (failDetail) return route.fulfill({ status: 403, body: "denied" });
          const id = url.searchParams.get("qIDX");
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<div id="productView"><div class="info_wrap"><div class="pdt_name"><span class="hint"></span><span>공개 상품 ${id}</span></div></div><div class="pdt-top-info"><span class="info-number">${id}</span><span class="info-number">8800000000001</span></div><div class="pdt_code"><div class="pdt_code_last"><strong>12,000</strong></div></div><div id="tab_01"><img src="https://image1.cheonyu.com/image/product/detail.jpg"></div></div>` });
        }
        if (/\.(jpg|png)$/.test(url.pathname)) return route.fulfill({ body: "", contentType: "image/jpeg" });
        throw new Error("Unexpected request " + url.pathname);
      });
      return context;
    } };
  } };
  const guest = config("initial");
  const list = parseListHtml('<li><a class="pLink" href="/product/view.html?qIDX=93001">공개</a></li>', 1, guest);
  assert.equal(list.length, 1);
  assert.equal(list[0].saleStatus, null);
  assert.equal(Object.hasOwn(list[0], "cartAddable"), false);
  const result = await runCollection(guest, { runId: "public-initial", browserType, onProgress: p => events.push(p) });
  assert.equal(result.payload.products.length, 2);
  assert.equal(result.payload.products[0].originalPrice, 12000);
  assert.match(result.payload.products[0].nameKo, /공개 상품/);
  assert.equal(result.payload.products[0].stockQuantity, null);
  assert.notEqual(result.payload.products[0].saleStatus, "SOLD_OUT");
  assert.equal(result.files.translatedResult, null);
  assert.equal(contexts[0].storageState, undefined);
  assert.ok(!requests.some(url => /member|order|cart|commers/i.test(url)));
  assert.ok(events.some(p => p.stage === "detail-page-saved"));
  assert.ok((await readDetailCollectionState()).products["cheonyu:93001"].lastDetailSuccessAt);
  requests.length = 0;
  const again = await runCollection(guest, { runId: "public-again", browserType });
  assert.equal(again.payload.products.length, 0);
  assert.ok(!requests.includes("/product/view.html"));
  failDetail = true;
  // Force recheck through the existing state store, as a failed/unknown previous detail requires a retry.
  const { recordDetailAttempts } = require("../src/utils/detail-collection-state");
  await recordDetailAttempts({ mall: "cheonyu", products: [{ productId: "93001" }] });
  await assert.rejects(runCollection(guest, { runId: "public-blocked", browserType }), /403/);
  const preserved = Object.values((await readProductArchive()).products).find(p => p.id === "93001");
  assert.equal(preserved.originalPrice, 12000);
});

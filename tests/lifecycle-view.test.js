// Test the real renderer with a local IPC fixture, without loading registered credentials.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { getPublicDefaults } = require("../src/config");

test("new collection UI shares execution status, cancellation and repeat scheduling", async t => {
  const publicRoot = path.resolve(__dirname, "../public");
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(publicRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(publicRoot + path.sep)) return response.writeHead(404).end();
    try {
      response.setHeader("Content-Type", ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(defaults => {
    localStorage.setItem("mall-collector-accounts-v1", JSON.stringify([
      { id: "member", name: "테스트 계정", loginId: "fixture-member", password: "fixture-password" },
    ]));
    window.fixtureRuns = [];
    window.fixtureInputs = [];
    window.fixtureDelays = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay >= 86400000) window.fixtureDelays.push(delay);
      return nativeSetTimeout(callback, delay, ...args);
    };
    const state = () => ({ runs: window.fixtureRuns, activeRunCount: window.fixtureRuns.filter(run => run.status === "running").length, shipping: {}, cart: {} });
    window.collectorApp = {
      getBrands: async () => ({ brands: [], recent: [], used: 0, remaining: 10, limit: 10 }),
      getDefaults: async () => ({ ...defaults, app: { version: "fixture" } }),
      getState: async () => state(),
      getCredentialProfiles: async () => ({ proxies: [
        { id: "decodo", name: "Decodo 테스트", server: "http://gate.decodo.com:7000" },
        { id: "dataimpulse", name: "DataImpulse 테스트", provider: "dataimpulse", server: "http://gw.dataimpulse.com:823" },
        { id: "other", name: "다른 프록시", server: "http://localhost:1234" },
      ], openAiKeys: [{ id: "ai", name: "선택 번역" }], shippingAccounts: [] }),
      saveProxyProfile: async input => {
        window.fixtureSavedProxy = input;
        const summary = await window.collectorApp.getCredentialProfiles();
        summary.proxies.push({ ...input, id: "registered-dataimpulse", password: undefined, hasPassword: true });
        return { summary, selectedId: "registered-dataimpulse" };
      },
      getUploadApiSettings: async () => ({ uploadApiUrl: "https://fixture.invalid/", isDefault: true }),
      getCollectionUploadLogs: async () => ({ items: [], page: 1, totalPages: 1, totalCount: 0 }),
      onStateChanged: listener => { window.fixtureStateListener = listener; return () => {}; },
      start: async input => {
        window.fixtureInputs.push(input);
        const run = { id: `fixture-${window.fixtureInputs.length}`, status: "running", startedAtMs: Date.now(),
          request: { ...input, accountName: input.collectionKind === "newProducts" && !input.accountId ? "비로그인" : input.accountName },
          progress: { stage: "collecting", message: "페이지 수집 중", collectedProductCount: 25 }, files: {}, summary: null };
        window.fixtureRuns.unshift(run);
        return run;
      },
      cancel: async id => { window.fixtureRuns.find(run => run.id === id).status = "canceled"; return state(); },
    };
  }, getPublicDefaults({}, "fixture-output"));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector("#appBadge").textContent.includes("fixture") || document.querySelector("#appBadge").textContent.includes("실패"));
  assert.match(await page.locator("#appBadge").innerText(), /fixture/, await page.locator("#errorMessage").innerText());
  const menu = page.locator('[data-view="lifecycle-collection"]');
  assert.match(await menu.innerText(), /새 수집\(신규\)/);
  await menu.click();
  assert.equal(await page.locator("#lifecycleCollectionView").isVisible(), true);
  assert.deepEqual(await page.locator("#lifecycleKind option").allTextContents(), ["재고 파악", "새 제품 수집", "상품 변동 확인"]);
  assert.deepEqual(await page.locator("#lifecycleChange option").allTextContents(), ["품절", "재입고 (최근 30일)", "재입고 (최근 90일)"]);
  assert.deepEqual(await page.locator("#lifecycleBest option").allTextContents(), ["주목받는 베스트", "문구점 베스트", "과자 베스트"]);
  assert.equal(await page.locator("#lifecycleAccount").isEnabled(), true);
  await page.locator("#lifecycleKind").selectOption("newProducts");
  assert.equal(await page.locator("#lifecycleAccount").isEnabled(), true);
  assert.equal(await page.locator("#lifecycleBestField").isVisible(), false);
  assert.equal(await page.locator("#lifecycleProxy option").count(), 3);
  await page.locator("#lifecycleProxy").selectOption("decodo");
  await page.locator("#lifecycleBrowser").selectOption("show-no-images");
  await page.locator("#lifecycleSubmit").click();
  await page.locator("#runsView.active").waitFor();
  assert.equal(await page.locator("#lifecycleCollectionView").isVisible(), false);
  assert.match(await page.locator("#runList").innerText(), /새 제품 수집/);
  assert.match(await page.locator("#runList").innerText(), /비로그인/);
  const initial = await page.evaluate(() => window.fixtureInputs[0]);
  assert.equal(initial.showBrowser, true);
  assert.equal(initial.blockImages, true);
  assert.equal(Object.hasOwn(initial, "accountId"), false);
  assert.equal(Object.hasOwn(initial, "openAiProfileId"), false);
  assert.equal(initial.collectionKind, "newProducts");
  assert.equal(initial.category, "ALL");
  assert.equal(initial.pageStart, 1);
  assert.equal(initial.pageEnd, 0);
  await page.getByRole("button", { name: "이 실행 취소" }).click();

  await menu.click();
  await page.locator("#lifecycleAccount").selectOption("member");
  await page.locator("#lifecycleRunMode").selectOption("repeat");
  await page.locator("#lifecycleRepeatDays").fill("2");
  await page.locator("#lifecycleSubmit").click();
  await page.locator("#runsView.active").waitFor();
  assert.match(await page.locator("#runList").innerText(), /새 제품 수집/);
  await page.evaluate(() => {
    const run = window.fixtureRuns[0];
    run.status = "completed";
    run.finishedAtMs = Date.now();
    run.progress = { stage: "completed", message: "완료" };
    window.fixtureStateListener({ runs: window.fixtureRuns, activeRunCount: 0, shipping: {}, cart: {} });
  });
  await page.getByRole("button", { name: "반복 예약 중지" }).click();
  assert.equal(await page.getByRole("button", { name: "반복 예약 중지" }).count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureInputs.length), 2);
  assert.equal(await page.evaluate(() => window.fixtureInputs[1].accountId), "fixture-member");
  const delays = await page.evaluate(() => window.fixtureDelays);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] <= 2 * 86400000 && delays[0] > 2 * 86400000 - 5000);

  await menu.click();
  await page.locator("#lifecycleKind").selectOption("inventory");
  await page.locator("#lifecycleBest").selectOption("stationery");
  await page.locator("#lifecycleProxy").selectOption("dataimpulse");
  assert.equal(await page.locator("#lifecycleAccount").isEnabled(), true);
  assert.equal(await page.locator("#lifecycleBestField").isVisible(), true);
  assert.equal(await page.locator("#lifecycleOpenAi").isDisabled(), true);
  await page.locator("#lifecycleRunMode").selectOption("once");
  await page.locator("#lifecycleAccount").selectOption("member");
  assert.match(await menu.getAttribute("class"), /active/);
  await page.locator(".content-wrapper").evaluate(element => { element.scrollTop = 0; });
  await fs.mkdir(path.resolve(__dirname, "../out"), { recursive: true });
  await page.screenshot({ path: path.resolve(__dirname, "../out/lifecycle-collection-ui.png"), fullPage: true, animations: "disabled" });
  await page.locator("#lifecycleSubmit").click();
  await page.locator("#runsView.active").waitFor();
  const short = await page.evaluate(() => window.fixtureInputs.at(-1));
  assert.equal(short.collectionKind, "inventory");
  assert.equal(short.inventoryBest, "stationery");
  assert.equal(short.accountId, "fixture-member");
  assert.equal(short.proxyProfileId, "dataimpulse");
  assert.match(await page.locator("#runList").innerText(), /재고 파악 · 문구점 베스트/);
  await page.getByRole("button", { name: "이 실행 취소" }).click();
  await menu.click();
  await page.locator("#lifecycleKind").selectOption("inventory");
  await page.locator("#lifecycleBest").selectOption("snack");
  assert.equal(await page.locator("#lifecycleAccount").isEnabled(), true);
  assert.equal(await page.locator("#lifecycleOpenAi").isDisabled(), true);
  await page.locator("#lifecycleSubmit").click();
  await page.locator("#runsView.active").waitFor();
  const inventory = await page.evaluate(() => window.fixtureInputs.at(-1));
  assert.equal(inventory.collectionKind, "inventory");
  assert.equal(inventory.inventoryBest, "snack");
  assert.equal(Object.hasOwn(inventory, "longTermDays"), false);
  assert.equal(inventory.collectionMode, "general");
  assert.equal(inventory.accountId, "fixture-member");
  assert.equal(Object.hasOwn(inventory, "openAiProfileId"), false);
  assert.match(await page.locator("#runList").innerText(), /재고 파악 · 과자 베스트/);
  await page.getByRole("button", { name: "이 실행 취소" }).click();
  await menu.click();
  await page.locator("#lifecycleKind").selectOption("changes");
  assert.equal(await page.locator("#lifecycleAccount").isEnabled(), true);
  assert.equal(await page.locator("#lifecycleChangeField").isVisible(), true);
  assert.equal(await page.locator("#lifecycleBestField").isVisible(), false);
  assert.equal(await page.locator("#lifecycleOpenAi").isDisabled(), true);
  for (const [changeType, label] of [["soldOut", "품절"], ["restock30", "재입고 30일"], ["restock90", "재입고 90일"]]) {
    await page.locator("#lifecycleChange").selectOption(changeType);
    assert.equal(await page.locator("#lifecycleSubmit").isEnabled(), true);
    if (changeType === "restock90") {
      await page.screenshot({ path: path.resolve(__dirname, "../out/product-changes-ui.png"), fullPage: true, animations: "disabled" });
      assert.match(await page.locator("#lifecycleScope").innerText(), /최근 90일/);
    }
    await page.locator("#lifecycleSubmit").click();
    await page.locator("#runsView.active").waitFor();
    const changes = await page.evaluate(() => window.fixtureInputs.at(-1));
    assert.equal(changes.collectionKind, "changes");
    assert.equal(changes.changeType, changeType);
    assert.equal(changes.accountId, "fixture-member");
    assert.equal(changes.collectionMode, "general");
    assert.match(await page.locator("#runList").innerText(), new RegExp(`상품 변동 확인 · ${label}`));
    await page.getByRole("button", { name: "이 실행 취소" }).click();
    await menu.click();
  }
  assert.equal(await page.evaluate(() => window.fixtureInputs.length), 7);
  assert.deepEqual(errors, []);
  await page.locator('[data-view="settings"]').click();
  await page.locator("#openProxyManagerButton").click();
  await page.locator("#proxyRegisterProvider").selectOption("dataimpulse");
  assert.equal(await page.locator("#proxyRegisterServer").inputValue(), "gw.dataimpulse.com:823");
  assert.match(await page.locator("#proxyProviderHelp").innerText(), /60분/);
  await page.locator("#proxyRegisterName").fill("등록 테스트 DataImpulse");
  await page.locator("#proxyRegisterUsername").fill("fixture__cr.kr");
  await page.locator("#proxyRegisterPassword").fill("fixture-secret");
  await page.locator("#saveProxyProfileButton").click();
  await page.waitForFunction(() => Boolean(window.fixtureSavedProxy));
  const saved = await page.evaluate(() => window.fixtureSavedProxy);
  assert.equal(saved.provider, "dataimpulse");
  assert.equal(saved.server, "gw.dataimpulse.com:823");
  await page.locator("#proxyProfileList .account-item").filter({ hasText: "등록 테스트 DataImpulse" }).getByRole("button", { name: "수정", exact: true }).click();
  assert.equal(await page.locator("#proxyRegisterProvider").inputValue(), "dataimpulse");
  assert.equal(await page.locator("#proxyRegisterPassword").inputValue(), "");
  await page.locator("#closeProxyManagerButton").click();
  await menu.click();
  await page.locator("#lifecycleProxy").selectOption("registered-dataimpulse");
  assert.equal(await page.locator("#lifecycleProxy").inputValue(), "registered-dataimpulse");
  assert.deepEqual(errors, []);
});

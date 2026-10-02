const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = require("playwright");
const { getPublicDefaults } = require("../src/config");

const PUBLIC_ROOT = path.resolve(__dirname, "../public");
const TEST_ORIGIN = "http://127.0.0.1:32109";

async function createSettingsPage(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const pageErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Every request is fulfilled from local files; no server, account or external API is contacted.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== TEST_ORIGIN) {
      externalRequests.push(url.origin);
      await route.abort();
      return;
    }
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(PUBLIC_ROOT, relativePath);
    const relative = path.relative(PUBLIC_ROOT, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
    try {
      await route.fulfill({ status: 200, contentType: contentTypes[path.extname(file)] || "application/octet-stream", body: await fs.readFile(file) });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.addInitScript((defaults) => {
    let accounts = [];
    let selectedShippingAccountId = "";
    let nextId = 1;
    let uploadSettings = {
      uploadApiUrl: "https://example.invalid/uploader",
      isDefault: true,
    };
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const summary = () => ({
      proxies: [], openAiKeys: [], selectedShippingAccountId,
      shippingAccounts: accounts.map(({ password, ...account }) => ({ ...account, hasPassword: Boolean(password) })),
    });
    window.__rendererTest = {
      initialized: false,
      notificationMode: "success",
      notificationCalls: 0,
      resolveNotification: null,
      saveSettingsCalls: [],
      returnedSummaries: [],
      getStoredAccountChecks: () => accounts.map((account) => ({ id: account.id, name: account.name, loginId: account.loginId, passwordMatches: account.password === "synthetic-ui-password" })),
    };
    const respondSummary = () => {
      const result = copy(summary());
      window.__rendererTest.returnedSummaries.push(result);
      return result;
    };
    window.collectorApp = Object.freeze({
      getDefaults: async () => defaults,
      onStateChanged: () => () => {},
      getState: async () => {
        window.__rendererTest.initialized = true;
        return { runs: [], activeRunCount: 0, latestCompletedRunId: "", cart: { running: false, lockedAccountKeys: [] }, shipping: { enabled: false, running: false, collectionUploadEnabled: false } };
      },
      getCredentialProfiles: async () => respondSummary(),
      getUploadApiSettings: async () => copy(uploadSettings),
      getCollectionUploadLogs: async () => ({ items: [], page: 1, totalPages: 1, totalCount: 0 }),
      sendTestNotification: async () => {
        window.__rendererTest.notificationCalls += 1;
        await new Promise((resolve) => { window.__rendererTest.resolveNotification = resolve; });
        if (window.__rendererTest.notificationMode === "failure") throw new Error("테스트용 연결 실패");
        return { status: 200 };
      },
      saveShippingAccount: async (input) => {
        const existing = accounts.find((account) => account.id === input.id);
        const account = { id: existing?.id || `shipping-test-${nextId++}`, name: input.name, loginId: input.loginId, password: input.password || existing?.password || "" };
        if (!account.password) throw new Error("운송장 계정 비밀번호를 입력하세요.");
        accounts = existing ? accounts.map((item) => item.id === existing.id ? account : item) : [...accounts, account];
        selectedShippingAccountId = account.id;
        return { summary: respondSummary(), selectedId: account.id };
      },
      selectShippingAccount: async (id) => {
        if (id && !accounts.some((account) => account.id === id)) throw new Error("계정 없음");
        selectedShippingAccountId = id;
        return respondSummary();
      },
      deleteShippingAccount: async (id) => {
        accounts = accounts.filter((account) => account.id !== id);
        if (selectedShippingAccountId === id) selectedShippingAccountId = "";
        return respondSummary();
      },
      saveUploadApiSettings: async (settings) => {
        window.__rendererTest.saveSettingsCalls.push(copy(settings));
        uploadSettings = { ...uploadSettings, ...settings, isDefault: false };
        return copy(uploadSettings);
      },
    });
  }, { ...getPublicDefaults({}, os.tmpdir()), app: { version: "test", name: "Renderer test" } });
  await page.goto(`${TEST_ORIGIN}/index.html`);
  await page.waitForFunction(() => window.__rendererTest?.initialized === true);
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.waitForFunction(() => document.querySelector("#shippingAccountSelect")?.disabled === false);
  t.after(() => {
    assert.deepEqual(pageErrors, [], "renderer emitted pageerror");
    assert.deepEqual(externalRequests, [], "renderer attempted an external request");
  });
  return page;
}

test("설정 화면에서 수동 테스트 알림의 중복 클릭을 막고 성공·실패를 표시한다", async (t) => {
  const page = await createSettingsPage(t);
  const button = page.locator("#sendTestNotificationButton");
  await button.click();
  assert.equal(await button.isDisabled(), true);
  await button.evaluate((element) => element.dispatchEvent(new Event("click")));
  assert.equal(await page.evaluate(() => window.__rendererTest.notificationCalls), 1);
  await page.evaluate(() => window.__rendererTest.resolveNotification());
  await page.waitForFunction(() => document.querySelector("#testNotificationStatus").textContent.includes("HTTP 200"));
  assert.equal(await button.isDisabled(), false);
  await page.evaluate(() => { window.__rendererTest.notificationMode = "failure"; });
  await button.click();
  await page.evaluate(() => window.__rendererTest.resolveNotification());
  await page.waitForFunction(() => document.querySelector("#testNotificationStatus").textContent.includes("테스트용 연결 실패"));
  assert.equal(await button.isDisabled(), false);
  assert.equal(await page.evaluate(() => window.__rendererTest.notificationCalls), 2);
});

test("설정 화면에서 운송장 계정을 등록·선택·수정·삭제하고 비밀번호를 다시 표시하지 않는다", async (t) => {
  const page = await createSettingsPage(t);
  await page.locator("#shippingAccountName").fill("테스트 KSE");
  await page.locator("#shippingAccountLoginId").fill("synthetic-user");
  await page.locator("#shippingAccountPassword").fill("synthetic-ui-password");
  await page.locator("#saveShippingAccountButton").click();
  await page.waitForFunction(() => document.querySelector("#shippingAccountStatus").textContent.includes("저장했습니다"));
  assert.equal(await page.locator("#shippingAccountSelect").inputValue(), "shipping-test-1");
  assert.equal(await page.locator("#shippingAccountPassword").inputValue(), "");
  assert.equal(await page.locator("#shippingAccountPassword").getAttribute("required"), null);

  await page.locator("#shippingAccountName").fill("수정된 KSE");
  await page.locator("#saveShippingAccountButton").click();
  await page.waitForFunction(() => window.__rendererTest.getStoredAccountChecks()[0]?.name === "수정된 KSE");
  assert.equal(await page.evaluate(() => window.__rendererTest.getStoredAccountChecks()[0].passwordMatches), true);
  assert.equal(await page.locator("#shippingAccountPassword").inputValue(), "");

  await page.locator("#shippingAccountSelect").selectOption("");
  await page.waitForFunction(() => document.querySelector("#shippingAccountStatus").textContent.includes("직접 로그인으로 변경"));
  assert.equal(await page.locator("#shippingAccountName").inputValue(), "");
  assert.equal(await page.locator("#deleteShippingAccountButton").isDisabled(), true);
  await page.locator("#shippingAccountSelect").selectOption("shipping-test-1");
  await page.waitForFunction(() => document.querySelector("#shippingAccountName").value === "수정된 KSE");
  assert.equal(await page.locator("#shippingAccountPassword").inputValue(), "");
  assert.equal(await page.evaluate(() => JSON.stringify(window.__rendererTest.returnedSummaries).includes("synthetic-ui-password")), false);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some((value) => value.includes("synthetic-ui-password"))), false);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#deleteShippingAccountButton").click();
  await page.waitForFunction(() => document.querySelector("#shippingAccountStatus").textContent.includes("삭제했습니다"));
  assert.equal(await page.locator("#shippingAccountSelect").inputValue(), "");
  assert.equal(await page.locator("#shippingAccountSelect option").count(), 1);
  assert.equal(await page.locator("#shippingAccountPassword").inputValue(), "");
});

test("Upload API URL을 검증하고 저장한 뒤에만 변경한 주소로 테스트할 수 있다", async (t) => {
  const page = await createSettingsPage(t);
  const uploadUrl = page.locator("#uploadApiUrl");
  const save = page.locator("#saveUploadApiUrlButton");
  const notification = page.locator("#sendTestNotificationButton");
  assert.equal(await uploadUrl.inputValue(), "https://example.invalid/uploader");
  await uploadUrl.fill("not-a-url");
  await save.click();
  assert.equal(await uploadUrl.evaluate((element) => element.validity.typeMismatch), true);
  assert.equal(await page.evaluate(() => window.__rendererTest.saveSettingsCalls.length), 0);

  await uploadUrl.fill("https://example.invalid/uploader/updated");
  await notification.click();
  assert.match(await page.locator("#testNotificationStatus").textContent(), /먼저 저장/);
  assert.equal(await page.evaluate(() => window.__rendererTest.notificationCalls), 0);
  await save.click();
  await page.waitForFunction(() => window.__rendererTest.saveSettingsCalls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__rendererTest.saveSettingsCalls[0]), {
    uploadApiUrl: "https://example.invalid/uploader/updated",
  });
  assert.match(await page.locator("#testNotificationStatus").textContent(), /uploader\/updated/);
  await notification.click();
  assert.equal(await notification.isDisabled(), true);
  await page.evaluate(() => window.__rendererTest.resolveNotification());
  await page.waitForFunction(() => document.querySelector("#testNotificationStatus").textContent.includes("HTTP 200"));
  await page.evaluate(() => { window.__rendererTest.notificationMode = "failure"; });
  await notification.click();
  await page.evaluate(() => window.__rendererTest.resolveNotification());
  await page.waitForFunction(() => document.querySelector("#testNotificationStatus").textContent.includes("테스트용 연결 실패"));
  assert.equal(await notification.isDisabled(), false);

  if (process.env.RENDERER_SMOKE_SCREENSHOT) {
    await page.setViewportSize({ width: 1440, height: 1800 });
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollTop) element.scrollTop = 0;
      }
    });
    await page.screenshot({ path: path.resolve(process.env.RENDERER_SMOKE_SCREENSHOT), fullPage: true });
  }

});

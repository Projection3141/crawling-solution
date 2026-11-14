// 실제 Chromium과 로컬 서버만 사용한다. 등록 계정·외부 사이트에 접속하지 않는다.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { createConnectionTester } = require("../electron/connection-test");
const { getPublicDefaults } = require("../src/config");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("실제 브라우저: 직접 연결, 인증 프록시, 리다이렉트, HTTP 거절, CONNECT 실패", async (t) => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>direct fixture</body></html>");
  });
  t.after(() => origin.close());
  const directUrl = await listen(origin);
  const authorized = [];
  const tunnels = [];
  const authorization = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
  const proxy = http.createServer((req, res) => {
    if (req.headers["proxy-authorization"] !== authorization) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    authorized.push(req.url);
    const url = new URL(req.url);
    if (url.pathname === "/egress") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ip":"203.0.113.42"}');
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { Location: "http://proxy-target.invalid/final" });
      res.end();
      return;
    }
    res.writeHead(url.pathname === "/deny" ? 403 : 200, { "Content-Type": "text/html" });
    res.end("<html><body>proxy fixture</body></html>");
  });
  proxy.on("connect", (req, socket) => {
    tunnels.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  t.after(() => proxy.close());
  const server = await listen(proxy);
  const tester = createConnectionTester({
    env: {}, getProxy: () => ({ name: "로컬 프록시", server, username: "fixture-user", password: "fixture-password" }),
    egressCheckUrl: "http://proxy-target.invalid/egress",
  });
  t.after(() => tester.close());
  const direct = await tester.run({ url: directUrl, showBrowser: false });
  assert.equal(direct.success, true, direct.error);
  assert.equal(direct.proxyServer, "");
  const chromiumHeadless = await tester.run({ url: directUrl, browserMode: "chromium-headless" });
  assert.equal(chromiumHeadless.success, true, chromiumHeadless.error);
  assert.equal(chromiumHeadless.browserMode, "chromium-headless");
  const connected = await tester.run({ url: "http://proxy-target.invalid/redirect", proxyProfileId: "fixture", showBrowser: false, checkEgress: true });
  assert.equal(connected.success, true, connected.error);
  assert.equal(connected.finalUrl, "http://proxy-target.invalid/final");
  assert.ok(authorized.includes("http://proxy-target.invalid/redirect"));
  assert.ok(authorized.includes("http://proxy-target.invalid/final"));
  assert.equal(connected.egressIp, "203.0.113.42");
  assert.ok(authorized.includes("http://proxy-target.invalid/egress"));
  const denied = await tester.run({ url: "http://proxy-target.invalid/deny", proxyProfileId: "fixture", showBrowser: false });
  assert.equal(denied.success, false);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.failureLayer, "http-access");
  const tunnel = await tester.run({ url: "https://proxy-target.invalid/", proxyProfileId: "fixture", showBrowser: false });
  assert.equal(tunnel.success, false);
  assert.equal(tunnel.errorCode, "ERR_TUNNEL_CONNECTION_FAILED");
  assert.equal(tunnel.statusCode, null);
  assert.equal(tunnel.failureLayer, "proxy-tunnel");
  assert.ok(tunnels.includes("proxy-target.invalid:443"));
});

test("실제 화면: 사이드바·프록시 갱신·중복 방지·결과 비교·오류 후 복구", async (t) => {
  const root = path.resolve(__dirname, "../public");
  const server = http.createServer(async (req, res) => {
    const relative = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${relative === "/" ? "/index.html" : relative}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    try {
      const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" };
      res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  t.after(() => server.close());
  const address = await listen(server);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const calls = [];
  const htmlCalls = [];
  await page.exposeFunction('fixtureHtmlTest', async (input) => {
    htmlCalls.push(input);
    return { success: true, productId: '66658', proxyName: 'fixture proxy', reason: 'fixture parsed',
      baseline: { file: 'fixture-archive.json', observedAt: '2026-11-01' },
      request: { statusCode: 200, elapsedMs: 10, transfer: { bodyBytes: 1234, responseHeaderBytes: 100, decodedBodyBytes: 4000 } },
      comparison: [{ field: 'nameKo', status: 'same', value: '<img src=x onerror=alert(1)>', baseline: 'fixture' }, { field: 'barcode', status: 'missing', value: null, baseline: '8800' }, { field: 'stockQuantity', status: 'outside-scope', value: null, baseline: 10 }],
      browser: { available: true, receivedBytes: 5000, elapsedMs: 20 }, diagnosticPath: 'fixture-report.json' };
  });
  let release;
  let reject = false;
  await page.exposeFunction("fixtureTestConnection", async (input) => {
    calls.push(input);
    if (reject) throw new Error("테스트용 IPC 오류");
    await new Promise((resolve) => { release = resolve; });
    return {
      success: false, startedAt: new Date().toISOString(), requestedUrl: input.url,
      proxyName: input.proxyProfileId ? "프록시 1" : "직접 연결 (내 IP)",
      proxyServer: input.proxyProfileId ? "http://127.0.0.1:12323" : "",
      statusCode: null, elapsedMs: 200, finalUrl: "about:blank",
      message: "페이지 접속 실패", errorCode: "ERR_TUNNEL_CONNECTION_FAILED",
      error: "<img src=x onerror=alert(1)> net::ERR_TUNNEL_CONNECTION_FAILED",
    };
  });
  await page.addInitScript((defaults) => {
    window.collectorApp = {
      getBrands: async () => ({ brands: [], recent: [], used: 0, remaining: 10, limit: 10 }),
      getDefaults: async () => ({ ...defaults, app: { version: "fixture" } }),
      getState: async () => ({ runs: [], activeRuns: [], shipping: {} }),
      getCredentialProfiles: async () => ({ proxies: [{ id: "p1", name: "프록시 1", server: "http://127.0.0.1:12323" }], openAiKeys: [], shippingAccounts: [] }),
      getUploadApiSettings: async () => ({ uploadApiUrl: "https://fixture.invalid/", isDefault: true }),
      getCollectionUploadLogs: async () => ({ items: [], page: 1, totalPages: 1, totalCount: 0 }),
      onStateChanged: () => () => {},
      testConnection: (input) => window.fixtureTestConnection(input),
      testProductHtml: (input) => window.fixtureHtmlTest(input),
    };
  }, getPublicDefaults({}, "fixture-output"));
  await page.goto(address);
  await page.waitForFunction(() => document.querySelector("#connectionTestProxy").options.length === 2);
  await page.locator('[data-view="test"]').click();
  assert.equal(await page.locator("#testView").isVisible(), true);
  assert.equal(await page.locator("#connectionTestBrowserMode").inputValue(), "show");
  await page.locator("#connectionTestProxy").selectOption("p1");
  await page.locator("#connectionTestCheckEgress").check();
  await page.locator("#connectionTestCheckTunnel").check();
  await page.locator("#connectionTestUrl").fill("https://proxy-target.invalid/login");
  await page.locator("#connectionTestButton").click();
  await page.waitForFunction(() => document.querySelector("#connectionTestButton").disabled);
  await page.waitForTimeout(50);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].proxyProfileId, "p1");
  assert.equal(calls[0].showBrowser, true);
  assert.equal(calls[0].browserMode, "show");
  assert.equal(calls[0].checkEgress, true);
  assert.equal(calls[0].checkTunnel, true);
  assert.equal(await page.locator("#connectionTestCheckEgress").isDisabled(), true);
  assert.equal(await page.locator("#cheonyuProxyProfileSelect").inputValue(), "");
  // 네비게이션을 이동해도 결과와 진행 중 상태를 유지한다.
  await page.locator('[data-view="runs"]').click();
  release();
  await page.locator('[data-view="test"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#connectionTestResults article").length === 1);
  assert.match(await page.locator("#connectionTestResults").innerText(), /ERR_TUNNEL_CONNECTION_FAILED/);
  assert.equal(await page.locator("#connectionTestResults img").count(), 0);
  // 프로필 목록 갱신은 테스트 선택을 보존한다.
  await page.evaluate(() => applyCredentialProfiles({ proxies: [{ id: "p1", name: "이름 변경", server: "http://127.0.0.1:12323" }], openAiKeys: [] }));
  assert.equal(await page.locator("#connectionTestProxy").inputValue(), "p1");
  // 직접 연결 비교는 앞선 결과를 지우지 않는다.
  await page.locator("#connectionTestProxy").selectOption("");
  await page.locator("#connectionTestBrowserMode").selectOption("hide");
  await page.locator("#connectionTestButton").click();
  await page.waitForTimeout(50);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].proxyProfileId, "");
  assert.equal(calls[1].showBrowser, false);
  release();
  await page.waitForFunction(() => document.querySelectorAll("#connectionTestResults article").length === 2);
  reject = true;
  await page.locator("#connectionTestButton").click();
  await page.waitForFunction(() => document.querySelector("#connectionTestStatus").textContent.includes("테스트용 IPC 오류"));
  assert.equal(await page.locator("#connectionTestButton").isEnabled(), true);
  assert.equal(await page.locator('#productHtmlCompareBrowser').isChecked(), false);
  await page.locator('#productHtmlTestUrl').fill('66658');
  await page.locator('#productHtmlCompareBrowser').check();
  await page.locator('#productHtmlTestButton').click();
  await page.waitForFunction(() => document.querySelector('#productHtmlTestStatus').textContent.includes('완료'));
  assert.equal(htmlCalls.length, 1); assert.equal(htmlCalls[0].url, '66658');
  assert.equal(htmlCalls[0].compareBrowser, true); assert.equal(htmlCalls[0].showBrowser, false);
  assert.match(await page.locator('#productHtmlTestResults').innerText(), /1,234 B/);
  assert.match(await page.locator('#productHtmlTestResults').innerText(), /기존 값 있으나 누락/);
  assert.match(await page.locator('#productHtmlTestResults').innerText(), /단일 상세 HTML 범위 밖/);
  assert.equal(await page.locator('#productHtmlTestResults img').count(), 0);
  assert.equal(await page.locator('#productHtmlTestButton').isEnabled(), true);
  assert.deepEqual(pageErrors, []);
  if (process.env.CONNECTION_TEST_SCREENSHOT) {
    await page.locator('#productHtmlTestUrl').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.CONNECTION_TEST_SCREENSHOT}.html.png`, fullPage: true });
    await page.locator("#connectionTestUrl").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.CONNECTION_TEST_SCREENSHOT, fullPage: true });
  }
});

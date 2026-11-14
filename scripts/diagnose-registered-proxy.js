// 등록 정보는 읽기 전용이며 인증정보는 표시하거나 파일에 출력하지 않는다.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { app, safeStorage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createCredentialStore } = require("../electron/credential-store");
const { normalizeProxyCredentials } = require("../src/config");
const { createConnectionTester, normalizeTestUrl } = require("../electron/connection-test");
const { probeProxyTunnel } = require("../electron/proxy-tunnel-probe");
const { createSanitizer } = require("../src/utils/collection-diagnostics");
const { createHtmlProductTester } = require("../electron/html-product-test");
const os = require("node:os");
const userDataDir = path.join(app.getPath("appData"), "Mall Collector");
const reportDir = path.resolve(__dirname, "../out/connection-investigation");
// safeStorage는 원래 앱 프로필의 암호화 키를 사용해야 한다.
app.setPath("userData", userDataDir);
app.whenReady().then(async () => {
  const store = createCredentialStore({ safeStorage, userDataDir, normalizeProxyCredentials });
  const profiles = store.getSummary().proxies;
  const number = Number(process.argv[2]);
  if (process.argv.includes("--product-html") && Number.isInteger(number) && number >= 0 && number <= profiles.length) {
    const tester = createHtmlProductTester({ getProxy: (id) => store.getProxy(id),
      archiveDirectory: process.env.PRODUCT_ARCHIVE_DIRECTORY || path.join(os.homedir(), "MallCollector", "archive"), diagnosticDirectory: reportDir });
    try {
      const result = await tester.run({ url: process.argv[3], proxyProfileId: number ? profiles[number - 1].id : '',
        compareBrowser: process.argv.includes('--compare-browser'), showBrowser: !process.argv.includes('--headless') });
      console.log(JSON.stringify(result));
    } finally { tester.close(); app.quit(); }
    return;
  }
  if (!Number.isInteger(number) || number < 1 || number > profiles.length) {
    console.log(JSON.stringify(profiles.map(({ name, server, updatedAt }, index) => ({ number: index + 1, name, server, updatedAt }))));
    app.quit();
    return;
  }
  const url = normalizeTestUrl(process.argv[3] || "https://www.cheonyu.com/member/login.html");
  if (process.argv.includes("--tunnel-only")) {
    const profile = store.getProxy(profiles[number - 1].id);
    const sanitize = createSanitizer([profile.username, profile.password]);
    const report = sanitize({
      startedAt: new Date().toISOString(), requestedUrl: url,
      proxyName: profile.name, proxyServer: profile.server,
      tunnelProbe: await probeProxyTunnel({ proxy: profile, url }),
    });
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `tunnel-${report.startedAt.replace(/[:.]/g, "-")}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ ...report, diagnosticPath: reportPath }));
    app.quit();
    return;
  }
  const test = createConnectionTester({
    getProxy: (id) => store.getProxy(id), diagnosticDirectory: reportDir, env: {},
  });
  try {
    const result = await test.run({
      url, proxyProfileId: profiles[number - 1].id,
      showBrowser: !process.argv.includes("--headless"), checkEgress: true, checkTunnel: true,
      browserMode: process.argv.includes("--chromium-headless") ? "chromium-headless" : undefined,
    });
    console.log(JSON.stringify(result));
  } finally {
    await test.close();
    app.quit();
  }
}).catch((error) => { console.error(error.message); app.exit(1); });


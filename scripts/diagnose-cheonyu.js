// 공개 페이지에만 소량 접속하며 계정 로그인·장바구니 변경·자동 재시도는 하지 않는다.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const { getLightweightLaunchArgs, installLightweightNetworkPolicy } = require("../src/utils/browser");

async function main() {
  const mode = process.argv[2] || "headed";
  if (!["headed", "headless", "chromium-headless"].includes(mode)) {
    throw new Error("mode: headed | headless | chromium-headless");
  }
  const collectionPolicy = process.argv.includes("--collection-policy");
  const showBrowser = mode === "headed";
  const directory = path.resolve(__dirname, "../out/connection-investigation");
  await fs.mkdir(directory, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
  const report = { at: new Date().toISOString(), mode, collectionPolicy, proxy: false, results: [] };
  const browser = await chromium.launch({
    headless: !showBrowser,
    ...(mode === "chromium-headless" ? { channel: "chromium" } : {}),
    args: collectionPolicy ? getLightweightLaunchArgs({ showBrowser }) : [],
    timeout: 30000,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (collectionPolicy) await installLightweightNetworkPolicy(context, { showBrowser });
    const page = await context.newPage();
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    for (const route of ["/", "/member/login.html"]) {
      const started = Date.now();
      const result = { url: `https://www.cheonyu.com${route}`, status: null };
      try {
        const response = await page.goto(result.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        result.status = response?.status() ?? null;
        result.finalUrl = page.url();
        result.title = await page.title();
        result.passwordInputs = await page.locator('input[type="password"]').count();
        result.server = response?.headers()?.server || "";
        result.bodyPreview = (await page.locator("body").innerText({ timeout: 3000 })).slice(0, 1500);
        const screenshot = path.join(directory, `${id}-${report.results.length}.png`);
        await page.screenshot({ path: screenshot, timeout: 5000 }).catch(() => {});
        result.screenshot = screenshot;
      } catch (error) {
        result.error = error.message;
      }
      result.elapsedMs = Date.now() - started;
      report.results.push(result);
      console.log(JSON.stringify(result));
      if (result.error || result.status === 403 || result.status === 429) break;
    }
  } finally {
    await browser.close();
    const reportPath = path.join(directory, `${id}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportPath }));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

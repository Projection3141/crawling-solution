const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * npm install 직후 Playwright Chromium을 프로젝트 내부에 설치한다.
 *
 * 설치 위치:
 * node_modules/playwright-core/.local-browsers
 *
 * 이 위치는 Electron Forge가 node_modules와 함께 설치 파일에 포함한다.
 */
function installChromium() {
  if (process.env.SKIP_PLAYWRIGHT_INSTALL === "true") {
    console.log("[PLAYWRIGHT] SKIP_PLAYWRIGHT_INSTALL=true, 설치 생략");
    return;
  }

  const packageJsonPath = require.resolve("playwright/package.json");
  const cliPath = path.resolve(path.dirname(packageJsonPath), "cli.js");

  console.log("[PLAYWRIGHT] Chromium 설치 시작");

  const result = spawnSync(
    process.execPath,
    [cliPath, "install", "chromium"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: "0",
      },
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  console.log("[PLAYWRIGHT] Chromium 설치 완료");
}

installChromium();
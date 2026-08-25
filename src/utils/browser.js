//src/utils/browser.js

const DEFAULT_BLOCKED_URL_FRAGMENTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "facebook.net",
  "cdnfonts.com",
  "googleapis.com",
  "gstatic.com",
];

const ALWAYS_BLOCKED_URL_PATTERNS = [
  "*.mp4*",
  "*.webm*",
  "*.mp3*",
  "*.wav*",
  "*.ogg*",
  "*.m4a*",
  "*.mov*",
  "*.avi*",
];

const HIDDEN_BROWSER_BLOCKED_URL_PATTERNS = [
  "*.css*",
  "*.woff*",
  "*.woff2*",
  "*.ttf*",
  "*.otf*",
  "*.png*",
  "*.jpg*",
  "*.jpeg*",
  "*.gif*",
  "*.webp*",
  "*.avif*",
  "*.svg*",
  "*.ico*",
];

/** 숨김 수집에서는 Chromium이 이미지 자체를 요청하지 않게 한다. */
function getLightweightLaunchArgs({ showBrowser = false } = {}) {
  return showBrowser ? [] : ["--blink-settings=imagesEnabled=false"];
}

/**
 * Playwright route를 사용하지 않고 Chromium CDP에서 불필요한 URL을 차단한다.
 *
 * 브라우저를 화면에 표시할 때는 페이지가 정상적으로 보이도록
 * 이미지·CSS·폰트를 유지하고 미디어와 추적 요청만 차단한다.
 * route를 사용하지 않으므로 Chromium의 기본 HTTP 캐시가 유지된다.
 */
async function installLightweightNetworkPolicy(
  context,
  {
    showBrowser = false,
    blockedUrlFragments = DEFAULT_BLOCKED_URL_FRAGMENTS,
  } = {},
) {
  const blockedPatterns = Array.from(
    new Set([
      ...blockedUrlFragments.map((fragment) => `*${fragment}*`),
      ...ALWAYS_BLOCKED_URL_PATTERNS,
      ...(showBrowser ? [] : HIDDEN_BROWSER_BLOCKED_URL_PATTERNS),
    ]),
  );
  const configuredPages = new WeakSet();
  const pageConfigurationPromises = new WeakMap();

  const startConfiguringPage = async (page) => {
    if (!page || configuredPages.has(page)) return;
    configuredPages.add(page);

    try {
      const session = await context.newCDPSession(page);
      await session.send("Network.enable");
      await session.send("Network.setCacheDisabled", {
        cacheDisabled: false,
      });
      await session.send("Network.setBlockedURLs", {
        urls: blockedPatterns,
      });
    } catch (error) {
      configuredPages.delete(page);
      pageConfigurationPromises.delete(page);
      console.warn(
        "[WARN] [NETWORK POLICY] CDP 리소스 차단 연결 실패: " +
          `${error?.message || error}`,
      );
    }
  };

  const configurePage = (page) => {
    if (!page) return Promise.resolve();

    const existingPromise = pageConfigurationPromises.get(page);
    if (existingPromise) return existingPromise;

    const configurationPromise = startConfiguringPage(page);
    pageConfigurationPromises.set(page, configurationPromise);
    return configurationPromise;
  };

  context.on?.("page", (page) => {
    void configurePage(page);
  });

  await Promise.all((context.pages?.() || []).map(configurePage));
  return { configurePage };
}

/** 후보 selector 중 처음 존재하는 입력 요소에 값을 채운다. */
async function fillFirstAvailable(page, selectors, value, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    if ((await locator.count()) > 0) {
      await locator.fill(String(value));
      return selector;
    }
  }

  throw new Error(`${label} 입력 요소를 찾지 못했습니다.`);
}

/** 후보 selector 중 처음 존재하는 요소를 클릭한다. */
async function clickFirstAvailable(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    if ((await locator.count()) > 0) {
      await locator.click();
      return selector;
    }
  }

  return "";
}

/** 브라우저 dialog를 로그로 남기고 자동 승인한다. */
function installDialogAutoAccept(page, logger = console.log) {
  page.on("dialog", async (dialog) => {
    logger(`[DIALOG] ${dialog.type()} - ${dialog.message()}`);
    await dialog.accept().catch(() => null);
  });
}

/**
 * Electron의 취소 신호를 Playwright 브라우저 종료에 연결한다.
 *
 * 브라우저를 닫으면 진행 중인 goto/wait/evaluate도 즉시 실패하므로
 * 긴 네트워크 대기 중에도 취소 버튼이 빠르게 반응한다.
 */
function bindAbortToBrowser(signal, browser) {
  if (!signal || !browser) return () => {};

  const closeBrowser = () => {
    void browser.close().catch(() => null);
  };

  if (signal.aborted) {
    closeBrowser();
  } else {
    signal.addEventListener("abort", closeBrowser, { once: true });
  }

  return () => {
    signal.removeEventListener("abort", closeBrowser);
  };
}

module.exports = {
  bindAbortToBrowser,
  clickFirstAvailable,
  fillFirstAvailable,
  getLightweightLaunchArgs,
  installDialogAutoAccept,
  installLightweightNetworkPolicy,
};

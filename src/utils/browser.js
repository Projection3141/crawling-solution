const DEFAULT_BLOCKED_URL_FRAGMENTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "facebook.net",
  "cdnfonts.com",
  "googleapis.com",
  "gstatic.com",
];

/**
 * 수집에 불필요한 리소스를 차단한다.
 *
 * 브라우저를 화면에 표시할 때는 페이지가 정상적으로 보이도록
 * 이미지·CSS·폰트를 유지하고 미디어와 추적 요청만 차단한다.
 */
async function installLightweightRouting(
  context,
  {
    showBrowser = false,
    blockedUrlFragments = DEFAULT_BLOCKED_URL_FRAGMENTS,
  } = {},
) {
  const blockedTypes = new Set(
    showBrowser
      ? ["media"]
      : ["image", "font", "media", "stylesheet"],
  );

  await context.route("**/*", async (route) => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url();

    if (blockedTypes.has(type)) return route.abort();

    if (blockedUrlFragments.some((fragment) => url.includes(fragment))) {
      return route.abort();
    }

    return route.continue();
  });
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
  installDialogAutoAccept,
  installLightweightRouting,
};
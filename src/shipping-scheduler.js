const path = require("node:path");
const { chromium } = require("playwright");

const SOURCE_BASE_URL =
  "https://www.kseoms.com/cs_partner/xhr/getGridData";

const UPLOAD_URL =
  "https://www.web3.io.kr/joahstore/crawling/uploader";

const INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

/** 한국 시간 기준 오늘과 1년 전 날짜를 반환한다. */
function getDateRange() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const endDate = formatter.format(new Date());
  const [year, month, day] = endDate
    .split("-")
    .map(Number);

  const oneYearAgo = new Date(
    Date.UTC(year - 1, month - 1, day),
  );

  const startDate = [
    oneYearAgo.getUTCFullYear(),
    String(
      oneYearAgo.getUTCMonth() + 1,
    ).padStart(2, "0"),
    String(
      oneYearAgo.getUTCDate(),
    ).padStart(2, "0"),
  ].join("-");

  return {
    startDate,
    endDate,
  };
}

/** KSE 조회용 GET URL을 생성한다. */
function createSourceUrl(
  startDate,
  endDate,
) {
  const url = new URL(
    SOURCE_BASE_URL,
  );

  url.searchParams.set("rtype", "0");
  url.searchParams.set(
    "dtype",
    "req_date",
  );
  url.searchParams.set(
    "sd",
    startDate,
  );
  url.searchParams.set(
    "ed",
    endDate,
  );

  return url.toString();
}

/** 응답에서 id와 mft_itemName만 추출한다. */
function extractShippingRecords(
  source,
) {
  const records = new Map();

  function walk(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    if (
      !value ||
      typeof value !== "object"
    ) {
      return;
    }

    const id = String(
      value.id ?? "",
    ).trim();

    const mftItemName = String(
      value.mft_itemName ?? "",
    ).trim();

    if (id && mftItemName) {
      const key =
        `${id}\u0000${mftItemName}`;

      records.set(key, {
        id,
        mft_itemName:
          mftItemName,
      });
    }

    for (
      const child of
      Object.values(value)
    ) {
      walk(child);
    }
  }

  walk(source);

  return Array.from(
    records.values(),
  );
}

/**
 * 로그인된 Playwright persistent context의 request API로
 * KSE 데이터를 GET 한다.
 */
async function fetchGridData(
  context,
  sourceUrl,
) {
  const response =
    await context.request.get(
      sourceUrl,
      {
        headers: {
          Accept:
            "application/json, text/plain, */*",
          Referer:
            "https://www.kseoms.com/",
          "X-Requested-With":
            "XMLHttpRequest",
        },
        timeout:
          REQUEST_TIMEOUT_MS,
      },
    );

  if (!response.ok()) {
    throw new Error(
      `KSE 조회 실패: HTTP ` +
        `${response.status()} ` +
        `${response.statusText()}`,
    );
  }

  const headers =
    response.headers();

  const contentType = String(
    headers["content-type"] || "",
  ).toLowerCase();

  const responseText = String(
    await response.text(),
  )
    .replace(/^\uFEFF/, "")
    .trim();

  if (
    contentType.includes(
      "text/html",
    ) ||
    /<!doctype\s+html/i.test(
      responseText,
    ) ||
    /<html[\s>]/i.test(
      responseText,
    )
  ) {
    const error = new Error(
      "KSE 로그인이 필요합니다.",
    );

    error.code =
      "KSE_LOGIN_REQUIRED";

    throw error;
  }

  try {
    return JSON.parse(
      responseText,
    );
  } catch {
    console.error(
      "[SHIPPING INVALID RESPONSE]",
      {
        contentType,
        length:
          responseText.length,
        preview:
          responseText.slice(
            0,
            300,
          ),
      },
    );

    throw new Error(
      "KSE 응답을 JSON으로 변환하지 못했습니다.",
    );
  }
}

/** 추출한 운송정보 배열을 업로더에 POST한다. */
async function uploadShippingRecords(
  records,
) {
  const response = await fetch(
    UPLOAD_URL,
    {
      method: "POST",
      headers: {
        Accept:
          "application/json, text/plain, */*",
        "Content-Type":
          "application/json",
      },
      body:
        JSON.stringify(records),
    },
  );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `서버 전송 실패: HTTP ` +
        `${response.status} ` +
        `${response.statusText()}\n` +
        responseText,
    );
  }

  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(
      responseText,
    );
  } catch {
    return responseText;
  }
}

/**
 * 세션이 없으면 표시된 브라우저에서 사용자의 로그인을 기다린다.
 *
 * 로그인 성공 시 메인으로 이동하므로,
 * 이후 sourceUrl을 다시 GET하는 것은 fetchGridData가 담당한다.
 */
async function ensureLoggedIn(
  page,
  sourceUrl,
) {
  await page.goto(sourceUrl, {
    waitUntil:
      "domcontentloaded",
    timeout:
      REQUEST_TIMEOUT_MS,
  });

  const loginFormVisible =
    await page
      .locator(
        [
          'input[name="user_id"]',
          'input[name="password"]',
          'input[type="password"]',
        ].join(", "),
      )
      .first()
      .isVisible()
      .catch(() => false);

  if (
    !page
      .url()
      .toLowerCase()
      .includes("login") &&
    !loginFormVisible
  ) {
    return;
  }

  console.log(
    "[SHIPPING LOGIN] 열린 브라우저에서 KSE OMS 로그인을 완료해주세요.",
  );

  /**
   * 로그인 완료 후 메인 페이지로 이동하고
   * 로그인 입력창이 사라질 때까지 기다린다.
   */
  await page.waitForFunction(
    () => {
      const hasLoginForm =
        Boolean(
          document.querySelector(
            [
              'input[name="user_id"]',
              'input[name="password"]',
              'input[type="password"]',
            ].join(", "),
          ),
        );

      return !hasLoginForm;
    },
    null,
    {
      timeout: 0,
    },
  );

  await page
    .waitForLoadState(
      "domcontentloaded",
      {
        timeout:
          REQUEST_TIMEOUT_MS,
      },
    )
    .catch(() => null);

  console.log(
    "[SHIPPING LOGIN] 로그인 완료",
  );
}

/** 운송정보를 한 번 GET하고 POST한다. */
async function collectAndUploadOnce(
  profileDirectory,
) {
  const {
    startDate,
    endDate,
  } = getDateRange();

  const sourceUrl =
    createSourceUrl(
      startDate,
      endDate,
    );

  console.log(
    `[SHIPPING DATE] ` +
      `${startDate} ~ ${endDate}`,
  );

  console.log(
    `[SHIPPING SOURCE] ${sourceUrl}`,
  );

  const context =
    await chromium.launchPersistentContext(
      profileDirectory,
      {
        headless: false,
        viewport: {
          width: 1400,
          height: 900,
        },
      },
    );

  try {
    const pages =
      context.pages();

    const page =
      pages[0] ||
      (await context.newPage());

    /**
     * 사용자 로그인이 필요한 경우 먼저 기다린다.
     */
    await ensureLoggedIn(
      page,
      sourceUrl,
    );

    /**
     * 첨부 코드와 동일하게 로그인된 context.request로
     * sourceUrl을 GET한다.
     */
    const gridData =
      await fetchGridData(
        context,
        sourceUrl,
      );

    const shippingRecords =
      extractShippingRecords(
        gridData,
      );

    console.log(
      `[SHIPPING EXTRACT] ` +
        `${shippingRecords.length}건`,
    );

    if (
      shippingRecords.length ===
      0
    ) {
      throw new Error(
        "응답에서 id와 mft_itemName을 가진 운송정보를 찾지 못했습니다.",
      );
    }

    /**
     * JSON 파일은 만들지 않고 추출 배열을 그대로 POST한다.
     */
    const uploadResult =
      await uploadShippingRecords(
        shippingRecords,
      );

    console.log(
      `[SHIPPING UPLOAD] ` +
        `${shippingRecords.length}건 서버 전송 완료`,
    );

    if (
      uploadResult !== null
    ) {
      console.log(
        "[SHIPPING RESPONSE]",
        uploadResult,
      );
    }

    return {
      count:
        shippingRecords.length,
      response:
        uploadResult,
    };
  } finally {
    await context.close();
  }
}

/**
 * 앱 실행 시 즉시 한 번 실행하고,
 * 완료 여부와 관계없이 1시간 후 다시 실행하는 스케줄러다.
 */
function createShippingScheduler({
  profileDirectory,
  onStateChanged = () => {},
}) {
  const resolvedProfileDirectory =
    path.resolve(
      profileDirectory,
    );

  let enabled = true;
  let running = false;
  let timer = null;
  let stopped = false;
  let nextRunAt = null;
  let lastStartedAt = null;
  let lastFinishedAt = null;
  let lastSuccessAt = null;
  let lastRecordCount = 0;
  let lastError = "";

  function emitState(
    patch = {},
  ) {
    onStateChanged({
      enabled,
      running,
      ...patch,
    });
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();

    if (
      stopped ||
      !enabled
    ) {
      return;
    }

    timer = setTimeout(
      () => {
        void runOnce();
      },
      INTERVAL_MS,
    );

    emitState({
      nextRunAt: (nextRunAt =
        new Date(
          Date.now() +
            INTERVAL_MS,
        ).toISOString()),
    });
  }

  async function runOnce() {
    if (
      stopped ||
      !enabled ||
      running
    ) {
      return;
    }

    running = true;
    clearTimer();

    emitState({
      lastError: "",
      lastStartedAt: (lastStartedAt = new Date().toISOString()),
    });

    try {
      const result =
        await collectAndUploadOnce(
          resolvedProfileDirectory,
        );

      emitState({
        lastError: "",
        lastSuccessAt:
          (lastSuccessAt = new Date().toISOString()),
        lastRecordCount:
          (lastRecordCount = result.count),
      });
    } catch (error) {
      console.error(
        "[SHIPPING ERROR]",
        error?.message || error,
      );

      emitState({
        lastError:
          error?.message ||
          String(error),
      });
    } finally {
      running = false;
      emitState({
        lastFinishedAt: (lastFinishedAt = new Date().toISOString()),
      });
      emitState({
        lastCount: lastRecordCount,
        startedAt: lastStartedAt,
      });
      scheduleNext();
    }
  }

  function setEnabled(
    nextEnabled,
  ) {
    enabled =
      nextEnabled === true;

    clearTimer();

    emitState();

    if (enabled) {
      /**
       * OFF에서 ON으로 바꾸면 즉시 한 번 실행한다.
       */
      void runOnce();
    }
  }

  function start() {
    stopped = false;

    if (enabled) {
      /**
       * Electron 앱이 켜지면 즉시 한 번 실행한다.
       */
      void runOnce();
    }
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  return {
    start,
    stop,
    setEnabled,
    runOnce,
    getState: () => ({
      enabled,
      running,
      lastStartedAt,
      lastFinishedAt,
      lastSuccessAt,
      lastRecordCount,
      lastError,
      nextRunAt,
      startedAt: lastStartedAt,
      lastCount: lastRecordCount,
    }),
  };
}

module.exports = {
  collectAndUploadOnce,
  createShippingScheduler,
  extractShippingRecords,
  fetchGridData,
  uploadShippingRecords,
};

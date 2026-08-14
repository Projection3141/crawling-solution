/** translate/convert.js */

const fs = require("node:fs/promises");
const path = require("node:path");

const CITI_EXCHANGE_URL =
  "https://www.citibank.co.kr/FxdExrt0100.act";
const WON_TO_YEN_RATE_PATH = path.resolve(
  __dirname,
  "wonToYenRate.json",
);
const KOREA_TIME_ZONE = "Asia/Seoul";
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KOREA_TIME_ZONE,
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

let currentRate = null;
let refreshPromise = null;
let refreshHour = null;
let historyQueue = Promise.resolve();

function getKoreaDateTimeParts(value = new Date()) {
  const date = value instanceof Date
    ? value
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid conversion date.");
  }

  return Object.fromEntries(
    dateTimeFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatKoreaDate(value = new Date()) {
  const parts = getKoreaDateTimeParts(value);

  return `${parts.year}${parts.month}${parts.day}`;
}

function formatConvertTime(value = new Date()) {
  const parts = getKoreaDateTimeParts(value);

  return [
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
  ].join("");
}

function formatKoreaHour(value = new Date()) {
  return formatConvertTime(value).slice(0, 8);
}

function findAssignedJson(source, variableName) {
  const assignmentPattern = new RegExp(
    `\\b${variableName}\\s*=\\s*`,
  );
  const assignment = assignmentPattern.exec(source);

  if (!assignment) {
    throw new Error(`Could not find ${variableName} on the Citi page.`);
  }

  const startIndex = source.indexOf(
    "{",
    assignment.index + assignment[0].length,
  );

  if (startIndex < 0) {
    throw new Error(`Could not find ${variableName} JSON.`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;

    if (depth === 0) {
      return JSON.parse(source.slice(startIndex, index + 1));
    }
  }

  throw new Error(`Could not read the complete ${variableName} JSON.`);
}

function parseCitiJpyRate(html) {
  const data = findAssignedJson(String(html ?? ""), "_data");
  const jpy = Array.isArray(data?.REC_FXD)
    ? data.REC_FXD.find((item) => item?.CURR_CODE === "JPY")
    : null;

  if (!jpy) {
    throw new Error("Could not find the JPY rate on the Citi page.");
  }

  const unitPrice = Number(
    String(jpy.UNIT_PRICE ?? "").replaceAll(",", ""),
  );
  /**
   * Citi names this from the bank's perspective: CASH_BUY is the
   * customer's "현찰 팔 때" rate (KRW per 100 JPY).
   */
  const cashBuyRate = Number(
    String(jpy.CASH_BUY ?? "").replaceAll(",", ""),
  );

  if (unitPrice !== 100) {
    throw new Error(
      `Unexpected Citi JPY unit price: ${jpy.UNIT_PRICE}`,
    );
  }

  if (!Number.isFinite(cashBuyRate) || cashBuyRate <= 0) {
    throw new Error(
      `Invalid Citi JPY cash-buy rate: ${jpy.CASH_BUY}`,
    );
  }

  return {
    rate: (unitPrice / cashBuyRate).toFixed(5),
    revRate: cashBuyRate.toFixed(2),
    exchangeDate: String(jpy.EXCHANGE_DATE ?? "").trim(),
  };
}

function createAbortError() {
  const error = new Error("The exchange-rate request was aborted.");
  error.name = "AbortError";
  return error;
}

function wait(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSharedRequest(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function fetchCitiJpyRate({
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This runtime does not provide fetch().");
  }

  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetchImpl(CITI_EXCHANGE_URL, {
    method: "GET",
    headers: {
      Accept: "text/html",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "User-Agent": "MallCollector/1.2",
    },
    cache: "no-store",
    signal: requestSignal,
  });

  if (!response.ok) {
    throw new Error(
      `Citi exchange-rate request failed with HTTP ${response.status}.`,
    );
  }

  return parseCitiJpyRate(await response.text());
}

async function fetchCitiJpyRateWithRetry(options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= FETCH_RETRY_COUNT; attempt += 1) {
    try {
      return await fetchCitiJpyRate(options);
    } catch (error) {
      lastError = error;

      if (options.signal?.aborted || attempt === FETCH_RETRY_COUNT) {
        break;
      }

      await wait(RETRY_DELAY_MS * attempt, options.signal);
    }
  }

  throw lastError;
}

async function readRateHistory() {
  try {
    const text = await fs.readFile(WON_TO_YEN_RATE_PATH, "utf8");
    const value = JSON.parse(text.replace(/^\uFEFF/, "").trim() || "[]");

    if (!Array.isArray(value)) {
      throw new TypeError("wonToYenRate.json must contain an array.");
    }

    return value;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function writeDailyRate(rateInfo, value = new Date()) {
  const task = historyQueue.then(async () => {
    const date = formatKoreaDate(value);
    const history = await readRateHistory();
    const dailyRate = {
      date,
      rate: rateInfo.rate,
      revRate: rateInfo.revRate,
    };
    const existingIndex = history.findIndex(
      (item) => item?.date === date,
    );

    if (existingIndex >= 0) {
      history[existingIndex] = dailyRate;
    } else {
      history.push(dailyRate);
    }

    history.sort((left, right) =>
      String(left?.date ?? "").localeCompare(
        String(right?.date ?? ""),
      ));

    const temporaryPath = `${WON_TO_YEN_RATE_PATH}.${process.pid}.tmp`;

    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(history, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporaryPath, WON_TO_YEN_RATE_PATH);

    return dailyRate;
  });

  historyQueue = task.catch(() => undefined);

  return task;
}

function refreshCurrentRate({
  signal,
  now = new Date(),
  persistDaily = false,
  fetchImpl,
} = {}) {
  const targetHour = formatKoreaHour(now);
  let request;

  if (refreshPromise) {
    request = refreshHour === targetHour
      ? refreshPromise
      : refreshPromise
        .catch(() => undefined)
        .then(() => refreshCurrentRate({
          signal,
          now,
          persistDaily: false,
          fetchImpl,
        }));
  } else {
    const nextRefresh = (async () => {
      const rateInfo = await fetchCitiJpyRateWithRetry({
        fetchImpl,
        signal,
      });
      const fetchedAt = new Date();

      const nextRate = {
        ...rateInfo,
        fetchedAt: fetchedAt.toISOString(),
        hour: targetHour,
      };

      currentRate = nextRate;

      return { ...nextRate };
    })();

    refreshPromise = nextRefresh;
    refreshHour = targetHour;
    request = nextRefresh;

    void nextRefresh.then(() => {
      if (refreshPromise === nextRefresh) {
        refreshPromise = null;
        refreshHour = null;
      }
    }, () => {
      if (refreshPromise === nextRefresh) {
        refreshPromise = null;
        refreshHour = null;
      }
    });
  }

  if (!persistDaily) {
    return request;
  }

  return request.then(async (rateInfo) => {
    await writeDailyRate(rateInfo, now);
    return rateInfo;
  });
}

function ensureCurrentRate({
  signal,
  now = new Date(),
} = {}) {
  const expectedHour = formatKoreaHour(now);
  const request = currentRate?.hour === expectedHour
    ? Promise.resolve({ ...currentRate })
    : refreshCurrentRate({
      now,
      /**
       * Do not pass a caller's cancellation signal into the shared
       * hourly request. Cancelling one collection must not cancel the
       * exchange-rate request used by another collection or scheduler.
       */
    });

  return waitForSharedRequest(request, signal);
}

async function createConversionSnapshot({
  signal,
  now,
} = {}) {
  const requestedAt = now || new Date();
  let rateInfo = await ensureCurrentRate({
    signal,
    now: requestedAt,
  });

  if (signal?.aborted) {
    throw createAbortError();
  }

  let convertedAt = now || new Date();

  if (!now && rateInfo.hour !== formatKoreaHour(convertedAt)) {
    rateInfo = await ensureCurrentRate({
      signal,
      now: convertedAt,
    });

    convertedAt = new Date();
  }

  return {
    rate: rateInfo.rate,
    revRate: rateInfo.revRate,
    convertTime: formatConvertTime(convertedAt),
  };
}

function convertWonToYen(originalPrice, rate) {
  if (originalPrice === null || originalPrice === undefined) {
    return null;
  }

  const wonPrice = Number(originalPrice);
  const wonToYenRate = Number(rate);

  if (!Number.isFinite(wonPrice) || wonPrice < 0) {
    throw new TypeError(`Invalid originalPrice: ${originalPrice}`);
  }

  if (!Number.isFinite(wonToYenRate) || wonToYenRate <= 0) {
    throw new TypeError(`Invalid won-to-yen rate: ${rate}`);
  }

  return Math.round(wonPrice * wonToYenRate);
}

function millisecondsUntilNextHour(value = new Date()) {
  const now = value instanceof Date
    ? value
    : new Date(value);
  const hourMs = 60 * 60 * 1000;
  const nextHourTime =
    (Math.floor(now.getTime() / hourMs) + 1) * hourMs;

  /** KST is UTC+09:00, so UTC and KST hour boundaries coincide. */
  return Math.max(1, nextHourTime - now.getTime());
}

function createWonToYenRateScheduler({
  onError = (error) => console.error("[EXCHANGE RATE]", error),
} = {}) {
  let stopped = true;
  let timer = null;
  let controller = null;
  let runPromise = null;
  let pendingScheduledRun = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();

    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      scheduleNext();
      const scheduledAt = new Date();

      if (runPromise) {
        pendingScheduledRun = scheduledAt;
        return;
      }

      // 그날 환율 기록하는 시각
      void runNow({
        now: scheduledAt,
        persistDaily:
          getKoreaDateTimeParts(scheduledAt).hour === "00",
      });
    }, millisecondsUntilNextHour());
  }

  function runNow({
    now = new Date(),
    persistDaily = false,
  } = {}) {
    if (stopped) {
      return Promise.resolve(null);
    }

    if (runPromise) {
      return runPromise;
    }

    const runController = new AbortController();

    controller = runController;

    runPromise = (async () => {
      try {
        const expectedHour = formatKoreaHour(now);
        const rateInfo = currentRate?.hour === expectedHour
          ? { ...currentRate }
          : await refreshCurrentRate({
            signal: runController.signal,
            now,
          });

        if (persistDaily) {
          await writeDailyRate(rateInfo, now);
        }

        return rateInfo;
      } catch (error) {
        if (!stopped && error?.name !== "AbortError") {
          onError(error);
        }

        return null;
      } finally {
        if (controller === runController) {
          controller = null;
        }

        runPromise = null;

        if (!stopped && pendingScheduledRun) {
          const pendingAt = pendingScheduledRun;

          // 기록하는 시각이 지나서 다음 시각에 기록해야 하는 경우, 즉시 기록하도록 함
          pendingScheduledRun = null;
          void runNow({
            now: pendingAt,
            persistDaily:
              getKoreaDateTimeParts(pendingAt).hour === "00",
          });
        }
      }
    })();

    return runPromise;
  }

  function start() {
    if (!stopped) {
      return;
    }

    stopped = false;
    scheduleNext();
    void runNow({ persistDaily: false });
  }

  function stop() {
    stopped = true;
    clearTimer();
    pendingScheduledRun = null;
    controller?.abort();
    controller = null;
  }

  return {
    start,
    stop,
    dispose: stop,
    runNow,
    getState: () => ({
      running: !stopped,
      currentRate: currentRate ? { ...currentRate } : null,
    }),
  };
}

module.exports = {
  CITI_EXCHANGE_URL,
  WON_TO_YEN_RATE_PATH,
  convertWonToYen,
  createConversionSnapshot,
  createWonToYenRateScheduler,
  ensureCurrentRate,
  fetchCitiJpyRate,
  formatConvertTime,
  formatKoreaDate,
  millisecondsUntilNextHour,
  parseCitiJpyRate,
  refreshCurrentRate,
  writeDailyRate,
};

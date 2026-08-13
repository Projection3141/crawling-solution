// src/utils/site-safety.js

const { throwIfAborted } = require("./common");

const DEFAULT_RETRYABLE_HTTP_STATUS_CODES = Object.freeze([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
]);

const DEFAULT_BLOCKING_HTTP_STATUS_CODES = Object.freeze([403, 429]);
const DEFAULT_BLOCKING_RESOURCE_TYPES = Object.freeze([
  "document",
  "xhr",
  "fetch",
]);

const DEFAULT_RETRYABLE_ERROR_PATTERNS = Object.freeze([
  /timeout/i,
  /timed out/i,
  /net::ERR_ABORTED/i,
  /net::ERR_CONNECTION_RESET/i,
  /net::ERR_CONNECTION_CLOSED/i,
  /net::ERR_CONNECTION_REFUSED/i,
  /net::ERR_NETWORK_CHANGED/i,
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_NAME_NOT_RESOLVED/i,
  /socket hang up/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /EPIPE/i,
  /interrupted by another navigation/i,
  /Execution context was destroyed/i,
  /Target page, context or browser has been closed/i,
  /Navigation failed because page was closed/i,
  /page crashed/i,
]);

/** 숫자를 안전한 정수 범위로 제한한다. */
function clampInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 설정 객체에서 안전장치용 숫자 설정을 읽는다. */
function getSafetyNumber(config, key, fallback, min = 1, max = 100) {
  return clampInteger(config?.[key], fallback, min, max);
}

/** AbortSignal 또는 Playwright 취소 오류인지 판정한다. */
function isAbortError(error, signal) {
  if (signal?.aborted) return true;

  const name = String(error?.name || "");
  const message = String(error?.message || "");

  return (
    name === "AbortError" ||
    message.includes("수집이 취소") ||
    message.includes("작업이 취소")
  );
}

/** 오류 객체에 재시도 여부와 진단 정보를 부착한다. */
function markSiteError(
  error,
  {
    retryable = true,
    code = "",
    statusCode = null,
    stage = "",
    details = null,
  } = {},
) {
  const target = error instanceof Error ? error : new Error(String(error || "오류"));

  target.retryable = Boolean(retryable);

  if (code) target.code = code;
  if (Number.isFinite(Number(statusCode))) {
    target.statusCode = Number(statusCode);
    target.status = Number(statusCode);
  }
  if (stage) target.stage = stage;
  if (details !== null && details !== undefined) target.details = details;

  return target;
}

/** 재시도하면 안 되는 업무 오류를 생성한다. */
function createNonRetryableError(message, options = {}) {
  return markSiteError(new Error(message), {
    ...options,
    retryable: false,
  });
}

/** HTTP 응답 오류를 표준 오류 객체로 변환한다. */
function createHttpStatusError(response, label = "HTTP 요청", url = "") {
  const statusCode = Number(response?.status?.() || response?.status || 0);
  const retryable = DEFAULT_RETRYABLE_HTTP_STATUS_CODES.includes(statusCode);
  const suffix = url ? ` - ${url}` : "";

  return markSiteError(
    new Error(`${label} 실패: HTTP ${statusCode || "UNKNOWN"}${suffix}`),
    {
      retryable,
      code: "HTTP_STATUS_ERROR",
      statusCode,
      stage: label,
      details: {
        url,
        statusCode,
      },
    },
  );
}

/** 같은 사이트의 차단 응답을 Context 전체에서 한 번만 감지한다. */
function installHttpBlockGuard(
  context,
  {
    hostname = "",
    label = "사이트",
    statusCodes = DEFAULT_BLOCKING_HTTP_STATUS_CODES,
    resourceTypes = DEFAULT_BLOCKING_RESOURCE_TYPES,
    onBlocked,
  } = {},
) {
  const expectedHostname = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  const blockedStatuses = new Set(statusCodes.map(Number));
  const watchedResourceTypes = new Set(resourceTypes.map(String));
  let blockedError = null;

  const handleResponse = (response) => {
    if (blockedError) return;

    const statusCode = Number(response?.status?.() || 0);
    const resourceType = String(
      response?.request?.()?.resourceType?.() || "",
    );

    if (!blockedStatuses.has(statusCode)) return;
    if (!watchedResourceTypes.has(resourceType)) return;

    let responseHostname = "";

    try {
      responseHostname = new URL(response.url()).hostname.toLowerCase();
    } catch {
      return;
    }

    if (
      expectedHostname &&
      responseHostname !== expectedHostname &&
      !responseHostname.endsWith(`.${expectedHostname}`)
    ) {
      return;
    }

    blockedError = markSiteError(
      new Error(
        `${label}가 요청을 거부하거나 제한했습니다(HTTP ${statusCode}). ` +
        "IP를 자동 변경하지 않고 작업을 중단합니다.",
      ),
      {
        retryable: false,
        code: "SITE_ACCESS_BLOCKED",
        statusCode,
        stage: `${label}-access-guard`,
        details: {
          statusCode,
          resourceType,
          url: response.url(),
        },
      },
    );

    try {
      Promise.resolve(onBlocked?.(blockedError)).catch(() => null);
    } catch {
      /** 차단 오류가 원래 종료 원인으로 유지되도록 callback 오류는 무시한다. */
    }
  };

  context.on("response", handleResponse);

  return {
    getError() {
      return blockedError;
    },
    dispose() {
      context.off("response", handleResponse);
    },
  };
}

/** 네트워크·타임아웃·일시 서버 오류인지 판정한다. */
function isRetryableSiteError(
  error,
  {
    signal,
    retryUnknownErrors = true,
    retryableStatusCodes = DEFAULT_RETRYABLE_HTTP_STATUS_CODES,
    extraPatterns = [],
  } = {},
) {
  if (isAbortError(error, signal)) return false;

  if (typeof error?.retryable === "boolean") {
    return error.retryable;
  }

  const statusCode = Number(error?.statusCode || error?.status || 0);

  if (statusCode > 0) {
    return retryableStatusCodes.includes(statusCode);
  }

  const message = String(error?.message || error || "");
  const patterns = [...DEFAULT_RETRYABLE_ERROR_PATTERNS, ...extraPatterns];

  if (patterns.some((pattern) => pattern.test(message))) {
    return true;
  }

  return Boolean(retryUnknownErrors);
}

/** 지수 백오프와 작은 랜덤 지연을 계산한다. */
function calculateRetryDelayMs(
  attempt,
  {
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    multiplier = 1.7,
    jitterRatio = 0.15,
  } = {},
) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const exponential = Math.min(
    Math.max(0, Number(maxDelayMs) || 0),
    Math.max(0, Number(baseDelayMs) || 0) *
      Math.pow(Math.max(1, Number(multiplier) || 1), safeAttempt - 1),
  );
  const jitter = exponential * Math.max(0, Number(jitterRatio) || 0);
  const randomized = exponential + (Math.random() * 2 - 1) * jitter;

  return Math.max(0, Math.round(randomized));
}

/** AbortSignal을 인식하면서 지정 시간만큼 대기한다. */
async function sleepWithSignal(ms, signal) {
  const delayMs = Math.max(0, Number(ms) || 0);

  if (delayMs < 1) {
    throwIfAborted(signal);
    return;
  }

  throwIfAborted(signal);

  await new Promise((resolve, reject) => {
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      const error = new Error("작업이 취소되었습니다.");
      error.name = "AbortError";
      reject(error);
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", handleAbort, { once: true });
  });

  throwIfAborted(signal);
}

/**
 * 사이트 동작을 공통 재시도 정책으로 실행한다.
 *
 * task는 `{ attempt, maxAttempts, signal }`을 전달받는다.
 * 업무상 재시도하면 안 되는 오류는 `createNonRetryableError()`를 사용한다.
 */
async function withSiteRetry(
  task,
  {
    label = "사이트 작업",
    maxAttempts = 5,
    signal,
    shouldRetry,
    beforeAttempt,
    onRetry,
    onGiveUp,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    multiplier = 1.7,
    jitterRatio = 0.15,
    retryUnknownErrors = true,
  } = {},
) {
  const attempts = clampInteger(maxAttempts, 5, 1, 100);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);

    if (typeof beforeAttempt === "function") {
      await beforeAttempt({
        attempt,
        maxAttempts: attempts,
        signal,
        lastError,
      });
    }

    try {
      return await task({
        attempt,
        maxAttempts: attempts,
        signal,
      });
    } catch (error) {
      throwIfAborted(signal);
      lastError = error instanceof Error ? error : new Error(String(error));

      const retryable =
        attempt < attempts &&
        (typeof shouldRetry === "function"
          ? await shouldRetry(lastError, {
              attempt,
              maxAttempts: attempts,
              signal,
            })
          : isRetryableSiteError(lastError, {
              signal,
              retryUnknownErrors,
            }));

      if (!retryable) {
        if (typeof onGiveUp === "function") {
          await onGiveUp({
            error: lastError,
            attempt,
            maxAttempts: attempts,
            signal,
          });
        }

        throw lastError;
      }

      const delayMs = calculateRetryDelayMs(attempt, {
        baseDelayMs,
        maxDelayMs,
        multiplier,
        jitterRatio,
      });

      console.warn(
        `[SITE SAFETY] ${label} 재시도 ${attempt + 1}/${attempts} ` +
          `(대기 ${delayMs}ms): ${lastError.message}`,
      );

      if (typeof onRetry === "function") {
        await onRetry({
          error: lastError,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: attempts,
          delayMs,
          signal,
        });
      }

      await sleepWithSignal(delayMs, signal);
    }
  }

  throw lastError || new Error(`${label} 실패`);
}

/** Playwright page.goto를 HTTP 상태·DOM 준비 검증과 함께 재시도한다. */
async function gotoWithSiteRetry(
  page,
  url,
  {
    label = "페이지 이동",
    signal,
    maxAttempts = 6,
    timeoutMs = 60000,
    waitUntil = "domcontentloaded",
    readySelector = "",
    readyTimeoutMs = null,
    validate,
    beforeAttempt,
    onRetry,
    baseDelayMs = 1000,
    maxDelayMs = 20000,
    multiplier = 1.7,
    jitterRatio = 0.15,
  } = {},
) {
  return withSiteRetry(
    async ({ attempt, maxAttempts: totalAttempts }) => {
      throwIfAborted(signal);

      const response = await page.goto(url, {
        waitUntil,
        timeout: Math.max(1000, Number(timeoutMs) || 60000),
      });

      if (response && !response.ok()) {
        throw createHttpStatusError(response, label, url);
      }

      if (readySelector) {
        await page.waitForSelector(readySelector, {
          timeout: Math.max(
            1000,
            Number(readyTimeoutMs) || Number(timeoutMs) || 60000,
          ),
        });
      }

      if (typeof validate === "function") {
        const validation = await validate({
          page,
          response,
          url,
          attempt,
          maxAttempts: totalAttempts,
        });

        if (validation === false) {
          throw markSiteError(
            new Error(`${label} 페이지 검증에 실패했습니다.`),
            {
              retryable: true,
              code: "PAGE_VALIDATION_FAILED",
              stage: label,
            },
          );
        }
      }

      return response;
    },
    {
      label,
      maxAttempts,
      signal,
      beforeAttempt,
      onRetry,
      baseDelayMs,
      maxDelayMs,
      multiplier,
      jitterRatio,
      retryUnknownErrors: true,
    },
  );
}

/** 현재 탭을 about:blank로 이동시켜 남은 팝업·AJAX 상태를 비운다. */
async function resetPageState(page, { signal, delayMs = 500 } = {}) {
  throwIfAborted(signal);

  await page
    .goto("about:blank", {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    })
    .catch(() => null);

  await sleepWithSignal(delayMs, signal);
}

/** 같은 browser context 안에서 손상된 작업 탭을 새 탭으로 교체한다. */
async function replacePage(
  page,
  {
    signal,
    setupPage,
    closeOldPage = true,
  } = {},
) {
  throwIfAborted(signal);

  const context = page.context();
  const nextPage = await context.newPage();

  if (typeof setupPage === "function") {
    await setupPage(nextPage);
  }

  if (closeOldPage) {
    await page.close().catch(() => null);
  }

  return nextPage;
}

module.exports = {
  DEFAULT_RETRYABLE_ERROR_PATTERNS,
  DEFAULT_RETRYABLE_HTTP_STATUS_CODES,
  calculateRetryDelayMs,
  clampInteger,
  createHttpStatusError,
  createNonRetryableError,
  getSafetyNumber,
  gotoWithSiteRetry,
  installHttpBlockGuard,
  isAbortError,
  isRetryableSiteError,
  markSiteError,
  replacePage,
  resetPageState,
  sleepWithSignal,
  withSiteRetry,
};

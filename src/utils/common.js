// src/utils/common.js

/** 지정한 시간만큼 비동기 대기한다. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 숫자·통화 문자열에서 부호와 숫자만 남겨 정수로 변환한다. */
function toNumber(value) {
  return Number(String(value ?? "").replace(/[^\d-]/g, "")) || 0;
}

/** 연속 공백과 줄바꿈을 한 칸으로 정리한다. */
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 밀리초를 화면과 로그에 사용할 문자열로 변환한다. */
function formatMs(ms) {
  const value = Number(ms) || 0;

  if (value < 1000) return `${value.toFixed(0)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(2)}s`;

  const minutes = Math.floor(value / 60000);
  const seconds = ((value % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

/** 현재 Node.js 프로세스의 메모리 사용량을 MB 단위로 반환한다. */
function getMemoryMb() {
  const memory = process.memoryUsage();

  return {
    rss: +(memory.rss / 1024 / 1024).toFixed(2),
    heapTotal: +(memory.heapTotal / 1024 / 1024).toFixed(2),
    heapUsed: +(memory.heapUsed / 1024 / 1024).toFixed(2),
    external: +(memory.external / 1024 / 1024).toFixed(2),
  };
}

/** 값이 null, undefined, 빈 문자열이 아닌지 확인한다. */
function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** 문자열 또는 boolean 값을 boolean으로 변환한다. */
function toBoolean(value, fallback = false) {
  if (!hasValue(value)) return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on", "show"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off", "hide"].includes(normalized)) {
    return false;
  }

  return fallback;
}

/** 값을 유한한 정수로 변환하고 최솟값을 적용한다. */
function toInteger(value, fallback, min = Number.MIN_SAFE_INTEGER) {
  if (!hasValue(value)) return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
}

/** 사용자 취소를 일반 오류와 구분하기 위한 AbortError를 생성한다. */
function createAbortError(message = "수집 작업이 취소되었습니다.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/** AbortSignal이 취소된 상태면 즉시 AbortError를 발생시킨다. */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/** 오류가 사용자 취소로 발생했는지 확인한다. */
function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/** 오류 객체를 직렬화 가능한 메시지로 변환한다. */
function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "알 수 없는 오류");
}

module.exports = {
  createAbortError,
  formatMs,
  getErrorMessage,
  getMemoryMb,
  hasValue,
  isAbortError,
  normalizeWhitespace,
  sleep,
  throwIfAborted,
  toBoolean,
  toInteger,
  toNumber,
};
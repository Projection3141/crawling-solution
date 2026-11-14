const { randomBytes } = require("node:crypto");
const { isIP } = require("node:net");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { recordDiagnostic, describeDiagnosticContext } = require("./collection-diagnostics");
const { isTemporaryProbeHttpStatus } = require("./collection-failure");

const STICKY_MINUTES = 60;
const REQUEST_ERROR_TYPES = new Set(["Error", "TypeError", "TimeoutError", "AbortError", "AggregateError"]);
const REQUEST_ERROR_CODES = new Set([
  "ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "EPROTO", "HPE_INVALID_CONSTANT",
  "ERR_PROXY_AUTH_REQUESTED", "ERR_PROXY_AUTH_UNSUPPORTED", "ERR_INVALID_AUTH_CREDENTIALS",
  "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_TIMED_OUT", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_SESSION_ERROR",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function createDecodoProxy(proxy, sticky = false) {
  if (!proxy) throw new Error("Decodo 프록시를 선택하세요.");
  const url = new URL(proxy.server);
  if (url.hostname !== "gate.decodo.com" || url.port !== "7000" ||
      !["http:", "https:"].includes(url.protocol)) {
    throw new Error("새 수집에는 Decodo Residential 주소 gate.decodo.com:7000을 등록하세요.");
  }
  if (!proxy.username || !proxy.password) throw new Error("Decodo 프록시 ID와 비밀번호가 필요합니다.");
  let username = proxy.username.replace(/-sessionduration-[^-]+/g, "").replace(/-session-[^-]+/g, "");
  if (!username.startsWith("user-")) username = `user-${username}`;
  if (sticky) username += `-session-${randomBytes(12).toString("hex")}-sessionduration-${STICKY_MINUTES}`;
  return { ...proxy, username };
}

function canonicalIp(value) {
  if (typeof value !== "string") return "";
  const ip = value.trim();
  const family = isIP(ip);
  if (family !== 6) return family === 4 ? ip : "";
  // A scoped IPv6 address is not an Internet egress address.
  if (ip.includes("%")) return "";
  const address = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const mapped = address.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return address;
  const [high, low] = mapped.slice(1).map(part => Number.parseInt(part, 16));
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

// Probe on the configured context; a real exit-IP change invalidates that context.
async function monitorDecodoSession(context, onFailure, { now = () => performance.now(), intervalMs = 30000, sleep = delay,
  providerLabel = "Decodo", checkUrl = "https://ip.decodo.com/json", errorCode = "DECODO_SESSION_LOST" } = {}) {
  const startedAt = now();
  let expectedIp = "";
  let lastConfirmedAt = null;
  let pending = null;
  let stopped = false;
  let terminalError = null;
  let timer;
  const retryDelays = [1000, 2000];
  const probeHost = new URL(checkUrl).hostname;
  const diagnostic = (event, details) => recordDiagnostic(event, {
    ...describeDiagnosticContext(context), provider: providerLabel, probeHost, ...details,
  });
  const failure = (reason, message, retryable = false, details = {}) =>
    Object.assign(new Error(message), { code: reason, retryable, details });
  const ageDetails = (at = now()) => ({
    sessionElapsedMs: Math.max(0, Math.round(at - startedAt)),
    lastConfirmedAgoMs: lastConfirmedAt === null ? null : Math.max(0, Math.round(at - lastConfirmedAt)),
  });
  function ensureActive() {
    if (stopped) throw failure("SESSION_STOPPED", "세션 확인이 종료되었습니다.");
    if (now() - startedAt >= (STICKY_MINUTES - 1) * 60000) {
      throw failure("SESSION_EXPIRED", "스티키 세션 유효 시간이 끝났습니다.");
    }
  }
  // APIRequestContext errors may contain request headers. Preserve a safe classification,
  // never the raw exception/body (which can contain proxy credentials).
  function transportFailure(error) {
    const text = `${error?.code || ""} ${error?.message || ""}`;
    const proxyClosedEarly = /Proxy connection ended before receiving CONNECT response/i.test(text);
    const firstLine = text.split(/\r?\n/, 1)[0];
    const requestErrorCode = firstLine.match(/\b[A-Z][A-Z0-9_]+\b/g)?.find(code => REQUEST_ERROR_CODES.has(code));
    const details = {
      requestErrorType: REQUEST_ERROR_TYPES.has(error?.name) ? error.name : null,
      requestErrorCode: requestErrorCode || (proxyClosedEarly ? "PROXY_CONNECTION_CLOSED" : null),
    };
    const statusCode = Number(error?.statusCode || error?.status) ||
      Number(text.match(/\b(?:HTTP(?:\/\d+(?:\.\d+)?|\s+code)?|CONNECT|status\s*code|proxy response)\s*[:=(]?\s*(403|407|429)\b/i)?.[1]);
    if (statusCode === 407) {
      return failure("PROXY_AUTH_FAILED", "프록시 인증에 실패했습니다 (HTTP 407).", false, { ...details, statusCode });
    }
    if ([403, 429].includes(statusCode)) {
      return failure("PROBE_HTTP_ERROR", `IP 확인 연결이 거절되었습니다 (HTTP ${statusCode}).`, false, { ...details, statusCode });
    }
    if (/ERR_PROXY_AUTH|ERR_INVALID_AUTH_CREDENTIALS|Proxy Authentication Required/i.test(text)) {
      return failure("PROXY_AUTH_FAILED", "프록시 인증에 실패했습니다.", false, details);
    }
    if (proxyClosedEarly || /ERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)/i.test(text)) {
      return failure("PROBE_CONNECTION_FAILED", "IP 확인용 프록시 연결에 실패했습니다.", true, { ...details, tunnelFailure: true });
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) return failure("PROBE_TIMEOUT", "IP 확인 요청 시간이 초과되었습니다.", true, details);
    if (/ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|connection (?:closed|reset)|ERR_CONNECTION_RESET/i.test(text)) {
      return failure("PROBE_CONNECTION_FAILED", "IP 확인 서버와의 연결에 실패했습니다.", true, details);
    }
    return failure("PROBE_REQUEST_FAILED", "IP 확인 요청을 완료하지 못했습니다.", true, details);
  }
  async function probe() {
    let response;
    try {
      response = await context.request.get(checkUrl, {
        timeout: 15000,
        maxRedirects: 0,
        headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
      });
    }
    catch (error) { throw transportFailure(error); }
    try {
      if (!response.ok()) {
        const statusCode = response.status();
        throw failure("PROBE_HTTP_ERROR", `IP 확인 서버 응답 오류 (HTTP ${statusCode}).`,
          isTemporaryProbeHttpStatus(statusCode), { statusCode });
      }
      let body;
      try { body = await response.json(); }
      catch { throw failure("PROBE_INVALID_RESPONSE", "IP 확인 서버가 올바른 JSON을 반환하지 않았습니다."); }
      const ip = canonicalIp(body?.proxy?.ip || body?.ip);
      if (!ip) throw failure("PROBE_INVALID_IP", "응답에서 유효한 IP를 확인할 수 없습니다.");
      return ip;
    } finally { await response.dispose().catch(() => {}); }
  }
  function check() {
    if (terminalError) return Promise.reject(terminalError);
    if (pending) return pending;
    pending = (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          ensureActive();
          const ip = await probe();
          ensureActive();
          if (expectedIp && ip !== expectedIp) {
            throw failure("SESSION_IP_CHANGED", "스티키 세션의 IP가 변경되었습니다.", false, { expectedIp, actualIp: ip });
          }
          const confirmedAt = now();
          diagnostic("sticky-session-confirmed", { ip, attempt, initial: !expectedIp, ...ageDetails(confirmedAt) });
          expectedIp = ip;
          lastConfirmedAt = confirmedAt;
          return;
        } catch (error) {
          error.details = { ...error.details, attempt, ...ageDetails() };
          if (stopped || !error.retryable || attempt > retryDelays.length) throw error;
          diagnostic("sticky-session-check-retry", { reason: error.code, ...error.details,
            delayMs: retryDelays[attempt - 1] });
          await sleep(retryDelays[attempt - 1]);
        }
      }
    })().catch(cause => {
      if (stopped) throw cause;
      const error = new Error(`${providerLabel}: ${cause.message} 작업을 중단했습니다. 저장된 페이지와 장바구니 상태를 확인하세요.`, { cause });
      error.code = errorCode;
      error.retryable = false;
      error.details = { reason: cause.code, ...cause.details };
      if (cause.details?.statusCode) error.statusCode = cause.details.statusCode;
      terminalError = error;
      clearInterval(timer);
      diagnostic("sticky-session-failed", error.details);
      onFailure(error);
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }
  await check();
  timer = setInterval(() => { if (!stopped) void check().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return {
    check,
    needsRenewal: () => now() - startedAt >= (STICKY_MINUTES - 10) * 60000,
    stop() { stopped = true; clearInterval(timer); },
  };
}

module.exports = { createDecodoProxy, monitorDecodoSession, STICKY_MINUTES };

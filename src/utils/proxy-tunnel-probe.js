// 프록시에 HTTPS CONNECT만 요청하고 응답 직후 소켓을 닫는다.
// 반환값에 인증 헤더, 사용자명, 비밀번호 및 응답 본문을 포함하지 않는다.
const net = require("node:net");
const tls = require("node:tls");
const { createAbortError, throwIfAborted } = require("./common");

const TRANSPORT_ERRORS = new Set([
  "CONNECT_TIMEOUT",
  "PROXY_CONNECTION_CLOSED",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

async function probeProxyTunnel({ proxy, url, timeoutMs = 15000, signal }) {
  throwIfAborted(signal);
  const started = performance.now();
  let target;
  let gateway;
  try {
    target = new URL(url);
    gateway = new URL(proxy?.server || "");
  } catch {
    return { skipped: true, message: "프록시 또는 목적지 주소 형식을 확인할 수 없습니다." };
  }
  if (target.protocol !== "https:" || !["http:", "https:"].includes(gateway.protocol) ||
      target.username || target.password || gateway.username || gateway.password) {
    return { skipped: true, message: "HTTPS 목적지와 HTTP(S) 프록시 조합에서만 터널을 확인합니다." };
  }
  const authority = `${target.hostname}:${target.port || 443}`;
  const credentials = proxy.username
    ? Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64") : "";
  const secure = gateway.protocol === "https:";
  const host = gateway.hostname.replace(/^\[|\]$/g, "");
  const port = Number(gateway.port || (secure ? 443 : 80));
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let receivedResponse = false;
    const socket = secure
      ? tls.connect({
          host, port, servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: true, ALPNProtocols: ["http/1.1"],
        })
      : net.createConnection({ host, port });
    const abort = () => finish(null, createAbortError());
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve({
        ...result,
        ...(result.statusCode === null && receivedResponse ? { partialResponse: true } : {}),
        elapsedMs: Math.round(performance.now() - started),
      });
    };
    const deadline = setTimeout(() => finish({
      statusCode: null, errorCode: "CONNECT_TIMEOUT", message: "프록시의 터널 응답 대기 시간이 초과되었습니다.",
    }), Math.max(100, Math.min(Number(timeoutMs) || 15000, 60000)));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once(secure ? "secureConnect" : "connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
        (credentials ? `Proxy-Authorization: Basic ${credentials}\r\n` : "") +
        "Connection: close\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      receivedResponse = true;
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if ((boundary < 0 && buffer.length > 16384) || boundary > 16384) {
          finish({ statusCode: null, errorCode: "INVALID_PROXY_RESPONSE", message: "프록시 응답 헤더가 너무 큽니다." });
          return;
        }
        if (boundary < 0) return;
        const statusLine = buffer.subarray(0, boundary).toString("latin1").split("\r\n", 1)[0];
        const match = statusLine.match(/^HTTP\/1\.[01] ([1-5]\d\d)(?:[ \t][^\r\n]*)?$/);
        if (!match) {
          finish({ statusCode: null, errorCode: "INVALID_PROXY_RESPONSE", message: "프록시 응답 형식을 확인할 수 없습니다." });
          return;
        }
        const statusCode = Number(match[1]);
        // 100/103 같은 중간 응답이 먼저 도착하면 최종 CONNECT 결과를 기다린다.
        if (statusCode < 200 && statusCode !== 101) {
          buffer = buffer.subarray(boundary + 4);
          continue;
        }
        finish({
          statusCode,
          success: statusCode >= 200 && statusCode < 300,
          message: statusCode >= 200 && statusCode < 300
            ? "프록시 터널 설정에 성공했습니다. 이후 TLS·페이지 응답은 별도입니다."
            : `프록시가 터널 설정 요청에 HTTP ${statusCode}로 응답했습니다.`,
        });
      }
    });
    socket.on("error", (error) => finish({
      statusCode: null, errorCode: /^[A-Z0-9_]{1,64}$/.test(error.code || "") ? error.code : "PROXY_CONNECTION_ERROR",
      message: "프록시 서버에 연결하지 못했습니다.",
    }));
    socket.on("end", () => finish({
      statusCode: null, errorCode: "PROXY_CONNECTION_CLOSED", message: "응답을 완료하기 전에 프록시 연결이 닫혔습니다.",
    }));
    socket.on("close", () => finish({
      statusCode: null, errorCode: "PROXY_CONNECTION_CLOSED", message: "응답을 완료하기 전에 프록시 연결이 닫혔습니다.",
    }));
  });
}

function terminalProbeError(code, message, statusCode = null) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false });
}

/** 브라우저가 숨긴 CONNECT 거부를 확인한 뒤 연결 복구 가능 여부만 반환한다. */
async function checkStickyTunnelBeforeRecovery({ proxy, url, signal, probe = probeProxyTunnel }) {
  throwIfAborted(signal);
  let observation;
  try {
    observation = await probe({ proxy, url, signal, timeoutMs: 5000 });
  } catch {
    throwIfAborted(signal);
    throw terminalProbeError("PROXY_TUNNEL_UNVERIFIED", "프록시 터널 상태를 확인하지 못했습니다.");
  }
  throwIfAborted(signal);
  const statusCode = Number.isInteger(observation?.statusCode) &&
    observation.statusCode >= 100 && observation.statusCode <= 599 ? observation.statusCode : null;
  const rawErrorCode = observation?.errorCode || "";
  const errorCode = typeof rawErrorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawErrorCode) ? rawErrorCode : "";
  if (statusCode === 407 || /^(?:ERR_PROXY_AUTH\w*|ERR_INVALID_AUTH_CREDENTIALS|PROXY_AUTHENTICATION_REQUIRED)$/.test(errorCode)) {
    const statusLabel = statusCode === 407 ? " (HTTP 407)" : "";
    throw terminalProbeError("PROXY_AUTHENTICATION_REQUIRED",
      `프록시 인증 또는 사용 한도로 연결이 거절되었습니다${statusLabel}.`, statusCode);
  }
  if (statusCode === 403 || statusCode === 429) {
    throw terminalProbeError("SITE_ACCESS_BLOCKED",
      `프록시가 목적지 연결을 거부하거나 제한했습니다 (HTTP ${statusCode}).`, statusCode);
  }
  const knownConnectResponse = (statusCode >= 200 && statusCode < 300) || [502, 503, 504].includes(statusCode);
  const noConnectResponse = observation?.statusCode === null && !observation.partialResponse &&
    TRANSPORT_ERRORS.has(errorCode);
  if (observation?.skipped || (!knownConnectResponse && !noConnectResponse)) {
    const statusLabel = statusCode === null ? "" : ` (HTTP ${statusCode})`;
    throw terminalProbeError("PROXY_TUNNEL_UNVERIFIED",
      `프록시 터널의 복구 가능 여부를 확인하지 못했습니다${statusLabel}.`, statusCode);
  }
  const elapsedMs = Number.isFinite(observation.elapsedMs) ? Math.max(0, observation.elapsedMs) : null;
  return { statusCode, errorCode, elapsedMs };
}

module.exports = { probeProxyTunnel, checkStickyTunnelBeforeRecovery };


// 실행이 최종 실패한 뒤 자동 반복을 계속해도 되는지 판정한다.
// 요청 단위의 기존 재시도 횟수·대기 간격에는 관여하지 않는다.

/** 원인 오류까지 살피되 순환 참조와 과도한 중첩은 제한한다. */
function getErrorChain(error) {
  const errors = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && errors.length < 6) {
    seen.add(current);
    errors.push(current);
    current = typeof current === "object" ? current.cause : null;
  }
  return errors;
}

/** 민감한 원문을 반환하지 않고 실패 종류와 자동 반복 중단 사유만 제공한다. */
function classifyCollectionFailure(error) {
  const errors = getErrorChain(error);
  const descriptions = errors.map((item) => ({
    code: String(item?.code || item?.errorCode || "").toUpperCase(),
    reason: String(item?.details?.reason || "").toUpperCase(),
    statusCode: Number(item?.statusCode || item?.status || item?.details?.statusCode || 0),
    message: String(item?.message || item || ""),
  }));
  const deniedStatus = /\b(?:HTTP(?:\s+code)?|CONNECT)\s*[:=]?\s*(403|429)\b/i;
  const blocked = descriptions.find((item) =>
    item.code === "SITE_ACCESS_BLOCKED" ||
    [403, 429].includes(item.statusCode) ||
    deniedStatus.test(item.message));
  if (descriptions.some(item => item.code === "CART_CLEANUP_INCOMPLETE")) {
    return { kind: "cart-state", code: "CART_CLEANUP_INCOMPLETE", statusCode: null,
      stopAutoRepeat: true, message: "장바구니 정리를 확인하지 못해 자동 반복을 중단했습니다. 저장 결과와 장바구니 상태를 확인하세요." };
  }
  if (blocked) {
    const statusCode = [403, 429].includes(blocked.statusCode)
      ? blocked.statusCode
      : Number(blocked.message.match(deniedStatus)?.[1]) || null;
    return {
      kind: "site-access-blocked", code: "SITE_ACCESS_BLOCKED", statusCode,
      stopAutoRepeat: true,
      message: `사이트 접근 제한${statusCode ? ` (HTTP ${statusCode})` : ""}으로 자동 반복을 중단했습니다. 접속 상태를 확인한 후 수동으로 다시 실행하세요.`,
    };
  }

  const authenticationCode = /(?:ERR_PROXY_AUTH|ERR_INVALID_AUTH_CREDENTIALS|PROXY_AUTHENTICATION_REQUIRED|PROXY_AUTH_FAILED|PROBE_AUTH_FAILED)/;
  const authentication = descriptions.find((item) =>
    item.statusCode === 407 ||
    authenticationCode.test(item.code) || authenticationCode.test(item.reason) ||
    /(?:ERR_PROXY_AUTH|ERR_INVALID_AUTH_CREDENTIALS|\bHTTP(?:\s+code)?\s*[:=]?\s*407\b|\bCONNECT\s*=\s*407\b|Proxy Authentication Required)/i.test(item.message));
  if (authentication) {
    return {
      kind: "proxy-authentication", code: "PROXY_AUTHENTICATION_REQUIRED", statusCode: 407,
      stopAutoRepeat: true,
      message: "프록시 인증 실패로 자동 반복을 중단했습니다. 현재 프록시 주소와 인증정보를 확인한 후 수동으로 다시 실행하세요.",
    };
  }

  const loginDenied = descriptions.some(item => ["SITE_LOGIN_FAILED", "CHEONYU_LOGIN_REQUIRED"].includes(item.code) ||
    /천유닷컴 로그인 성공 확인에 실패했습니다|자동 프로그램으로는 로그인할 수 없습니다/.test(item.message));
  if (loginDenied) {
    return { kind: "site-authentication", code: "SITE_LOGIN_FAILED", statusCode: null,
      stopAutoRepeat: true, message: "천유 로그인을 확인하지 못해 자동 반복을 중단했습니다. 계정과 사이트의 로그인 응답을 확인하세요." };
  }

  const unverifiedTunnel = descriptions.find(item => item.code === "PROXY_TUNNEL_UNVERIFIED");
  if (unverifiedTunnel) {
    return { kind: "proxy-connection-unverified", code: "PROXY_TUNNEL_UNVERIFIED",
      statusCode: unverifiedTunnel.statusCode || null, stopAutoRepeat: true,
      message: "프록시 터널 실패 원인을 확인하지 못해 자동 반복을 중단했습니다. 프록시 연결 상태를 확인하세요." };
  }

  const lostSession = descriptions.find(item => ["DECODO_SESSION_LOST", "DATAIMPULSE_SESSION_LOST"].includes(item.code));
  if (lostSession) {
    return { kind: "proxy-session", code: lostSession.code, statusCode: null,
      stopAutoRepeat: true, message: "스티키 세션 확인 실패로 자동 반복을 중단했습니다. 마지막 저장 페이지와 장바구니 상태를 확인하세요." };
  }

  const tunnel = descriptions.find((item) =>
    /^(?:ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|PROXY_TUNNEL_FAILED)$/.test(item.code) ||
    /(?:ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|\bCONNECT\s*=\s*502\b|Received HTTP code 502 from proxy after CONNECT)/i.test(item.message));
  if (tunnel) {
    return {
      kind: "proxy-connection", code: "PROXY_TUNNEL_FAILED", statusCode: null,
      stopAutoRepeat: true,
      message: "프록시 연결 실패로 자동 반복을 중단했습니다. 테스트 화면에서 연결을 확인한 후 수동으로 다시 실행하세요.",
    };
  }

  const statusCode = descriptions.find((item) =>
    Number.isInteger(item.statusCode) && item.statusCode >= 100 && item.statusCode <= 599)?.statusCode || null;
  return {
    kind: "other", code: "COLLECTION_FAILED", statusCode,
    stopAutoRepeat: false, message: "",
  };
}

function isTerminalStickyConnectionError(error) {
  return ["site-access-blocked", "proxy-authentication", "site-authentication", "cart-state", "proxy-connection-unverified"]
    .includes(classifyCollectionFailure(error).kind);
}

function isTemporaryProbeHttpStatus(statusCode) {
  return statusCode === 408 || (statusCode >= 500 && statusCode <= 599);
}

function isRecoverableStickySessionError(error) {
  const { kind } = classifyCollectionFailure(error);
  if (kind === "proxy-connection") return true;
  return kind === "proxy-session" && getErrorChain(error).some(item => {
    if (!["DECODO_SESSION_LOST", "DATAIMPULSE_SESSION_LOST"].includes(item?.code)) return false;
    const { reason, statusCode } = item.details || {};
    return ["SESSION_IP_CHANGED", "SESSION_EXPIRED", "PROBE_TIMEOUT", "PROBE_CONNECTION_FAILED", "PROBE_REQUEST_FAILED"]
      .includes(reason) || (reason === "PROBE_HTTP_ERROR" && isTemporaryProbeHttpStatus(statusCode));
  });
}

function needsStickyTunnelConfirmation(error) {
  const { kind } = classifyCollectionFailure(error);
  return kind === "proxy-connection" ||
    (kind === "proxy-session" && getErrorChain(error).some(item => item?.details?.tunnelFailure === true));
}

module.exports = { classifyCollectionFailure, isTerminalStickyConnectionError, isRecoverableStickySessionError,
  needsStickyTunnelConfirmation, isTemporaryProbeHttpStatus };

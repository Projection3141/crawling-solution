const { randomInt } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createDecodoProxy, monitorDecodoSession, STICKY_MINUTES } = require("./decodo");

const PROVIDER_LABELS = { decodo: "Decodo", dataimpulse: "DataImpulse", other: "기타 / 기존 ISP" };
// Do not reuse a port while another local run's provider session may still be alive.
const reservedPorts = new Map();

function inferProxyProvider(server) {
  try {
    const host = new URL(server).hostname;
    if (host === "gate.decodo.com") return "decodo";
    if (host === "gw.dataimpulse.com") return "dataimpulse";
  } catch {}
  return "other";
}

function validateProxyProvider(proxy, provider = inferProxyProvider(proxy?.server)) {
  if (!Object.hasOwn(PROVIDER_LABELS, provider)) throw new Error("프록시 공급자를 다시 선택하세요.");
  if (provider === "other") return provider;
  const url = new URL(proxy.server);
  const validPort = provider === "decodo" ? url.port === "7000"
    : url.port === "823" || (Number(url.port) >= 10000 && Number(url.port) <= 20000);
  if (inferProxyProvider(proxy.server) !== provider || !validPort || !["http:", "https:"].includes(url.protocol)) {
    throw new Error(provider === "decodo"
      ? "Decodo Residential 주소 gate.decodo.com:7000을 등록하세요."
      : "DataImpulse 주소 gw.dataimpulse.com:823을 등록하세요. 스티키 포트는 자동 설정됩니다.");
  }
  if (!proxy.username || !proxy.password) throw new Error(`${PROVIDER_LABELS[provider]} 프록시 ID와 비밀번호가 필요합니다.`);
  return provider;
}

function reserveStickyPort(previousPort) {
  const now = performance.now();
  for (const [port, expiresAt] of reservedPorts) if (expiresAt <= now) reservedPorts.delete(port);
  const start = randomInt(10000, 20001);
  for (let offset = 0; offset <= 10000; offset++) {
    const port = 10000 + (start - 10000 + offset) % 10001;
    if (port !== Number(previousPort) && !reservedPorts.has(port)) {
      reservedPorts.set(port, now + (STICKY_MINUTES + 1) * 60000);
      return String(port);
    }
  }
  throw new Error("사용 가능한 DataImpulse 스티키 포트가 없습니다. 실행이 끝난 후 다시 시도하세요.");
}

function createCollectionProxy(proxy, sticky = false, provider = inferProxyProvider(proxy?.server)) {
  if (!proxy) throw new Error("Decodo 또는 DataImpulse 프록시를 선택하세요.");
  validateProxyProvider(proxy, provider);
  if (provider === "decodo") return createDecodoProxy(proxy, sticky);
  if (provider !== "dataimpulse") throw new Error("새 수집에는 Decodo gate.decodo.com:7000 또는 DataImpulse gw.dataimpulse.com:823을 등록하세요.");
  const url = new URL(proxy.server);
  const [login, ...suffix] = proxy.username.split("__");
  const params = suffix.join("__").split(";").filter(Boolean)
    .filter(param => !/^(sessid|sessttl)\./i.test(param));
  if (!login) throw new Error("DataImpulse 프록시 ID를 입력하세요.");
  // sessid alone defaults to ~30 minutes. Use the documented sticky port + TTL instead.
  url.port = sticky ? reserveStickyPort(url.port) : "823";
  if (sticky) params.push(`sessttl.${STICKY_MINUTES}`);
  return { ...proxy, server: url.origin, username: login + (params.length ? `__${params.join(";")}` : "") };
}

function monitorCollectionSession(context, onFailure, provider = "decodo", options = {}) {
  if (!["decodo", "dataimpulse"].includes(provider)) throw new Error("지원하지 않는 스티키 공급자입니다.");
  return monitorDecodoSession(context, onFailure, {
    ...options,
    providerLabel: PROVIDER_LABELS[provider],
    checkUrl: provider === "dataimpulse" ? "https://api.ipify.org?format=json" : "https://ip.decodo.com/json",
    errorCode: provider === "dataimpulse" ? "DATAIMPULSE_SESSION_LOST" : "DECODO_SESSION_LOST",
  });
}

module.exports = { PROVIDER_LABELS, inferProxyProvider, validateProxyProvider, createCollectionProxy, monitorCollectionSession };

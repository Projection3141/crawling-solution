// 수집과 분리된 브라우저에서 선택한 프록시로 URL을 한 번만 확인한다.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isIP } = require("node:net");
const { normalizeProxyCredentials, resolveUserAgent } = require("../src/config");
const { getLightweightLaunchArgs } = require("../src/utils/browser");
const { createSanitizer } = require("../src/utils/collection-diagnostics");

function normalizeTestUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 4096 || /[\r\n\0]/.test(raw)) {
    throw new Error("테스트할 HTTP 또는 HTTPS URL을 입력하세요.");
  }
  let url;
  try { url = new URL(raw); } catch {
    throw new Error("https:// 또는 http://로 시작하는 올바른 URL을 입력하세요.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("인증정보가 포함되지 않은 HTTP 또는 HTTPS URL만 테스트할 수 있습니다.");
  }
  return url.href;
}

const RESPONSE_HEADERS = ["content-type", "server", "date", "retry-after", "via", "x-cache", "cf-ray"];

async function within(task, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function closeWithin(target) {
  try { await within(() => target?.close(), 3000, "브라우저 정리 시간 초과"); return true; }
  catch { return false; }
}

function classifyConnectionFailure({ success, statusCode, errorCode, phase }) {
  if (success) return "none";
  if (statusCode === 407 || ["ERR_INVALID_AUTH_CREDENTIALS", "ERR_PROXY_AUTH_UNSUPPORTED"].includes(errorCode)) return "proxy-auth";
  if (errorCode === "ERR_TUNNEL_CONNECTION_FAILED") return "proxy-tunnel";
  if (errorCode === "ERR_PROXY_CONNECTION_FAILED") return "proxy-connection";
  if (statusCode === 403 || statusCode === 429) return "http-access";
  if (errorCode === "TIMEOUT") return statusCode === null ? "navigation-timeout" : "document-load-timeout";
  if (statusCode !== null) return "http";
  if (phase === "브라우저 준비") return "browser";
  return "network";
}

async function readResponseSummary(response, page) {
  const summary = { headers: {} };
  try {
    const headers = response?.headers?.() || {};
    for (const name of RESPONSE_HEADERS) {
      if (headers[name]) summary.headers[name] = String(headers[name]).slice(0, 500);
    }
  } catch { /* 응답이 이미 폐기되어도 테스트 결과를 보존한다. */ }
  // 본문·쿠키·폼 값은 저장하지 않는다. 제목은 HTTP 오류 문서를 식별하는 용도로만 쓴다.
  try {
    if (response?.status?.() >= 400) {
      summary.title = String(await within(() => page?.title?.(), 1000, "문서 제목 확인 시간 초과") || "").slice(0, 300);
    }
  } catch { /* 문서 로딩 실패나 응답 정지가 진단 정리를 막지 않게 한다. */ }
  return summary;
}

async function checkEgress(context, endpoint) {
  let probe;
  try {
    return await within(async () => {
      probe = await context.newPage();
      const response = await probe.goto(endpoint, { waitUntil: "domcontentloaded", timeout: 10000 });
      if (response?.status() !== 200) throw new Error(`IP 확인 서버 HTTP ${response?.status() ?? "응답 없음"}`);
      const body = await probe.locator("body").innerText({ timeout: 1000 });
      if (body.length > 1000) throw new Error("IP 확인 응답 형식이 올바르지 않습니다.");
      const address = String(JSON.parse(body).ip || "").trim();
      if (!isIP(address)) throw new Error("IP 확인 응답에 유효한 IP가 없습니다.");
      return { egressIp: address, egressCheckedAt: new Date().toISOString() };
    }, 10000, "외부 IP 확인 제한 시간 10초가 지났습니다.");
  } catch (error) {
    return { egressIp: "", egressError: String(error?.message || error) };
  } finally {
    await closeWithin(probe);
  }
}

function createConnectionTester({
  getProxy, browserType = chromium, env = process.env,
  diagnosticDirectory, fileSystem = fs,
  egressCheckUrl = "https://api.ipify.org/?format=json",
  probeTunnel = (options) => require("./proxy-tunnel-probe").probeProxyTunnel(options),
}) {
  let running = false;
  let browser = null;
  let disposed = false;

  function releaseDisconnectedBrowser(target = browser) {
    if (!target) return true;
    try {
      if (target.isConnected?.() === false) {
        if (browser === target) browser = null;
        return true;
      }
    } catch { /* 연결 상태를 읽지 못하면 핸들을 보존한다. */ }
    return false;
  }

  async function closeTestBrowser() {
    const target = browser;
    if (releaseDisconnectedBrowser(target)) return true;
    try {
      await within(async () => {
        await target.close();
        // 시간 제한 이후에 종료가 완료되어도 같은 브라우저 핸들만 해제한다.
        if (browser === target) browser = null;
      }, 3000, "테스트 브라우저 종료 확인 시간 초과");
      return true;
    } catch {
      return releaseDisconnectedBrowser(target);
    }
  }

  async function close() {
    disposed = true;
    await closeTestBrowser();
  }

  async function run(input = {}) {
    if (disposed) throw new Error("앱을 종료하는 중입니다.");
    if (running) throw new Error("접속 테스트가 진행 중입니다. 완료 후 다시 실행하세요.");
    if (!releaseDisconnectedBrowser()) {
      throw new Error("이전 테스트 브라우저의 종료가 확인되지 않았습니다. 남은 테스트 창을 닫은 뒤 다시 실행하거나 앱을 다시 시작하세요.");
    }
    const url = normalizeTestUrl(input.url);
    const profileId = String(input.proxyProfileId || "").trim();
    // 삭제되거나 잘못된 프로필은 직접 연결로 대체하지 않는다.
    const profile = profileId ? getProxy(profileId) : null;
    if (profileId && !profile) throw new Error("선택한 프록시를 찾을 수 없습니다.");
    const proxy = profile ? normalizeProxyCredentials(profile, "테스트 프록시") : undefined;
    const sanitize = createSanitizer([proxy?.username, proxy?.password]);
    const chromiumHeadless = input.browserMode === "chromium-headless";
    const showBrowser = !chromiumHeadless && input.showBrowser !== false;
    const userAgent = resolveUserAgent({}, env, "cheonyu");
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let page;
    let context;
    let mainResponse;
    let statusCode = null;
    let phase = "브라우저 준비";
    running = true;
    const result = {
      testId: randomUUID(), startedAt, requestedUrl: url, proxyProfileId: profileId,
      proxyName: profile?.name || "직접 연결 (내 IP)",
      proxyServer: proxy?.server || "", showBrowser,
      browserMode: showBrowser ? "show" : chromiumHeadless ? "chromium-headless" : "hide",
      egressRequested: input.checkEgress === true, tunnelRequested: input.checkTunnel === true,
    };
    try {
      browser = await browserType.launch({
        headless: !showBrowser,
        ...(chromiumHeadless ? { channel: "chromium" } : {}),
        args: getLightweightLaunchArgs({ showBrowser }),
        timeout: 30000,
      });
      const launchedBrowser = browser;
      launchedBrowser.on?.("disconnected", () => {
        if (browser === launchedBrowser) browser = null;
      });
      if (disposed) throw new Error("앱을 종료하는 중입니다.");
      context = await launchedBrowser.newContext({
        viewport: { width: 1440, height: 1000 }, userAgent,
        acceptDownloads: false,
        ...(proxy ? { proxy } : {}),
      });
      page = await context.newPage();
      page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
      page.on("response", (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          statusCode = response.status();
          mainResponse = response;
        }
      });
      phase = "페이지 접속";
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      mainResponse = response || mainResponse;
      statusCode = response?.status() ?? statusCode;
      const success = statusCode !== null && statusCode >= 200 && statusCode < 400;
      Object.assign(result, {
        success, outcome: success ? "success" : "http-error",
        message: success
          ? "페이지 응답과 기본 문서 로딩을 확인했습니다. 로그인·수집 성공 여부는 별도입니다."
          : statusCode === null ? "페이지의 HTTP 응답을 확인하지 못했습니다."
            : `서버가 HTTP ${statusCode}로 응답했습니다.`,
      });
    } catch (error) {
      const errorMessage = String(error?.message || error);
      Object.assign(result, {
        success: false, outcome: "connection-error",
        errorCode: errorMessage.match(/net::(ERR_[A-Z_]+)/)?.[1]
          || (error?.name === "TimeoutError" ? "TIMEOUT" : ""),
        message: `${phase} 실패`, error: errorMessage,
      });
    } finally {
      result.statusCode = statusCode;
      result.elapsedMs = Math.round(performance.now() - started);
      try { result.finalUrl = page?.url() || ""; } catch { result.finalUrl = ""; }
      result.failureLayer = classifyConnectionFailure({ ...result, phase });
      if (result.failureLayer === "proxy-tunnel") {
        result.message = "프록시의 HTTPS 터널 연결에 실패했습니다. 실제 CONNECT 응답 코드는 별도 진단이 필요합니다.";
      } else if (result.failureLayer === "proxy-auth") {
        result.message = "프록시 인증이 거절되었습니다. 현재 등록된 사용자명·비밀번호와 접속 제한을 확인하세요.";
      } else if (result.failureLayer === "document-load-timeout") {
        result.message = `HTTP ${statusCode} 응답은 받았지만 기본 문서 로딩이 제한 시간 안에 끝나지 않았습니다.`;
      }
      result.responseSummary = await readResponseSummary(mainResponse, page);
      // 대상 URL의 시간·결과와 별개로, 동일 브라우저 세션에서 딱 한 번만 확인한다.
      if (input.checkEgress === true && context && !disposed) {
        Object.assign(result, await checkEgress(context, egressCheckUrl));
      }
      // 성공·실패 모두 테스트 브라우저만 정리한다.
      if (!await closeTestBrowser()) {
        result.browserCloseWarning = "테스트 브라우저 종료를 확인하지 못했습니다. 남아 있는 테스트 창이 있으면 닫아 주세요.";
      }
    }
    try {
      if (input.checkTunnel === true && !disposed) {
        if (proxy?.server.startsWith("http:") && new URL(url).protocol === "https:") {
          try { result.tunnelProbe = await probeTunnel({ proxy, url, timeoutMs: 15000 }); }
          catch (error) { result.tunnelProbe = { statusCode: null, message: String(error?.message || error) }; }
        } else {
          result.tunnelProbe = { skipped: true, message: "CONNECT 진단은 HTTP 프록시를 통한 HTTPS URL 접속에서만 실행합니다." };
        }
      }
      if (diagnosticDirectory) {
        const directory = typeof diagnosticDirectory === "function" ? diagnosticDirectory() : diagnosticDirectory;
        if (directory) {
          await fileSystem.mkdir(directory, { recursive: true });
          result.diagnosticPath = path.join(directory, `${startedAt.replace(/[:.]/g, "-")}-${result.testId}.json`);
          await fileSystem.writeFile(result.diagnosticPath, `${JSON.stringify(sanitize(result), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        }
      }
    } catch (error) {
      delete result.diagnosticPath;
      result.diagnosticSaveError = String(error?.message || error);
    } finally {
      running = false;
    }
    return sanitize(result);
  }

  return { run, close };
}

module.exports = { createConnectionTester, normalizeTestUrl, classifyConnectionFailure };

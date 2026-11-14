const { createCollectionProxy, monitorCollectionSession } = require("../../utils/collection-proxy");
const {
  classifyCollectionFailure,
  isRecoverableStickySessionError,
  isTerminalStickyConnectionError,
  needsStickyTunnelConfirmation,
} = require("../../utils/collection-failure");
const { checkStickyTunnelBeforeRecovery } = require("../../utils/proxy-tunnel-probe");
const { installLightweightNetworkPolicy } = require("../../utils/browser");
const { installHttpBlockGuard, sleepWithSignal } = require("../../utils/site-safety");
const { registerDiagnosticContext, recordDiagnostic } = require("../../utils/collection-diagnostics");
const { throwIfAborted } = require("../../utils/common");
const { loginCheonyu, parseLoginState } = require("./site");

const RECONNECT_DELAYS_MS = [1000, 3000, 6000];

function requireLifecycleLogin(html, message) {
  if (!parseLoginState(html).loggedIn) {
    throw Object.assign(new Error(message), { code: "CHEONYU_LOGIN_REQUIRED" });
  }
}

function createLifecycleConnection(browser, config, {
  signal, label, onProgress, probeTunnel, loggedIn = config.collectionKind !== "newProducts",
}) {
  const blocked = new AbortController();
  const taskSignal = signal ? AbortSignal.any([signal, blocked.signal]) : blocked.signal;
  let active;
  let proxy = config.proxy;

  async function close() {
    const connection = active;
    active = undefined;
    if (!connection) return;
    connection.monitor?.stop();
    connection.guard?.dispose();
    await connection.context.close().catch(() => {});
  }

  async function connect() {
    const context = await browser.newContext({ viewport: config.viewport, userAgent: config.userAgent, proxy });
    const interrupted = new AbortController();
    const connection = { context, interrupted, signal: AbortSignal.any([taskSignal, interrupted.signal]) };
    active = connection;
    registerDiagnosticContext(context, {
      proxyProfileId: config.proxyProfileId,
      proxyProfileName: config.proxyProfileName,
      server: proxy?.server,
    });
    connection.guard = installHttpBlockGuard(context, {
      hostname: new URL(config.baseUrl).hostname,
      label: "천유",
      statusCodes: [403, 407, 429],
      onBlocked: error => {
        blocked.abort(error);
        void context.close().catch(() => {});
      },
    });
    const policy = await installLightweightNetworkPolicy(context, config);
    const page = await context.newPage();
    connection.page = page;
    await policy.configurePage(page);
    await context.addCookies([{ name: "is_korean_mode", value: "Y", url: config.baseUrl }]);
    page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
    if (!loggedIn) return;

    connection.monitor = await monitorCollectionSession(context, error => {
      interrupted.abort(error);
      void context.close().catch(() => {});
    }, config.proxyProvider);
    onProgress({ stage: "login", message: `${label} · 로그인하고 있습니다.` });
    const login = await loginCheonyu(page, config, connection.signal, { verificationTarget: "home" });
    connection.home = login.html;
  }

  async function renew() {
    await close();
    throwIfAborted(taskSignal);
    proxy = createCollectionProxy(proxy, true, config.proxyProvider);
  }

  // A caller persists the result only after this returns. A cart-reading
  // operation must reconcile any rows it added before replaying an attempt.
  async function read(pageNo, operation) {
    for (let retries = 0; ; retries++) {
      try {
        throwIfAborted(taskSignal);
        if (active?.monitor?.needsRenewal() && !active.signal.aborted) {
          await renew();
          onProgress({ stage: "proxy-session", currentPage: pageNo,
            message: `${label} · 세션 만료 전에 다시 연결하고 ${pageNo}페이지를 확인합니다.` });
        }
        if (!active) await connect();
        await active.monitor?.check();
        throwIfAborted(active.signal);
        let result;
        try {
          result = await operation(active);
        } catch (error) {
          if (error?.code === "CHEONYU_LOGIN_REQUIRED") await active.monitor?.check();
          throw error;
        }
        await active.monitor?.check();
        throwIfAborted(active.signal);
        return result;
      } catch (error) {
        if (blocked.signal.aborted) throw blocked.signal.reason;
        throwIfAborted(taskSignal);
        const interrupted = active?.interrupted.signal.reason;
        const terminal = [error, interrupted].find(isTerminalStickyConnectionError);
        if (terminal) throw terminal;
        const tunnel = classifyCollectionFailure(error).kind === "proxy-connection";
        const failure = tunnel ? error : interrupted || error;
        if (!loggedIn || !isRecoverableStickySessionError(failure) || retries >= RECONNECT_DELAYS_MS.length) {
          throw failure;
        }
        let tunnelObservation;
        if (needsStickyTunnelConfirmation(failure)) {
          tunnelObservation = await checkStickyTunnelBeforeRecovery({
            proxy, url: config.baseUrl, signal: taskSignal, probe: probeTunnel,
          });
        }
        if (blocked.signal.aborted) throw blocked.signal.reason;
        recordDiagnostic("sticky-checkpoint-renewal", {
          pageNo, attempt: retries + 1,
          reason: failure.details?.reason || classifyCollectionFailure(failure).code,
          tunnel: tunnelObservation,
        });
        await renew();
        onProgress({ stage: "proxy-session", currentPage: pageNo,
          message: `${label} · 새 스티키 세션으로 다시 로그인하고 ${pageNo}페이지부터 이어갑니다 (${retries + 1}/${RECONNECT_DELAYS_MS.length}).` });
        await sleepWithSignal(RECONNECT_DELAYS_MS[retries], taskSignal);
      }
    }
  }

  return { read, close, signal: taskSignal, getBlockError: () => blocked.signal.reason };
}

module.exports = { createLifecycleConnection, requireLifecycleLogin };

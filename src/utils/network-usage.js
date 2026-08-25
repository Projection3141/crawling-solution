const BYTES_PER_GB = 1024 ** 3;
const RESOURCE_CATEGORIES = ["html", "js", "img", "xhr", "other"];

function getResourceCategory(resourceType) {
  const type = String(resourceType || "").toLowerCase();

  if (type === "document") return "html";
  if (type === "script") return "js";
  if (type === "image") return "img";
  if (type === "xhr" || type === "fetch") return "xhr";
  return "other";
}

function normalizeProxy(proxy = {}) {
  const profileId = String(proxy.proxyProfileId || proxy.id || "").trim();
  const profileName = String(proxy.proxyProfileName || proxy.name || "").trim();
  const server = String(proxy.server || proxy.proxy?.server || "").trim();

  return {
    key: profileId || server || "direct",
    profileId,
    profileName: profileName || (server ? "등록 프록시" : "직접 연결"),
    server: server || "direct",
  };
}

function createEmptyUsage(proxy) {
  return {
    ...proxy,
    html: 0,
    js: 0,
    img: 0,
    xhr: 0,
    other: 0,
  };
}

function toGb(bytes) {
  return +(Math.max(0, Number(bytes) || 0) / BYTES_PER_GB).toFixed(9);
}

/** Chromium CDP의 실제 수신 바이트를 실행·프록시·리소스별로 누적한다. */
function createNetworkUsageTracker({ label = "수집" } = {}) {
  const startedAt = new Date().toISOString();
  const usageByProxy = new Map();
  const trackedPages = new WeakSet();
  const pageTrackingPromises = new WeakMap();
  const contextListeners = [];
  const sessions = new Set();

  function getUsage(proxyInput) {
    const proxy = normalizeProxy(proxyInput);
    if (!usageByProxy.has(proxy.key)) {
      usageByProxy.set(proxy.key, createEmptyUsage(proxy));
    }
    return usageByProxy.get(proxy.key);
  }

  async function startTrackingPage(page, proxyInput) {
    if (!page || trackedPages.has(page)) return;
    trackedPages.add(page);

    const context = page.context?.();
    if (!context || typeof context.newCDPSession !== "function") return;

    try {
      const usage = getUsage(proxyInput);
      const session = await context.newCDPSession(page);
      const requestTypes = new Map();
      const partialBytes = new Map();
      sessions.add(session);

      session.on("Network.requestWillBeSent", (event) => {
        if (event?.requestId && event?.type) {
          requestTypes.set(event.requestId, event.type);
        }
      });
      session.on("Network.responseReceived", (event) => {
        if (event?.requestId && event?.type) {
          requestTypes.set(event.requestId, event.type);
        }
      });
      session.on("Network.dataReceived", (event) => {
        const requestId = event?.requestId;
        if (!requestId) return;
        const bytes = Math.max(
          0,
          Number(event.encodedDataLength) || Number(event.dataLength) || 0,
        );
        partialBytes.set(requestId, (partialBytes.get(requestId) || 0) + bytes);
      });

      const finishRequest = (event, failed = false) => {
        const requestId = event?.requestId;
        if (!requestId) return;
        const measuredBytes = partialBytes.get(requestId) || 0;
        const bytes = failed
          ? measuredBytes
          : Math.max(measuredBytes, Number(event.encodedDataLength) || 0);
        const category = getResourceCategory(requestTypes.get(requestId));
        usage[category] += Math.max(0, bytes);
        requestTypes.delete(requestId);
        partialBytes.delete(requestId);
      };

      session.on("Network.loadingFinished", (event) => finishRequest(event));
      session.on("Network.loadingFailed", (event) => finishRequest(event, true));
      await session.send("Network.enable");
    } catch (error) {
      console.warn(
        `[WARN] [NETWORK USAGE] ${label} 페이지 추적 연결 실패: ` +
          `${error?.message || error}`,
      );
    }
  }

  function trackPage(page, proxyInput) {
    if (!page) return Promise.resolve();

    const existingPromise = pageTrackingPromises.get(page);
    if (existingPromise) return existingPromise;

    const trackingPromise = startTrackingPage(page, proxyInput);
    pageTrackingPromises.set(page, trackingPromise);
    return trackingPromise;
  }

  async function trackContext(context, proxyInput) {
    if (!context) return;
    getUsage(proxyInput);

    const onPage = (page) => {
      void trackPage(page, proxyInput);
    };
    context.on?.("page", onPage);
    contextListeners.push({ context, onPage });

    await Promise.all(
      (context.pages?.() || []).map((page) => trackPage(page, proxyInput)),
    );
  }

  function snapshot() {
    const proxies = Array.from(usageByProxy.values()).map((usage) => {
      const totalBytes = RESOURCE_CATEGORIES.reduce(
        (sum, category) => sum + usage[category],
        0,
      );

      return {
        proxyProfileId: usage.profileId,
        proxyProfileName: usage.profileName,
        server: usage.server,
        htmlBytes: usage.html,
        jsBytes: usage.js,
        imgBytes: usage.img,
        xhrBytes: usage.xhr,
        otherBytes: usage.other,
        totalBytes,
        htmlGB: toGb(usage.html),
        jsGB: toGb(usage.js),
        imgGB: toGb(usage.img),
        xhrGB: toGb(usage.xhr),
        otherGB: toGb(usage.other),
        totalGB: toGb(totalBytes),
      };
    });

    return {
      label,
      startedAt,
      finishedAt: new Date().toISOString(),
      proxies,
      totalGB: +proxies.reduce((sum, item) => sum + item.totalGB, 0).toFixed(9),
    };
  }

  async function finishAndLog() {
    for (const { context, onPage } of contextListeners) {
      context.off?.("page", onPage);
    }
    contextListeners.length = 0;

    await Promise.all(
      Array.from(sessions).map((session) =>
        session.detach().catch(() => null),
      ),
    );
    sessions.clear();

    const report = snapshot();
    const rows = report.proxies.map((item) => ({
      proxy: item.proxyProfileName,
      server: item.server,
      htmlGB: item.htmlGB.toFixed(9),
      jsGB: item.jsGB.toFixed(9),
      imgGB: item.imgGB.toFixed(9),
      xhrGB: item.xhrGB.toFixed(9),
      otherGB: item.otherGB.toFixed(9),
      totalGB: item.totalGB.toFixed(9),
    }));

    console.log(
      `[INFO] [NETWORK USAGE] ${label} 종료 · 프록시 ${rows.length}개 · ` +
        `총 ${report.totalGB.toFixed(9)} GB`,
    );
    if (typeof console.table === "function") {
      console.table(rows);
    } else {
      console.log("[INFO] [NETWORK USAGE]", rows);
    }

    return report;
  }

  return {
    finishAndLog,
    snapshot,
    trackContext,
    trackPage,
  };
}

module.exports = {
  createNetworkUsageTracker,
  getResourceCategory,
};

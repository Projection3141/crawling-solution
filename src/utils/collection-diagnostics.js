// 실행별 진단 기록. 수집 요청과 재시도를 기다리게 하지 않고 파일 쓰기를 직렬화한다.
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs/promises");
const path = require("node:path");

const storage = new AsyncLocalStorage();
const contexts = new WeakMap();
const pages = new WeakMap();
const sensitiveKey = /password|passwd|secret|token|authorization|cookie|username|account(?:id|pw)?|credential|api.?key/i;

function createSanitizer(secrets) {
  const hidden = [...new Set((secrets || []).filter(Boolean).flatMap((value) => {
    const text = String(value);
    try { return [text, encodeURIComponent(text)]; }
    catch { return [text]; }
  }))].sort((a, b) => b.length - a.length);
  const cleanText = (value) => {
    let text = String(value).replace(/\u001b\[[0-9;]*m/g, "");
    text = text.replace(/(?:https?|socks5?):\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[URL REDACTED]";
      }
    });
    for (const secret of hidden) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, 12000);
  };
  return function sanitize(value, seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string") return cleanText(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (depth > 8) return "[TRUNCATED]";
    if (typeof value !== "object") return cleanText(value);
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (value instanceof Error) {
      return sanitize({
        name: value.name, message: value.message, stack: value.stack,
        code: value.code, statusCode: value.statusCode, stage: value.stage,
        details: value.details, cause: value.cause,
      }, seen, depth + 1);
    }
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key, sensitiveKey.test(key) ? "[REDACTED]" : sanitize(item, seen, depth + 1),
    ]));
  };
}

function createCollectionDiagnostics({ directory, runId, secrets = [], fileSystem = fs }) {
  const safeRunId = String(runId || "run").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(directory, `${safeRunId}.jsonl`);
  const sanitize = createSanitizer(secrets);
  let queue = Promise.resolve();
  let ready = false;
  let writeError = null;
  let sequence = 0;
  let contextSequence = 0;
  let pageSequence = 0;
  const logger = {
    filePath,
    get error() { return writeError; },
    nextContextId: () => `context-${++contextSequence}`,
    nextPageId: () => `page-${++pageSequence}`,
    record(event, details = {}) {
      if (writeError) return;
      try {
        const line = JSON.stringify({
          at: new Date().toISOString(), runId: safeRunId, sequence: ++sequence,
          event: String(event), details: sanitize(details),
        }) + "\n";
        queue = queue.then(async () => {
          if (writeError) return;
          if (!ready) {
            await fileSystem.mkdir(directory, { recursive: true });
            ready = true;
          }
          await fileSystem.appendFile(filePath, line, "utf8");
        }).catch((error) => { writeError = error; });
      } catch (error) {
        // 진단 기록의 직렬화 오류가 수집 작업을 중단하지 않게 한다.
        writeError = error;
      }
    },
    run(task) { return storage.run(logger, task); },
    async flush() { await queue; },
  };
  return logger;
}

function recordDiagnostic(event, details) {
  storage.getStore()?.record(event, details);
}

function describeDiagnosticPage(page) {
  try {
    const contextInfo = contexts.get(page?.context?.());
    const pageInfo = pages.get(page);
    return {
      ...(contextInfo?.metadata || {}),
      ...(pageInfo ? { pageId: pageInfo.pageId } : {}),
      url: page?.url?.() || "",
    };
  } catch {
    return {};
  }
}

function describeDiagnosticContext(context) {
  return { ...(contexts.get(context)?.metadata || {}) };
}

function attachDiagnosticContext(context, proxy = {}) {
  const logger = storage.getStore();
  if (!logger || !context || contexts.has(context)) return contexts.get(context)?.metadata || {};
  const metadata = {
    contextId: logger.nextContextId(),
    proxyProfileId: proxy.proxyProfileId || "",
    proxyProfileName: proxy.proxyProfileName || "직접 연결",
    proxyServer: proxy.server || "",
  };
  contexts.set(context, { logger, metadata });
  // Playwright 이벤트는 AsyncLocalStorage 바깥에서 발생할 수도 있으므로 logger를 고정한다.
  const attachPage = (page) => {
    try {
      if (pages.has(page)) return;
      pages.set(page, { pageId: logger.nextPageId() });
      const describe = () => describeDiagnosticPage(page);
      logger.record("tab-created", describe());
      page.on?.("close", () => logger.record("tab-closed", describe()));
      page.on?.("crash", () => logger.record("tab-crashed", describe()));
      page.on?.("framenavigated", (frame) => {
        try {
          if (frame === page.mainFrame?.()) logger.record("tab-navigated", describe());
        } catch { /* 닫힌 탭의 이벤트는 수집에 영향을 주지 않는다. */ }
      });
      page.on?.("requestfailed", (request) => {
        try {
          if (!["document", "xhr", "fetch"].includes(request.resourceType())) return;
          logger.record("request-failed", {
            ...describe(), requestUrl: request.url(), resourceType: request.resourceType(),
            error: request.failure()?.errorText || "",
          });
        } catch { /* 진단 이벤트가 브라우저 동작에 영향을 주지 않는다. */ }
      });
    } catch { /* 일부 테스트나 이미 닫힌 탭에서도 수집 동작은 유지한다. */ }
  };
  logger.record("session-created", metadata);
  context.on?.("page", attachPage);
  context.on?.("close", () => logger.record("session-closed", metadata));
  context.on?.("response", (response) => {
    try {
      const statusCode = response.status();
      const resourceType = response.request().resourceType();
      if (statusCode < 400 || !["document", "xhr", "fetch"].includes(resourceType)) return;
      logger.record("http-error", { ...metadata, statusCode, resourceType, url: response.url() });
    } catch { /* 오류 응답을 기록하지 못해도 원래 응답 처리는 유지한다. */ }
  });
  for (const page of context.pages?.() || []) attachPage(page);
  return metadata;
}

function registerDiagnosticContext(context, proxy) {
  try {
    return attachDiagnosticContext(context, proxy);
  } catch {
    return {};
  }
}

module.exports = {
  createSanitizer,
  createCollectionDiagnostics, recordDiagnostic, registerDiagnosticContext,
  describeDiagnosticPage, describeDiagnosticContext,
};

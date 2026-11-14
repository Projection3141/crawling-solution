const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const {
  createCollectionDiagnostics, recordDiagnostic, registerDiagnosticContext,
} = require("../src/utils/collection-diagnostics");
const { gotoWithSiteRetry, resetPageState, replacePage, getSafetyNumber, withSiteRetry } = require("../src/utils/site-safety");
const { loginCheonyu } = require("../src/malls/cheonyu/site");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "collection-diagnostics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, read: async (logger) => {
    await logger.flush();
    return (await fs.readFile(logger.filePath, "utf8")).trim().split("\n").map(JSON.parse);
  } };
}

class Context extends EventEmitter {
  constructor() { super(); this.openPages = []; }
  pages() { return this.openPages; }
  async newPage() {
    const page = new EventEmitter();
    page.context = () => this;
    page.currentUrl = "about:blank";
    page.url = () => page.currentUrl;
    page.mainFrame = () => page.frame;
    page.frame = {};
    page.goto = async (url) => {
      page.currentUrl = url;
      page.emit("framenavigated", page.frame);
      return { ok: () => true };
    };
    page.close = async () => { page.emit("close"); };
    this.openPages.push(page);
    this.emit("page", page);
    return page;
  }
}

test("동시 실행의 진단 파일과 프록시·탭 이력을 분리하고 인증정보를 제거한다", async (t) => {
  const { directory, read } = await fixture(t);
  const first = createCollectionDiagnostics({ directory, runId: "run-a", secrets: ["private-password", "private-user"] });
  const second = createCollectionDiagnostics({ directory, runId: "run-b" });
  const a = new Context();
  const b = new Context();
  await Promise.all([
    first.run(async () => {
      registerDiagnosticContext(a, { proxyProfileId: "p1", proxyProfileName: "프록시 1", server: "http://private-user:private-password@proxy.invalid:80?token=hidden" });
      recordDiagnostic("credential-test", {
        password: "unlisted-secret", cookie: "private-cookie",
        error: new Error("private-password https://private-user:private-password@site.invalid/login?token=hidden#secret"),
      });
      await Promise.resolve();
      recordDiagnostic("a-only", {});
    }),
    second.run(async () => {
      registerDiagnosticContext(b, { proxyProfileId: "p2", proxyProfileName: "프록시 2" });
      await Promise.resolve();
      recordDiagnostic("b-only", {});
    }),
  ]);
  // 실제 브라우저처럼 ALS 범위 밖에서 발생하는 이벤트도 원래 실행에 귀속되어야 한다.
  const pageA = await a.newPage();
  await b.newPage();
  pageA.emit("requestfailed", {
    resourceType: () => "document", url: () => "https://site.invalid/member/login.html?token=hidden",
    failure: () => ({ errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" }),
  });
  const entriesA = await read(first);
  const entriesB = await read(second);
  assert.ok(entriesA.some((entry) => entry.event === "a-only"));
  assert.ok(!entriesA.some((entry) => entry.event === "b-only"));
  assert.ok(!entriesB.some((entry) => entry.event === "a-only"));
  const failed = entriesA.find((entry) => entry.event === "request-failed");
  assert.equal(failed.details.proxyProfileId, "p1");
  assert.equal(failed.details.pageId, "page-1");
  assert.equal(failed.details.requestUrl, "https://site.invalid/member/login.html");
  assert.deepEqual(entriesA.map((entry) => entry.sequence), entriesA.map((_, index) => index + 1));
  const raw = JSON.stringify(entriesA);
  for (const secret of ["private-password", "private-user", "unlisted-secret", "private-cookie", "token=hidden", "#secret"]) {
    assert.ok(!raw.includes(secret), secret);
  }
});

test("재시도 횟수와 원래 예외를 유지하면서 원인과 실제 프록시를 기록한다", async (t) => {
  const { directory, read } = await fixture(t);
  const logger = createCollectionDiagnostics({ directory, runId: "retry" });
  const context = new Context();
  let attempts = 0;
  const error = new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED");
  const retryCalls = [];
  await logger.run(async () => {
    registerDiagnosticContext(context, { proxyProfileId: "p6", proxyProfileName: "프록시 6" });
    const page = await context.newPage();
    page.goto = async () => { attempts++; throw error; };
    await assert.rejects(gotoWithSiteRetry(page, "https://site.invalid/member/login.html", {
      maxAttempts: 3, baseDelayMs: 0, jitterRatio: 0,
      onRetry: ({ nextAttempt }) => { retryCalls.push(nextAttempt); },
    }), (caught) => caught === error);
  });
  const entries = await read(logger);
  assert.equal(attempts, 3);
  assert.deepEqual(retryCalls, [2, 3]);
  const scheduled = entries.filter((entry) => entry.event === "retry-scheduled");
  assert.deepEqual(scheduled.map((entry) => entry.details.nextAttempt), [2, 3]);
  assert.ok(scheduled.every((entry) => entry.details.proxyProfileId === "p6"));
  assert.equal(entries.find((entry) => entry.event === "retry-exhausted").details.attempt, 3);
  assert.ok(entries.some((entry) => entry.details.error?.message === error.message));
});

test("로그 쓰기 실패와 순환 객체가 있어도 수집 결과와 예외를 바꾸지 않는다", async () => {
  const logger = createCollectionDiagnostics({
    directory: "unused", runId: "unavailable",
    fileSystem: { mkdir: async () => { throw new Error("disk unavailable"); } },
  });
  const circular = {};
  circular.self = circular;
  const result = await logger.run(async () => {
    recordDiagnostic("circular", circular);
    return "collected";
  });
  await logger.flush();
  assert.equal(result, "collected");
  assert.equal(logger.error.message, "disk unavailable");
  const original = new Error("collection failed");
  await assert.rejects(logger.run(async () => { recordDiagnostic("later", {}); throw original; }), (error) => error === original);
});

test("진단 기록 유무와 무관하게 재시도 지연과 성공 반환값을 유지한다", async (t) => {
  const { directory, read } = await fixture(t);
  const logger = createCollectionDiagnostics({ directory, runId: "cadence" });
  async function exercise() {
    let attempts = 0;
    const delays = [];
    const result = await withSiteRetry(async () => {
      if (++attempts < 4) throw new Error("temporary fixture failure");
      return "success";
    }, {
      maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4, multiplier: 2, jitterRatio: 0,
      onRetry: ({ delayMs }) => { delays.push(delayMs); },
    });
    return { attempts, delays, result };
  }
  const without = await exercise();
  const withDiagnostics = await logger.run(exercise);
  assert.deepEqual(withDiagnostics, without);
  assert.deepEqual(withDiagnostics, { attempts: 4, delays: [1, 2, 4], result: "success" });
  const entries = await read(logger);
  assert.deepEqual(entries.filter((entry) => entry.event === "retry-scheduled").map((entry) => entry.details.delayMs), [1, 2, 4]);
  assert.equal(entries.at(-1).event, "attempt-succeeded");
});

test("탭 초기화·교체 및 로그인 실패를 같은 세션에 연결한다", async (t) => {
  const { directory, read } = await fixture(t);
  const logger = createCollectionDiagnostics({ directory, runId: "tabs" });
  await logger.run(async () => {
    const context = new Context();
    registerDiagnosticContext(context, { proxyProfileName: "프록시 1" });
    const page = await context.newPage();
    await resetPageState(page, { delayMs: 0 });
    const replacement = await replacePage(page);
    const loginError = new Error("context closed during login");
    context.addCookies = async () => { throw loginError; };
    await assert.rejects(loginCheonyu(replacement, { baseUrl: "https://site.invalid" }), (error) => error === loginError);
    context.emit("close");
  });
  const entries = await read(logger);
  const replacement = entries.find((entry) => entry.event === "tab-replacement-complete");
  assert.equal(replacement.details.previousPageId, "page-1");
  assert.equal(replacement.details.pageId, "page-2");
  assert.equal(replacement.details.contextId, "context-1");
  assert.ok(entries.some((entry) => entry.event === "tab-reset"));
  assert.ok(entries.some((entry) => entry.event === "tab-closed" && entry.details.pageId === "page-1"));
  assert.equal(entries.find((entry) => entry.event === "login-failed").details.pageId, "page-2");
  assert.ok(entries.some((entry) => entry.event === "session-closed"));
});

test("목록 순회는 설정한 페이지 간격으로 프록시를 교체하고 기존 페이지 대기를 유지한다", async () => {
  const source = await fs.readFile(path.join(__dirname, "../src/malls/cheonyu/site.js"), "utf8");
  const implementation = source.slice(source.indexOf("async function bulkAddPages("), source.lastIndexOf("module.exports ="));
  async function traverse(proxyRotationPages, pageOrder = "forward") {
    const rotations = [];
    const resets = [];
    const waits = [];
    let proxyStart = pageOrder === "reverse" ? 12 : 1;
    const page = { goto: async () => null, waitForTimeout: async (ms) => { waits.push(ms); } };
    const sandbox = {
      getSafetyNumber, recordDiagnostic: () => {}, describeDiagnosticPage: () => ({}),
      throwIfAborted: () => {}, logCheonyuInfo: () => {}, logCheonyuWarn: () => {},
      CHEONYU_PAGE_HARD_COOLDOWN_MS: 30000, CHEONYU_PAGE_PACING_BUDGET_MS: 120000,
      CHEONYU_PAGE_POPUP_ADAPTIVE_BUDGET_MS: 90000,
      performance: { now: () => 0 }, Date: { now: () => 1000 }, formatMs: String,
      readCheonyuPageRuntimeSnapshot: async () => ({}),
      collectListCandidates: async (_, pageNo) => ({ candidates: [{ productId: String(pageNo) }], targets: [] }),
    };
    vm.createContext(sandbox);
    vm.runInContext(implementation, sandbox);
    const result = await sandbox.bulkAddPages(page, {
      collectionMode: "general", pageOrder, ...(proxyRotationPages === undefined ? {} : { proxyRotationPages }),
    }, undefined, undefined, {
      resolvedPageRange: { pageStart: 1, pageEnd: 12 },
      getProxyPageStart: () => proxyStart,
      rotatePage: async ({ pageNo, forceRestart }) => {
        rotations.push(pageNo);
        if (forceRestart) proxyStart = pageNo;
        return page;
      },
      resetPage: async ({ pageNo }) => { resets.push(pageNo); return page; },
    });
    assert.equal(result.collectedProductCount, 12);
    assert.equal(waits.length, 11);
    assert.ok(waits.every((ms) => ms === 120000));
    return { rotations, resets };
  }
  assert.deepEqual(await traverse(), { rotations: [1, 11], resets: [6] });
  assert.deepEqual((await traverse(3)).rotations, [1, 4, 7, 10]);
  assert.deepEqual((await traverse(3, "reverse")).rotations, [12, 9, 6, 3]);
});

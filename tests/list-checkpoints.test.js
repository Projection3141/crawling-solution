const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { createListCheckpointWriter } = require("../src/utils/list-checkpoint");
const { getSafetyNumber } = require("../src/utils/site-safety");

function fixture(config = {}, failManifestAt = 0) {
  const stored = new Map();
  const events = [];
  const runDir = path.resolve("list-checkpoint-fixture");
  const files = { runDir, resultJson: path.join(runDir, "result.json") };
  let manifests = 0;
  const writer = createListCheckpointWriter({
    config: { mall: "cheonyu", pageStart: 1, pageEnd: 12, ...config }, files,
    onProgress: (event) => events.push(event),
    async writeJson(file, data) {
      if (file.endsWith("list-checkpoint.json") && ++manifests === failManifestAt) throw new Error("disk full");
      stored.set(file, structuredClone(data));
    },
  });
  return { writer, stored, events, files };
}

function page(pageNo) {
  return { pageNo, pageRange: { pageStart: 1, pageEnd: 12 }, products: [{ productId: String(pageNo), page: pageNo }] };
}

async function traverse({ writer, failPage = 11, pageOrder = "forward", pageEnd = 12, onVisit = () => {}, collectionKind = "", waitBeforeFirstPage = false }) {
  const source = await fs.readFile(path.join(__dirname, "../src/malls/cheonyu/site.js"), "utf8");
  const implementation = source.slice(source.indexOf("async function bulkAddPages("), source.lastIndexOf("module.exports ="));
  const rotations = [];
  const waits = [];
  let proxyStart = pageOrder === "reverse" ? pageEnd : 1;
  const browserPage = { goto: async () => null, waitForTimeout: async (ms) => waits.push(ms) };
  const sandbox = {
    getSafetyNumber, recordDiagnostic() {}, describeDiagnosticPage: () => ({}),
    throwIfAborted() {}, logCheonyuInfo() {}, logCheonyuWarn() {},
    CHEONYU_PAGE_HARD_COOLDOWN_MS: 30000, CHEONYU_PAGE_PACING_BUDGET_MS: 120000,
    CHEONYU_PAGE_POPUP_ADAPTIVE_BUDGET_MS: 90000,
    performance: { now: () => 0 }, Date: { now: () => 1000 }, formatMs: String,
    readCheonyuPageRuntimeSnapshot: async () => ({}),
    collectListCandidates: async (_, pageNo) => {
      onVisit(pageNo);
      return { candidates: [{ productId: String(pageNo), page: pageNo }], targets: [{ productId: String(pageNo), page: pageNo }] };
    },
    addCheonyuProductBatchesToCart: async (_, pageNo) => ({
      activePage: browserPage,
      popupOptionRows: [{ productId: String(pageNo), optionText: "관찰한 옵션", maxStock: 4 }],
      excludedProducts: [], unavailableProductIds: pageNo === 2 ? ["2"] : [],
    }),
  };
  vm.createContext(sandbox);
  vm.runInContext(implementation, sandbox);
  const result = sandbox.bulkAddPages(browserPage, {
    collectionMode: collectionKind === "inventory" ? "general" : "detail", collectionKind, requestDelayMs: 0, pageOrder, proxyRotationPages: 1,
  }, undefined, undefined, {
    resolvedPageRange: { pageStart: 1, pageEnd },
    waitBeforeFirstPage,
    pagePacingNotBeforeAt: waitBeforeFirstPage ? 121000 : 0,
    getProxyPageStart: () => proxyStart,
    rotatePage: async ({ pageNo, forceRestart }) => {
      rotations.push(pageNo);
      if (pageNo === failPage) throw new Error(`ERR_TUNNEL_CONNECTION_FAILED page ${pageNo}`);
      if (forceRestart) proxyStart = pageNo;
      return browserPage;
    },
    onListPage: (payload) => writer.savePage(payload),
  });
  return { result: await result, rotations, waits };
}

test("page 11 login failure retains all ten completed list pages before first inventory cycle", async () => {
  const f = fixture();
  await assert.rejects(traverse({ writer: f.writer }), /ERR_TUNNEL_CONNECTION_FAILED page 11/);
  const checkpoint = f.stored.get(path.join(f.files.runDir, "list-checkpoint.json"));
  assert.deepEqual(checkpoint.savedPages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(checkpoint.savedThroughPage, 10);
  assert.equal(checkpoint.phase, "list");
  assert.equal(checkpoint.inventoryComplete, false);
  assert.equal(checkpoint.detailComplete, false);
  assert.equal(f.stored.has(f.files.resultJson), false, "raw pages never masquerade as normalized results");
  assert.equal(f.events.length, 10);
  const second = f.stored.get(checkpoint.pages[1].file);
  assert.equal(second.products[0].isSoldOut, true, "page mutations after popup processing are captured");
  assert.equal(second.popupOptionItems[0].maxStock, 4);
  assert.equal(second.pageRange.collectedLastPage, 2, "later navigation does not mutate saved page metadata");
  assert.equal(f.stored.has(path.join(f.files.runDir, "list-pages", "page-000011.json")), false);
});

test("raw page commit failure halts before the next navigation and keeps previous manifest", async () => {
  const f = fixture({}, 2);
  const visited = [];
  await assert.rejects(traverse({ writer: f.writer, onVisit: (pageNo) => visited.push(pageNo) }), /disk full/);
  assert.deepEqual(visited, [1, 2]);
  const checkpoint = f.stored.get(path.join(f.files.runDir, "list-checkpoint.json"));
  assert.deepEqual(checkpoint.savedPages, [1]);
  assert.equal(f.events.length, 1);
  assert.ok(f.stored.has(path.join(f.files.runDir, "list-pages", "page-000002.json")), "uncommitted raw page can still be recovered without claiming a committed page");
});

test("reverse traversal reports only the saved reverse prefix and preserves the pacing budget", async () => {
  const f = fixture({ pageOrder: "reverse" });
  const result = await traverse({ writer: f.writer, pageOrder: "reverse", failPage: -1, pageEnd: 3 });
  assert.deepEqual(result.rotations, [3, 2, 1]);
  assert.deepEqual(result.waits, [120000, 120000]);
  assert.deepEqual(f.events.map((event) => event.savedCheckpoint.savedThroughPage), [3, 2, 1]);
  assert.equal(f.events.at(-1).savedCheckpoint.pageOrder, "desc");
});

test("a first-page failure does not claim saved list data", async () => {
  const f = fixture();
  await assert.rejects(traverse({ writer: f.writer, failPage: 1 }), /page 1/);
  assert.equal(f.stored.size, 0);
  assert.equal(f.events.length, 0);
});

test("inventory skips page pacing including the first page of a resumed cycle", async () => {
  for (const pageOrder of ["forward", "reverse"]) {
    const f = fixture();
    const result = await traverse({ writer: f.writer, collectionKind: "inventory", pageOrder,
      waitBeforeFirstPage: true, failPage: -1, pageEnd: 3 });
    assert.deepEqual(result.waits, []);
    assert.equal(f.events.length, 3);
  }
});

test("out-of-order overlapping saves do not claim a missing prefix", async () => {
  const f = fixture();
  const saved = await Promise.all([f.writer.savePage(page(2)), f.writer.savePage(page(1))]);
  assert.equal(saved[0].savedThroughPage, null);
  assert.equal(saved[1].savedThroughPage, 2);
  assert.deepEqual(saved[1].savedPages, [1, 2]);
  await assert.rejects(f.writer.savePage(page(0)), /페이지 번호/);
});

async function verifyCollectionBlock(statusCode, failingLogin = 2) {
  const filename = path.join(__dirname, "../src/malls/cheonyu/index.js");
  const source = await fs.readFile(filename, "utf8");
  const realRequire = createRequire(filename);
  const f = fixture();
  const contexts = [];
  let loginCount = 0;
  let browserClosed = false;
  const browser = {
    async newContext() {
      const context = new EventEmitter();
      context.newPage = async () => ({ context: () => context });
      context.close = async () => { context.closed = true; };
      contexts.push(context);
      return context;
    },
    async close() { browserClosed = true; },
  };
  const overrides = {
    "../../utils/browser": {
      bindAbortToBrowser: () => () => {}, installDialogAutoAccept() {},
      getLightweightLaunchArgs: () => [],
      installLightweightNetworkPolicy: async () => ({ configurePage: async () => {} }),
    },
    "../../utils/network-usage": {
      createNetworkUsageTracker: () => ({ trackContext: async () => {}, trackPage: async () => {}, finishAndLog: async () => {} }),
    },
    "./logger": { logCheonyuInfo() {}, logCheonyuWarn() {}, logCheonyuError() {}, logCheonyuSuccess() {} },
    "./site": {
      resetCheonyuPopupWorkloadTracker() {},
      async loginCheonyu(browserPage) {
        if (++loginCount !== failingLogin) return {};
        browserPage.context().emit("response", {
          status: () => statusCode, url: () => "https://www.cheonyu.com/member/login.html",
          request: () => ({ resourceType: () => "document" }),
        });
        const error = new Error("browser aborted after HTTP block");
        error.name = "AbortError";
        throw error;
      },
      async bulkAddPages(browserPage, _config, _progress, _signal, options) {
        await options.onListPage(page(1));
        await options.rotatePage({ currentPage: browserPage, pageNo: 2, forceRestart: true });
        throw new Error("must stop at blocked replacement login");
      },
    },
  };
  const sandbox = {
    require: (id) => overrides[id] || realRequire(id), module: { exports: {} },
    URL, AbortController, AbortSignal, console, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { filename });
  const config = {
    mall: "cheonyu", collectionMode: "detail", baseUrl: "https://www.cheonyu.com",
    pageStart: 1, pageEnd: 12, showBrowser: true, headless: false,
    proxy: { server: "http://first.invalid:12323" },
    proxyRotation: [{ proxy: { server: "http://first.invalid:12323" } }, { proxy: { server: "http://second.invalid:12323" } }],
  };
  await assert.rejects(sandbox.module.exports.runCheonyu(config, {
    browserType: { launch: async () => browser }, onListPage: (payload) => f.writer.savePage(payload),
  }), (error) => {
    assert.equal(error.code, statusCode === 407 ? "PROXY_AUTHENTICATION_REQUIRED" : "SITE_ACCESS_BLOCKED");
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.retryable, false);
    assert.notEqual(error.name, "AbortError");
    if (statusCode === 407) assert.match(error.message, /프록시 인증/);
    return true;
  });
  assert.equal(contexts.length, failingLogin);
  assert.equal(loginCount, failingLogin);
  assert.ok(contexts.every((context) => context.closed));
  assert.equal(browserClosed, true);
  if (failingLogin === 2) assert.equal(f.events.at(-1).savedCheckpoint.savedThroughPage, 1);
  else assert.equal(f.events.length, 0);
}

for (const statusCode of [403, 429]) {
  test(`a block in a replacement login context preserves HTTP ${statusCode} instead of becoming user cancellation`, async () => {
    await verifyCollectionBlock(statusCode);
  });
}
for (const failingLogin of [1, 2]) {
  test(`observed HTTP 407 in ${failingLogin === 1 ? "initial" : "replacement"} login stops with a proxy authentication cause`, async () => {
    await verifyCollectionBlock(407, failingLogin);
  });
}

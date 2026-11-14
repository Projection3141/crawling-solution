const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  createDetailCheckpointWriter, writeJsonAtomically, getCompletedCyclePages,
} = require("../src/utils/detail-checkpoint");
const { collectCcdomeDetails } = require("../src/malls/ccdome/detail");

function fixture(overrides = {}) {
  const stored = new Map();
  const events = [];
  const calls = [];
  const runDir = path.resolve("checkpoint-test-fixture");
  const files = { runDir, resultJson: path.join(runDir, "result.json"), detailResultJson: path.join(runDir, "detailResult.json") };
  const options = {
    config: { mall: "cheonyu", pageStart: 1, pageEnd: 3 }, files,
    createBackendProducts: async ({ detailItems }) => detailItems.map((item) => ({ id: item.productId, nameKo: item.productName })),
    updateProductArchive: async (products, options) => { calls.push(options); return { currentProducts: products }; },
    getConversionSnapshot: async () => null,
    getGeneralProducts: () => [{ id: "general-only", stockQuantity: 7 }],
    onProgress: (event) => events.push(event),
    writeJson: async (file, data) => { stored.set(file, structuredClone(data)); },
    ...overrides,
  };
  return { writer: createDetailCheckpointWriter(options), stored, events, calls, files };
}

function page(pageNo) {
  return {
    pageNo, pageRange: { pageStart: 1, pageEnd: 3 },
    products: [{ page: pageNo, productId: String(pageNo) }],
    inventoryItems: [],
    detailItems: [{ productId: String(pageNo), productName: `상품 ${pageNo}` }],
  };
}

test("completed detail pages survive a later page failure and preserve general products", async () => {
  let recordOutcomesCalls = 0;
  const f = fixture({
    recordDetailOutcomes: () => { recordOutcomesCalls++; },
    createBackendProducts: async ({ detailItems }) => {
      if (detailItems[0].productId === "2") throw new Error("page 2 failed");
      return detailItems.map((item) => ({ id: item.productId, nameKo: item.productName }));
    },
  });
  await f.writer.savePage(page(1));
  await assert.rejects(f.writer.savePage(page(2)), /page 2 failed/);
  assert.deepEqual(f.stored.get(f.files.resultJson).map((item) => item.id), ["general-only", "1"]);
  assert.deepEqual(f.stored.get(f.files.detailResultJson).map((item) => item.id), ["1"]);
  const checkpoint = f.stored.get(path.join(f.files.runDir, "detail-checkpoint.json"));
  assert.equal(checkpoint.savedThroughPage, 1);
  assert.deepEqual(checkpoint.savedPages, [1]);
  assert.equal(f.events.length, 1);
  assert.equal(recordOutcomesCalls, 0, "checkpoint must not make pending mode skip untranslated data");
  assert.ok(f.stored.has(path.join(f.files.runDir, "detail-pages", "page-000002.json")), "raw data remains recoverable even when archive conversion fails");
});

test("out-of-order and reverse page saves never claim an unsaved contiguous prefix", async () => {
  const f = fixture();
  assert.equal((await f.writer.savePage(page(3))).savedThroughPage, null);
  assert.equal((await f.writer.savePage(page(1))).savedThroughPage, 1);
  const checkpoint = await f.writer.savePage(page(2));
  assert.equal(checkpoint.savedThroughPage, 3);
  assert.deepEqual(checkpoint.savedPages, [1, 2, 3]);
  assert.equal(f.stored.get(f.files.detailResultJson).length, 3);
  const reverse = fixture({ config: { mall: "cheonyu", pageOrder: "reverse", pageStart: 1, pageEnd: 3 } });
  const last = await reverse.writer.savePage(page(3));
  assert.equal(last.savedThroughPage, 3);
  assert.equal(last.pageOrder, "desc");
});

test("a failed checkpoint commit does not advertise another saved page", async () => {
  const disk = new Map();
  let manifests = 0;
  const f = fixture({ writeJson: async (file, data) => {
    if (file.endsWith("detail-checkpoint.json") && ++manifests === 2) throw new Error("disk full");
    disk.set(file, structuredClone(data));
  } });
  await f.writer.savePage(page(1));
  await assert.rejects(f.writer.savePage(page(2)), /disk full/);
  assert.equal(f.events.length, 1);
  assert.equal(disk.get(path.join(f.files.runDir, "detail-checkpoint.json")).savedThroughPage, 1);
  assert.ok(disk.has(path.join(f.files.runDir, "detail-pages", "page-000001.json")));
});

test("overlapping page completions are committed in order", async () => {
  const f = fixture();
  const checkpoints = await Promise.all([f.writer.savePage(page(1)), f.writer.savePage(page(2))]);
  assert.deepEqual(checkpoints.map((item) => item.savedPages), [[1], [1, 2]]);
  assert.deepEqual(f.events.map((item) => item.savedCheckpoint.savedThroughPage), [1, 2]);
  assert.ok(f.calls.every((options) => options.source === "detail"));
});

test("a partial cycle last page is excluded until the remainder is saved", () => {
  const products = [{ page: 1 }, { page: 2 }, { page: 2 }];
  assert.deepEqual(getCompletedCyclePages(products, { collectedLastPage: 2, resumePage: 2, stopReason: "limit-reached" }), [1]);
  assert.deepEqual(getCompletedCyclePages(products, { collectedLastPage: 2, resumePage: 3, stopReason: "limit-reached" }), [1, 2]);
});

test("atomic detail snapshots replace complete JSON and leave no temporary files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "detail-checkpoint-"));
  try {
    const file = path.join(directory, "checkpoint.json");
    await writeJsonAtomically(file, { savedPages: [1] });
    await writeJsonAtomically(file, { savedPages: [1, 2] });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { savedPages: [1, 2] });
    assert.deepEqual(await fs.readdir(directory), ["checkpoint.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function ccdomePage() {
  return {
    on() {}, async goto() { return { ok: () => true }; },
    async waitForSelector() {}, async waitForFunction() {}, async waitForTimeout() {},
    async content() { return '<div class="goods_view"></div>'; },
    async evaluate() { return { mainImageUrls: ["https://fixture.invalid/image.jpg"], introImageUrls: [], diagnostics: {}, salePriceText: "1000", brandText: "" }; },
    async close() {},
  };
}
const ccdomeConfig = { mall: "ccdome", baseUrl: "https://fixture.invalid", detailConcurrency: 1, detailRequestDelayMs: 0 };
const ccdomeProduct = (id, pageNo) => ({ productId: id, page: pageNo, productName: id, productUrl: `https://fixture.invalid/${id}` });

test("ccdome publishes a page only when all its targets finish, retaining it on later cancellation", async () => {
  const controller = new AbortController();
  const saved = [];
  const context = { newPage: async () => ccdomePage() };
  await assert.rejects(collectCcdomeDetails({ context: () => context }, [
    ccdomeProduct("a", 1), ccdomeProduct("b", 1), ccdomeProduct("c", 2),
  ], ccdomeConfig, (progress) => {
    if (progress.productId === "c") controller.abort();
  }, controller.signal, async (data) => saved.push(data)), /취소/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pageNo, 1);
  assert.deepEqual(saved[0].detailItems.map((item) => item.productId), ["a", "b"]);
});

test("ccdome drains an in-flight page save before returning another worker failure", async () => {
  let releaseFirst;
  const firstSave = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted;
  const failedSave = new Promise((resolve) => { secondStarted = resolve; });
  let settled = false;
  let firstFinished = false;
  const context = { newPage: async () => ccdomePage() };
  const collecting = collectCcdomeDetails({ context: () => context }, [
    ccdomeProduct("a", 1), ccdomeProduct("b", 2),
  ], { ...ccdomeConfig, detailConcurrency: 2 }, () => {}, undefined, async ({ pageNo }) => {
    if (pageNo === 1) { await firstSave; firstFinished = true; }
    else { secondStarted(); throw new Error("checkpoint write failed"); }
  });
  collecting.then(() => { settled = true; }, () => { settled = true; });
  await failedSave;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseFirst();
  await assert.rejects(collecting, /checkpoint write failed/);
  assert.equal(firstFinished, true);
});

async function runCheonyuDetailLoop(failPage, onDetailPage) {
  const source = (await fs.readFile(path.join(__dirname, "../src/malls/cheonyu/index.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("      let completedDetailTargetCount = 0;");
  const end = source.indexOf("      throwIfAborted(runSignal);\n    }", start);
  // Execute the actual orchestration block; browser and network operations are replaced.
  assert.ok(start >= 0 && end > start);
  const targets = [1, 2, 3].map((pageNo) => ({ productId: String(pageNo), page: pageNo }));
  const groups = new Map(targets.map((target) => [target.page, [target]]));
  const inventoryItems = targets.map((target) => ({ ...target, stockQuantity: 1 }));
  const savedCalls = [];
  const sandbox = {
    detailPageGroups: groups, detailTargets: targets, detailItems: [], inventoryItems,
    pageRange: { pageStart: 1, pageEnd: 3 }, config: { mall: "cheonyu" },
    page: {}, startedAt: 0, performance: { now: () => 1 }, runSignal: undefined,
    throwIfAborted() {}, onProgress() {},
    async rotateCheonyuProxyPage({ pageNo }) {
      if (pageNo === failPage) throw new Error(`login failed at page ${pageNo}`);
      return {};
    },
    async collectCheonyuDetails(_page, products) {
      return products.map((product) => ({ ...product, productName: "수집 완료" }));
    },
    async onDetailPage(payload) { savedCalls.push(payload); await onDetailPage(payload); },
  };
  await assert.rejects(vm.runInNewContext(`(async () => {${source.slice(start, end)}})()`, sandbox), /login failed/);
  return savedCalls;
}

test("cheonyu saves the completed first page before next-page login fails", async () => {
  const f = fixture();
  const calls = await runCheonyuDetailLoop(2, (payload) => f.writer.savePage(payload));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pageNo, 1);
  assert.deepEqual(Array.from(calls[0].inventoryItems, (item) => item.productId), ["1"]);
  assert.deepEqual(f.stored.get(f.files.detailResultJson).map((item) => item.id), ["1"]);
  assert.equal(f.events[0].savedCheckpoint.savedThroughPage, 1);
});

test("cheonyu first-page login failure does not claim any saved detail page", async () => {
  const f = fixture();
  assert.equal((await runCheonyuDetailLoop(1, (payload) => f.writer.savePage(payload))).length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.stored.size, 0);
});

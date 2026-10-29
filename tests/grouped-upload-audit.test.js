const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const {
  requestJsonWithAudit,
  setResultUploadLogRoot,
} = require("../src/utils/result-uploader");

const groups = {
  cheonyu: [{ id: "same" }, { id: "c2" }],
  ccdome: [{ id: "same" }, { id: "d2" }],
  futureMall: [{ id: "f1" }, { id: "f2" }],
};

// Electron을 실행하지 않고 앱에서 사용하는 순수 요약 함수만 검사한다.
async function loadSummaryFunction() {
  const source = await fs.readFile(path.resolve(__dirname, "../electron/main.js"), "utf8");
  const start = source.indexOf("function summarizeCollectionUploadLog(");
  const end = source.indexOf("async function listCollectionUploadLogs(", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInThisContext(`(${source.slice(start, end).trim()})`);
}

async function captureAudit(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grouped-upload-audit-"));
  setResultUploadLogRoot(root);
  t.after(async () => {
    setResultUploadLogRoot("");
    // mkdtemp가 반환한 전용 임시 디렉터리만 삭제한다.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("grouped-upload-audit-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  let sent;
  let result;
  let error;
  const { fail = false, response = {}, ...request } = options;
  try {
    result = await requestJsonWithAudit({
      type: "아카이브",
      url: "https://audit.invalid/upload",
      payload: { type: "아카이브", data: groups },
      ...request,
      fetchImpl: async (url, init) => {
        sent = { url, ...init };
        return {
          ok: !fail,
          status: fail ? 503 : 200,
          text: async () => JSON.stringify(response),
        };
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(Boolean(error), fail);
  const log = JSON.parse(await fs.readFile((error || result).auditLogPath, "utf8"));
  return { log, sent };
}

test("grouped archive audit counts all malls and preserves actual body", async (t) => {
  const { log, sent } = await captureAudit(t);
  assert.equal(log.itemCount, 6);
  assert.deepEqual(log.sampleIds, ["same", "c2", "same", "d2", "f1"]);
  assert.deepEqual(log.request, JSON.parse(sent.body));
  assert.deepEqual(log.request.data, groups);
  const summarize = await loadSummaryFunction();
  const summary = summarize(log, "20261004", "test.json");
  assert.equal(summary.itemCount, 6);
  assert.deepEqual(summary.sampleProductIds, log.sampleIds);
});

test("failed grouped archive upload still logs the attempted product count", async (t) => {
  const { log } = await captureAudit(t, { fail: true });
  assert.equal(log.success, false);
  assert.equal(log.itemCount, 6);
  assert.equal(log.response.status, 503);
  assert.deepEqual(log.sampleIds, ["same", "c2", "same", "d2", "f1"]);
});

test("empty mall arrays count zero products", async (t) => {
  const { log } = await captureAudit(t, {
    payload: { type: "아카이브", data: { cheonyu: [], ccdome: [] } },
  });
  assert.equal(log.itemCount, 0);
  assert.deepEqual(log.sampleIds, []);
});

test("legacy flat product and raw shipping bodies retain their counts", async (t) => {
  for (const payload of [
    { type: "아카이브", data: [{ productId: "p1" }, { product_id: "p2" }] },
    [{ id: "shipping1", mft_itemName: "test item" }],
  ]) {
    await t.test(Array.isArray(payload) ? "shipping" : "flat archive", async (subtest) => {
      const { log } = await captureAudit(subtest, {
        type: Array.isArray(payload) ? "운송장" : "아카이브",
        payload,
      });
      assert.equal(log.itemCount, Array.isArray(payload) ? 1 : 2);
      assert.deepEqual(log.sampleIds, Array.isArray(payload) ? ["shipping1"] : ["p1", "p2"]);
    });
  }
});

test("GET audit still counts validated response items", async (t) => {
  const { log, sent } = await captureAudit(t, {
    type: "장바구니 요청",
    method: "GET",
    payload: undefined,
    response: { products: [{ id: "cart1" }, { id: "cart2" }] },
    validateResponse: (response) => response.products,
  });
  assert.equal(sent.body, undefined);
  assert.equal(log.request, null);
  assert.equal(log.itemCount, 2);
  assert.deepEqual(log.sampleIds, ["cart1", "cart2"]);
});

test("manual test event does not become a product group", async (t) => {
  const { log } = await captureAudit(t, {
    type: "테스트",
    payload: { type: "테스트", data: { event: "connection-test", details: [{ id: "not-a-product" }] } },
  });
  assert.equal(log.itemCount, null);
  assert.deepEqual(log.sampleIds, []);
  const summarize = await loadSummaryFunction();
  assert.equal(summarize(log, "20261004", "test.json").itemCount, 0);
});

test("explicit audit metadata remains authoritative", async (t) => {
  const { log } = await captureAudit(t, { itemCount: 42, sampleIds: [123] });
  assert.equal(log.itemCount, 42);
  assert.deepEqual(log.sampleIds, ["123"]);
  const summarize = await loadSummaryFunction();
  const summary = summarize(log, "20261004", "test.json");
  assert.equal(summary.itemCount, 42);
  assert.deepEqual(summary.sampleProductIds, ["123"]);
});

test("log UI recovers grouped counts and IDs when audit metadata is absent", async () => {
  const summarize = await loadSummaryFunction();
  const summary = summarize({ request: { type: "아카이브", data: groups } }, "20261004", "legacy.json");
  assert.equal(summary.type, "아카이브");
  assert.equal(summary.itemCount, 6);
  assert.deepEqual(summary.sampleProductIds, ["same", "c2", "same", "d2", "f1"]);
});

test("log UI retains legacy flat, raw shipping, and GET metadata behavior", async () => {
  const summarize = await loadSummaryFunction();
  const flat = summarize({ request: { type: "아카이브", data: [{ id: "p1" }] } }, "20261004", "flat.json");
  const shipping = summarize({ type: "운송장", request: [{ id: "s1" }] }, "20261004", "shipping.json");
  const get = summarize({ type: "장바구니 요청", method: "GET", request: null, itemCount: 2, sampleIds: ["g1", "g2"] }, "20261004", "get.json");
  assert.equal(flat.itemCount, 1);
  assert.deepEqual(flat.sampleProductIds, ["p1"]);
  assert.equal(shipping.itemCount, 1);
  assert.deepEqual(shipping.sampleProductIds, ["s1"]);
  assert.equal(get.itemCount, 2);
  assert.deepEqual(get.sampleProductIds, ["g1", "g2"]);
});

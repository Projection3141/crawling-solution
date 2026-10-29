const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 실제 아카이브를 읽거나 이관하지 않도록 모듈 로드 전에 전용 임시 경로를 지정한다.
const directory = syncFs.mkdtempSync(path.join(os.tmpdir(), "grouped-product-test-"));
const previous = process.env.PRODUCT_ARCHIVE_DIRECTORY;
process.env.PRODUCT_ARCHIVE_DIRECTORY = directory;
const { createProductUploadScheduler } = require("../src/product-upload-scheduler");
const { ARCHIVE_PATH, archiveToMallGroups } = require("../src/utils/product-archive");
const { createProduct } = require("../src/utils/product-schema");
if (previous === undefined) delete process.env.PRODUCT_ARCHIVE_DIRECTORY;
else process.env.PRODUCT_ARCHIVE_DIRECTORY = previous;
after(async () => {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith("grouped-product-test-"));
  await fs.rm(directory, { recursive: true, force: true });
});

const groups = () => ({
  cheonyu: [{ id: "95371", sourceMall: "cheonyu", categoryId: "152", stockQuantity: 0, saleStatus: "HIDDEN", special: null,
    options: [{ id: "7", stockQuantity: 0 }], category: { depth1: "패션잡화", depth2: null } }],
  ccdome: [{ id: "1000005467", sourceMall: "ccdome", categoryId: "021001" }],
  newmall: [{ id: "95371", sourceMall: "newmall" }],
  empty_mall: [],
});

async function until(predicate) {
  for (let i = 0; i < 10000; i += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("전송 완료 대기 초과");
}

let fixtureNumber = 0;
async function fixture(t, overrides = {}, saved = null) {
  const statePath = path.join(directory, `state-${++fixtureNumber}.json`);
  if (saved) await fs.writeFile(statePath, JSON.stringify(saved));
  const calls = [];
  const scheduler = createProductUploadScheduler({
    statePath, getDestination: () => "https://fixture.invalid/upload",
    readProducts: async () => groups(),
    uploadProducts: async (data, options) => { calls.push({ data, options }); },
    ...overrides,
  });
  t.after(() => scheduler.stop());
  await scheduler.start();
  return { scheduler, calls, statePath, readState: async () => JSON.parse(await fs.readFile(statePath, "utf8")) };
}

test("완료 시 그룹 구조·추가 쇼핑몰·빈 배열·필드·동일 ID를 그대로 보관하고 전송한다", async (t) => {
  const source = groups();
  const f = await fixture(t, { readProducts: async () => source });
  assert.equal(f.calls.length, 0);
  await f.scheduler.setEnabled(false);
  await f.scheduler.notifyCollectionCompleted();
  assert.equal(f.scheduler.getState().pendingProductCount, 3);
  const saved = await f.readState();
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.pending.data, source);
  assert.equal(saved.pending.products, undefined);
  source.cheonyu[0].stockQuantity = 999;
  await f.scheduler.setEnabled(true);
  await until(() => !f.scheduler.getState().running);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].data, groups());
  assert.equal((await f.readState()).pending, null);
});

test("실제 아카이브 읽기부터 HTTP JSON 생성까지 data가 저장된 그룹 객체와 같다", async (t) => {
  const internal = {
    mallNames: ["cheonyu", "ccdome", "future_empty"],
    products: {
      "cheonyu:95371": { ...createProduct("95371"), sourceMall: "cheonyu", stockQuantity: 0, saleStatus: "HIDDEN" },
      "ccdome:1000005467": { ...createProduct("1000005467"), sourceMall: "ccdome", categoryId: "021001" },
    },
  };
  const archiveJson = JSON.parse(JSON.stringify(archiveToMallGroups(internal)));
  assert.equal(path.dirname(ARCHIVE_PATH), directory);
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(archiveJson));
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, ...init };
    return { status: 200, ok: true, text: async () => '{"ok":true}' };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = await fixture(t, { readProducts: undefined, uploadProducts: undefined });
  await f.scheduler.notifyCollectionCompleted();
  await until(() => !f.scheduler.getState().running);
  assert.ok(sent);
  assert.deepEqual(JSON.parse(sent.body), { type: "아카이브", data: archiveJson });
  assert.equal(sent.headers["Content-Encoding"], undefined);
  assert.match(sent.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(await fs.readFile(ARCHIVE_PATH, "utf8")), archiveJson);
});

test("v1의 평면 대기 데이터를 새 수집 없이 그룹으로 이관하며 OFF도 보존한다", async (t) => {
  const legacy = { version: 1, enabled: false, pending: {
    id: "old-pending", url: "https://fixture.invalid/upload", archiveRef: "fixture-archive",
    products: Object.values(groups()).flat(),
  } };
  const f = await fixture(t, { readProducts: async () => assert.fail("복구 중 현재 아카이브 읽기") }, legacy);
  assert.equal(f.calls.length, 0);
  assert.equal(f.scheduler.getState().enabled, false);
  assert.equal(f.scheduler.getState().pendingProductCount, 3);
  await f.scheduler.setEnabled(true);
  await until(() => !f.scheduler.getState().running);
  const expected = groups();
  delete expected.empty_mall; // v1 배열에는 빈 추가 쇼핑몰에 대한 정보가 없었다.
  assert.deepEqual(f.calls[0].data, expected);
  assert.equal((await f.readState()).version, 2);
});

test("v2 대기는 앱 재시작에서 쇼핑몰 객체 그대로 복구한다", async (t) => {
  const f = await fixture(t, { readProducts: async () => assert.fail("복구 중 재수집") }, {
    version: 2, enabled: true, pending: { id: "grouped", url: "https://fixture.invalid/upload", data: groups() },
  });
  await until(() => !f.scheduler.getState().running);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].data, groups());
});

test("구형 빈 대기 배열도 기본 쇼핑몰 빈 배열을 포함한 객체로 전송한다", async (t) => {
  const f = await fixture(t, {}, { version: 1, enabled: true,
    pending: { id: "empty", url: "https://fixture.invalid/upload", products: [] } });
  await until(() => !f.scheduler.getState().running);
  assert.deepEqual(f.calls[0].data, { cheonyu: [], ccdome: [] });
});

test("실패한 그룹 본문은 60분 뒤 같은 데이터로 재시도하고 성공 후 반복하지 않는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const source = groups();
  const f = await fixture(t, {
    readProducts: async () => source,
    uploadProducts: async (data) => { calls.push(data); if (calls.length === 1) throw new Error("HTTP 503"); },
  });
  await f.scheduler.notifyCollectionCompleted();
  await until(() => !f.scheduler.getState().running);
  assert.equal(f.scheduler.getState().pendingProductCount, 3);
  source.cheonyu = [];
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(f.scheduler.getState().running, false);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(50 * 60 * 1000 - 1);
  assert.equal(f.scheduler.getState().running, false);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.scheduler.getState().running, true);
  await until(() => !f.scheduler.getState().running);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.scheduler.getState().pending, false);
  t.mock.timers.tick(3600000);
  assert.equal(f.scheduler.getState().running, false);
  assert.equal(calls.length, 2);
});

test("전송 중 새 그룹 데이터는 최신 대기로 남고 이전 성공으로 삭제되지 않는다", async (t) => {
  const calls = [];
  let finish;
  let source = groups();
  const f = await fixture(t, {
    readProducts: async () => source,
    uploadProducts: async (data) => {
      calls.push(data);
      if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
    },
  });
  await f.scheduler.notifyCollectionCompleted();
  await until(() => Boolean(finish));
  source = { cheonyu: [], ccdome: [], nextmall: [{ id: "42", sourceMall: "nextmall" }] };
  await f.scheduler.notifyCollectionCompleted();
  assert.deepEqual((await f.readState()).pending.data, source);
  finish();
  await until(() => !f.scheduler.getState().running && !f.scheduler.getState().pending);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], source);
});

test("손상된 그룹과 출처 불일치는 요청을 보내지 않고 복원 오류로 표시한다", async (t) => {
  for (const data of [[], { cheonyu: {} }, { cheonyu: [{ id: "1", sourceMall: "ccdome" }] }]) {
    const f = await fixture(t, {}, { version: 2, enabled: true,
      pending: { id: "bad", url: "https://fixture.invalid/upload", data } });
    assert.equal(f.calls.length, 0);
    assert.match(f.scheduler.getState().lastError, /복원 실패/);
  }
});

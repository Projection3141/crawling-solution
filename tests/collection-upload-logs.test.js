const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { listCollectionUploadLogs } = require("../electron/collection-upload-logs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "collection-upload-logs-test-"));
  const root = path.join(directory, "collection-upload-logs");
  t.after(async () => {
    // 이 테스트가 만든 전용 임시 폴더만 정리한다.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("collection-upload-logs-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return root;
}

async function writeLog(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content ?? JSON.stringify({
    success: true,
    request: { type: "아카이브", data: { cheonyu: [{ id: relativePath }] } },
    response: { status: 200 },
  }));
  return filePath;
}

test("날짜·파일명 내림차순으로 JSON 로그를 5개씩 조회하고 페이지 범위를 보정한다", async (t) => {
  const root = await fixture(t);
  const expected = [
    "20261029/190000.json", "20261029/180000.JSON", "20261029/170000.json",
    "20261029/160000.json", "20261028/130000.json", "20261028/120000.json",
    "20261028/110000.json",
  ];
  for (const relativePath of [...expected].reverse()) await writeLog(root, relativePath);
  for (const relativePath of [
    "root.json", "notes/200000.json", "2026102/200000.json",
    "20261029/200000.txt", "20261029/nested.json/200000.json",
  ]) await writeLog(root, relativePath);

  const first = await listCollectionUploadLogs(root);
  assert.equal(first.root, root);
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 5);
  assert.equal(first.totalCount, 7);
  assert.equal(first.totalPages, 2);
  assert.deepEqual(first.items.map(item => item.sampleProductIds[0]), expected.slice(0, 5));
  assert.ok(first.items.every(item => item.success && item.itemCount === 1 && item.status === 200));

  for (const page of [2, 999, "2tail"]) {
    const last = await listCollectionUploadLogs(root, { page });
    assert.equal(last.page, 2);
    assert.deepEqual(last.items.map(item => item.sampleProductIds[0]), expected.slice(5));
  }
  for (const payload of [null, {}, { page: 0 }, { page: -1 }, { page: "invalid" }]) {
    const result = await listCollectionUploadLogs(root, payload);
    assert.equal(result.page, 1);
    assert.deepEqual(result.items, first.items);
  }
});

test("로그 폴더가 없어도 생성하고 빈 첫 페이지를 반환한다", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await listCollectionUploadLogs(root, { page: 999 }), {
    page: 1, pageSize: 5, totalCount: 0, totalPages: 1, items: [], root,
  });
  assert.equal((await fs.stat(root)).isDirectory(), true);
});

test("손상된 JSON과 개별 읽기 실패를 오류 행으로 보존하고 나머지 로그를 반환한다", async (t) => {
  const root = await fixture(t);
  await writeLog(root, "20261029/190000.json", '{"request":');
  const unreadable = await writeLog(root, "20261029/180000.json");
  await writeLog(root, "20261029/170000.json");
  const readFile = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === unreadable) throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
    return readFile(file, ...args);
  });

  const result = await listCollectionUploadLogs(root);
  assert.equal(result.totalCount, 3);
  assert.equal(result.items.length, 3);
  for (const [index, fileName] of ["190000.json", "180000.json"].entries()) {
    const item = result.items[index];
    assert.equal(typeof item.error, "string");
    assert.ok(item.error.length > 0);
    assert.deepEqual(item, {
      dateDirectory: "20261029", fileName, sentAt: null, success: false,
      type: "로그 읽기 실패", itemCount: null, uploadApiUrl: "", status: null,
      error: item.error, sampleProductIds: [],
    });
  }
  assert.equal(result.items[1].error, "fixture read denied");
  assert.equal(result.items[2].success, true);
});

test("선택한 페이지의 본문만 읽고 다른 페이지의 손상 로그는 읽지 않는다", async (t) => {
  const root = await fixture(t);
  await writeLog(root, "20261029/100000.json", "invalid JSON");
  for (const hour of [11, 12, 13, 14, 15]) await writeLog(root, `20261029/${hour}0000.json`);
  const readFile = fs.readFile;
  const reads = [];
  t.mock.method(fs, "readFile", async (file, ...args) => {
    reads.push(path.basename(file));
    return readFile(file, ...args);
  });

  const first = await listCollectionUploadLogs(root);
  assert.equal(first.totalCount, 6);
  assert.equal(first.items.length, 5);
  assert.ok(first.items.every(item => item.success));
  assert.deepEqual(reads.sort(), ["110000.json", "120000.json", "130000.json", "140000.json", "150000.json"]);
  const second = await listCollectionUploadLogs(root, { page: 2 });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].type, "로그 읽기 실패");
  assert.equal(reads[reads.length - 1], "100000.json");
});

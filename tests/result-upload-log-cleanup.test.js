const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  cleanupResultUploadLogs,
  RESULT_UPLOAD_LOG_RETENTION_MS,
} = require("../src/utils/result-upload-log-cleanup");
const { requestJsonWithAudit, setResultUploadLogRoot } = require("../src/utils/result-uploader");

const NOW = Date.parse("2026-10-19T12:00:00+09:00");
const CUTOFF = NOW - RESULT_UPLOAD_LOG_RETENTION_MS;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "upload-log-cleanup-"));
  const root = path.join(directory, "collection-upload-logs");
  await fs.mkdir(root);
  t.after(async () => {
    // 이 테스트가 만든 전용 임시 폴더만 삭제한다.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("upload-log-cleanup-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root };
}

async function writeFile(root, relativePath, modifiedAt, content = "{}") {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await fs.utimes(file, new Date(modifiedAt), new Date(modifiedAt));
  return file;
}

test("7일 경계 이전·정각 로그와 손상된 로그를 삭제하고 최근·미래 로그는 보존한다", async (t) => {
  const { root } = await fixture(t);
  const expired = await writeFile(root, "20261011/120000-000.json", CUTOFF - 1000, '{"request":"unfinished');
  const boundary = await writeFile(root, "20261012/120000-000-1.json", CUTOFF);
  const recent = await writeFile(root, "20261012/120000-001.json", CUTOFF + 1000);
  const future = await writeFile(root, "20261020/120000-000.json", NOW + 86400000);

  assert.equal(await cleanupResultUploadLogs(root, { now: NOW }), 2);
  await assert.rejects(fs.stat(expired), { code: "ENOENT" });
  await assert.rejects(fs.stat(boundary), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, "20261011")), { code: "ENOENT" });
  assert.equal(await fs.readFile(recent, "utf8"), "{}");
  assert.equal(await fs.readFile(future, "utf8"), "{}");
  assert.equal(await cleanupResultUploadLogs(root, { now: NOW }), 0);
});

test("날짜 폴더의 전송 로그만 정리하고 대기 파일·아카이브·하위 폴더·junction은 보존한다", async (t) => {
  const { directory, root } = await fixture(t);
  const retained = await Promise.all([
    writeFile(root, "product-upload-state.json", CUTOFF),
    writeFile(root, "archive/120000-000.json", CUTOFF),
    writeFile(root, "20261011/notes.txt", CUTOFF),
    writeFile(root, "20261011/product-upload-state.json", CUTOFF),
    writeFile(root, "20261011/nested/120000-000.json", CUTOFF),
    writeFile(directory, "outside/120000-000.json", CUTOFF),
  ]);
  await fs.symlink(path.join(directory, "outside"), path.join(root, "20261010"), "junction");
  await writeFile(root, "20261011/120000-000.json", CUTOFF);

  assert.equal(await cleanupResultUploadLogs(root, { now: NOW }), 1);
  for (const file of retained) assert.equal(await fs.readFile(file, "utf8"), "{}");
  assert.equal((await fs.lstat(path.join(root, "20261010"))).isSymbolicLink(), true);
});

test("파일 삭제 실패가 나머지 로그 정리를 막지 않는다", async (t) => {
  const { root } = await fixture(t);
  const locked = await writeFile(root, "20261011/120000-000.json", CUTOFF);
  const removable = await writeFile(root, "20261011/130000-000.json", CUTOFF);
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (file) => {
    if (file === locked) throw Object.assign(new Error("locked"), { code: "EPERM" });
    return unlink(file);
  });
  const warning = t.mock.method(console, "warn", () => {});

  assert.equal(await cleanupResultUploadLogs(root, { now: NOW }), 1);
  assert.equal(await fs.readFile(locked, "utf8"), "{}");
  await assert.rejects(fs.stat(removable), { code: "ENOENT" });
  assert.equal(warning.mock.callCount(), 1);
});

test("로그 폴더가 없거나 기준 시각이 잘못돼도 앱 시작을 막거나 파일을 삭제하지 않는다", async (t) => {
  const { root } = await fixture(t);
  const file = await writeFile(root, "20261011/120000-000.json", CUTOFF);
  assert.equal(await cleanupResultUploadLogs(path.join(root, "missing"), { now: NOW }), 0);
  assert.equal(await cleanupResultUploadLogs("", { now: NOW }), 0);
  assert.equal(await cleanupResultUploadLogs(root, { now: NaN }), 0);
  assert.equal(await fs.readFile(file, "utf8"), "{}");
});

test("실제 요청 이력 작성기가 만든 로그에도 보관 기간이 적용된다", async (t) => {
  const { root } = await fixture(t);
  setResultUploadLogRoot(root);
  t.after(() => setResultUploadLogRoot(""));
  const result = await requestJsonWithAudit({
    type: "테스트",
    url: "https://audit.invalid/upload",
    payload: { type: "테스트", data: {} },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
  });
  assert.ok(result.auditLogPath);
  const saved = await fs.stat(result.auditLogPath);
  assert.equal(await cleanupResultUploadLogs(root, {
    now: saved.mtimeMs + RESULT_UPLOAD_LOG_RETENTION_MS - 1,
  }), 0);
  assert.equal(await cleanupResultUploadLogs(root, {
    now: saved.mtimeMs + RESULT_UPLOAD_LOG_RETENTION_MS,
  }), 1);
  await assert.rejects(fs.stat(result.auditLogPath), { code: "ENOENT" });
});

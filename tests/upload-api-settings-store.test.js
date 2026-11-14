const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createUploadApiSettingsStore } = require("../electron/upload-api-settings-store");
const {
  DEFAULT_UPLOAD_API_URL,
  getUploadApiSettings,
  setUploadApiSettings,
} = require("../src/utils/upload-api-settings");

async function fixture(t, environmentUrl = "") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "upload-settings-store-"));
  const settingsPath = path.join(directory, "upload-api-settings.json");
  const previousSettings = getUploadApiSettings();
  setUploadApiSettings({ uploadApiUrl: DEFAULT_UPLOAD_API_URL });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  t.after(async () => {
    setUploadApiSettings(previousSettings);
    // 이 테스트가 만든 전용 임시 디렉터리만 삭제한다.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("upload-settings-store-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createUploadApiSettingsStore({
    getUserDataDir: () => directory,
    getEnvironmentUrl: () => environmentUrl,
  });
  return { directory, settingsPath, store };
}

function expectedResult(uploadApiUrl, source) {
  return {
    uploadApiUrl,
    defaultUploadApiUrl: DEFAULT_UPLOAD_API_URL,
    isDefault: uploadApiUrl === DEFAULT_UPLOAD_API_URL,
    source,
  };
}

test("설정을 동기적으로 읽고 사용자·환경·기본값 우선순위와 복구 규칙을 유지한다", async (t) => {
  const cases = [
    { name: "파일·환경 없음", expected: DEFAULT_UPLOAD_API_URL, source: "default" },
    { name: "환경만 지정", environment: " https://environment.invalid/upload#old ", expected: "https://environment.invalid/upload", source: "environment" },
    { name: "사용자 설정 우선", environment: "https://environment.invalid/upload", stored: '{"uploadApiUrl":" https://saved.invalid/upload#old "}', expected: "https://saved.invalid/upload", source: "user" },
    { name: "빈 사용자 설정은 환경 사용", environment: "https://environment.invalid/upload", stored: '{"uploadApiUrl":"  "}', expected: "https://environment.invalid/upload", source: "environment" },
    { name: "손상된 JSON은 환경 사용", environment: "https://environment.invalid/upload", stored: "{broken", expected: "https://environment.invalid/upload", source: "environment" },
    { name: "잘못된 사용자 URL은 환경이 있어도 기본값", environment: "https://environment.invalid/upload", stored: '{"uploadApiUrl":"file:///invalid"}', expected: DEFAULT_UPLOAD_API_URL, source: "default" },
    { name: "잘못된 환경 URL은 기본값", environment: "invalid", expected: DEFAULT_UPLOAD_API_URL, source: "default" },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const { store, settingsPath } = await fixture(subtest, entry.environment);
      if (entry.stored !== undefined) await fs.writeFile(settingsPath, entry.stored);
      const result = store.loadUploadApiSettings();
      assert.deepEqual(result, expectedResult(entry.expected, entry.source));
      assert.deepEqual(getUploadApiSettings(), { uploadApiUrl: entry.expected });
      // 읽기는 손상된 원본을 덮어쓰거나 설정 파일을 새로 만들지 않는다.
      if (entry.stored !== undefined) assert.equal(await fs.readFile(settingsPath, "utf8"), entry.stored);
      else await assert.rejects(fs.stat(settingsPath), { code: "ENOENT" });
    });
  }
});

test("설정 경로와 환경값은 생성 시점이 아니라 읽기·저장 시점에 결정한다", async (t) => {
  const { directory } = await fixture(t);
  let userDataDir = path.join(directory, "before");
  let environmentUrl = "https://before.invalid/upload";
  let pathCalls = 0;
  const store = createUploadApiSettingsStore({
    getUserDataDir: () => { pathCalls += 1; return userDataDir; },
    getEnvironmentUrl: () => environmentUrl,
  });
  assert.equal(pathCalls, 0);
  assert.equal(store.loadUploadApiSettings().uploadApiUrl, environmentUrl);
  environmentUrl = "https://after.invalid/upload";
  userDataDir = path.join(directory, "after");
  assert.equal(store.loadUploadApiSettings().uploadApiUrl, environmentUrl);
  await store.saveUploadApiSettings({ uploadApiUrl: "https://saved.invalid/upload" });
  assert.equal(pathCalls, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(userDataDir, "upload-api-settings.json"), "utf8")), {
    uploadApiUrl: "https://saved.invalid/upload",
  });
  await assert.rejects(fs.stat(path.join(directory, "before")), { code: "ENOENT" });
});

test("저장은 정규화된 JSON과 응답을 유지하고 빈 URL은 기본값으로 복원한다", async (t) => {
  const { directory, settingsPath, store } = await fixture(t, "https://environment.invalid/upload");
  const requestedUrl = "https://saved.invalid/upload";
  const result = await store.saveUploadApiSettings({ uploadApiUrl: ` ${requestedUrl}#old `, ignored: true });
  assert.deepEqual(result, expectedResult(requestedUrl, "user"));
  assert.deepEqual(getUploadApiSettings(), { uploadApiUrl: requestedUrl });
  assert.equal(await fs.readFile(settingsPath, "utf8"), `${JSON.stringify({ uploadApiUrl: requestedUrl }, null, 2)}\n`);
  assert.deepEqual(await fs.readdir(directory), ["upload-api-settings.json"]);

  assert.deepEqual(await store.saveUploadApiSettings({ uploadApiUrl: "  " }), expectedResult(DEFAULT_UPLOAD_API_URL, "default"));
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), { uploadApiUrl: DEFAULT_UPLOAD_API_URL });
  assert.deepEqual(getUploadApiSettings(), { uploadApiUrl: DEFAULT_UPLOAD_API_URL });
});

test("잘못된 저장 URL은 기존 파일과 활성 설정을 변경하지 않는다", async (t) => {
  const { directory, settingsPath, store } = await fixture(t);
  const before = { uploadApiUrl: "https://before.invalid/upload" };
  setUploadApiSettings(before);
  await fs.writeFile(settingsPath, JSON.stringify(before));
  await assert.rejects(store.saveUploadApiSettings({ uploadApiUrl: "ftp://invalid/upload" }), /HTTP 또는 HTTPS/);
  assert.deepEqual(getUploadApiSettings(), before);
  assert.equal(await fs.readFile(settingsPath, "utf8"), JSON.stringify(before));
  assert.deepEqual(await fs.readdir(directory), ["upload-api-settings.json"]);
});

test("파일 쓰기·교체 실패 시 기존 설정을 보존하고 임시 파일을 정리한다", async (t) => {
  for (const method of ["writeFile", "rename"]) {
    await t.test(method, async (subtest) => {
      const { directory, settingsPath, store } = await fixture(subtest);
      const before = { uploadApiUrl: "https://before.invalid/upload" };
      setUploadApiSettings(before);
      await fs.writeFile(settingsPath, JSON.stringify(before));
      subtest.mock.method(fs, method, async () => {
        throw Object.assign(new Error(`fixture ${method} failed`), { code: "EACCES" });
      });
      await assert.rejects(store.saveUploadApiSettings({ uploadApiUrl: "https://next.invalid/upload" }), { code: "EACCES" });
      assert.deepEqual(getUploadApiSettings(), before);
      assert.equal(await fs.readFile(settingsPath, "utf8"), JSON.stringify(before));
      assert.deepEqual(await fs.readdir(directory), ["upload-api-settings.json"]);
    });
  }
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const settingsPath = require.resolve("../src/utils/upload-api-settings");
const uploaderPath = require.resolve("../src/utils/result-uploader");
const LEGACY_URL = "https://legacy.example.test/uploader";

function loadUploader(t, overrides = {}) {
  const originalSettings = require(settingsPath);
  const originalUploader = require.cache[uploaderPath];
  const originalFetch = globalThis.fetch;
  let settings = {
    uploadApiUrl: LEGACY_URL,
    ...overrides,
  };
  let reads = 0;
  require.cache[settingsPath].exports = {
    ...originalSettings,
    getUploadApiUrl: () => { reads += 1; return settings.uploadApiUrl; },
  };
  delete require.cache[uploaderPath];
  const uploader = require(uploaderPath);
  t.after(() => {
    globalThis.fetch = originalFetch;
    require.cache[settingsPath].exports = originalSettings;
    if (originalUploader) require.cache[uploaderPath] = originalUploader;
    else delete require.cache[uploaderPath];
  });
  return {
    ...uploader,
    setSettings(next) { settings = { ...settings, ...next }; },
    getSettingsReadCount: () => reads,
  };
}

function response(data, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => typeof data === "string" ? data : JSON.stringify(data),
  };
}

async function enableLogs(t, uploader) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mall-transport-test-"));
  uploader.setResultUploadLogRoot(directory);
  t.after(async () => {
    // Only remove this test's freshly created directory under the temp root.
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "mall-transport-test-")));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("상품 type/data와 운송 배열을 기존 API로 전송한다", async (t) => {
  const uploader = loadUploader(t);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return response("accepted");
  };
  const products = [{ id: "1", stockQuantity: 0, productUrl: "local-only", options: [{ id: "2", productUrl: "local-option" }] }];
  await uploader.postResultJson("아카이브", products);
  const shipping = [{ id: "S1", mft_itemName: "품목" }];
  await uploader.postResultJson("운송정보", shipping, { legacyRaw: true });
  assert.equal(calls[0].url, LEGACY_URL);
  assert.deepEqual(JSON.parse(calls[0].body), {
    type: "아카이브", data: [{ id: "1", stockQuantity: 0, options: [{ id: "2" }] }],
  });
  assert.deepEqual(JSON.parse(calls[1].body), shipping);
  assert.equal(calls[0].headers["Content-Encoding"], undefined);
  assert.equal(typeof calls[0].body, "string");
  assert.equal(calls[1].headers["Content-Encoding"], undefined);
  assert.equal(products[0].productUrl, "local-only");
});

test("빈 응답은 허용하고 명시적 업무 실패는 감사 로그에 기록한다", async (t) => {
  const uploader = loadUploader(t);
  await enableLogs(t, uploader);
  globalThis.fetch = async () => response("", 204);
  const accepted = await uploader.postResultJson("운송정보", [], { legacyRaw: true });
  assert.equal(accepted.response, null);
  for (const flag of ["ok", "success"]) {
    globalThis.fetch = async () => response({ [flag]: false, message: "처리 실패" });
    let failed;
    await assert.rejects(uploader.postResultJson("아카이브", [{ id: "1" }]), (error) => {
      failed = error;
      return error.message === "처리 실패";
    });
    const log = JSON.parse(await fs.readFile(failed.auditLogPath, "utf8"));
    assert.equal(failed.uploadApiUrl, LEGACY_URL);
    assert.equal(failed.method, "POST");
    assert.equal(log.success, false);
    assert.equal(log.response.status, 200);
    assert.equal(log.error, "처리 실패");
    assert.deepEqual(log.sampleIds, ["1"]);
  }
});

test("수동 테스트는 기존 API에 테스트 이벤트를 보내고 요청 ID 없는 성공 응답을 허용한다", async (t) => {
  const uploader = loadUploader(t);
  const notificationPath = require.resolve("../src/utils/test-notification");
  const previousNotification = require.cache[notificationPath];
  delete require.cache[notificationPath];
  const { sendTestNotification } = require(notificationPath);
  t.after(() => {
    if (previousNotification) require.cache[notificationPath] = previousNotification;
    else delete require.cache[notificationPath];
  });
  await enableLogs(t, uploader);
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, ...options };
    return response({ ok: true });
  };
  const result = await sendTestNotification({ appVersion: "test-version" });
  const payload = JSON.parse(captured.body);
  assert.equal(captured.url, LEGACY_URL);
  assert.equal(captured.headers["Content-Encoding"], undefined);
  assert.deepEqual(Object.keys(payload), ["type", "data"]);
  assert.equal(payload.type, "테스트");
  assert.equal(payload.data.event, "connection-test");
  assert.equal(payload.data.appVersion, "test-version");
  assert.equal(payload.data.requestId, result.requestId);
  assert.ok(payload.data.sentAt);
  assert.equal(result.status, 200);
  const log = JSON.parse(await fs.readFile(result.auditLogPath, "utf8"));
  assert.deepEqual(log.request, payload);
});

test("GET은 주입된 fetch로 body 없이 요청하고 응답 검증 결과와 로그를 반환한다", async (t) => {
  const uploader = loadUploader(t);
  await enableLogs(t, uploader);
  globalThis.fetch = async () => { throw new Error("global fetch must not be called"); };
  const result = await uploader.requestJsonWithAudit({
    type: "장바구니 요청", url: LEGACY_URL, method: "GET",
    fetchImpl: async (url, options) => {
      assert.equal(url, LEGACY_URL);
      assert.equal(options.method, "GET");
      assert.equal(Object.hasOwn(options, "body"), false);
      assert.equal(options.headers["Content-Type"], undefined);
      return response({ items: [{ productId: "10" }] });
    },
    validateResponse: (body) => body.items,
  });
  assert.deepEqual(result.validatedData, [{ productId: "10" }]);
  const log = JSON.parse(await fs.readFile(result.auditLogPath, "utf8"));
  assert.equal(log.method, "GET");
  assert.equal(log.request, null);
  assert.equal(log.itemCount, 1);
  assert.deepEqual(log.sampleIds, ["10"]);
});

test("GET 응답 형식 검증 실패도 실패 요청 이력으로 남긴다", async (t) => {
  const uploader = loadUploader(t);
  await enableLogs(t, uploader);
  let failure;
  await assert.rejects(uploader.requestJsonWithAudit({
    type: "장바구니 요청", url: LEGACY_URL, method: "GET",
    fetchImpl: async () => response("<html>login</html>"),
    validateResponse: () => { throw new Error("상품 배열이 아닙니다."); },
  }), (error) => { failure = error; return error.message === "상품 배열이 아닙니다."; });
  const log = JSON.parse(await fs.readFile(failure.auditLogPath, "utf8"));
  assert.equal(log.success, false);
  assert.equal(log.response.status, 200);
});

test("부모 취소는 fetch를 중단하고 AbortError 및 실패 이력을 유지한다", async (t) => {
  const uploader = loadUploader(t);
  await enableLogs(t, uploader);
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    requestStarted();
  });
  const pending = uploader.postResultJson("아카이브", [], { signal: controller.signal });
  await started;
  controller.abort();
  let failure;
  await assert.rejects(pending, (error) => { failure = error; return error.name === "AbortError"; });
  const log = JSON.parse(await fs.readFile(failure.auditLogPath, "utf8"));
  assert.equal(log.success, false);
  assert.equal(log.response, null);
});

test("요청 이전 취소에서는 네트워크 호출을 하지 않는다", async (t) => {
  const uploader = loadUploader(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response(""); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(uploader.postResultJson("아카이브", [], { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("타임아웃은 사용자 취소와 구분한다", async (t) => {
  const uploader = loadUploader(t);
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await assert.rejects(uploader.postResultJson("아카이브", [], { timeoutMs: 10 }), { code: "UPLOAD_TIMEOUT" });
});

test("응답 대기 중 설정이나 원본 객체가 바뀌어도 요청과 로그의 snapshot은 유지한다", async (t) => {
  const uploader = loadUploader(t);
  await enableLogs(t, uploader);
  let finish;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, LEGACY_URL);
    assert.equal(JSON.parse(options.body).data[0].stockQuantity, 1);
    requestStarted();
    return new Promise((resolve) => { finish = resolve; });
  };
  const data = [{ id: "1", stockQuantity: 1 }];
  const pending = uploader.postResultJson("아카이브", data, { requestId: "snapshot" });
  await started;
  uploader.setSettings({ uploadApiUrl: "https://changed.example.test/" });
  data[0].stockQuantity = 999;
  finish(response({ ok: true, requestId: "snapshot" }));
  const result = await pending;
  const log = JSON.parse(await fs.readFile(result.auditLogPath, "utf8"));
  assert.equal(uploader.getSettingsReadCount(), 1);
  assert.equal(log.uploadApiUrl, LEGACY_URL);
  assert.equal(log.request.data[0].stockQuantity, 1);
  assert.equal(result.uploadApiUrl, LEGACY_URL);
});

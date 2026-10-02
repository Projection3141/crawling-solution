const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeUploadApiSettings, getUploadApiSettings, setUploadApiSettings, DEFAULT_UPLOAD_API_URL } = require("../src/utils/upload-api-settings");

test("단일 API URL을 정규화하고 비어 있으면 기본 주소를 사용한다", () => {
  assert.deepEqual(normalizeUploadApiSettings({ uploadApiUrl: " https://example.test/uploader#fragment " }), {
    uploadApiUrl: "https://example.test/uploader",
  });
  assert.deepEqual(normalizeUploadApiSettings(), { uploadApiUrl: DEFAULT_UPLOAD_API_URL });
});

test("이전에 저장한 경량 설정이 있어도 기존 API 주소만 유지한다", () => {
  const before = getUploadApiSettings();
  try {
    const normalized = setUploadApiSettings({
      uploadApiUrl: "https://example.test/uploader",
      transferMode: "light", lightUploadApiUrl: "https://example.test/light", compression: "gzip",
    });
    assert.deepEqual(normalized, { uploadApiUrl: "https://example.test/uploader" });
    assert.deepEqual(getUploadApiSettings(), normalized);
  } finally {
    setUploadApiSettings(before);
  }
});

test("잘못된 URL 변경은 현재 설정에 반영하지 않는다", () => {
  const before = getUploadApiSettings();
  for (const uploadApiUrl of ["not a url", "file:///tmp/x", "ftp://example.test/"]) {
    assert.throws(() => setUploadApiSettings({ uploadApiUrl }));
    assert.deepEqual(getUploadApiSettings(), before);
  }
});

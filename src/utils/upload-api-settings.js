// src/utils/upload-api-settings.js
// 목적: 서버 API 주소를 검증하고 현재 전송 설정을 관리한다.

const DEFAULT_UPLOAD_API_URL =
  "https://www.web3.io.kr/joahstore/crawling/uploader";

function normalizeUploadApiUrl(value) {
  const rawValue = String(value || "").trim();
  const candidate = rawValue || DEFAULT_UPLOAD_API_URL;
  let parsed;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Upload API URL은 http:// 또는 https://로 시작하는 올바른 주소여야 합니다.",
    );
  }

  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Upload API URL은 HTTP 또는 HTTPS 주소만 사용할 수 있습니다.");
  }

  parsed.hash = "";
  return parsed.toString();
}

function normalizeUploadApiSettings(value = {}) {
  return {
    uploadApiUrl: normalizeUploadApiUrl(value.uploadApiUrl),
  };
}

let activeSettings = normalizeUploadApiSettings({
  uploadApiUrl: process.env.UPLOAD_API_URL || DEFAULT_UPLOAD_API_URL,
});

function getUploadApiUrl() {
  return activeSettings.uploadApiUrl;
}

function setUploadApiUrl(value) {
  activeSettings = { ...activeSettings, uploadApiUrl: normalizeUploadApiUrl(value) };
  return activeSettings.uploadApiUrl;
}

function getUploadApiSettings() {
  return { ...activeSettings };
}

function setUploadApiSettings(value) {
  activeSettings = normalizeUploadApiSettings(value);
  return getUploadApiSettings();
}

module.exports = {
  DEFAULT_UPLOAD_API_URL,
  getUploadApiUrl,
  normalizeUploadApiUrl,
  setUploadApiUrl,
  getUploadApiSettings,
  normalizeUploadApiSettings,
  setUploadApiSettings,
};

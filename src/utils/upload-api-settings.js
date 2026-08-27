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

let activeUploadApiUrl = normalizeUploadApiUrl(
  process.env.UPLOAD_API_URL || DEFAULT_UPLOAD_API_URL,
);

function getUploadApiUrl() {
  return activeUploadApiUrl;
}

function setUploadApiUrl(value) {
  activeUploadApiUrl = normalizeUploadApiUrl(value);
  return activeUploadApiUrl;
}

module.exports = {
  DEFAULT_UPLOAD_API_URL,
  getUploadApiUrl,
  normalizeUploadApiUrl,
  setUploadApiUrl,
};

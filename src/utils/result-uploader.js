// src/utils/result-uploader.js
// 목적: 기존 JSON 형식으로 서버에 요청하고 응답 검증·취소·전송 이력을 처리한다.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { throwIfAborted } = require("./common");
const { getUploadApiUrl } = require("./upload-api-settings");

const RESULT_UPLOAD_TIMEOUT_MS = 30000;
let resultUploadLogRoot = "";

/** Electron main process에서 서버 요청 이력 저장 루트를 설정한다. */
function setResultUploadLogRoot(rootDirectory) {
  resultUploadLogRoot = String(rootDirectory || "").trim();
}

function getKoreaTimestampParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");

  return {
    directoryName: `${values.year}${values.month}${values.day}`,
    fileName: `${values.hour}${values.minute}${values.second}-${milliseconds}.json`,
    localDateTime: `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${milliseconds}+09:00`,
  };
}

// POST 전송 성공·실패와 실제 요청 JSON 및 응답을 파일에 기록한다.
async function writeResultUploadAuditLog(entry, startedAt, logRoot) {
  if (!logRoot) return null;

  try {
    const timestamp = getKoreaTimestampParts(startedAt);
    const directory = path.join(logRoot, timestamp.directoryName);
    await fs.promises.mkdir(directory, { recursive: true });
    const extension = path.extname(timestamp.fileName);
    const baseName = path.basename(timestamp.fileName, extension);
    let suffix = 0;

    while (true) {
      const suffixText = suffix === 0 ? "" : `-${suffix}`;
      const logPath = path.join(directory, `${baseName}${suffixText}${extension}`);

      try {
        await fs.promises.writeFile(
          logPath,
          JSON.stringify(
            {
              sentAt: timestamp.localDateTime,
              ...entry,
            },
            null,
            2,
          ),
          { encoding: "utf8", flag: "wx" },
        );
        return logPath;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        suffix += 1;
      }
    }
  } catch (error) {
    console.warn("[RESULT REQUEST] 요청 이력 JSON 저장 실패", error?.message || error);
    return null;
  }
}

/** POST 데이터에서 로컬 탐색용 productUrl을 재귀적으로 제거한다. */
function removeProductUrlDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => removeProductUrlDeep(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (key === "productUrl") continue;
    result[key] = removeProductUrlDeep(childValue);
  }

  return result;
}

function parseUploadResponseText(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** HTTP 성공 응답 안에 명시된 업무 실패도 성공으로 기록하지 않는다. */
function assertApplicationSuccess(responseData, type) {
  if (responseData && typeof responseData === "object" &&
      (responseData.ok === false || responseData.success === false)) {
    throw new Error(String(responseData.message || responseData.error ||
      `${type} 요청을 서버가 처리하지 못했습니다.`));
  }
}

function getSampleIds(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => item?.productId ?? item?.product_id ?? item?.id)
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .slice(0, 5).map(String);
}

/** GET/POST를 같은 감사 로그와 취소·타임아웃 처리로 수행한다. */
async function requestJsonWithAudit({
  type,
  url,
  method = "POST",
  payload,
  timeoutMs = RESULT_UPLOAD_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
  archiveRef,
  requestId,
  validateResponse,
  itemCount,
  sampleIds,
}) {
  const startedAt = new Date();
  const logRoot = resultUploadLogRoot;
  const uploadApiUrl = String(url || "");
  const requestMethod = String(method).toUpperCase();
  const requestTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs) : RESULT_UPLOAD_TIMEOUT_MS;
  let requestPayload = null;
  let responseStatus = null;
  let responseData = null;
  let validatedData;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });

  const auditEntry = (success, error) => {
    const items = Array.isArray(requestPayload) ? requestPayload
      : Array.isArray(requestPayload?.data) ? requestPayload.data : validatedData;
    return {
      success,
      type,
      method: requestMethod,
      itemCount: Number.isFinite(itemCount) ? itemCount
        : Array.isArray(items) ? items.length : null,
      sampleIds: Array.isArray(sampleIds) ? sampleIds.map(String).slice(0, 5) : getSampleIds(items),
      uploadApiUrl,
      archiveRef: archiveRef ?? null,
      requestId: requestId ?? requestPayload?.requestId ?? null,
      durationMs: Date.now() - startedAt.getTime(),
      request: requestPayload,
      response: responseStatus === null ? null : { status: responseStatus, data: responseData },
      ...(error ? { error: error?.message || String(error) } : {}),
    };
  };

  try {
    throwIfAborted(signal);
    if (typeof fetchImpl !== "function") {
      throw new Error("현재 Node.js 환경에서 fetch를 사용할 수 없습니다.");
    }
    const parsedUrl = new URL(uploadApiUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("서버 요청 URL은 HTTP 또는 HTTPS 주소여야 합니다.");
    }
    const hasBody = payload !== undefined;
    if (hasBody && ["GET", "HEAD"].includes(requestMethod)) {
      throw new Error(`${requestMethod} 요청에는 JSON 본문을 보낼 수 없습니다.`);
    }
    const headers = { Accept: "application/json, text/plain, */*" };
    let body;
    if (hasBody) {
      const json = JSON.stringify(payload);
      // 호출자가 기다리는 동안 객체를 바꿔도 송신 본문과 감사 로그는 일치한다.
      requestPayload = JSON.parse(json);
      body = json;
      headers["Content-Type"] = "application/json; charset=UTF-8";
    }
    throwIfAborted(signal);
    controller.signal.throwIfAborted();

    console.log(`[RESULT REQUEST] ${type} ${requestMethod} 시작`, {
      url: uploadApiUrl,
    });
    const response = await fetchImpl(uploadApiUrl, {
      method: requestMethod,
      headers,
      ...(hasBody ? { body } : {}),
      signal: controller.signal,
    });
    responseStatus = response.status;
    const responseText = await response.text();
    responseData = parseUploadResponseText(responseText);
    throwIfAborted(signal);
    controller.signal.throwIfAborted();
    if (!response.ok) {
      const message =
        responseData && typeof responseData === "object"
          ? responseData.message || responseData.error
          : responseData;
      throw new Error(String(message || `${type} 요청 실패: HTTP ${response.status}`));
    }
    assertApplicationSuccess(responseData, type);
    if (validateResponse) {
      validatedData = await validateResponse(responseData, {
        status: responseStatus, method: requestMethod, url: uploadApiUrl,
      });
    }
    throwIfAborted(signal);
    controller.signal.throwIfAborted();
    const auditLogPath = await writeResultUploadAuditLog(
      auditEntry(true), startedAt, logRoot,
    );
    console.log(`[RESULT REQUEST] ${type} ${requestMethod} 완료`, { status: responseStatus });
    return {
      type,
      status: responseStatus,
      response: responseData,
      auditLogPath,
      uploadApiUrl,
      method: requestMethod,
      ...(validatedData !== undefined ? { validatedData } : {}),
    };
  } catch (error) {
    let finalError = error;
    if (signal?.aborted) {
      try {
        throwIfAborted(signal);
      } catch (abortError) {
        finalError = abortError;
      }
    } else if (timedOut) {
      finalError = new Error(
        `${type} ${requestMethod} 요청 시간이 ${requestTimeoutMs}ms를 초과했습니다.`,
      );
      finalError.code = "UPLOAD_TIMEOUT";
    }
    const auditLogPath = await writeResultUploadAuditLog(
      auditEntry(false, finalError), startedAt, logRoot,
    );
    if (finalError && typeof finalError === "object") {
      finalError.auditLogPath = auditLogPath;
      finalError.status = responseStatus;
      finalError.uploadApiUrl = uploadApiUrl;
      finalError.method = requestMethod;
    }
    throw finalError;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/** 상품·테스트는 type/data 객체로, 운송장은 기존 배열 그대로 POST한다. */
async function postResultJson(type, data, {
  url = getUploadApiUrl(),
  signal,
  legacyRaw = false,
  timeoutMs = RESULT_UPLOAD_TIMEOUT_MS,
  requestId = randomUUID(),
  sentAt = new Date().toISOString(),
  archiveRef,
} = {}) {
  const cleanedData = removeProductUrlDeep(data);
  const payload = legacyRaw ? cleanedData : { type, data: cleanedData };
  const result = await requestJsonWithAudit({
    type,
    url,
    payload,
    signal,
    timeoutMs,
    archiveRef,
    requestId,
  });
  return { ...result, requestId, sentAt };
}

module.exports = {
  postResultJson,
  requestJsonWithAudit,
  removeProductUrlDeep,
  setResultUploadLogRoot,
};

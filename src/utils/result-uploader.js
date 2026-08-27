const fs = require("node:fs");
const path = require("node:path");
const { throwIfAborted } = require("./common");
const { getUploadApiUrl } = require("./upload-api-settings");

const RESULT_UPLOAD_TIMEOUT_MS = 30000;
let resultUploadLogRoot = "";

/** Electron main process에서 수집정보 POST 이력 저장 루트를 설정한다. */
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

// POST 전송 성공/실패 이력을 JSON 파일로 기록한다. (Electron main process에서만 사용)
async function writeResultUploadAuditLog(entry, startedAt) {
  if (!resultUploadLogRoot) return null;

  try {
    const timestamp = getKoreaTimestampParts(startedAt);
    const directory = path.join(resultUploadLogRoot, timestamp.directoryName);
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
    console.warn("[RESULT POST] 전송 이력 JSON 저장 실패", error?.message || error);
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

/** 아카이브 등 저장 완료 데이터를 uploader 서버에 POST한다. */
async function postResultJson(type, data, { signal } = {}) {
  throwIfAborted(signal);

  if (typeof fetch !== "function") {
    throw new Error(
      "현재 Node.js 환경에서 fetch를 사용할 수 없습니다. Node.js 18 이상이 필요합니다.",
    );
  }

  const startedAt = new Date();
  const uploadApiUrl = getUploadApiUrl();
  const requestPayload = {
    type,
    data: removeProductUrlDeep(data),
  };
  let responseStatus = null;
  let responseData = null;
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESULT_UPLOAD_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();

  signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    console.log(`[RESULT POST] ${type} 전송 시작`, {
      url: uploadApiUrl,
      itemCount: Array.isArray(data) ? data.length : null,
    });

    const response = await fetch(uploadApiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });
    const responseText = await response.text();
    responseStatus = response.status;
    responseData = parseUploadResponseText(responseText);

    console.log(`[RESULT POST] ${type} 응답`, {
      status: response.status,
      ok: response.ok,
      data: responseData,
    });

    if (!response.ok) {
      const message =
        responseData && typeof responseData === "object"
          ? responseData.message || responseData.error
          : responseData;
      throw new Error(
        message || `${type} 결과 POST 실패: HTTP ${response.status}`,
      );
    }

    const auditLogPath = await writeResultUploadAuditLog(
      {
        success: true,
        type,
        itemCount: Array.isArray(requestPayload.data)
          ? requestPayload.data.length
          : null,
        uploadApiUrl,
        request: requestPayload,
        response: {
          status: responseStatus,
          data: responseData,
        },
      },
      startedAt,
    );

    return {
      type,
      status: response.status,
      response: responseData,
      auditLogPath,
    };
  } catch (error) {
    let finalError = error;

    if (signal?.aborted) {
      try {
        throwIfAborted(signal);
      } catch (abortError) {
        finalError = abortError;
      }
    } else if (timedOut || error?.name === "AbortError") {
      finalError = new Error(
        `${type} 결과 POST 요청 시간이 ${RESULT_UPLOAD_TIMEOUT_MS}ms를 초과했습니다.`,
      );
    }

    await writeResultUploadAuditLog(
      {
        success: false,
        type,
        itemCount: Array.isArray(requestPayload.data)
          ? requestPayload.data.length
          : null,
        uploadApiUrl,
        request: requestPayload,
        response:
          responseStatus === null
            ? null
            : { status: responseStatus, data: responseData },
        error: finalError?.message || String(finalError),
      },
      startedAt,
    );
    throw finalError;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

module.exports = {
  postResultJson,
  removeProductUrlDeep,
  setResultUploadLogRoot,
};

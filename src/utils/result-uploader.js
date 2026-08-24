const { throwIfAborted } = require("./common");

const RESULT_UPLOAD_URL =
  "https://www.web3.io.kr/joahstore/crawling/uploader";
const RESULT_UPLOAD_TIMEOUT_MS = 30000;

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
      url: RESULT_UPLOAD_URL,
      itemCount: Array.isArray(data) ? data.length : null,
    });

    const response = await fetch(RESULT_UPLOAD_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        type,
        data: removeProductUrlDeep(data),
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    const responseData = parseUploadResponseText(responseText);

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

    return {
      type,
      status: response.status,
      response: responseData,
    };
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }

    if (timedOut || error?.name === "AbortError") {
      throw new Error(
        `${type} 결과 POST 요청 시간이 ${RESULT_UPLOAD_TIMEOUT_MS}ms를 초과했습니다.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

module.exports = {
  postResultJson,
  removeProductUrlDeep,
};

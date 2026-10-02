// src/product-upload-scheduler.js
// 목적: 수집 완료 시 전체 상품을 전송하고 실패한 전송 데이터를 보관·재시도한다.

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { archiveToProductArray, readProductArchive, ARCHIVE_PATH } = require("./utils/product-archive");
const { postResultJson } = require("./utils/result-uploader");
const { getUploadApiUrl } = require("./utils/upload-api-settings");

const RETRY_INTERVAL_MS = 5 * 60 * 1000;

function createProductUploadScheduler({
  statePath,
  readProducts = async () => archiveToProductArray(await readProductArchive()),
  uploadProducts = (products, options) => postResultJson("아카이브", products, options),
  getDestination = getUploadApiUrl,
  onStateChanged = () => {},
}) {
  let enabled = true;
  let stopped = true;
  let running = false;
  let pending = null;
  let timer = null;
  let nextRetryAt = null;
  let lastSuccessAt = null;
  let lastError = "";
  let operations = Promise.resolve();

  const getState = () => ({
    enabled, running, pending: Boolean(pending),
    pendingProductCount: pending?.products.length || 0,
    nextRetryAt, lastSuccessAt, lastError,
  });
  const emitState = () => onStateChanged(getState());

  // 파일 변경만 직렬화한다. HTTP 응답을 기다리는 동안 새 완료 데이터를 보관할 수 있다.
  function serialize(action) {
    const result = operations.then(action);
    operations = result.catch(() => {});
    return result;
  }

  async function saveState() {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify({ version: 1, enabled, pending }), "utf8");
    await fs.rename(temporaryPath, statePath);
  }

  function clearRetry() {
    if (timer) clearTimeout(timer);
    timer = null;
    nextRetryAt = null;
  }

  function scheduleRetry() {
    clearRetry();
    if (!stopped && enabled && pending) {
      nextRetryAt = new Date(Date.now() + RETRY_INTERVAL_MS).toISOString();
      timer = setTimeout(() => { void runOnce(); }, RETRY_INTERVAL_MS);
    }
    emitState();
  }

  async function runOnce() {
    if (stopped || !enabled || running || !pending) return;
    running = true;
    clearRetry();
    lastError = "";
    emitState();
    let sent = null;
    let succeeded = false;
    try {
      sent = await serialize(async () => {
        if (stopped || !enabled || !pending) return null;
        if (pending.url !== getDestination()) {
          throw new Error("대기 데이터의 서버 주소가 현재 설정과 다릅니다. 다시 수집하거나 기존 서버 주소로 복원하세요.");
        }
        // 전송 전에 반드시 디스크에 남긴다. 강제 종료되어도 다음 실행에서 복구한다.
        await saveState();
        return pending;
      });
      if (!sent) return;
      await uploadProducts(sent.products, { url: sent.url, archiveRef: sent.archiveRef });
      await serialize(async () => {
        // 이전 요청의 성공 응답으로 그 사이 완료된 새 전송을 지우지 않는다.
        if (pending?.id === sent.id) {
          pending = null;
          try {
            await saveState();
          } catch (error) {
            pending = sent;
            throw error;
          }
        }
      });
      succeeded = true;
      lastSuccessAt = new Date().toISOString();
      lastError = "";
    } catch (error) {
      lastError = error?.message || String(error);
      console.error("[PRODUCT UPLOAD ERROR]", lastError);
    } finally {
      running = false;
      if (pending && succeeded) {
        emitState();
        void runOnce();
      } else {
        // 성공 후에는 주기 전송을 예약하지 않는다. 실패한 데이터만 재시도한다.
        scheduleRetry();
      }
    }
  }

  async function notifyCollectionCompleted() {
    try {
      await serialize(async () => {
        const products = await readProducts();
        if (!Array.isArray(products)) throw new Error("전송할 상품 아카이브를 읽지 못했습니다.");
        pending = {
          id: randomUUID(), url: getDestination(), archiveRef: ARCHIVE_PATH,
          createdAt: new Date().toISOString(),
          products: JSON.parse(JSON.stringify(products)),
        };
        // 전체 아카이브이므로 아직 보내지 못한 이전 완료 데이터는 최신본으로 대체한다.
        await saveState();
        lastError = "";
        emitState();
      });
    } catch (error) {
      lastError = `전송 대기 저장 실패: ${error?.message || String(error)}`;
      scheduleRetry();
      throw error;
    }
    void runOnce();
  }

  async function setEnabled(value) {
    await serialize(async () => {
      const previous = enabled;
      enabled = value === true;
      try {
        await saveState();
      } catch (error) {
        enabled = previous;
        throw error;
      }
      clearRetry();
      emitState();
    });
    // ON으로 바꾸어도 완료된 대기 데이터가 없으면 아무것도 전송하지 않는다.
    void runOnce();
    return getState();
  }

  async function start() {
    await serialize(async () => {
      try {
        const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
        if (saved.version !== 1 || typeof saved.enabled !== "boolean" ||
            (saved.pending !== null && (!saved.pending?.id ||
              typeof saved.pending.url !== "string" || !Array.isArray(saved.pending.products)))) {
          throw new Error("전송 대기 파일 형식이 올바르지 않습니다.");
        }
        enabled = saved.enabled;
        pending = saved.pending;
      } catch (error) {
        if (error.code !== "ENOENT") lastError = `전송 대기 복원 실패: ${error.message}`;
      }
      stopped = false;
      emitState();
    });
    // 앱 시작 시 전체 아카이브를 새로 읽지 않고 미완료 요청만 복구한다.
    void runOnce();
  }

  function stop() {
    stopped = true;
    clearRetry();
  }

  return { start, stop, getState, setEnabled, notifyCollectionCompleted, runOnce };
}

module.exports = { createProductUploadScheduler, RETRY_INTERVAL_MS };

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { ARCHIVE_DIRECTORY } = require("./product-archive");
const { writeJsonAtomically } = require("./detail-checkpoint");

const RESTOCK_STATE_PATH = path.join(ARCHIVE_DIRECTORY, "restock-collection-state.json");
let queue = Promise.resolve();
function locked(action) {
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result;
}

function restockKey(config) {
  if (!["restock30", "restock90"].includes(config.changeType)) throw new Error("재입고 확인 기간이 올바르지 않습니다.");
  const account = createHash("sha256").update(String(config.accountId || "").trim()).digest("hex").slice(0, 24);
  return `cheonyu:${config.changeType}:${account}`;
}

async function readState() {
  let text;
  try { text = await fs.readFile(RESTOCK_STATE_PATH, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, cursors: {} }; throw error; }
  const state = JSON.parse(text);
  if (state?.schemaVersion !== 1 || !state.cursors || typeof state.cursors !== "object" || Array.isArray(state.cursors)) {
    throw new Error("재입고 확인 기록 형식이 올바르지 않습니다.");
  }
  return state;
}

function validateCursor(cursor) {
  if (!cursor) return;
  if (!Number.isSafeInteger(cursor.revision) || cursor.revision < 1 || !Number.isFinite(Date.parse(cursor.lastCheckedAt)) ||
      (cursor.lastRestockedAt != null && !Number.isFinite(Date.parse(cursor.lastRestockedAt))) || !/^\d+$/.test(cursor.lastProductId) ||
      !Array.isArray(cursor.boundaryProductIds) || !cursor.boundaryProductIds.length ||
      cursor.boundaryProductIds.some(id => !/^\d+$/.test(id)) || !cursor.boundaryProductIds.includes(cursor.lastProductId)) throw new Error("재입고 확인 기록이 손상되었습니다.");
}

async function readRestockCursor(config) {
  return locked(async () => {
    const key = restockKey(config);
    const cursor = (await readState()).cursors[key] || null;
    validateCursor(cursor);
    return { key, cursor };
  });
}

function isNewRestock(product, cursor) {
  if (!cursor) return true;
  if (!product.restockedAt || !cursor.lastRestockedAt) return !cursor.boundaryProductIds.includes(String(product.productId));
  const date = Date.parse(product.restockedAt);
  const boundary = Date.parse(cursor.lastRestockedAt);
  return date > boundary || (date === boundary && !cursor.boundaryProductIds.includes(String(product.productId)));
}

function createRestockCheckpoint({ key, cursor }, firstDateProducts, checkedAt) {
  const unchanged = () => cursor ? { key, expectedRevision: cursor.revision, next: { ...cursor, lastCheckedAt: checkedAt } } : null;
  if (!firstDateProducts.length) return unchanged();
  const first = firstDateProducts[0];
  const date = Date.parse(first.restockedAt);
  const previous = cursor ? Date.parse(cursor.lastRestockedAt) : -Infinity;
  if (date < previous) return unchanged();
  return { key, expectedRevision: cursor?.revision || 0, next: {
    lastCheckedAt: checkedAt, lastRestockedAt: first.restockedAt || null, lastProductId: String(first.productId),
    boundaryProductIds: [...new Set([...(date === previous ? cursor.boundaryProductIds : []),
      ...firstDateProducts.map(product => String(product.productId))])],
  } };
}

async function commitRestockCursor(checkpoint) {
  return locked(async () => {
    const state = await readState();
    const previous = state.cursors[checkpoint.key];
    validateCursor(previous);
    if ((previous?.revision || 0) !== checkpoint.expectedRevision) {
      throw new Error("다른 실행이 재입고 확인 기록을 갱신했습니다. 이번 실행의 확인 기록은 덮어쓰지 않습니다.");
    }
    const next = { ...checkpoint.next, revision: checkpoint.expectedRevision + 1 };
    validateCursor(next);
    if (previous && Date.parse(next.lastRestockedAt) < Date.parse(previous.lastRestockedAt)) throw new Error("재입고 확인 날짜를 이전으로 변경할 수 없습니다.");
    state.cursors[checkpoint.key] = next;
    await writeJsonAtomically(RESTOCK_STATE_PATH, state);
    return next;
  });
}

module.exports = { RESTOCK_STATE_PATH, readRestockCursor, isNewRestock, createRestockCheckpoint, commitRestockCursor };

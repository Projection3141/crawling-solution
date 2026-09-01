/** src/utils/detail-collection-state.js */

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  ARCHIVE_DIRECTORY,
} = require("./product-archive");

const DETAIL_STATE_SCHEMA_VERSION = 1;
const DETAIL_DATA_SCHEMA_VERSION = 1;
const DETAIL_STATE_PATH = path.join(
  ARCHIVE_DIRECTORY,
  "detail-collection-state.json",
);

let detailStateQueue = Promise.resolve();

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createProductKey(mall, productId) {
  const normalizedMall = normalizeText(mall).toLowerCase();
  const normalizedProductId = normalizeText(productId);

  if (!normalizedMall || !normalizedProductId) {
    return "";
  }

  return `${normalizedMall}:${normalizedProductId}`;
}

function createEmptyStateDocument() {
  return {
    schemaVersion: DETAIL_STATE_SCHEMA_VERSION,
    products: {},
  };
}

function normalizeProductState(key, value = {}) {
  const [keyMall = "", ...idParts] = String(key || "").split(":");
  const productId = normalizeText(value.productId || idParts.join(":"));
  const mall = normalizeText(value.mall || keyMall).toLowerCase();
  const normalizedKey = createProductKey(mall, productId);

  if (!normalizedKey) {
    return null;
  }

  const status = ["pending", "success", "failed"].includes(
    normalizeText(value.detailStatus),
  )
    ? normalizeText(value.detailStatus)
    : "pending";

  return {
    key: normalizedKey,
    value: {
      mall,
      productId,
      productUrl: normalizeText(value.productUrl),
      lastSeenPage:
        Number.isInteger(Number(value.lastSeenPage)) &&
        Number(value.lastSeenPage) > 0
          ? Number(value.lastSeenPage)
          : null,
      firstSeenAt: normalizeText(value.firstSeenAt) || null,
      lastSeenAt: normalizeText(value.lastSeenAt) || null,
      detailStatus: status,
      detailStatusSource:
        normalizeText(value.detailStatusSource) || "collector",
      detailDataSchemaVersion:
        Number.isInteger(Number(value.detailDataSchemaVersion)) &&
        Number(value.detailDataSchemaVersion) > 0
          ? Number(value.detailDataSchemaVersion)
          : 0,
      lastDetailAttemptAt:
        normalizeText(value.lastDetailAttemptAt) || null,
      lastDetailSuccessAt:
        normalizeText(value.lastDetailSuccessAt) || null,
      lastDetailError: normalizeText(value.lastDetailError),
    },
  };
}

function normalizeStateDocument(value) {
  const result = createEmptyStateDocument();
  const sourceProducts =
    value?.products && typeof value.products === "object"
      ? value.products
      : {};

  for (const [key, item] of Object.entries(sourceProducts)) {
    const normalized = normalizeProductState(key, item);

    if (normalized) {
      result.products[normalized.key] = normalized.value;
    }
  }

  return result;
}

async function readStateUnlocked() {
  try {
    const text = await fs.readFile(DETAIL_STATE_PATH, "utf8");
    const normalizedText = text.replace(/^\uFEFF/, "").trim();

    if (!normalizedText) {
      return createEmptyStateDocument();
    }

    return normalizeStateDocument(JSON.parse(normalizedText));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createEmptyStateDocument();
    }

    if (error instanceof SyntaxError) {
      throw new Error(
        `상세 수집 상태 파일이 손상되었습니다: ${DETAIL_STATE_PATH}`,
        { cause: error },
      );
    }

    throw error;
  }
}

async function writeStateUnlocked(state) {
  await fs.mkdir(ARCHIVE_DIRECTORY, { recursive: true });
  const tempPath = path.join(
    ARCHIVE_DIRECTORY,
    `.detail-collection-state-${process.pid}-${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(normalizeStateDocument(state), null, 2)}\n`;

  await fs.writeFile(tempPath, body, "utf8");

  try {
    await fs.rename(tempPath, DETAIL_STATE_PATH);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function runWithDetailStateLock(task) {
  const queued = detailStateQueue.then(task);
  detailStateQueue = queued.catch(() => undefined);
  return queued;
}

/**
 * 일반 수집에서 실제로 관측한 상품만 상태에 반영한다.
 * 관측되지 않은 기존 상품은 삭제 또는 실패로 간주하지 않는다.
 * 기존 통합 archive에는 쇼핑몰 출처가 없어서 같은 ID의 타 쇼핑몰 상품과
 * 구분할 수 없으므로, 이 상태 파일에 기록된 실제 상세 성공만 success로 인정한다.
 */
function observeDetailProducts({
  mall,
  products = [],
  observedAt = new Date().toISOString(),
} = {}) {
  return runWithDetailStateLock(async () => {
    const state = await readStateUnlocked();
    const observedProductIds = [];
    const pendingProductIds = [];
    let changed = false;

    for (const product of products || []) {
      const productId = normalizeText(
        product?.productId || product?.id || product?.productNo,
      );
      const key = createProductKey(mall, productId);

      if (!key) continue;

      observedProductIds.push(productId);
      const existing = state.products[key];
      const productUrl = normalizeText(product?.productUrl);
      const lastSeenPage =
        Number.isInteger(Number(product?.page)) && Number(product.page) > 0
          ? Number(product.page)
          : existing?.lastSeenPage ?? null;

      if (!existing) {
        state.products[key] = {
          mall: normalizeText(mall).toLowerCase(),
          productId,
          productUrl,
          lastSeenPage,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          detailStatus: "pending",
          detailStatusSource: "collector",
          detailDataSchemaVersion: 0,
          lastDetailAttemptAt: null,
          lastDetailSuccessAt: null,
          lastDetailError: "",
        };
        changed = true;
      } else {
        const nextProductUrl = productUrl || existing.productUrl;

        if (
          existing.lastSeenAt !== observedAt ||
          existing.productUrl !== nextProductUrl ||
          existing.lastSeenPage !== lastSeenPage
        ) {
          existing.lastSeenAt = observedAt;
          existing.productUrl = nextProductUrl;
          existing.lastSeenPage = lastSeenPage;
          changed = true;
        }
      }

      const current = state.products[key];
      if (
        current.detailStatus !== "success" ||
        current.detailDataSchemaVersion < DETAIL_DATA_SCHEMA_VERSION
      ) {
        pendingProductIds.push(productId);
      }
    }

    if (changed) {
      await writeStateUnlocked(state);
    }

    return {
      state: cloneJson(state),
      observedProductIds,
      pendingProductIds,
      path: DETAIL_STATE_PATH,
    };
  });
}

function selectPendingDetailProductIds(mall, products = []) {
  return runWithDetailStateLock(async () => {
    const state = await readStateUnlocked();
    const ids = [];

    for (const product of products || []) {
      const productId = normalizeText(
        product?.productId || product?.id || product?.productNo,
      );
      const item = state.products[createProductKey(mall, productId)];

      if (
        productId &&
        (!item ||
          item.detailStatus !== "success" ||
          item.detailDataSchemaVersion < DETAIL_DATA_SCHEMA_VERSION)
      ) {
        ids.push(productId);
      }
    }

    return ids;
  });
}

function recordDetailAttempts({
  mall,
  products = [],
  attemptedAt = new Date().toISOString(),
} = {}) {
  return runWithDetailStateLock(async () => {
    const state = await readStateUnlocked();
    let changed = false;

    for (const product of products || []) {
      const productId = normalizeText(
        product?.productId || product?.id || product?.productNo,
      );
      const key = createProductKey(mall, productId);
      if (!key) continue;

      const existing = state.products[key] || {
        mall: normalizeText(mall).toLowerCase(),
        productId,
        productUrl: normalizeText(product?.productUrl),
        lastSeenPage: Number(product?.page) || null,
        firstSeenAt: attemptedAt,
        lastSeenAt: attemptedAt,
        detailStatus: "pending",
        detailStatusSource: "collector",
        detailDataSchemaVersion: 0,
        lastDetailSuccessAt: null,
        lastDetailError: "",
      };

      existing.lastDetailAttemptAt = attemptedAt;
      existing.detailStatus = "pending";
      existing.detailStatusSource = "collector";
      existing.lastDetailError = "";
      existing.productUrl =
        normalizeText(product?.productUrl) || existing.productUrl;
      state.products[key] = existing;
      changed = true;
    }

    if (changed) {
      await writeStateUnlocked(state);
    }

    return { state: cloneJson(state), path: DETAIL_STATE_PATH };
  });
}

/** 상세 결과와 상품 archive 병합이 끝난 뒤에만 호출한다. */
function recordDetailOutcomes({
  mall,
  detailItems = [],
  completedAt = new Date().toISOString(),
} = {}) {
  return runWithDetailStateLock(async () => {
    const state = await readStateUnlocked();
    const succeededProductIds = [];
    const failedProductIds = [];
    let changed = false;

    for (const item of detailItems || []) {
      const productId = normalizeText(
        item?.productId || item?.id || item?.productNo,
      );
      const key = createProductKey(mall, productId);
      if (!key) continue;

      const existing = state.products[key] || {
        mall: normalizeText(mall).toLowerCase(),
        productId,
        productUrl: normalizeText(item?.productUrl),
        lastSeenPage: Number(item?.page) || null,
        firstSeenAt: completedAt,
        lastSeenAt: completedAt,
        detailStatus: "pending",
        detailStatusSource: "collector",
        detailDataSchemaVersion: 0,
        lastDetailSuccessAt: null,
      };
      const detailError = normalizeText(item?.detailError);
      const succeeded = detailError === "";

      existing.lastDetailAttemptAt =
        existing.lastDetailAttemptAt || completedAt;

      if (succeeded) {
        existing.detailStatus = "success";
        existing.detailStatusSource = "collector";
        existing.detailDataSchemaVersion = DETAIL_DATA_SCHEMA_VERSION;
        existing.lastDetailSuccessAt = completedAt;
        existing.lastDetailError = "";
        succeededProductIds.push(productId);
      } else {
        /** archive의 과거 상세값은 유지하되 다음 pending 실행에서 다시 시도한다. */
        existing.detailStatus = "failed";
        existing.detailStatusSource = "collector";
        existing.lastDetailError = detailError;
        failedProductIds.push(productId);
      }

      state.products[key] = existing;
      changed = true;
    }

    if (changed) {
      await writeStateUnlocked(state);
    }

    return {
      state: cloneJson(state),
      succeededProductIds,
      failedProductIds,
      path: DETAIL_STATE_PATH,
    };
  });
}

function readDetailCollectionState() {
  return runWithDetailStateLock(async () => cloneJson(await readStateUnlocked()));
}

module.exports = {
  DETAIL_DATA_SCHEMA_VERSION,
  DETAIL_STATE_PATH,
  createProductKey,
  observeDetailProducts,
  readDetailCollectionState,
  recordDetailAttempts,
  recordDetailOutcomes,
  selectPendingDetailProductIds,
};

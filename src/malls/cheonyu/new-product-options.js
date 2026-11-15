const { throwIfAborted } = require("../../utils/common");
const { sleepWithSignal } = require("../../utils/site-safety");
const { isRecoverableStickySessionError, isTerminalStickyConnectionError } = require("../../utils/collection-failure");
const { describeDiagnosticPage, recordDiagnostic } = require("../../utils/collection-diagnostics");
const { normalizeStockStatus } = require("../../utils/inventory");
const { addProductsFromListPagesToCart, parseLoginState } = require("./site");
const { clearCartByCartIds, parseCartHtml, readCartHtml } = require("./cart");
const {
  createCartOptionMatchKey,
  createCheonyuPopupInventoryItems,
  mergeCheonyuDetailInventoryItems,
} = require("./cart-stock");

function getDetailOptionHints(product) {
  let options = product.detailOptions;
  if (typeof options === "string") {
    try { options = JSON.parse(options); }
    catch { return []; }
  }
  return Array.isArray(options)
    ? options.filter(option => /^\d+$/.test(String(option?.optionId || "")) && String(option.optionId) !== "0")
    : [];
}

function optionKey(row) {
  return `${row.productId}:${row.optionId}`;
}

function cartKey(row) {
  return createCartOptionMatchKey(row.productId, row.optionText);
}

function cartRowId(row) {
  return String(row.cartCheckId || row.inPIDX || "");
}

function submissionPlan(selectedRows, popupRows) {
  const groups = new Set(popupRows.filter(row => row.hasOption && row.cartGroupId).map(row => String(row.cartGroupId)));
  const writes = new Set();
  for (const row of selectedRows) {
    const group = String(row.cartGroupId || "");
    const option = String(row.submitOptionId || "");
    const key = `${group}@@${option}`;
    if (!group || !option || /[#,|@]/.test(group + option) || writes.has(key)) {
      throw new Error("장바구니에 담을 옵션 요청값을 확인하지 못했습니다.");
    }
    writes.add(key);
  }
  return { groups, writes };
}

function matchesSubmission(data, plan) {
  if (!plan || !data) return false;
  const writes = new Set();
  for (const group of data.split("##")) {
    const parts = group.split("@@");
    if (parts.length !== 2 || !plan.groups.has(parts[0])) return false;
    if (!parts[1]) continue;
    for (const option of parts[1].split("|")) {
      const values = option.split(",");
      const key = `${parts[0]}@@${values[0]}`;
      if (values.length !== 2 || values[1] !== "1" || !plan.writes.has(key) || writes.has(key)) return false;
      writes.add(key);
    }
  }
  return writes.size === plan.writes.size;
}

function isCartHandshake(data, eligible) {
  const step = data.get("stepCode");
  if (step === "2" || step === "4") {
    return data.getAll("stepCode").length === 1 && data.getAll("cartCode").length === 1 &&
      Array.from(data.keys()).every(key => key === "stepCode" || key === "cartCode");
  }
  if (step !== null || Array.from(data.keys()).some(key => key !== "inIDX" && key !== "inCount")) return false;
  if (data.getAll("inIDX").length !== 1 || data.getAll("inCount").length !== 1) return false;
  const ids = String(data.get("inIDX") || "").split(",");
  const counts = String(data.get("inCount") || "").split(",");
  return ids.length === counts.length && new Set(ids).size === ids.length &&
    ids.every(id => eligible.has(id)) && counts.every(count => count === "1");
}

function cleanupError(reason, details = {}, cause) {
  return Object.assign(new Error("새 상품 수집에서 추가한 장바구니 행의 정리를 확인하지 못했습니다. 장바구니를 확인하세요.", { cause }),
    { code: "CART_CLEANUP_INCOMPLETE", retryable: false, details: { reason, ...details } });
}

function checkedCartRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = cartRowId(row);
    if (!id || !row.productId || byId.has(id)) {
      throw cleanupError("INVALID_CART_ROW_IDENTITY", {
        productId: row.productId,
        hasCartRowId: Boolean(id),
        duplicateCartRowId: byId.has(id),
      });
    }
    byId.set(id, row);
  }
  return byId;
}

function findOwnedRows(current, before, pending) {
  for (const [id, previous] of before) {
    const row = current.get(id);
    if (!row || cartKey(row) !== cartKey(previous) || row.requestedQty !== previous.requestedQty) {
      throw cleanupError("EXISTING_CART_ROW_CHANGED", {
        productId: previous.productId, expectedQuantity: previous.requestedQty, cartQuantity: row?.requestedQty,
      });
    }
  }
  const pendingProducts = new Set();
  const optionByCartKey = new Map();
  for (const [key, option] of pending) {
    pendingProducts.add(String(option.productId));
    for (const nameKey of option.cartMatchKeys) optionByCartKey.set(nameKey, key);
  }
  const owned = new Map();
  for (const [id, row] of current) {
    if (before.has(id) || !pendingProducts.has(String(row.productId))) continue;
    const key = optionByCartKey.get(cartKey(row));
    const expected = pending.get(key);
    if (!expected) throw cleanupError("CART_OPTION_LABEL_MISMATCH", {
      productId: row.productId, cartOption: row.optionText,
      expectedOptions: Array.from(pending.values()).filter(item => String(item.productId) === String(row.productId))
        .map(({ optionId, optionText, detailOption }) => ({ optionId, popupOption: optionText, detailOption })),
    });
    if (row.requestedQty !== expected.requestedQty) throw cleanupError("CART_OPTION_QUANTITY_MISMATCH", {
      productId: row.productId, optionId: expected.optionId, cartOption: row.optionText,
      expectedQuantity: expected.requestedQty, cartQuantity: row.requestedQty,
    });
    if (owned.has(key)) throw cleanupError("DUPLICATE_CART_OPTION_ROW", {
      productId: row.productId, optionId: expected.optionId, cartOption: row.optionText,
    });
    owned.set(key, row);
  }
  return owned;
}

/** Keep page-local ownership across retries of the same logged-in operation. */
function createNewProductOptionProbe(config, { listUrl, sourcePage, products, onProgress = () => {} }) {
  const hints = new Map();
  const productsWithHints = new Set();
  const optionProducts = [];
  for (const product of products) {
    const options = getDetailOptionHints(product);
    if (!options.length && product.hasOptionHint !== true) continue;
    const productId = String(product.productId);
    if (options.length) productsWithHints.add(productId);
    for (const option of options) {
      const row = { sourceMall: config.mall, categoryCode: config.category, productId,
        productName: product.productName, productUrl: product.productUrl, hasOption: true,
        optionId: String(option.optionId), optionText: option.optionName, barcode: null,
        ...(product.isSoldOut ? { isSoldOut: true, stockStatus: "OUT_OF_STOCK" } : {}) };
      hints.set(optionKey(row), row);
    }
    if (!product.isSoldOut) {
      // Use the authenticated listing values for stock and purchase controls.
      optionProducts.push({ productId, page: sourcePage, quantity: 1 });
    }
  }

  const eligible = new Set(optionProducts.map(product => product.productId));
  const cartConfig = { ...config, listUrl, anonymousCollection: false, optionCartQty: 1, cartQty: 1 };
  const cartEndpoint = new URL("/order/ajaxCartAddCheck.php", config.baseUrl);
  const matchesCartEndpoint = url => url.pathname === cartEndpoint.pathname &&
    url.hostname.replace(/^www\./i, "") === cartEndpoint.hostname.replace(/^www\./i, "");
  const pending = new Map();
  let baseline;
  let completed;

  async function checkActive(connection) {
    throwIfAborted(connection.signal);
    await connection.monitor?.check();
    throwIfAborted(connection.signal);
  }

  async function readCart(connection, { observeStock = false } = {}) {
    await checkActive(connection);
    const html = await readCartHtml(connection.page, cartConfig, { observeStock });
    if (!parseLoginState(html).loggedIn) {
      throw Object.assign(new Error("장바구니에서 천유 로그인 상태를 확인하지 못했습니다."),
        { code: "CHEONYU_LOGIN_REQUIRED" });
    }
    return checkedCartRows(parseCartHtml(html, cartConfig, { requireTable: true, observeStock }));
  }

  async function cleanup(connection, current) {
    if (!pending.size) return;
    let owned = findOwnedRows(current || await readCart(connection), baseline, pending);
    if (!current && !owned.size) {
      // The old request may have reached the server shortly before its connection closed.
      await sleepWithSignal(500, connection.signal);
      owned = findOwnedRows(await readCart(connection), baseline, pending);
    }
    if (owned.size) {
      await checkActive(connection);
      await clearCartByCartIds(connection.context, Array.from(owned.values(), cartRowId), cartConfig);
      const remaining = findOwnedRows(await readCart(connection), baseline, pending);
      if (remaining.size) throw cleanupError("CART_ROWS_REMAIN_AFTER_DELETE", {
        remainingCount: remaining.size,
      });
    }
    pending.clear();
  }

  function isIdentifiedOption(row) {
    const productId = String(row.productId);
    const optionId = String(row.optionId);
    return eligible.has(productId) && row.hasOption === true && /^\d+$/.test(optionId) && optionId !== "0" &&
      (!productsWithHints.has(productId) || hints.has(optionKey(row)));
  }

  function rememberSubmission(ids, popupRows) {
    const observed = new Map();
    const usedCartKeys = new Set(Array.from(pending.values()).flatMap(row => row.cartMatchKeys));
    const submitted = new Set(ids.map(String));
    const valid = popupRows.length > 0 && popupRows.every(row => {
      const identity = optionKey(row);
      if (!submitted.has(String(row.productId)) || !isIdentifiedOption(row) || !row.complete ||
          !row.optionText || row.requestedQty !== 1 ||
          pending.has(identity) || observed.has(identity)) return false;

      // The cart may omit the stock note attached to this option on the detail page.
      const detail = hints.get(identity);
      const cartMatchKeys = new Set([cartKey(row)]);
      if (detail?.optionText) {
        cartMatchKeys.add(cartKey(detail));
        const name = String(detail.optionText).normalize("NFKC")
          .replace(/\s*\(\s*현\s*재고\s*\d+(?:,\d{3})*\s*개\s*\)\s*$/, "").trim();
        if (name) cartMatchKeys.add(createCartOptionMatchKey(detail.productId, name));
      }
      for (const key of cartMatchKeys) {
        if (usedCartKeys.has(key)) return false;
        usedCartKeys.add(key);
      }
      observed.set(identity, { ...row, cartMatchKeys: [...cartMatchKeys], detailOption: detail?.optionText });
      return true;
    });
    if (!valid || new Set(popupRows.map(row => String(row.productId))).size !== submitted.size) {
      throw new Error("상세·팝업 옵션을 고유하게 대조하지 못했습니다. 장바구니에는 담지 않습니다.");
    }
    for (const [key, row] of observed) pending.set(key, row);
  }

  async function readOptions(connection) {
    if (completed) return completed;
    if (!optionProducts.length) return { inventoryItems: Array.from(hints.values()), popupOptionItems: [] };
    try {
      await cleanup(connection);
      baseline = await readCart(connection);
      if (Array.from(baseline.values()).some(row => eligible.has(String(row.productId)))) {
        throw new Error("새 상품 수집 대상이 이미 장바구니에 있습니다. 해당 행의 수량을 보호하기 위해 옵션 수집을 중단합니다.");
      }
      onProgress({ stage: "inventory", message: `새 옵션 상품 ${optionProducts.length}개의 장바구니 바코드를 확인합니다.` });
      // The site's initial bulk click can ask the browser to jump straight to
      // step 6. Permit that write only once we have verified the popup rows.
      const rejected = new AbortController();
      const operationSignal = connection.signal ? AbortSignal.any([connection.signal, rejected.signal]) : rejected.signal;
      let authorizedSubmission;
      const guard = async route => {
        const request = route.request();
        const data = new URLSearchParams(request.postData() || "");
        const url = new URL(request.url());
        if (!operationSignal.aborted && request.method() === "POST" &&
            url.protocol === cartEndpoint.protocol && url.port === cartEndpoint.port) {
          if (isCartHandshake(data, eligible)) return route.fallback();
          if (data.get("stepCode") === "6" && data.getAll("stepCode").length === 1 &&
              data.getAll("addStr").length === 1 && data.getAll("cartCode").length <= 1 &&
              matchesSubmission(data.get("addStr"), authorizedSubmission) &&
              Array.from(data.keys()).every(key => ["stepCode", "cartCode", "addStr"].includes(key))) {
            authorizedSubmission = undefined;
            return route.fallback();
          }
        }
        rejected.abort(new Error("확인하지 않은 장바구니 담기 요청을 차단했습니다."));
        await route.abort();
      };
      await connection.page.route(matchesCartEndpoint, guard);
      let result;
      try {
        result = await addProductsFromListPagesToCart(connection.page, optionProducts, {
          ...cartConfig,
          onCartSubmission: async (ids, rows, popupRows) => {
            await checkActive(connection);
            throwIfAborted(operationSignal);
            const plan = submissionPlan(rows, popupRows.filter(isIdentifiedOption));
            rememberSubmission(ids, rows);
            authorizedSubmission = plan;
          },
        }, () => {}, operationSignal);
        if (rejected.signal.aborted) throw rejected.signal.reason;
      } catch (error) {
        throw rejected.signal.reason || error;
      } finally {
        await connection.page.unroute(matchesCartEndpoint, guard).catch(() => {});
      }
      const batches = result.pageResults.map(page => page.bulkResult);
      if (batches.some(batch => batch.excludedProductIds?.length)) {
        throw new Error("새 상품 목록에서 옵션 팝업을 확인하지 못했습니다.");
      }
      const unavailable = new Set(batches.flatMap(batch => batch.unavailableProductIds || []).map(String));
      const popupOptionItems = batches.flatMap(batch => batch.popupOptionRows)
        .filter(isIdentifiedOption);
      const popupInventory = createCheonyuPopupInventoryItems({ products, popupOptionRows: popupOptionItems,
        directProductIds: Array.from(eligible), config });
      const byOption = new Map(popupInventory.map(row => [optionKey(row), row]));
      const observedProducts = new Set(popupInventory.map(row => String(row.productId)));
      const missingOption = Array.from(hints.values()).find(row =>
        eligible.has(row.productId) && !unavailable.has(row.productId) && !byOption.has(optionKey(row)));
      if (missingOption) {
        throw new Error(`상품 ${missingOption.productId} 옵션 ${missingOption.optionId}의 팝업 정보를 확인하지 못했습니다.`);
      }
      for (const productId of eligible) {
        if (!unavailable.has(productId) && !observedProducts.has(productId)) {
          throw new Error(`상품 ${productId}의 옵션 정보를 확인하지 못했습니다.`);
        }
      }
      let cart;
      let owned = new Map();
      for (let attempt = 0; pending.size && attempt < 3; attempt++) {
        if (attempt) await sleepWithSignal(500, connection.signal);
        cart = await readCart(connection, { observeStock: true });
        owned = findOwnedRows(cart, baseline, pending);
        if (owned.size === pending.size) break;
      }
      const cartInventory = [];
      for (const [key, popup] of pending) {
        const row = owned.get(key);
        const inventory = byOption.get(key);
        if (!row || !inventory || !/^\d{13}$/.test(String(row.barcode || ""))) {
          throw new Error(`상품 ${popup.productId} 옵션 ${popup.optionId}의 장바구니 바코드를 확인하지 못했습니다.`);
        }
        const latestStock = row.observedMaxStock;
        const stock = latestStock == null ? {} : {
          maxStock: latestStock,
          isSoldOut: latestStock === 0,
          stockLimited: row.requestedQty > latestStock,
          stockStatus: normalizeStockStatus({ maxStock: latestStock, stockLimited: row.requestedQty > latestStock,
            lowStockThreshold: config.lowStockThreshold }),
        };
        if (latestStock != null && latestStock !== inventory.maxStock) {
          recordDiagnostic("new-product-cart-stock-changed", { ...describeDiagnosticPage(connection.page), sourcePage,
            productId: row.productId, optionId: popup.optionId, popupStock: inventory.maxStock, cartStock: latestStock });
        }
        cartInventory.push({ ...inventory, ...stock, barcode: row.barcode, rowSource: "cart" });
      }
      await cleanup(connection, cart);
      const merged = mergeCheonyuDetailInventoryItems(popupInventory, cartInventory);
      const observed = new Set(merged.map(optionKey));
      completed = { inventoryItems: [...merged, ...Array.from(hints.values()).filter(row => !observed.has(optionKey(row)))],
        popupOptionItems };
      return completed;
    } catch (error) {
      let failure = error;
      if (pending.size && !connection.signal?.aborted && !isRecoverableStickySessionError(error) &&
          !isTerminalStickyConnectionError(error)) {
        try {
          await cleanup(connection);
        } catch (cleanupFailure) {
          if (connection.signal?.aborted || isRecoverableStickySessionError(cleanupFailure) ||
              isTerminalStickyConnectionError(cleanupFailure)) throw cleanupFailure;
          failure = cleanupFailure?.code === "CART_CLEANUP_INCOMPLETE"
            ? cleanupFailure
            : cleanupError("CART_CLEANUP_FAILED", {}, cleanupFailure);
        }
      }
      if (failure?.code === "CART_CLEANUP_INCOMPLETE") {
        recordDiagnostic("new-product-cart-cleanup-failed", {
          ...describeDiagnosticPage(connection.page), sourcePage, ...failure.details, error: failure.cause,
        });
      }
      throw failure;
    }
  }

  readOptions.hasPendingCart = () => pending.size > 0;
  return readOptions;
}

module.exports = { createNewProductOptionProbe, getDetailOptionHints };

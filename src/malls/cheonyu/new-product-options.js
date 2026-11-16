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
  // The popup serializes empty groups even after all their checkboxes are cleared.
  const groups = new Set(popupRows.filter(row => row.productId && row.cartGroupId).map(row => String(row.cartGroupId)));
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

function inspectCartRows(current, before, pending, protectedProducts) {
  for (const [id, previous] of before) {
    const row = current.get(id);
    if (!row || cartKey(row) !== cartKey(previous) || row.requestedQty !== previous.requestedQty) {
      throw cleanupError("EXISTING_CART_ROW_CHANGED", {
        productId: previous.productId, expectedQuantity: previous.requestedQty, cartQuantity: row?.requestedQty,
      });
    }
  }
  const submittedByProduct = new Map();
  const optionByCartKey = new Map();
  for (const [key, option] of pending) {
    const productId = String(option.productId);
    if (!submittedByProduct.has(productId)) submittedByProduct.set(productId, []);
    submittedByProduct.get(productId).push(option);
    for (const nameKey of option.cartMatchKeys) optionByCartKey.set(nameKey, key);
  }

  const owned = new Map();
  const presentProducts = new Set();
  const issues = [];
  const uncertainProducts = new Set(protectedProducts);
  for (const [id, row] of current) {
    const productId = String(row.productId);
    if (before.has(id) || !submittedByProduct.has(productId)) continue;
    presentProducts.add(productId);
    const key = optionByCartKey.get(cartKey(row));
    const expected = pending.get(key);
    const reason = { productId, cartOption: row.optionText, cartBarcode: row.barcode || undefined };
    if (!expected) {
      reason.code = "CART_OPTION_LABEL_MISMATCH";
      reason.expectedOptions = submittedByProduct.get(productId).map(({ optionId, optionText, detailOption }) =>
        ({ optionId, popupOption: optionText, detailOption }));
    } else {
      Object.assign(reason, { optionId: expected.optionId, popupOption: expected.optionText, detailOption: expected.detailOption });
      if (row.requestedQty !== expected.requestedQty) {
        Object.assign(reason, { code: "CART_OPTION_QUANTITY_MISMATCH", expectedQuantity: expected.requestedQty,
          cartQuantity: row.requestedQty });
      } else if (owned.has(key)) {
        reason.code = "DUPLICATE_CART_OPTION_ROW";
      }
    }
    if (reason.code) {
      issues.push(reason);
      uncertainProducts.add(productId);
    } else {
      owned.set(key, row);
    }
  }
  // One unverified row makes the purchase variants for that product uncertain.
  for (const [key, row] of owned) {
    if (uncertainProducts.has(String(row.productId))) owned.delete(key);
  }
  return { owned, issues, presentProducts, uncertainProducts };
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
  const review = new Map();
  const protectedCartProducts = new Set();
  const productsById = new Map(products.map(product => [String(product.productId), product]));
  let baseline;
  let completed;

  function deferProduct(productId, reason) {
    const product = productsById.get(productId);
    if (!review.has(productId)) {
      review.set(productId, { productId, productName: product.productName, productUrl: product.productUrl,
        sourcePage, sourceMonth: product.sourceMonth, listUrl, reasons: [], cartRowsRemain: false });
    }
    const item = review.get(productId);
    const key = JSON.stringify(reason);
    if (item.reasons.some(existing => JSON.stringify(existing) === key)) return;
    item.reasons.push(reason);
    recordDiagnostic("new-product-option-review", { productId, sourcePage, sourceMonth: product.sourceMonth, ...reason });
  }

  function recordCartIssues(analysis) {
    for (const productId of analysis.uncertainProducts) protectedCartProducts.add(productId);
    for (const { productId, ...reason } of analysis.issues) deferProduct(productId, reason);
    for (const productId of new Set(Array.from(pending.values(), row => String(row.productId)))) {
      if (review.has(productId)) review.get(productId).cartRowsRemain = analysis.presentProducts.has(productId);
    }
  }

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

  async function cleanup(connection, current, analysis) {
    if (!pending.size) return;
    let initial = analysis || inspectCartRows(current || await readCart(connection), baseline, pending, protectedCartProducts);
    if (!current && !initial.owned.size) {
      // The old request may have reached the server shortly before its connection closed.
      await sleepWithSignal(500, connection.signal);
      initial = inspectCartRows(await readCart(connection), baseline, pending, protectedCartProducts);
    }
    recordCartIssues(initial);
    if (initial.owned.size) {
      const ids = Array.from(initial.owned.values(), cartRowId);
      await checkActive(connection);
      await clearCartByCartIds(connection.context, ids, cartConfig);
      const snapshot = await readCart(connection);
      const remaining = inspectCartRows(snapshot, baseline, pending, protectedCartProducts);
      recordCartIssues(remaining);
      if (remaining.owned.size || ids.some(id => snapshot.has(id))) {
        throw cleanupError("CART_ROWS_REMAIN_AFTER_DELETE", { remainingCount: remaining.owned.size });
      }
    }
    pending.clear();
  }

  function isIdentifiedOption(row) {
    const productId = String(row.productId);
    const optionId = String(row.optionId);
    return eligible.has(productId) && row.hasOption === true && /^\d+$/.test(optionId) && optionId !== "0" &&
      (!productsWithHints.has(productId) || hints.has(optionKey(row)));
  }

  function rememberSubmission(ids, selectedRows, popupRows) {
    const observed = new Map();
    const usedCartKeys = new Map();
    for (const option of pending.values()) {
      for (const key of option.cartMatchKeys) usedCartKeys.set(key, option);
    }
    const submitted = new Set(ids.map(String));
    const selectedProductIds = new Set();
    for (const row of selectedRows) {
      const productId = String(row.productId);
      const identity = optionKey(row);
      if (!submitted.has(productId) || !eligible.has(productId) || row.requestedQty !== 1) {
        throw new Error("장바구니에 담을 상품 또는 수량을 확인하지 못했습니다.");
      }
      selectedProductIds.add(productId);
      const detail = hints.get(identity);
      const names = { optionId: row.optionId, popupOption: row.optionText, detailOption: detail?.optionText };
      if (!isIdentifiedOption(row) || !row.complete || !row.optionText) {
        deferProduct(productId, { code: "POPUP_OPTION_ID_MISMATCH", ...names });
        continue;
      }

      const cartMatchKeys = new Set([cartKey(row)]);
      if (detail?.optionText) {
        cartMatchKeys.add(cartKey(detail));
        const name = String(detail.optionText).normalize("NFKC")
          .replace(/\s*\(\s*현\s*재고\s*\d+(?:,\d{3})*\s*개\s*\)\s*$/, "").trim();
        if (name) cartMatchKeys.add(createCartOptionMatchKey(detail.productId, name));
      }
      const conflict = pending.get(identity) || observed.get(identity) ||
        Array.from(cartMatchKeys).map(key => usedCartKeys.get(key)).find(Boolean);
      if (conflict) {
        deferProduct(productId, { code: "AMBIGUOUS_OPTION_LABEL", ...names, expectedOptions: [
          { optionId: conflict.optionId, popupOption: conflict.optionText, detailOption: conflict.detailOption },
        ] });
        continue;
      }
      const option = { ...row, cartMatchKeys: [...cartMatchKeys], detailOption: detail?.optionText };
      observed.set(identity, option);
      for (const key of cartMatchKeys) usedCartKeys.set(key, option);
    }
    if (selectedProductIds.size !== submitted.size) throw new Error("장바구니에 담을 옵션을 확인하지 못했습니다.");

    const approved = selectedRows.filter(row => !review.has(String(row.productId)));
    const plan = approved.length ? submissionPlan(approved, popupRows) : undefined;
    for (const [key, row] of observed) {
      if (!review.has(String(row.productId))) pending.set(key, row);
    }
    return { plan, excludedProductIds: [...submitted].filter(id => review.has(id)) };
  }

  async function readOptions(connection) {
    if (completed) return completed;
    if (!optionProducts.length) return { inventoryItems: Array.from(hints.values()), popupOptionItems: [] };
    try {
      await cleanup(connection);
      baseline = await readCart(connection);
      for (const row of baseline.values()) {
        const productId = String(row.productId);
        if (!eligible.has(productId)) continue;
        if (!review.has(productId)) deferProduct(productId, { code: "CART_PRODUCT_ALREADY_PRESENT", cartOption: row.optionText });
        review.get(productId).cartRowsRemain = true;
      }
      const requested = optionProducts.filter(product => !review.has(product.productId));
      if (!requested.length) {
        completed = { inventoryItems: Array.from(hints.values()).filter(row => !review.has(row.productId)),
          popupOptionItems: [], optionReviewItems: Array.from(review.values()) };
        return completed;
      }
      const requestedIds = new Set(requested.map(product => product.productId));
      onProgress({ stage: "inventory", message: `새 옵션 상품 ${requested.length}개의 장바구니 바코드를 확인합니다.` });
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
          if (isCartHandshake(data, requestedIds)) return route.fallback();
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
        result = await addProductsFromListPagesToCart(connection.page, requested, {
          ...cartConfig,
          onCartSubmission: async (ids, rows, popupRows) => {
            await checkActive(connection);
            throwIfAborted(operationSignal);
            const { plan, excludedProductIds } = rememberSubmission(ids, rows, popupRows);
            authorizedSubmission = plan;
            return excludedProductIds;
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
      for (const hint of hints.values()) {
        const productId = hint.productId;
        if (requestedIds.has(productId) && !review.has(productId) && !unavailable.has(productId) && !byOption.has(optionKey(hint))) {
          deferProduct(productId, { code: "POPUP_OPTION_ID_MISMATCH", optionId: hint.optionId, detailOption: hint.optionText });
        }
      }
      for (const productId of requestedIds) {
        if (!review.has(productId) && !unavailable.has(productId) && !observedProducts.has(productId)) {
          deferProduct(productId, { code: "POPUP_OPTION_ID_MISMATCH" });
        }
      }

      let cart, analysis;
      for (let attempt = 0; pending.size && attempt < 3; attempt++) {
        if (attempt) await sleepWithSignal(500, connection.signal);
        cart = await readCart(connection, { observeStock: true });
        analysis = inspectCartRows(cart, baseline, pending, protectedCartProducts);
        if (Array.from(pending.entries()).every(([key, row]) =>
          analysis.owned.has(key) || analysis.uncertainProducts.has(String(row.productId)))) break;
      }
      if (analysis) recordCartIssues(analysis);
      const cartInventory = [];
      for (const [key, popup] of pending) {
        const productId = String(popup.productId);
        if (analysis.uncertainProducts.has(productId)) continue;
        const row = analysis.owned.get(key);
        const inventory = byOption.get(key);
        if (!row || !inventory || !/^\d{13}$/.test(String(row.barcode || ""))) {
          deferProduct(productId, { code: row && inventory ? "MISSING_OPTION_BARCODE" : "MISSING_CART_OPTION",
            optionId: popup.optionId, popupOption: popup.optionText, detailOption: popup.detailOption, cartOption: row?.optionText });
          continue;
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
      await cleanup(connection, cart, analysis);
      const merged = mergeCheonyuDetailInventoryItems(popupInventory, cartInventory);
      const observed = new Set(merged.map(optionKey));
      completed = {
        inventoryItems: [...merged, ...Array.from(hints.values()).filter(row => !observed.has(optionKey(row)))]
          .filter(row => !review.has(String(row.productId))),
        popupOptionItems: popupOptionItems.filter(row => !review.has(String(row.productId))),
        optionReviewItems: Array.from(review.values()),
      };
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

// src/malls/cheonyu/cart-stock.js

const {
  sleep,
  throwIfAborted,
} = require("../../utils/common");
const {
  sortInventoryItems,
} = require("../../utils/inventory");
const {
  clearCartAll,
  clearCartByCartIds,
  parseCartHtml,
  readCartHtml,
} = require("./cart");
const {
  addProductsFromListPagesToCart,
  findCheonyuProductsByIds,
} = require("./site");

/** 동일 상품의 옵션 요청을 상품 단위로 묶는다. */
function groupCheonyuRequestsByProduct(items) {
  const map = new Map();

  for (const item of items || []) {
    const productId = String(item?.productId || "").trim();
    const optionId = String(item?.optionId ?? "0").trim();
    const quantity = Math.max(1, Math.trunc(Number(item?.quantity) || 1));

    if (!productId) continue;

    if (!map.has(productId)) {
      map.set(productId, []);
    }

    map.get(productId).push({
      productId,
      optionId,
      quantity,
    });
  }

  return map;
}

function normalizeCoverageText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** 팝업과 장바구니에서 다르게 표현되는 옵션 구분자·괄호를 같은 키로 맞춘다. */
function normalizeCoverageOptionText(value) {
  return normalizeCoverageText(value)
    .normalize("NFKC")
    .replace(/[／｜＞]/g, (token) => ({ "／": "/", "｜": "|", "＞": ">" })[token])
    .replace(/\s*[\/|>]\s*/g, " ")
    .replace(/[\[\](){}【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function createCartOptionMatchKey(productId, optionText) {
  return `${normalizeCoverageText(productId)}::${normalizeCoverageOptionText(optionText) || "0"}`;
}

function createCoverageRowKey(row) {
  const productId = normalizeCoverageText(row?.productId);

  if (row?.hasOption !== true) {
    return `${productId}::SINGLE`;
  }

  const optionId = normalizeCoverageText(row?.optionId);
  const optionText = normalizeCoverageOptionText(row?.optionText);
  const hasStableOptionId = optionId && optionId !== "0";
  const optionIdentity = hasStableOptionId
    ? `ID:${optionId}`
    : optionText
      ? `TEXT:${optionText}`
      : "UNKNOWN";

  return `${productId}::OPTION:${optionIdentity}`;
}

function countCoverageRows(rows) {
  const counts = new Map();

  for (const row of rows) {
    const key = createCoverageRowKey(row);
    if (!key || key.startsWith("::")) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

function analyzeCheonyuCartCoverage({
  products = [],
  popupOptionRows = [],
  inventoryItems = [],
  unavailableProductIds = [],
} = {}) {
  const unavailableIds = new Set(
    unavailableProductIds.map((productId) => String(productId)),
  );
  const expectedProductIds = Array.from(new Set(
    products
      .map((product) => String(product?.productId || "").trim())
      .filter((productId) => productId && !unavailableIds.has(productId)),
  ));
  const expectedProductIdSet = new Set(expectedProductIds);
  const actualProductIds = Array.from(new Set(
    inventoryItems
      .map((item) => String(item?.productId || "").trim())
      .filter((productId) => expectedProductIdSet.has(productId)),
  ));
  const actualProductIdSet = new Set(actualProductIds);
  const missingProductIds = expectedProductIds.filter(
    (productId) => !actualProductIdSet.has(productId),
  );
  const expectedRows = popupOptionRows.filter((row) =>
    row?.selectedForCart === true &&
    expectedProductIdSet.has(String(row?.productId || "").trim()),
  );
  const actualRows = inventoryItems.filter((row) =>
    expectedProductIdSet.has(String(row?.productId || "").trim()),
  );
  const rowCoverageAvailable = expectedRows.length > 0;
  const expectedRowCounts = countCoverageRows(expectedRows);
  const actualRowCounts = countCoverageRows(actualRows);
  const missingOptionRows = [];
  const extraOptionRows = [];

  if (rowCoverageAvailable) {
    const allRowKeys = new Set([
      ...expectedRowCounts.keys(),
      ...actualRowCounts.keys(),
    ]);

    for (const key of allRowKeys) {
      const expected = expectedRowCounts.get(key) || 0;
      const actual = actualRowCounts.get(key) || 0;

      if (actual < expected) {
        missingOptionRows.push({
          key,
          expected,
          actual,
          missing: expected - actual,
        });
      } else if (actual > expected) {
        extraOptionRows.push({
          key,
          expected,
          actual,
          extra: actual - expected,
        });
      }
    }
  }

  const missingProductIdSet = new Set(missingProductIds);
  const partialProductIds = Array.from(new Set(
    [...missingOptionRows, ...extraOptionRows]
      .map((item) => item.key.split("::", 1)[0])
      .filter((productId) =>
        productId && !missingProductIdSet.has(productId),
      ),
  ));
  const optionCoverageComplete =
    missingOptionRows.length === 0 && extraOptionRows.length === 0;

  return {
    complete: missingProductIds.length === 0,
    optionCoverageComplete,
    expectedProductCount: expectedProductIds.length,
    actualProductCount: actualProductIds.length,
    expectedRowCount: rowCoverageAvailable ? expectedRows.length : null,
    actualRowCount: actualRows.length,
    rowCoverageAvailable,
    expectedProductIds,
    actualProductIds,
    missingProductIds,
    partialProductIds,
    missingOptionRows,
    extraOptionRows,
    unavailableProductIds: Array.from(unavailableIds),
  };
}

/** 상품번호·옵션번호·수량으로 천유 장바구니에 실제로 담는다. */
async function addCheonyuProductsToCart(
  page,
  context,
  config,
  products,
  {
    clearBefore = false,
    onProgress = () => {},
    signal,
  } = {},
) {
  throwIfAborted(signal);

  if (!Array.isArray(products) || products.length < 1) {
    throw new Error("장바구니에 담을 천유 상품이 없습니다.");
  }

  if (clearBefore) {
    onProgress({
      stage: "cart",
      message: "천유 기존 장바구니를 정리하고 있습니다.",
    });
    await clearCartAll(page, context, config);
  }

  const grouped = groupCheonyuRequestsByProduct(products);
  const productIds = Array.from(grouped.keys());
  const foundProducts = await findCheonyuProductsByIds(
    page,
    productIds,
    config,
    onProgress,
    signal,
  );
  const foundMap = new Map(
    foundProducts.map((product) => [String(product.productId), product]),
  );
  const missingProductIds = productIds.filter(
    (productId) => !foundMap.has(productId),
  );
  const resolvedProducts = productIds.flatMap((productId) => {
    const found = foundMap.get(productId);

    if (!found) {
      return [];
    }

    return [{
      ...found,
      productId,
      cartRequests: grouped.get(productId),
    }];
  });

  if (missingProductIds.length > 0) {
    const message =
      `천유 상품번호 탐색에서 ${missingProductIds.length}개를 찾지 못해 ` +
      `해당 상품만 제외합니다. (${missingProductIds.slice(0, 10).join(", ")})`;
    console.warn(`[WARN] ${message}`);
    onProgress({
      stage: "cart-product-excluded",
      level: "warn",
      message,
      productIds: missingProductIds,
    });
  }

  if (resolvedProducts.length < 1) {
    throw new Error(
      "천유 장바구니 대상 상품을 하나도 찾지 못했습니다. 목록 HTML 구조를 확인해야 합니다.",
    );
  }

  onProgress({
    stage: "cart",
    message: `천유 상품 ${resolvedProducts.length}개를 실제 장바구니에 담고 있습니다.`,
  });

  const addResult = await addProductsFromListPagesToCart(
    page,
    resolvedProducts,
    config,
    onProgress,
    signal,
  );

  return {
    requestedProducts: products,
    resolvedProducts,
    ...addResult,
    unavailableProductIds: Array.from(new Set([
      ...missingProductIds,
      ...(addResult.unavailableProductIds || []).map(String),
    ])),
  };
}

/** 장바구니에서 지정 상품의 재고 row를 읽는다. */
async function probeCheonyuCartStock(
  page,
  context,
  config,
  products,
  {
    probeQty = 999,
    clearAfter = false,
    onProgress = () => {},
    signal,
    popupOptionRows = [],
    unavailableProductIds = [],
  } = {},
) {
  throwIfAborted(signal);

  onProgress({
    stage: "inventory",
    message: "천유 장바구니에서 실제 구매 가능 재고를 파싱하고 있습니다.",
  });

  const unavailableIdSet = new Set(
    unavailableProductIds.map((productId) => String(productId)),
  );
  const targetIds = new Set(
    products
      .map((item) => String(item.productId))
      .filter((productId) => !unavailableIdSet.has(productId)),
  );
  const popupMap = new Map();

  for (const row of popupOptionRows || []) {
    if (row?.selectedForCart !== true) continue;
    const productId = String(row.productId || "").trim();
    const optionText = String(row.optionText || "").trim();
    const key = createCartOptionMatchKey(productId, optionText);

    if (!productId) continue;
    if (!popupMap.has(key)) {
      popupMap.set(key, []);
    }
    popupMap.get(key).push(row);
  }
  const maxReadAttempts = Math.max(
    1,
    Math.min(5, Math.trunc(Number(config.cartCoverageReadAttempts) || 3)),
  );
  const retryDelayMs = Math.max(
    500,
    Math.min(10000, Number(config.cartCoverageRetryDelayMs) || 2000),
  );
  let cartHtml = "";
  let inventoryItems = [];
  let coverage = null;

  if (targetIds.size < 1) {
    coverage = analyzeCheonyuCartCoverage({
      products,
      popupOptionRows,
      inventoryItems,
      unavailableProductIds,
    });
    return {
      cartHtml,
      inventoryItems,
      clearAfterResult: null,
      probeQty,
      coverage,
    };
  }

  for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
    throwIfAborted(signal);
    cartHtml = await readCartHtml(page, config);
    const allCartItems = parseCartHtml(cartHtml, {
      ...config,
      cartQty: probeQty,
    }, {
      requireTable: true,
    });
    const popupMatchIndexes = new Map();

    inventoryItems = sortInventoryItems(
      allCartItems
        .filter((item) => targetIds.has(String(item.productId)))
        .map((item) => {
          const productId = String(item.productId || "").trim();
          const optionText = String(item.optionText || "").trim();
          const key = createCartOptionMatchKey(productId, optionText);
          const candidates = popupMap.get(key) || [];
          const candidateIndex = popupMatchIndexes.get(key) || 0;
          const popupRow =
            candidates[candidateIndex] || candidates[candidates.length - 1];

          if (popupRow) {
            popupMatchIndexes.set(key, candidateIndex + 1);
            return {
              ...item,
              optionId: popupRow.optionId ?? item.optionId,
              submitOptionId: popupRow.submitOptionId ?? item.submitOptionId,
              hasOption: popupRow.hasOption ?? item.hasOption,
              productName: popupRow.productName || item.productName,
            };
          }

          return item;
        }),
    );
    coverage = analyzeCheonyuCartCoverage({
      products,
      popupOptionRows,
      inventoryItems,
      unavailableProductIds,
    });

    if (coverage.complete) {
      break;
    }

    const missingPreview = coverage.missingProductIds.slice(0, 10).join(", ");
    console.warn(
      `[WARN] [CHEONYU CART] incomplete coverage ` +
      `${coverage.actualProductCount}/${coverage.expectedProductCount} products ` +
      `(attempt ${attempt}/${maxReadAttempts}), ` +
      `missing ${coverage.missingProductIds.length}` +
      (missingPreview ? ` (${missingPreview})` : ""),
    );

    if (attempt < maxReadAttempts) {
      onProgress({
        stage: "inventory-retry",
        message:
          `장바구니 반영을 재확인하고 있습니다. ` +
          `${coverage.actualProductCount}/${coverage.expectedProductCount}상품`,
        attempt,
        maxAttempts: maxReadAttempts,
        coverage,
      });
      await sleep(retryDelayMs);
    }
  }

  if (!coverage?.complete) {
    const expectedRows = coverage?.expectedRowCount;
    const actualRows = coverage?.actualRowCount ?? inventoryItems.length;
    const rowSummary = expectedRows === null
      ? `${actualRows} rows`
      : `${actualRows}/${expectedRows} rows`;
    const missingPreview = (coverage?.missingProductIds || [])
      .slice(0, 10)
      .join(", ");

    const message =
      `천유 장바구니 부분 수집 결과를 유지하고 계속 진행합니다: ` +
      `${coverage?.actualProductCount || 0}/${coverage?.expectedProductCount || 0}상품, ` +
      `${rowSummary}, 누락 상품 ${coverage?.missingProductIds?.length || 0}개, ` +
      `옵션 불일치 ${coverage?.partialProductIds?.length || 0}상품` +
      (missingPreview ? ` (${missingPreview})` : "");
    console.warn(`[WARN] ${message}`);
    onProgress({
      stage: "inventory-partial",
      level: "warn",
      message,
      coverage,
    });
  }

  let clearAfterResult = null;

  if (clearAfter) {
    const cartIds = inventoryItems
      .map((item) => item.cartCheckId || item.inPIDX)
      .filter(Boolean);
    clearAfterResult = await clearCartByCartIds(context, cartIds, config);
  }

  return {
    cartHtml,
    inventoryItems,
    clearAfterResult,
    probeQty,
    coverage,
  };
}

/** 장바구니 담기와 재고 파싱을 연속 실행한다. */
async function collectCheonyuCartStock(
  page,
  context,
  config,
  products,
  {
    quantity = 999,
    clearBefore = false,
    clearAfter = false,
    onProgress = () => {},
    signal,
  } = {},
) {
  const normalizedProducts = products.map((item) => ({
    ...item,
    quantity: item.quantity || quantity,
  }));

  const addResult = await addCheonyuProductsToCart(
    page,
    context,
    config,
    normalizedProducts,
    {
      clearBefore,
      onProgress,
      signal,
    },
  );
  const bulkResults = (addResult.pageResults || [])
    .map((item) => item.bulkResult)
    .filter(Boolean);
  const popupOptionRows = bulkResults.flatMap(
    (result) => result.popupOptionRows || [],
  );
  const unavailableProductIds = Array.from(new Set(
    [
      ...(addResult.unavailableProductIds || []),
      ...bulkResults.flatMap(
        (result) => result.unavailableProductIds || [],
      ),
    ].map(String),
  ));

  return probeCheonyuCartStock(
    page,
    context,
    config,
    normalizedProducts,
    {
      probeQty: quantity,
      clearAfter,
      onProgress,
      signal,
      popupOptionRows,
      unavailableProductIds,
    },
  );
}

function createCheonyuPopupInventoryItems({
  products = [],
  popupOptionRows = [],
  directProductIds = [],
  config = {},
} = {}) {
  const directProductIdSet = new Set(directProductIds.map((id) => String(id)));
  const productMap = new Map(
    products.map((product) => [String(product.productId || ""), product]),
  );
  const inventoryMap = new Map();

  for (const row of popupOptionRows) {
    const productId = String(row.productId || "");
    if (!directProductIdSet.has(productId) || row.complete !== true) continue;

    const product = productMap.get(productId) || {};
    const optionId = String(row.optionId ?? "0") || "0";
    const submitOptionId = String(row.submitOptionId ?? optionId) || optionId;
    const optionText = String(row.optionText || "").trim();
    const inventoryKey = `${productId}::${optionId}::${submitOptionId}::${optionText}`;
    const maxStock = Math.max(0, Math.trunc(Number(row.maxStock) || 0));
    const stockStatus =
      row.stockStatus || (maxStock > 0 ? "IN_STOCK" : "OUT_OF_STOCK");

    inventoryMap.set(inventoryKey, {
      sourceMall: config.mall || "cheonyu",
      categoryCode: config.category,
      cartCheckId: "",
      inPIDX: "",
      productId,
      barcode: product.barcode || null,
      productUrl: product.productUrl || "",
      productName: row.productName || product.productName || "",
      normalizedName:
        product.normalizedName ||
        row.productName ||
        product.productName ||
        "",
      optionText,
      hasOption: row.hasOption === true,
      optionId,
      submitOptionId,
      requestedQty: Math.max(0, Math.trunc(Number(row.requestedQty) || 0)),
      maxStock,
      stockStatus,
      stockLimited: false,
      porderMinus: String(row.porderMinus || ""),
      isSoldOut: maxStock <= 0 || stockStatus === "OUT_OF_STOCK",
      msg: row.disabled === true ? "옵션 선택 비활성화" : "",
      rowSource: "popup-max-stock",
    });
  }

  return Array.from(inventoryMap.values());
}

module.exports = {
  addCheonyuProductsToCart,
  analyzeCheonyuCartCoverage,
  collectCheonyuCartStock,
  createCheonyuPopupInventoryItems,
  groupCheonyuRequestsByProduct,
  probeCheonyuCartStock,
};

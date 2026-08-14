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
const {
  markSiteError,
} = require("../../utils/site-safety");

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

function createCartOptionMatchKey(productId, optionText) {
  return `${normalizeCoverageText(productId)}::${normalizeCoverageText(optionText) || "0"}`;
}

function createCoverageRowKey(row) {
  const productId = normalizeCoverageText(row?.productId);

  if (row?.hasOption !== true) {
    return `${productId}::SINGLE`;
  }

  const optionId = normalizeCoverageText(row?.optionId);
  const optionText = normalizeCoverageText(row?.optionText);
  const optionIdentity = optionText || (optionId ? `ID:${optionId}` : "UNKNOWN");

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
  const resolvedProducts = productIds.map((productId) => {
    const found = foundMap.get(productId);

    if (!found) {
      throw new Error(`천유 상품번호 ${productId}를 찾지 못했습니다.`);
    }

    return {
      ...found,
      productId,
      cartRequests: grouped.get(productId),
    };
  });

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
    const productId = String(row.productId || "").trim();
    const optionText = String(row.optionText || "").trim();
    const key = createCartOptionMatchKey(productId, optionText);

    if (!productId) continue;
    if (!popupMap.has(key)) {
      popupMap.set(key, row);
    }
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

  for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
    throwIfAborted(signal);
    cartHtml = await readCartHtml(page, config);
    const allCartItems = parseCartHtml(cartHtml, {
      ...config,
      cartQty: probeQty,
    });

    inventoryItems = sortInventoryItems(
      allCartItems
        .filter((item) => targetIds.has(String(item.productId)))
        .map((item) => {
          const productId = String(item.productId || "").trim();
          const optionText = String(item.optionText || "").trim();
          const key = createCartOptionMatchKey(productId, optionText);
          const popupRow = popupMap.get(key);

          if (popupRow) {
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

    console.warn(
      `[CHEONYU CART] incomplete coverage ` +
      `${coverage.actualProductCount}/${coverage.expectedProductCount} products ` +
      `(attempt ${attempt}/${maxReadAttempts})`,
      coverage,
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

    throw markSiteError(
      new Error(
        `천유 장바구니 부분 수집: ` +
        `${coverage?.actualProductCount || 0}/${coverage?.expectedProductCount || 0}상품, ` +
        `${rowSummary}, 누락 상품 ${coverage?.missingProductIds?.length || 0}개, ` +
        `옵션 불일치 ${coverage?.partialProductIds?.length || 0}상품` +
        (missingPreview ? ` (${missingPreview})` : ""),
      ),
      {
        retryable: true,
        code: "CHEONYU_CART_COVERAGE_INCOMPLETE",
        stage: "cheonyu-cart-coverage",
        details: coverage,
      },
    );
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
    bulkResults.flatMap(
      (result) => result.unavailableProductIds || [],
    ).map(String),
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

module.exports = {
  addCheonyuProductsToCart,
  analyzeCheonyuCartCoverage,
  collectCheonyuCartStock,
  groupCheonyuRequestsByProduct,
  probeCheonyuCartStock,
};

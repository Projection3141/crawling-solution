// src/malls/cheonyu/cart-stock.js

const {
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
  } = {},
) {
  throwIfAborted(signal);

  onProgress({
    stage: "inventory",
    message: "천유 장바구니에서 실제 구매 가능 재고를 파싱하고 있습니다.",
  });

  const cartHtml = await readCartHtml(page, config);
  const allCartItems = parseCartHtml(cartHtml, {
    ...config,
    cartQty: probeQty,
  });
  const targetIds = new Set(
    products.map((item) => String(item.productId)),
  );

  const popupMap = new Map();
  for (const row of popupOptionRows || []) {
    const productId = String(row.productId || "").trim();
    const optionText = String(row.optionText || "").trim();
    const key = `${productId}::${optionText || "0"}`;

    if (!productId) continue;
    if (!popupMap.has(key)) {
      popupMap.set(key, row);
    }
  }

  const inventoryItems = sortInventoryItems(
    allCartItems
      .filter((item) => targetIds.has(String(item.productId)))
      .map((item) => {
        const productId = String(item.productId || "").trim();
        const optionText = String(item.optionText || "").trim();
        const key = `${productId}::${optionText || "0"}`;
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

  await addCheonyuProductsToCart(
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
    },
  );
}

module.exports = {
  addCheonyuProductsToCart,
  collectCheonyuCartStock,
  groupCheonyuRequestsByProduct,
  probeCheonyuCartStock,
};

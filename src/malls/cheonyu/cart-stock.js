// src/malls/cheonyu/cart-stock.js

const { throwIfAborted } = require("../../utils/common");
const { sortInventoryItems } = require("../../utils/inventory");
const {
  clearCartAll,
  clearCartByCartIds,
  parseCartHtml,
  readCartHtml,
} = require("./cart");
const {
  addProductsFromListPagesToCart,
} = require("./site");

/**
 * 상품 n개를 천유 장바구니에 담는다.
 *
 * products 구조:
 * {
 *   productId,
 *   productUrl,
 *   page
 * }
 */
async function addCheonyuProductsToCart(
  page,
  context,
  config,
  products,
  {
    quantity = 999,
    clearBefore = false,
    onProgress = () => {},
    signal,
  } = {},
) {
  throwIfAborted(signal);

  if (clearBefore) {
    onProgress({
      stage: "cart",
      message: "천유 기존 장바구니를 정리하고 있습니다.",
    });

    await clearCartAll(page, context, config);
  }

  throwIfAborted(signal);

  onProgress({
    stage: "cart",
    message: `천유 상품 ${products.length}개를 장바구니에 담고 있습니다.`,
  });

  return addProductsFromListPagesToCart(
    page,
    products,
    {
      ...config,
      cartQty: quantity,
    },
    onProgress,
    signal,
  );
}

/** 장바구니 HTML에서 지정 상품들의 실제 구매 가능 재고를 파싱한다. */
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
  } = {},
) {
  throwIfAborted(signal);

  onProgress({
    stage: "inventory",
    message: "천유 장바구니에서 실제 구매 가능 재고를 파싱하고 있습니다.",
  });

  const cartHtml = await readCartHtml(page, {
    ...config,
    cartQty: probeQty,
  });

  throwIfAborted(signal);

  const allCartItems = parseCartHtml(cartHtml, {
    ...config,
    cartQty: probeQty,
  });

  const targetIds = new Set(
    products.map((item) => String(item.productId)),
  );

  const inventoryItems = sortInventoryItems(
    allCartItems.filter((item) => targetIds.has(String(item.productId))),
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
  };
}

/** 상품 n개 장바구니 담기 + 실제 재고 파싱 통합 실행. */
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
  await addCheonyuProductsToCart(
    page,
    context,
    config,
    products,
    {
      quantity,
      clearBefore,
      onProgress,
      signal,
    },
  );

  return probeCheonyuCartStock(
    page,
    context,
    config,
    products,
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
  probeCheonyuCartStock,
};
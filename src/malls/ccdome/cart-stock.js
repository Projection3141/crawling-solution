// src/malls/ccdome/cart-stock.js

const cheerio = require("cheerio");
const {
  sleep,
  throwIfAborted,
  toNumber,
} = require("../../utils/common");

const CCDOME_CART = Object.freeze({
  urls: {
    cart: "/order/cart.php",
    detail: "/goods/goods_view.php",
  },
  selectors: {
    root: ".item_goods_sec, .goods_view, .sub_content, #contents",
    quantityInputs: [
      "#frmView input[name='goodsCnt[]']",
      "form[name='frmView'] input[name='goodsCnt[]']",
      "input[name='goodsCnt[]']",
      "input[name='goodsCnt']",
      "input[id*='goodsCnt']",
      ".goods_qty input[type='text']",
      ".goods_qty input[type='number']",
      ".count input[type='text']",
    ],
    addButtons: [
      "#frmView .btn_add_cart",
      "form[name='frmView'] .btn_add_cart",
      "button.btn_add_cart",
      "a.btn_add_cart",
      ".btn_add_cart",
      "button:has-text('장바구니')",
      "a:has-text('장바구니')",
    ],
    cartProductLink:
      "a[href*='goods_view.php'][href*='goodsNo=']",
    cartQuantity:
      "input[name*='goodsCnt'], input[name*='cartCnt'], .goods_qty input",
  },
});

/** selector 배열에서 첫 번째 표시 요소를 찾는다. */
async function findFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);

      if (await target.isVisible().catch(() => false)) {
        return target;
      }
    }
  }

  return null;
}

/** 과자생각 상품 상세 URL을 만든다. */
function buildCcdomeProductUrl(productId, config) {
  const url = new URL(CCDOME_CART.urls.detail, config.baseUrl);
  url.searchParams.set("goodsNo", String(productId));
  return url.toString();
}

/** 과자생각 장바구니 HTML을 읽는다. */
async function readCcdomeCartHtml(page, config) {
  const url = new URL(CCDOME_CART.urls.cart, config.baseUrl).toString();
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  if (response && !response.ok()) {
    throw new Error(`과자생각 장바구니 요청 실패: HTTP ${response.status()}`);
  }

  await page
    .waitForLoadState("networkidle", {
      timeout: Math.min(config.navigationTimeoutMs, 5000),
    })
    .catch(() => null);

  await sleep(700);
  return page.content();
}

/** 과자생각 장바구니에서 상품번호와 표시 수량을 파싱한다. */
function parseCcdomeCartHtml(html, config) {
  const $ = cheerio.load(html);
  const items = [];
  const seenRows = new Set();

  $(CCDOME_CART.selectors.cartProductLink).each((_, link) => {
    const item = $(link);
    const href = item.attr("href") || "";
    let productUrl = "";
    let productId = "";

    try {
      productUrl = new URL(href, config.baseUrl).toString();
      productId = new URL(productUrl).searchParams.get("goodsNo") || "";
    } catch {
      return;
    }

    if (!productId) return;

    const row = item.closest(
      "tr, li, .cart_prdt_box, .order_table_type, .cart_cont_list",
    );
    const rowKey = `${productId}:${row.index()}`;

    if (seenRows.has(rowKey)) return;
    seenRows.add(rowKey);

    const quantityNode = row.find(CCDOME_CART.selectors.cartQuantity).first();
    const quantity = toNumber(
      quantityNode.attr("value") || quantityNode.val() || quantityNode.text(),
    );

    items.push({
      sourceMall: "ccdome",
      productId,
      productUrl,
      productName: row
        .find(".item_name, .cart_tit, .goods_name")
        .first()
        .text()
        .trim(),
      quantity,
    });
  });

  return items;
}

/**
 * 장바구니 추가 요청으로 추정되는 응답을 기다린다.
 * 고도몰 버전에 따라 goods/order/cart 계열 PHP가 사용될 수 있다.
 */
function waitForCcdomeCartResponse(page, config) {
  return page
    .waitForResponse(
      (response) => {
        const request = response.request();
        const method = request.method().toUpperCase();
        const url = response.url();

        return (
          ["GET", "POST"].includes(method) &&
          /\/(?:goods|order)\/(?:goods|cart)[^/]*\.php/i.test(url)
        );
      },
      {
        timeout: Math.min(config.navigationTimeoutMs, 10000),
      },
    )
    .catch(() => null);
}

/** 과자생각 상세페이지의 장바구니 기능을 한 번 실행한다. */
async function triggerCcdomeCartAdd(page, product, config) {
  const responsePromise = waitForCcdomeCartResponse(page, config);
  const beforeUrl = page.url();
  const addButton = await findFirstVisible(
    page,
    CCDOME_CART.selectors.addButtons,
  );

  let triggerMode = "";

  /**
   * 실제 사용자가 누르는 장바구니 버튼을 우선 클릭한다.
   * 버튼을 찾지 못했을 때만 전역 함수를 fallback으로 호출한다.
   */
  if (addButton) {
    triggerMode = "button-click";
    await addButton.click();
  } else {
    const invokedByFunction = await page
      .evaluate(() => {
        if (typeof window.gd_goods_order !== "function") {
          return false;
        }

        window.gd_goods_order("cart");
        return true;
      })
      .catch(() => false);

    if (!invokedByFunction) {
      throw new Error(
        `과자생각 상품 ${product.productId}의 장바구니 기능을 찾지 못했습니다.`,
      );
    }

    triggerMode = "gd_goods_order";
  }

  const cartResponse = await responsePromise;

  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 5000 }),
    page.waitForLoadState("networkidle", { timeout: 5000 }),
    page.waitForTimeout(1800),
  ]).catch(() => null);

  await sleep(700);

  return {
    triggerMode,
    navigated: page.url() !== beforeUrl,
    responseUrl: cartResponse?.url?.() || "",
    responseStatus: cartResponse?.status?.() || 0,
  };
}

/** 장바구니 페이지에서 지정 상품이 실제로 들어갔는지 확인한다. */
async function verifyCcdomeCartItem(page, product, config) {
  const cartHtml = await readCcdomeCartHtml(page, config);
  const cartItems = parseCcdomeCartHtml(cartHtml, config);
  const productId = String(product.productId);
  const matched = cartItems.find(
    (item) => String(item.productId) === productId,
  );

  if (!matched) {
    throw new Error(
      `과자생각 장바구니에서 상품 ${productId}를 확인하지 못했습니다.`,
    );
  }

  return matched;
}

/** 과자생각 상품 상세페이지에서 수량을 설정하고 한 상품만 담는다. */
async function addOneCcdomeProduct(page, product, config, signal) {
  throwIfAborted(signal);

  const productId = String(product.productId || "").trim();
  const quantity = Math.max(1, Math.trunc(Number(product.quantity) || 1));
  const productUrl = buildCcdomeProductUrl(productId, config);
  const response = await page.goto(productUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  if (response && !response.ok()) {
    throw new Error(
      `과자생각 상품 페이지 요청 실패: HTTP ${response.status()} (${productId})`,
    );
  }

  await page
    .waitForSelector(CCDOME_CART.selectors.root, {
      timeout: config.navigationTimeoutMs,
    })
    .catch(() => null);

  const quantityInput = await findFirstVisible(
    page,
    CCDOME_CART.selectors.quantityInputs,
  );

  if (!quantityInput) {
    throw new Error(
      `과자생각 상품 ${productId}의 수량 입력을 찾지 못했습니다.`,
    );
  }

  /** 이전 값이 남지 않도록 한 상품의 수량을 명시적으로 다시 입력한다. */
  await quantityInput.click().catch(() => null);
  await quantityInput.fill(String(quantity));
  await quantityInput.dispatchEvent("input");
  await quantityInput.dispatchEvent("change");
  await quantityInput.blur().catch(() => null);

  const triggerResult = await triggerCcdomeCartAdd(
    page,
    {
      ...product,
      productId,
      quantity,
    },
    config,
  );

  throwIfAborted(signal);

  /**
   * 다음 상품으로 넘어가기 전에 장바구니 페이지에서 이번 상품을 확인한다.
   * 이 확인이 끝난 뒤에만 다음 상세페이지로 이동하므로 완전한 순차 처리다.
   */
  const cartItem = await verifyCcdomeCartItem(
    page,
    {
      ...product,
      productId,
      quantity,
    },
    config,
  );

  return {
    productId,
    optionId: "",
    quantity,
    productUrl,
    added: true,
    verified: true,
    cartItem,
    ...triggerResult,
  };
}

/** 과자생각 상품 여러 개를 반드시 한 개씩 순차 처리한다. */
async function addCcdomeProductsToCart(
  page,
  context,
  config,
  products,
  {
    onProgress = () => {},
    signal,
  } = {},
) {
  if (!Array.isArray(products) || products.length < 1) {
    throw new Error("장바구니에 담을 과자생각 상품이 없습니다.");
  }

  const results = [];

  for (let index = 0; index < products.length; index += 1) {
    throwIfAborted(signal);

    const product = products[index];

    onProgress({
      stage: "cart",
      message:
        `과자생각 상품 ${index + 1}/${products.length} ` +
        `개별 장바구니 처리 중`,
      currentCartIndex: index + 1,
      cartTargetCount: products.length,
      productId: product.productId,
    });

    /** 한 번 호출할 때 상품 한 개만 처리하고 장바구니 확인까지 마친다. */
    const result = await addOneCcdomeProduct(
      page,
      product,
      config,
      signal,
    );

    results.push(result);

    onProgress({
      stage: "cart",
      message:
        `과자생각 상품 ${product.productId} 장바구니 확인 완료 ` +
        `(${index + 1}/${products.length})`,
      currentCartIndex: index + 1,
      cartTargetCount: products.length,
      productId: product.productId,
    });

    if (index < products.length - 1) {
      await sleep(Math.max(800, Number(config.requestDelayMs) || 0));
    }
  }

  return {
    requestedCount: products.length,
    successCount: results.length,
    mode: "one-by-one-with-cart-verification",
    results,
  };
}

module.exports = {
  CCDOME_CART,
  addCcdomeProductsToCart,
  addOneCcdomeProduct,
  buildCcdomeProductUrl,
  parseCcdomeCartHtml,
  readCcdomeCartHtml,
  verifyCcdomeCartItem,
};

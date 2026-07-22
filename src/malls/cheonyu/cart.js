const cheerio = require("cheerio");
const { sleep, toNumber } = require("../../utils/common");
const {
  inferBrand,
  inferCategory,
  normalizeEffectivePrice,
  normalizeProductName,
  normalizeStockStatus,
  parsePackageInfo,
} = require("../../utils/inventory");

const CHEONYU_CART = {
  urls: {
    cart: "/order/cart.html",
    cartApi: "/order/ajaxCart.php",
  },
  selectors: {
    table: "#cartTable",
    row: "#cartTable tr.tr-nth",
    cartCheck: 'input[name="cartCheck"][id="cartCheck"]',
    inPIDX: 'input[name="inPIDX"][id="inPIDX"]',
    productLink: 'a[href*="/product/view.html?qIDX="]',
    productNumberText: ".dtfont-pd",
    productName: ".product_dsc a.c",
    optionItems: ".option_list li",
    requestedQty: 'input[name="num01"][id="inPcount"]',
    maxStock: 'input[name="inMaxStock"][id="inMaxStock"]',
    porderMinus: 'input[name="inPorderMinus"][id="inPorderMinus"]',
    onePrice: "#inOnePrice",
    boxPrice: "#inBoxPrice",
    message: "#msgDiv",
  },
};

/** 천유 장바구니의 렌더링 완료 HTML을 읽는다. */
async function readCartHtml(page, config) {
  await page.goto(new URL(CHEONYU_CART.urls.cart, config.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  await page
    .waitForSelector(CHEONYU_CART.selectors.table, {
      timeout: config.navigationTimeoutMs,
    })
    .catch(() => null);

  await sleep(1500);
  return page.content();
}

/** 장바구니 HTML을 옵션 상세 재고 row로 변환한다. */
function parseCartHtml(html, config) {
  const $ = cheerio.load(html);
  const selectors = CHEONYU_CART.selectors;
  const items = [];

  $(selectors.row).each((_, row) => {
    const item = $(row);
    const cartCheckId =
      item.find(selectors.cartCheck).first().attr("value") || "";
    const inPIDX = item.find(selectors.inPIDX).first().attr("value") || "";
    const productHref =
      item.find(selectors.productLink).first().attr("href") || "";
    const productUrl = productHref
      ? new URL(productHref, config.baseUrl).toString()
      : "";

    let productId = "";

    try {
      productId = productUrl
        ? new URL(productUrl).searchParams.get("qIDX") || ""
        : "";
    } catch {
      productId = "";
    }

    const productNoText = normalizeProductName(
      item.find(selectors.productNumberText).first().text(),
    );
    const productNoMatch = productNoText.match(/상품번호\[(\d+)\]/);

    if (!productId && productNoMatch) {
      productId = productNoMatch[1];
    }

    const productName = normalizeProductName(
      item.find(selectors.productName).first().text(),
    );
    const optionText = normalizeProductName(
      item
        .find(selectors.optionItems)
        .map((__, option) => $(option).text())
        .get()
        .filter(Boolean)
        .join(" / "),
    );
    const requestedQty = toNumber(
      item.find(selectors.requestedQty).first().attr("value"),
    );
    const maxStock = toNumber(
      item.find(selectors.maxStock).first().attr("value"),
    );
    const porderMinus =
      item.find(selectors.porderMinus).first().attr("value") || "";
    const onePrice = toNumber(
      item.find(selectors.onePrice).first().attr("value"),
    );
    const boxPrice = toNumber(
      item.find(selectors.boxPrice).first().attr("value"),
    );
    const effectivePrice = normalizeEffectivePrice(onePrice, boxPrice);
    const msg = normalizeProductName(
      item.find(selectors.message).first().text(),
    );
    const stockLimited =
      msg.includes("주문가능하신 상품") ||
      (requestedQty > 0 && maxStock > 0 && requestedQty > maxStock);
    const packageInfo = parsePackageInfo(productName);
    const stockStatus = normalizeStockStatus({
      maxStock,
      stockLimited,
      lowStockThreshold: config.lowStockThreshold,
    });

    items.push({
      sourceMall: config.mall,
      categoryCode: config.category,
      cartCheckId,
      inPIDX,
      productId,
      productUrl,
      productName,
      normalizedName: productName,
      brandHint: inferBrand(productName),
      categoryHint: inferCategory(productName),
      optionText,
      hasOption: optionText.length > 0,
      requestedQty,
      maxStock,
      stockStatus,
      stockLimited,
      porderMinus,
      onePrice,
      boxPrice,
      effectivePrice,
      hasBoxDiscount: boxPrice > 0 && boxPrice < onePrice,
      packageQty: packageInfo.packageQty,
      packageUnit: packageInfo.packageUnit,
      packageText: packageInfo.packageText,
      isSoldOut: stockStatus === "OUT_OF_STOCK",
      msg,
      rawProductNoText: productNoText,
    });
  });

  return items;
}

/** cart row 식별자를 100개씩 나눠 천유 삭제 API로 전송한다. */
async function clearCartByCartIds(context, cartIds, config) {
  const uniqueIds = Array.from(new Set(cartIds.filter(Boolean)));

  if (!uniqueIds.length) {
    console.log("[CLEAR] 삭제할 장바구니 row 없음");
    return [];
  }

  const results = [];

  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const response = await context.request.post(
      new URL(CHEONYU_CART.urls.cartApi, config.baseUrl).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: new URL(CHEONYU_CART.urls.cart, config.baseUrl).toString(),
        },
        form: {
          qIDX: chunk.join(","),
          mode: "delete",
        },
        timeout: config.navigationTimeoutMs,
      },
    );

    results.push({
      status: response.status(),
      count: chunk.length,
      text: (await response.text()).slice(0, 300),
    });

    await sleep(500);
  }

  return results;
}

/** 현재 천유 장바구니 전체 row를 찾아 삭제한다. */
async function clearCartAll(page, context, config) {
  const items = parseCartHtml(await readCartHtml(page, config), config);
  const cartIds = items
    .map((item) => item.cartCheckId || item.inPIDX)
    .filter(Boolean);

  console.log(`[CLEAR] 기존 장바구니 row: ${cartIds.length}`);
  return clearCartByCartIds(context, cartIds, config);
}

module.exports = {
  CHEONYU_CART,
  clearCartAll,
  clearCartByCartIds,
  parseCartHtml,
  readCartHtml,
};
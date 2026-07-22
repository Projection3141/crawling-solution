const path = require("node:path");
const { readBoolean, readNumber } = require("../../utils/common");

const CHEONYU = {
  sourceMall: "cheonyu",
  baseUrl: "https://www.cheonyu.com",
  urls: {
    login: "/member/login.html",
    list: "/product/list.html",
    cart: "/order/cart.html",
    cartApi: "/order/ajaxCart.php",
  },
  selectors: {
    login: {
      idInputs: [
        "input[name='userID']",
        "input[name='memberID']",
        "input[name='id']",
        "input[name='loginID']",
        "input[type='text']",
      ],
      passwordInputs: [
        "input[name='userPW']",
        "input[name='memberPW']",
        "input[name='pw']",
        "input[name='password']",
        "input[type='password']",
      ],
      submitButtons: [
        "input[type='submit']",
        "button[type='submit']",
        "input[type='image']",
        "button:has-text('로그인')",
        "a:has-text('로그인')",
      ],
    },
    list: {
      productCount: "#ProductCount",
      productCheck: 'input[name="inPcheck"][id="inPcheck"]',
      productLink: 'a.pLink[href*="/product/view.html?qIDX="]',
      productName: ".m_pdt_list_name",
      productImage: "a.pLink img",
      soldOut: ".soldout_bg",
      addButton: "#btn_addCart",
      countInput: 'input[name="inPcount"][id="inPcount"]',
      maxStockInput: 'input[name="inMaxStock"][id="inMaxStock"]',
      porderMinusInput:
        'input[name="inPorderMinus"][id="inPorderMinus"]',
      bulkButton: ".all_add_btn",
      optionTable: "table#opSelectedList",
      manyAddWrap: ".many_add_wrap",
    },
    cart: {
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
      porderMinus:
        'input[name="inPorderMinus"][id="inPorderMinus"]',
      onePrice: "#inOnePrice",
      boxPrice: "#inBoxPrice",
      message: "#msgDiv",
    },
  },
  trackedUrlFragments: [
    "/product/list.html",
    "/order/cart.html",
    "cart",
    "Cart",
    "ajaxCart",
    "cartOptionCheck",
  ],
};

const CHEONYU_OUTPUT_HEADERS = {
  options: [
    "sourceMall",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "optionText",
    "hasOption",
    "requestedQty",
    "maxStock",
    "stockStatus",
    "stockLimited",
    "onePrice",
    "boxPrice",
    "effectivePrice",
    "hasBoxDiscount",
    "packageQty",
    "packageUnit",
    "packageText",
    "msg",
    "cartCheckId",
    "inPIDX",
    "productUrl",
  ],
  products: [
    "sourceMall",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "stockStatus",
    "totalStock",
    "minStock",
    "maxStock",
    "rowCount",
    "optionCount",
    "hasOptions",
    "limitedRowCount",
    "lowStockRowCount",
    "outOfStockRowCount",
    "priceMin",
    "priceMax",
    "hasBoxDiscount",
    "packageQty",
    "packageUnit",
    "packageText",
    "optionNames",
    "productUrl",
  ],
  targets: [
    "page",
    "index",
    "productId",
    "productName",
    "brandHint",
    "categoryHint",
    "packageQty",
    "packageUnit",
    "packageText",
    "listMaxStock",
    "listPorderMinus",
    "productUrl",
  ],
};

/** 환경변수 숫자를 지정한 최솟값 이상의 정수로 변환한다. */
function readInteger(env, key, fallback, min) {
  const value = Math.trunc(readNumber(env, key, fallback));
  return Math.max(min, value);
}

/** 환경변수에서 천유닷컴 실행 설정을 생성한다. */
function createCheonyuConfig(env = process.env, cwd = process.cwd()) {
  const outDir = path.resolve(cwd, "out");
  const pageStart = readInteger(env, "PAGE_START", 1, 1);
  const pageEnd = readInteger(env, "PAGE_END", 5, 0);

  /** 수동 범위에서는 시작 페이지보다 작은 종료 페이지를 허용하지 않는다. */
  if (pageEnd > 0 && pageEnd < pageStart) {
    throw new Error(
      `PAGE_END(${pageEnd})는 PAGE_START(${pageStart})보다 작을 수 없습니다.`,
    );
  }

  return {
    sourceMall: CHEONYU.sourceMall,
    baseUrl: CHEONYU.baseUrl,
    headless: readBoolean(env, "HEADLESS", false),
    pageStart,

    /** 0이면 첫 상품 목록에서 실제 마지막 페이지를 자동 감지한다. */
    pageEnd,

    listSize: readInteger(env, "LIST_SIZE", 150, 1),
    maxPerPage: readInteger(env, "MAX_PER_PAGE", 150, 1),
    cartQty: readInteger(env, "CART_QTY", 999, 1),
    clearCartBefore: readBoolean(env, "CLEAR_CART_BEFORE", true),
    clearCartAfter: readBoolean(env, "CLEAR_CART_AFTER", false),
    lowStockThreshold: readInteger(env, "LOW_STOCK_THRESHOLD", 10, 0),

    viewport: {
      width: 1440,
      height: 1000,
    },

    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/149.0.0.0 Safari/537.36",

    outDir,

    files: {
      resultJson: path.resolve(outDir, "cheonyu-inventory-result.json"),
      optionCsv: path.resolve(outDir, "cheonyu-option-inventory.csv"),
      productCsv: path.resolve(outDir, "cheonyu-product-summary.csv"),
      targetCsv: path.resolve(outDir, "cheonyu-target-products.csv"),
      networkLog: path.resolve(outDir, "cheonyu-network-log.json"),
      debugCartHtml: path.resolve(outDir, "debug-cart.html"),
    },
  };
}

module.exports = {
  CHEONYU,
  CHEONYU_OUTPUT_HEADERS,
  createCheonyuConfig,
};
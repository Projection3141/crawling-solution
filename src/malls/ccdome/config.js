// src/malls/ccdome/config.js

const path = require("node:path");
const { toBoolean, toInteger } = require("../../utils/common");

/** 과자생각 전용 URL과 DOM selector다. */
const CCDOME = {
  sourceMall: "ccdome",
  baseUrl: "https://www.ccdome.co.kr",

  urls: {
    login: "/member/login.php",
    list: "/goods/goods_list.php",
    detail: "/goods/goods_view.php",
  },

  selectors: {
    login: {
      idInputs: [
        "#formLogin input[name='loginId']",
        "form[name='formLogin'] input[name='loginId']",
        ".member_login_box input[name='loginId']",
        "input[name='loginId']",
        "input#loginId",
        ".member_login_box input[type='text']",
        "input[placeholder*='아이디']",
        "input[name='memId']",
      ],

      passwordInputs: [
        "#formLogin input[name='loginPwd']",
        "form[name='formLogin'] input[name='loginPwd']",
        ".member_login_box input[name='loginPwd']",
        "input[name='loginPwd']",
        "input#loginPwd",
        "input[name='memPw']",
        "input[type='password']",
      ],

      submitButtons: [
        "#formLogin button[type='submit']",
        "#formLogin input[type='submit']",
        "#formLogin .btn_login",
        "form[name='formLogin'] button[type='submit']",
        ".member_login_box button[type='submit']",
        ".member_login_box .btn_login",
        "button:has-text('로그인')",
        "input[type='submit'][value*='로그인']",
      ],
    },

    list: {
      item: ".item_cont",
      soldOut: ".item_soldout",
      productLink: "a[href*='goods_view.php'][href*='goodsNo=']",
      productName: ".item_name",
      productImage: ".item_photo_box img",
      productPrice: ".item_price",
      countAreas: [".goods_pick_list .pick_list_num", ".pick_list_num", ".goods_pick_list"],
      pagination:
        ".pagination a, .pagination button, " +
        ".pagination_box a, .pagination_box button",
    },

    detail: {
      root: ".sub_content, .goods_view, .item_goods_sec, #contents",
      categoryItems:
        ".location_wrap .location_select .location_tit span, " +
        ".location_wrap .location_select .location_tit a span",
      title: ".item_detail_tit h3, .item_tit_detail_cont h3",
      itemInfoList: ".item_info_box .item_detail_list dl, .item_detail_list dl",
      mainImages:
        ".item_photo_slide img, .item_photo_big img, .item_photo_view img, " +
        ".item_photo_box img, .slider_goods_nav img",
      detailImages:
        "#detail .detail_cont img, #detail .detail_explain_box img, " +
        "#detail .txt-manual img, .detail_cont img, .detail_explain_box img, .txt-manual img",
    },
  },
};

const CCDOME_OUTPUT_HEADERS = {
  products: [
    "sourceMall",
    "categoryCode",
    "page",
    "index",
    "productId",
    "productName",
    "productUrl",
    "imageUrl",
    "price",
    "priceText",
    "saleStatus",
    "isSoldOut",
    "soldOutText",
  ],
  details: [
    "sourceMall",
    "categoryCode",
    "productId",
    "productUrl",
    "productName",
    "categoryDepth1",
    "categoryDepth2",
    "categoryDepth3",
    "expiryDate",
    "salePrice",
    "unitPrice",
    "boxComposition",
    "modelName",
    "mainImageUrlsText",
    "introImageUrlsText",
    "detailError",
  ],
};

function readInteger(env, mallKey, commonKey, fallback, min) {
  const mallValue = env[mallKey];
  const commonValue = commonKey ? env[commonKey] : undefined;
  const raw = mallValue != null && mallValue !== "" ? mallValue : commonValue != null && commonValue !== "" ? commonValue : fallback;

  return toInteger(raw, fallback, min);
}

/** 환경변수에서 과자생각 단독 실행 설정을 생성한다. */
function createCcdomeConfig(env = process.env, cwd = process.cwd()) {
  const pageStart = readInteger(env, "CCDOME_PAGE_START", "PAGE_START", 1, 1);
  const pageEnd = readInteger(env, "CCDOME_PAGE_END", "PAGE_END", 0, 0);

  if (pageEnd > 0 && pageEnd < pageStart) {
    throw new Error(`CCDOME_PAGE_END(${pageEnd})는 CCDOME_PAGE_START(${pageStart})보다 작을 수 없습니다.`);
  }

  const outDir = path.resolve(cwd, "out", "ccdome");
  const categoryCode = String(env.CCDOME_CATEGORY_CODE || env.CATEGORY || "017").trim();

  if (!categoryCode) {
    throw new Error("CCDOME_CATEGORY_CODE를 설정하세요.");
  }

  const showBrowser = toBoolean(env.CCDOME_SHOW_BROWSER ?? env.SHOW_BROWSER, false);

  return {
    sourceMall: CCDOME.sourceMall,
    mall: CCDOME.sourceMall,
    mallLabel: "과자생각",
    baseUrl: String(env.CCDOME_BASE_URL || CCDOME.baseUrl).trim(),
    category: categoryCode,
    categoryCode,
    collectionMode: String(env.COLLECTION_MODE || "general").trim().toLowerCase(),
    accountId: String(env.CCDOME_ACCOUNT_ID || env.ACCOUNT_ID || "").trim(),
    accountPw: String(env.CCDOME_ACCOUNT_PW || env.ACCOUNT_PW || ""),
    showBrowser,
    headless: !showBrowser,
    pageStart,
    pageEnd,
    pageSize: readInteger(env, "CCDOME_PAGE_SIZE", "PAGE_SIZE", 40, 1),
    requestDelayMs: readInteger(env, "CCDOME_REQUEST_DELAY_MS", "REQUEST_DELAY_MS", 300, 0),
    detailRequestDelayMs: readInteger(env, "CCDOME_DETAIL_REQUEST_DELAY_MS", "DETAIL_REQUEST_DELAY_MS", 300, 0),
    detailMaxProducts: readInteger(env, "CCDOME_DETAIL_MAX_PRODUCTS", "DETAIL_MAX_PRODUCTS", 0, 0),
    maxSafePages: readInteger(env, "CCDOME_MAX_SAFE_PAGES", "MAX_SAFE_PAGES", 1000, 1),
    navigationTimeoutMs: readInteger(env, "CCDOME_NAVIGATION_TIMEOUT_MS", "NAVIGATION_TIMEOUT_MS", 60000, 1000),
    viewport: { width: 1440, height: 1000 },
    userAgent: env.USER_AGENT || undefined,
    outDir,
  };
}

module.exports = {
  CCDOME,
  CCDOME_OUTPUT_HEADERS,
  createCcdomeConfig,
};

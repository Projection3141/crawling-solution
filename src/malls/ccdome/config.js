const path = require("node:path");
const { readBoolean } = require("../../utils/common");

/**
 * 과자생각 전용 URL과 DOM selector다.
 *
 * 공통 유틸이나 다른 쇼핑몰 코드에서는 이 객체를 참조하지 않는다.
 */
const CCDOME = {
  sourceMall: "ccdome",
  baseUrl: "https://www.ccdome.co.kr",

  urls: {
    login: "/member/login.php",
    list: "/goods/goods_list.php",
  },

  selectors: {
    login: {
      /**
       * 사이트 HTML이 일부 변경되더라도 대응할 수 있도록
       * 여러 로그인 ID selector를 순서대로 확인한다.
       */
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
      /** 전체 상품 row */
      item: ".item_cont",

      /** 품절 표시 */
      soldOut: ".item_soldout",

      /** 상품 상세 링크 */
      productLink: "a[href*='goods_view.php'][href*='goodsNo=']",

      productName: ".item_name",
      productImage: ".item_photo_box img",
      productPrice: ".item_price",

      /** `상품 1,305개`와 같은 전체 상품 수 표시 영역 */
      countAreas: [
        ".goods_pick_list .pick_list_num",
        ".pick_list_num",
        ".goods_pick_list",
      ],

      /** 마지막 페이지 링크 탐색 영역 */
      pagination:
        ".pagination a, .pagination button, " +
        ".pagination_box a, .pagination_box button",
    },
  },
};

/**
 * 전체 상품 및 판매중 상품 CSV에 저장할 컬럼 순서다.
 */
const CCDOME_OUTPUT_HEADERS = [
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
];

/**
 * 환경변수 값을 정수로 읽는다.
 *
 * mallKey:
 * - CCDOME 전용 환경변수
 *
 * commonKey:
 * - 기존 공통 환경변수
 *
 * 우선순위:
 * 1. CCDOME 전용 값
 * 2. 공통 값
 * 3. fallback
 */
function readInteger(env, mallKey, commonKey, fallback, min) {
  const mallValue = env[mallKey];
  const commonValue = commonKey ? env[commonKey] : undefined;

  const raw =
    mallValue != null && mallValue !== ""
      ? mallValue
      : commonValue != null && commonValue !== ""
        ? commonValue
        : fallback;

  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;

  return Math.max(min, value);
}

/**
 * 환경변수에서 과자생각 수집 설정을 생성한다.
 *
 * CCDOME_PAGE_END가 없으면 기존 PAGE_END를 사용한다.
 * 둘 다 없으면 기본값 0으로 자동 감지한다.
 */
function createCcdomeConfig(env = process.env, cwd = process.cwd()) {
  const pageStart = readInteger(
    env,
    "CCDOME_PAGE_START",
    "PAGE_START",
    1,
    1,
  );

  const pageEnd = readInteger(
    env,
    "CCDOME_PAGE_END",
    "PAGE_END",
    0,
    0,
  );

  /**
   * PAGE_END=0은 자동 모드이므로 허용한다.
   * 수동 모드에서만 시작 페이지와 종료 페이지를 검증한다.
   */
  if (pageEnd > 0 && pageEnd < pageStart) {
    throw new Error(
      `CCDOME_PAGE_END(${pageEnd})는 ` +
        `CCDOME_PAGE_START(${pageStart})보다 작을 수 없습니다.`,
    );
  }

  const outDir = path.resolve(cwd, "out", "ccdome");
  const categoryCode = String(
    env.CCDOME_CATEGORY_CODE || "017",
  ).trim();

  if (!categoryCode) {
    throw new Error("CCDOME_CATEGORY_CODE를 설정하세요.");
  }

  return {
    sourceMall: CCDOME.sourceMall,

    baseUrl: String(
      env.CCDOME_BASE_URL || CCDOME.baseUrl,
    ).trim(),

    categoryCode,

    /**
     * CCDOME_HEADLESS가 있으면 우선 사용하고,
     * 없으면 공통 HEADLESS 값을 사용한다.
     */
    headless: readBoolean(
      env,
      "CCDOME_HEADLESS",
      readBoolean(env, "HEADLESS", false),
    ),

    pageStart,

    /**
     * 0:
     * 첫 상품 목록 HTML에서 마지막 페이지를 자동 감지한다.
     *
     * 1 이상:
     * 지정한 페이지까지만 수집한다.
     */
    pageEnd,

    /**
     * 과자생각 목록의 페이지당 상품 수다.
     *
     * 기존 천유의 LIST_SIZE=150을 공유하지 않고
     * CCDOME 전용으로 40을 사용한다.
     */
    pageSize: readInteger(
      env,
      "CCDOME_PAGE_SIZE",
      null,
      40,
      1,
    ),

    /** 각 목록 페이지 요청 사이의 대기 시간 */
    requestDelayMs: readInteger(
      env,
      "CCDOME_REQUEST_DELAY_MS",
      null,
      300,
      0,
    ),

    /**
     * 잘못된 페이지 감지나 설정 오류로 인해
     * 무한 요청하는 것을 방지하는 최대 페이지 수다.
     */
    maxSafePages: readInteger(
      env,
      "CCDOME_MAX_SAFE_PAGES",
      null,
      1000,
      1,
    ),

    navigationTimeoutMs: readInteger(
      env,
      "CCDOME_NAVIGATION_TIMEOUT_MS",
      null,
      60000,
      1000,
    ),

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
      resultJson: path.resolve(
        outDir,
        "ccdome-products-result.json",
      ),

      allProductsCsv: path.resolve(
        outDir,
        "ccdome-all-products.csv",
      ),

      activeProductsCsv: path.resolve(
        outDir,
        "ccdome-active-products.csv",
      ),

      debugFirstPageHtml: path.resolve(
        outDir,
        "debug-first-page.html",
      ),

      debugLastPageHtml: path.resolve(
        outDir,
        "debug-last-page.html",
      ),
    },
  };
}

module.exports = {
  CCDOME,
  CCDOME_OUTPUT_HEADERS,
  createCcdomeConfig,
};
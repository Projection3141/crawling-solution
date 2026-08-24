const cheerio = require("cheerio");
const { performance } = require("node:perf_hooks");
const { fillFirstAvailable } = require("../../utils/browser");
const {
  formatMs,
  normalizeWhitespace,
  sleep,
  throwIfAborted,
  toNumber,
} = require("../../utils/common");
const {
  inferBrand,
  inferCategory,
  normalizeProductName,
  parsePackageInfo,
} = require("../../utils/inventory");
const {
  getSafetyNumber,
  gotoWithSiteRetry,
  resetPageState,
} = require("../../utils/site-safety");

const CCDOME_SITE = {
  urls: {
    login: "/member/login.php",
    list: "/goods/goods_list.php",
  },
  selectors: {
    login: {
      idInputs: [
        "#formLogin input[name='loginId']",
        "form[name='formLogin'] input[name='loginId']",
        ".member_login_box input[name='loginId']",
        "input[name='loginId']",
        "input#loginId",
        "input[placeholder*='아이디']",
        "input[name='memId']",
        ".member_login_box input[type='text']",
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
      countAreas: [
        ".goods_pick_list .pick_list_num",
        ".pick_list_num",
        ".goods_pick_list",
      ],
      pagination:
        ".pagination a, .pagination button, " +
        ".pagination_box a, .pagination_box button",
    },
  },
};

/** 로그인 완료 HTML에서 로그인 상태와 오류 문구를 판독한다. */
function parseLoginState(html) {
  const $ = cheerio.load(html);
  const bodyText = normalizeWhitespace($("body").text());
  const bodyTextLower = bodyText.toLowerCase();

  const hrefs = $("a")
    .map((_, element) => String($(element).attr("href") || "").toLowerCase())
    .get();

  const logoutLinkFound = hrefs.some((href) =>
    href.includes("logout") ||
    href.includes("log_out") ||
    href.includes("logoff") ||
    href.includes("member/logout"),
  );

  const loginFormFound =
    $("input[name='loginId']").length > 0 ||
    $("input[name='loginPwd']").length > 0 ||
    $("input[type='password']").length > 0;

  const loginErrorText =
    [
      "아이디, 비밀번호가 일치하지 않습니다",
      "아이디 또는 비밀번호",
      "로그인 정보를 확인",
      "비밀번호가 일치",
      "존재하지 않는 회원",
    ].find((text) => bodyText.includes(text)) || "";

  /**
   * 로그아웃 링크가 가장 확실하다.
   * 다만 과자생각은 페이지/팝업 상태에 따라 헤더 판정이 흔들릴 수 있으므로
   * 로그인 폼이 사라지고 회원 관련 문구가 보이는 경우도 보조 성공으로 본다.
   */
  const memberTextFound =
    bodyText.includes("로그아웃") ||
    bodyText.includes("회원정보") ||
    bodyText.includes("정보수정") ||
    bodyText.includes("마이페이지") ||
    bodyTextLower.includes("mypage");

  return {
    loggedIn: logoutLinkFound || (!loginFormFound && memberTextFound && !loginErrorText),
    logoutLinkFound,
    loginFormFound,
    memberTextFound,
    errorText: loginErrorText,
    bodyText: bodyText.slice(0, 700),
  };
}

/** 과자생각 로그인 후 뜰 수 있는 공지/팝업/모달을 최대한 닫는다. */
async function closeCcdomeOverlays(page) {
  const closeSelectors = [
    "button:has-text('닫기')",
    "button:has-text('확인')",
    "button:has-text('오늘 하루 보지 않기')",
    "a:has-text('닫기')",
    "a:has-text('오늘 하루 보지 않기')",
    ".btn_close",
    ".btn-layer-close",
    ".layer_close",
    ".popup_close",
    ".close",
    "[class*='close']",
  ];

  for (const selector of closeSelectors) {
    const locator = page.locator(selector);

    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 5); index += 1) {
      await locator
        .nth(index)
        .click({
          timeout: 800,
          force: true,
        })
        .catch(() => null);

      await sleep(150);
    }
  }

  /**
   * ESC로 닫히는 모달도 있어서 한 번 눌러준다.
   */
  await page.keyboard.press("Escape").catch(() => null);
  await sleep(300);
}

/** 공통 계정 설정으로 과자생각에 로그인한다. */
async function loginCcdome(page, config, signal) {
  const selectors = CCDOME_SITE.selectors.login;

  console.log("[LOGIN] 과자생각 로그인 시작");

  await gotoWithNavigationRetry(
    page,
    new URL(CCDOME_SITE.urls.login, config.baseUrl).toString(),
    config,
    "로그인 페이지",
    signal,
    {
      readySelector: selectors.passwordInputs.join(", "),
    },
  );

  await fillFirstAvailable(
    page,
    selectors.idInputs,
    config.accountId,
    "과자생각 ID",
  );
  const passwordSelector = await fillFirstAvailable(
    page,
    selectors.passwordInputs,
    config.accountPw,
    "과자생각 PW",
  );

  let submitted = false;

  for (const selector of selectors.submitButtons) {
    const button = page.locator(selector).first();

    if ((await button.count()) < 1) continue;

    await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: 10000 }),
      button.click(),
    ]);

    submitted = true;
    break;
  }

  if (!submitted) {
    await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: 10000 }),
      page.locator(passwordSelector).first().press("Enter"),
    ]);
  }

  await sleep(2500);

  /**
   * 로그인 버튼 클릭 후 과자생각이 main/index.php로 자동 이동하는 경우가 있어
   * 곧바로 목록 URL로 이동하면 navigation 충돌이 발생할 수 있다.
   */
  await page
    .waitForLoadState("domcontentloaded", {
      timeout: 10000,
    })
    .catch(() => null);

  await page
    .waitForLoadState("networkidle", {
      timeout: 5000,
    })
    .catch(() => null);

  const listUrl = buildListUrl(1, config);

  await gotoWithNavigationRetry(
    page,
    listUrl,
    config,
    "로그인 확인용 목록",
    signal,
    {
      readySelector: CCDOME_SITE.selectors.list.item,
    },
  );

  const state = parseLoginState(await page.content());

  if (!state.loggedIn) {
    throw new Error(
      `과자생각 로그인 성공 확인 실패: ${state.errorText || "로그아웃 링크를 찾지 못했습니다."
      }`,
    );
  }

  console.log("[LOGIN] 과자생각 로그인 성공");
}

/** 공통 카테고리·페이지 설정으로 과자생각 목록 URL을 생성한다. */
function buildListUrl(pageNo, config) {
  const url = new URL(CCDOME_SITE.urls.list, config.baseUrl);

  url.searchParams.set("cateCd", String(config.category));
  url.searchParams.set("page", String(pageNo));
  url.searchParams.set("pageNum", String(config.pageSize));

  return url.toString();
}

/** 공통 사이트 안전 모듈로 과자생각 페이지 이동을 복구한다. */
async function gotoWithNavigationRetry(
  page,
  url,
  config,
  label = "페이지",
  signal,
  {
    readySelector = "",
    readyTimeoutMs = null,
  } = {},
) {
  const maxAttempts = getSafetyNumber(
    config,
    "navigationRetryCount",
    8,
    3,
    20,
  );
  const hardResetEvery = getSafetyNumber(
    config,
    "navigationHardResetEvery",
    3,
    2,
    10,
  );

  return gotoWithSiteRetry(page, url, {
    label: `[CCDOME] ${label}`,
    signal,
    maxAttempts,
    timeoutMs: config.navigationTimeoutMs,
    readySelector,
    readyTimeoutMs: readyTimeoutMs || config.navigationTimeoutMs,
    baseDelayMs: 900,
    maxDelayMs: 15000,
    multiplier: 1.6,
    beforeAttempt: async ({ attempt }) => {
      if (attempt > 1 && (attempt - 1) % hardResetEvery === 0) {
        console.warn(
          `[CCDOME] ${label} 이동 상태를 초기화합니다. (${attempt}/${maxAttempts})`,
        );
        await resetPageState(page, {
          signal,
          delayMs: 700,
        });
      }
    },
    onRetry: async () => {
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: 5000,
        })
        .catch(() => null);
      await closeCcdomeOverlays(page).catch(() => null);
    },
  });
}

/** href 또는 onclick 문자열에서 페이지 번호를 추출한다. */
function extractPageNumber(value, baseUrl) {
  const text = String(value || "").trim();

  if (!text) return 0;

  try {
    const pageNo = Number(new URL(text, baseUrl).searchParams.get("page"));
    if (Number.isInteger(pageNo) && pageNo > 0) return pageNo;
  } catch {
    /** JavaScript 링크는 정규식으로 다시 확인한다. */
  }

  const match = text.match(
    /[?&]page=(\d+)|\bpage\s*[=:,]\s*["']?(\d+)|(?:goPage|movePage|pageMove|paging)\s*\(\s*["']?(\d+)/i,
  );

  return Number(match?.[1] || match?.[2] || match?.[3]) || 0;
}

/** 목록 HTML의 `상품 N개` 문구에서 전체 상품 수를 읽는다. */
function parseTotalProductCount(html) {
  const $ = cheerio.load(html);
  const patterns = [/상품\s*([\d,]+)\s*개/i, /총\s*([\d,]+)\s*개/i];

  for (const selector of CCDOME_SITE.selectors.list.countAreas) {
    const text = normalizeWhitespace($(selector).first().text());

    for (const pattern of patterns) {
      const count = toNumber(text.match(pattern)?.[1]);
      if (count > 0) return count;
    }
  }

  const bodyText = normalizeWhitespace($("body").text());

  for (const pattern of patterns) {
    const count = toNumber(bodyText.match(pattern)?.[1]);
    if (count > 0) return count;
  }

  return 0;
}

/** 목록 HTML에서 현재 선택된 페이지당 상품 수를 읽는다. */
function parsePageSize(html, fallback) {
  const $ = cheerio.load(html);
  const selected = toNumber(
    $("select[name='pageNum'] option:selected").first().attr("value"),
  );

  return selected > 0 ? selected : fallback;
}

/** 페이지네이션의 `맨뒤` 링크에서 마지막 페이지 번호를 읽는다. */
function parseExplicitLastPage(html, config) {
  const $ = cheerio.load(html);
  let lastPage = 0;

  $(CCDOME_SITE.selectors.list.pagination).each((_, element) => {
    const item = $(element);
    const marker = normalizeWhitespace(
      [
        item.text(),
        item.attr("class"),
        item.attr("title"),
        item.attr("aria-label"),
        item.find("img").first().attr("alt"),
      ]
        .filter(Boolean)
        .join(" "),
    );

    if (!/맨뒤|마지막|맨끝|last\b|btn[_-]?last|≫|»|>>/i.test(marker)) {
      return;
    }

    lastPage = Math.max(
      lastPage,
      extractPageNumber(item.attr("href"), config.baseUrl),
      extractPageNumber(item.attr("onclick"), config.baseUrl),
      extractPageNumber(item.attr("data-page"), config.baseUrl),
    );
  });

  return lastPage;
}

/** 추천상품 영역을 제외하고 실제 상품 목록 영역을 선택한다. */
function findMainProductScope($) {
  const itemSelector = CCDOME_SITE.selectors.list.item;
  const pickList = $(".goods_pick_list").last();

  if (pickList.length > 0) {
    const ownerScope = pickList
      .closest(".goods_list")
      .find(".goods_list_cont")
      .last();

    if (ownerScope.length > 0) return ownerScope;

    const siblingScope = pickList.nextAll(".goods_list_cont").first();
    if (siblingScope.length > 0) return siblingScope;
  }

  let bestScope = $.root();
  let bestCount = 0;

  $(".goods_list_cont").each((_, element) => {
    const count = $(element).find(itemSelector).length;

    if (count >= bestCount) {
      bestScope = $(element);
      bestCount = count;
    }
  });

  return bestScope;
}

/** 상대 URL을 절대 URL로 정리한다. */
function toAbsoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();

  if (!raw || raw.startsWith("data:")) return "";

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

/** 상품 가격 문자열에서 첫 번째 금액을 정수로 변환한다. */
function parsePrice(value) {
  const match = normalizeWhitespace(value).match(/-?\d[\d,]*/);
  return match ? toNumber(match[0]) : 0;
}

/** `.item_cont` 상품과 `.item_soldout` 품절 상태를 파싱한다. */
function parseProductList(html, pageNo, config) {
  const $ = cheerio.load(html);
  const selectors = CCDOME_SITE.selectors.list;
  const scope = findMainProductScope($);
  const products = [];

  scope.find(selectors.item).each((index, element) => {
    const item = $(element);
    const row = item.closest("li").length > 0 ? item.closest("li") : item;
    const link = item.find(selectors.productLink).first();
    const productUrl = toAbsoluteUrl(link.attr("href"), config.baseUrl);
    const productId = productUrl
      ? new URL(productUrl).searchParams.get("goodsNo") || ""
      : "";

    if (!productId) return;

    const image = item.find(selectors.productImage).first();
    const productName = normalizeProductName(
      item.find(selectors.productName).first().text() ||
      link.text() ||
      image.attr("alt") ||
      "",
    );
    const priceText = normalizeWhitespace(
      item.find(selectors.productPrice).first().text(),
    );
    const soldOutNode = row.is(selectors.soldOut)
      ? row
      : row.find(selectors.soldOut).first();
    const isSoldOut =
      item.hasClass(selectors.soldOut.slice(1)) ||
      item.find(selectors.soldOut).length > 0 ||
      item.closest(selectors.soldOut).length > 0 ||
      row.find(selectors.soldOut).length > 0;
    const packageInfo = parsePackageInfo(productName);

    products.push({
      sourceMall: config.mall,
      categoryCode: config.category,
      page: pageNo,
      index,
      productId,
      productName,
      productUrl,
      imageUrl: toAbsoluteUrl(
        image.attr("data-original") ||
        image.attr("data-src") ||
        image.attr("src"),
        config.baseUrl,
      ),
      brandHint: inferBrand(productName),
      categoryHint: inferCategory(productName),
      packageQty: packageInfo.packageQty,
      packageUnit: packageInfo.packageUnit,
      packageText: packageInfo.packageText,
      price: parsePrice(priceText),
      priceText,
      saleStatus: isSoldOut ? "SOLD_OUT" : "ON_SALE",
      isSoldOut,
      soldOutText: normalizeWhitespace(soldOutNode.text()),
      listMaxStock: "",
      listPorderMinus: "",
    });
  });

  return products;
}

/** 첫 목록 HTML에서 전체 상품 수와 마지막 페이지를 계산한다. */
function parseCatalogInfo(html, config) {
  const totalProductCount = parseTotalProductCount(html);
  const pageSize = parsePageSize(html, config.pageSize);
  const explicitLastPage = parseExplicitLastPage(html, config);

  if (explicitLastPage > 0) {
    return {
      totalProductCount: totalProductCount || null,
      pageSize,
      lastPage: explicitLastPage,
      source: "last-page-link",
    };
  }

  if (totalProductCount > 0) {
    return {
      totalProductCount,
      pageSize,
      lastPage: Math.max(1, Math.ceil(totalProductCount / pageSize)),
      source: "product-count",
    };
  }

  const products = parseProductList(html, 1, config);

  if (products.length > 0 && products.length < pageSize) {
    return {
      totalProductCount: products.length,
      pageSize,
      lastPage: 1,
      source: "single-page",
    };
  }

  return {
    totalProductCount: null,
    pageSize,
    lastPage: 0,
    source: "not-detected",
  };
}

/** 첫 목록 페이지에서 전체 상품 수와 마지막 페이지를 감지한다. */
async function detectCatalog(page, config, signal) {
  const url = buildListUrl(1, config);

  console.log(`[PAGE DETECT] ${url}`);

  const response = await gotoWithNavigationRetry(
    page,
    url,
    config,
    "상품 목록 감지",
    signal,
    {
      readySelector: CCDOME_SITE.selectors.list.item,
    },
  );

  if (response && !response.ok()) {
    throw new Error(`과자생각 상품 목록 요청 실패: HTTP ${response.status()}`);
  }

  await page.waitForSelector(CCDOME_SITE.selectors.list.item, {
    timeout: config.navigationTimeoutMs,
  });

  const html = await page.content();
  const info = parseCatalogInfo(html, config);

  if (config.pageEnd === 0 && info.lastPage < 1) {
    throw new Error(
      "PAGE_END=0 자동 모드에서 과자생각 마지막 페이지를 감지하지 못했습니다.",
    );
  }

  if (info.lastPage > config.maxSafePages) {
    throw new Error(
      `감지된 마지막 페이지(${info.lastPage})가 안전 한도(${config.maxSafePages})를 초과했습니다.`,
    );
  }

  return {
    ...info,
    html,
    url,
  };
}

/** 수동 또는 자동 설정을 실제 수집 범위로 변환한다. */
async function resolvePageRange(page, config, signal) {
  const detection = await detectCatalog(page, config, signal);
  const detectedLastPage = detection.lastPage || null;
  let pageEnd = config.pageEnd;
  let mode = "manual";

  if (config.pageEnd === 0) {
    pageEnd = detection.lastPage;
    mode = "auto";
  } else if (detectedLastPage && config.pageEnd > detectedLastPage) {
    pageEnd = detectedLastPage;
    mode = "manual-capped";
  }

  if (config.pageStart > pageEnd) {
    throw new Error(
      `PAGE_START(${config.pageStart})가 마지막 페이지(${pageEnd})보다 큽니다.`,
    );
  }

  return {
    pageRange: {
      mode,
      pageStart: config.pageStart,
      pageEnd,
      requestedPageEnd: config.pageEnd,
      detectedLastPage,
      detectedTotalProductCount: detection.totalProductCount,
      detectionSource: detection.source,
      collectedLastPage: null,
      collectedPageCount: 0,
      stopReason: "completed-range",
    },
    firstPageHtml: detection.html,
  };
}

/** 한 목록 페이지를 이동하고 Cheerio로 상품을 파싱한다. */
async function collectListPage(
  page,
  pageNo,
  config,
  cachedHtml = null,
  signal,
) {
  const startedAt = performance.now();
  const url = buildListUrl(pageNo, config);
  let html = cachedHtml;

  if (!html) {
    const response = await gotoWithNavigationRetry(
      page,
      url,
      config,
      `${pageNo}페이지 목록`,
      signal,
      {
        readySelector: CCDOME_SITE.selectors.list.item,
      },
    );

    if (response && !response.ok()) {
      throw new Error(
        `과자생각 상품 목록 요청 실패: HTTP ${response.status()} - ${url}`,
      );
    }

    await page
      .waitForSelector(CCDOME_SITE.selectors.list.item, {
        timeout: config.navigationTimeoutMs,
      })
      .catch(() => null);

    html = await page.content();
  }

  const products = parseProductList(html, pageNo, config);
  const soldOutCount = products.filter((item) => item.isSoldOut).length;

  return {
    html,
    products,
    soldOutCount,
    activeCount: products.length - soldOutCount,
    elapsedMs: performance.now() - startedAt,
  };
}

/** 전체 범위를 순회하며 전체·판매중·품절 상품을 분리한다. */
async function collectCcdomeProducts(
  page,
  config,
  onProgress = () => { },
  signal,
) {
  throwIfAborted(signal);

  const { pageRange, firstPageHtml } = await resolvePageRange(
    page,
    config,
    signal,
  );
  throwIfAborted(signal);
  const productMap = new Map();
  const pageResults = [];
  let previousSignature = "";
  let firstHtml = "";
  let lastHtml = "";

  onProgress({
    stage: "collecting",
    message: `상품 목록 ${pageRange.pageStart} ~ ${pageRange.pageEnd}페이지 수집`,
    pageRange,
    detectedTotalProductCount: pageRange.detectedTotalProductCount,
  });

  for (
    let pageNo = pageRange.pageStart;
    pageNo <= pageRange.pageEnd;
    pageNo += 1
  ) {
    throwIfAborted(signal);

    const cachedHtml = pageNo === 1 ? firstPageHtml : null;
    const result = await collectListPage(
      page,
      pageNo,
      config,
      cachedHtml,
      signal,
    );
    throwIfAborted(signal);

    if (!firstHtml) firstHtml = result.html;
    lastHtml = result.html;

    if (!result.products.length) {
      pageRange.stopReason = "empty-page";
      break;
    }

    const signature = result.products
      .map((item) => item.productId)
      .sort()
      .join(",");

    if (previousSignature && signature === previousSignature) {
      pageRange.stopReason = "duplicate-page";
      break;
    }

    let addedCount = 0;

    for (const product of result.products) {
      if (productMap.has(product.productId)) continue;
      productMap.set(product.productId, product);
      addedCount += 1;
    }

    pageResults.push({
      page: pageNo,
      totalCount: result.products.length,
      activeCount: result.activeCount,
      soldOutCount: result.soldOutCount,
      addedCount,
      elapsedMs: +result.elapsedMs.toFixed(2),
    });

    pageRange.collectedLastPage = pageNo;
    pageRange.collectedPageCount = pageResults.length;
    previousSignature = signature;

    const allProducts = Array.from(productMap.values());
    const targetProductCount = allProducts.filter(
      (item) => !item.isSoldOut,
    ).length;
    const soldOutProductCount = allProducts.length - targetProductCount;

    onProgress({
      stage: "collecting",
      message: `${pageNo}페이지 완료`,
      currentPage: pageNo,
      pageRange,
      detectedTotalProductCount: pageRange.detectedTotalProductCount,
      collectedProductCount: allProducts.length,
      targetProductCount,
      productSummaryCount: allProducts.length,
      soldOutProductCount,
      elapsedText: formatMs(result.elapsedMs),
    });

    if (addedCount === 0) {
      pageRange.stopReason = "no-new-products";
      break;
    }

    if (config.requestDelayMs > 0 && pageNo < pageRange.pageEnd) {
      await sleep(config.requestDelayMs);
      throwIfAborted(signal);
    }
  }

  throwIfAborted(signal);

  const allProducts = Array.from(productMap.values());
  const activeProducts = allProducts.filter((item) => !item.isSoldOut);
  const soldOutProducts = allProducts.filter((item) => item.isSoldOut);

  return {
    allProducts,
    activeProducts,
    soldOutProducts,
    pageResults,
    pageRange,
    debugFiles: {
      "debug-first-page.html": firstHtml,
      "debug-last-page.html": lastHtml,
    },
  };
}

module.exports = {
  CCDOME_SITE,
  buildListUrl,
  collectCcdomeProducts,
  detectCatalog,
  gotoWithNavigationRetry,
  loginCcdome,
  parseCatalogInfo,
  parseProductList,
  parseTotalProductCount,
  resolvePageRange,
};

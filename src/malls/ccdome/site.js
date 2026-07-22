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

  return {
    loggedIn:
      $("a[href*='logout']").length > 0 || bodyText.includes("로그아웃"),
    errorText:
      [
        "아이디, 비밀번호가 일치하지 않습니다",
        "아이디 또는 비밀번호",
        "로그인 정보를 확인",
      ].find((text) => bodyText.includes(text)) || "",
  };
}

/** 공통 계정 설정으로 과자생각에 로그인한다. */
async function loginCcdome(page, config) {
  const selectors = CCDOME_SITE.selectors.login;

  console.log("[LOGIN] 과자생각 로그인 시작");

  await page.goto(new URL(CCDOME_SITE.urls.login, config.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

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

  await sleep(1500);
  await page.goto(buildListUrl(1, config), {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  const state = parseLoginState(await page.content());

  if (!state.loggedIn) {
    throw new Error(
      `과자생각 로그인 성공 확인 실패: ${
        state.errorText || "로그아웃 링크를 찾지 못했습니다."
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
async function detectCatalog(page, config) {
  const url = buildListUrl(1, config);

  console.log(`[PAGE DETECT] ${url}`);

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

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
async function resolvePageRange(page, config) {
  const detection = await detectCatalog(page, config);
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
async function collectListPage(page, pageNo, config, cachedHtml = null) {
  const startedAt = performance.now();
  const url = buildListUrl(pageNo, config);
  let html = cachedHtml;

  if (!html) {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });

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
  onProgress = () => {},
  signal,
) {
  throwIfAborted(signal);

  const { pageRange, firstPageHtml } = await resolvePageRange(page, config);
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
    const result = await collectListPage(page, pageNo, config, cachedHtml);
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
  loginCcdome,
  parseCatalogInfo,
  parseProductList,
  parseTotalProductCount,
  resolvePageRange,
};
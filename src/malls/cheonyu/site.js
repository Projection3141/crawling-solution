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

const CHEONYU_SITE = {
  urls: {
    login: "/member/login.html",
    list: "/product/list.html",
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
  },
};

/** 로그인 완료 HTML에서 로그인 상태를 판독한다. */
function parseLoginState(html) {
  const $ = cheerio.load(html);
  const bodyText = normalizeWhitespace($("body").text());

  return {
    loggedIn: bodyText.includes("로그아웃"),
    bodyText: bodyText.slice(0, 500),
  };
}

/** 공통 계정 설정으로 천유닷컴에 로그인한다. */
async function loginCheonyu(page, config) {
  const selectors = CHEONYU_SITE.selectors.login;

  console.log("[LOGIN] 천유닷컴 로그인 시작");

  await page.goto(new URL(CHEONYU_SITE.urls.login, config.baseUrl).toString(), {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  await fillFirstAvailable(page, selectors.idInputs, config.accountId, "ID");
  await fillFirstAvailable(
    page,
    selectors.passwordInputs,
    config.accountPw,
    "PW",
  );

  let submitted = false;

  for (const selector of selectors.submitButtons) {
    const locator = page.locator(selector).first();

    if ((await locator.count()) < 1) continue;

    await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: 10000 }),
      locator.click(),
    ]);

    submitted = true;
    break;
  }

  if (!submitted) {
    throw new Error("천유닷컴 로그인 버튼을 찾지 못했습니다.");
  }

  await sleep(1000);
  await page.goto(config.baseUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  if (!parseLoginState(await page.content()).loggedIn) {
    throw new Error("천유닷컴 로그인 성공 확인에 실패했습니다.");
  }

  console.log("[LOGIN] 천유닷컴 로그인 성공");
}

/** 공통 카테고리·페이지 설정으로 천유 상품 목록 URL을 생성한다. */
function buildListUrl(pageNo, config) {
  const url = new URL(CHEONYU_SITE.urls.list, config.baseUrl);

  url.searchParams.set("page", String(pageNo));
  url.searchParams.set("cateIDX", String(config.category));
  url.searchParams.set("listSize", String(config.pageSize));

  return url.toString();
}

/** 목록 HTML에서 전체 상품 수를 추출한다. */
function parseTotalProductCount(html) {
  const $ = cheerio.load(html);
  const countNode = $(CHEONYU_SITE.selectors.list.productCount).first();
  const selectorCount = toNumber(
    countNode.text() || countNode.attr("value") || "",
  );

  if (selectorCount > 0) return selectorCount;

  const bodyText = normalizeWhitespace($("body").text());
  const patterns = [
    /전체\s*([\d,]+)\s*개\s*의\s*상품이\s*등록되어\s*있습니다/i,
    /전체\s*([\d,]+)\s*개의\s*상품이\s*등록되어\s*있습니다/i,
    /전체\s*([\d,]+)\s*개\s*의\s*상품/i,
    /전체\s*([\d,]+)\s*개의\s*상품/i,
  ];

  for (const pattern of patterns) {
    const count = toNumber(bodyText.match(pattern)?.[1]);
    if (count > 0) return count;
  }

  return 0;
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

/** 명시적인 마지막 페이지 이동 링크를 찾는다. */
function parseExplicitLastPage(html, config) {
  const $ = cheerio.load(html);
  let lastPage = 0;

  $("a, button").each((_, element) => {
    const item = $(element);
    const marker = normalizeWhitespace(
      [
        item.text(),
        item.attr("class"),
        item.attr("title"),
        item.attr("aria-label"),
        item.attr("rel"),
        item.find("img").first().attr("alt"),
      ]
        .filter(Boolean)
        .join(" "),
    );

    if (
      !/마지막|맨끝|끝으로|last\b|btn[_-]?last|page[_-]?last|≫|»|>>/i.test(
        marker,
      )
    ) {
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

/** 첫 목록 HTML을 전체 상품 수와 마지막 페이지 정보로 변환한다. */
function parseCatalogInfo(html, config) {
  const totalProductCount = parseTotalProductCount(html);

  if (totalProductCount > 0) {
    return {
      totalProductCount,
      lastPage: Math.max(1, Math.ceil(totalProductCount / config.pageSize)),
      source: "product-count",
    };
  }

  const explicitLastPage = parseExplicitLastPage(html, config);

  if (explicitLastPage > 0) {
    return {
      totalProductCount: null,
      lastPage: explicitLastPage,
      source: "last-page-link",
    };
  }

  return {
    totalProductCount: null,
    lastPage: 0,
    source: "not-detected",
  };
}

/** 첫 목록 페이지에서 전체 상품 수와 마지막 페이지를 감지한다. */
async function detectCatalog(page, config) {
  const url = buildListUrl(1, config);
  const selectors = CHEONYU_SITE.selectors.list;

  console.log(`[PAGE DETECT] ${url}`);

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  if (response && !response.ok()) {
    throw new Error(`천유 상품 목록 요청 실패: HTTP ${response.status()}`);
  }

  await page.waitForSelector(
    `${selectors.productCheck}, ${selectors.productLink}`,
    { timeout: config.navigationTimeoutMs },
  );

  /** ProductCount가 비동기로 채워지는 경우를 최대 30초까지 기다린다. */
  await page
    .waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        const value = String(
          element?.textContent || element?.value || "",
        ).replace(/[^\d]/g, "");

        return Number(value) > 0;
      },
      selectors.productCount,
      { timeout: Math.min(config.navigationTimeoutMs, 30000) },
    )
    .catch(() => null);

  const html = await page.content();
  const info = parseCatalogInfo(html, config);

  if (config.pageEnd === 0 && info.lastPage < 1) {
    throw new Error(
      "PAGE_END=0 자동 모드에서 천유닷컴 마지막 페이지를 감지하지 못했습니다.",
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

/** 상품 목록 HTML을 Cheerio로 파싱한다. */
function parseListHtml(html, pageNo, config) {
  const $ = cheerio.load(html);
  const selectors = CHEONYU_SITE.selectors.list;
  const candidates = [];

  $(selectors.productCheck).each((index, check) => {
    const item = $(check).closest("li");
    const productId = $(check).attr("value") || "";

    if (!productId || !item.length) return;

    const href = item.find(selectors.productLink).first().attr("href") || "";
    const productName = normalizeProductName(
      item.find(selectors.productName).first().text() ||
        item.find(selectors.productImage).first().attr("alt") ||
        "",
    );
    const productUrl = href
      ? new URL(href, config.baseUrl).toString()
      : "";
    const packageInfo = parsePackageInfo(productName);
    const isSoldOut =
      item.find(selectors.soldOut).length > 0 ||
      item.closest(selectors.soldOut).length > 0;

    candidates.push({
      sourceMall: config.mall,
      categoryCode: config.category,
      page: pageNo,
      index,
      productId,
      productName,
      productUrl,
      imageUrl: "",
      isSoldOut,
      hasAddButton: item.find(selectors.addButton).length > 0,
      hasCountInput: item.find(selectors.countInput).length > 0,
      listMaxStock:
        item.find(selectors.maxStockInput).first().attr("value") || "",
      listPorderMinus:
        item.find(selectors.porderMinusInput).first().attr("value") || "",
      brandHint: inferBrand(productName),
      categoryHint: inferCategory(productName),
      packageQty: packageInfo.packageQty,
      packageUnit: packageInfo.packageUnit,
      packageText: packageInfo.packageText,
      saleStatus: isSoldOut ? "SOLD_OUT" : "ON_SALE",
      price: "",
      priceText: "",
    });
  });

  return candidates;
}

/** 한 상품 목록 페이지에서 장바구니 담기 가능한 상품을 추출한다. */
async function collectListCandidates(page, pageNo, config, cachedHtml = null) {
  const selectors = CHEONYU_SITE.selectors.list;
  const listUrl = buildListUrl(pageNo, config);
  let html = cachedHtml;

  if (!html) {
    console.log(`[LIST ${pageNo}] 이동: ${listUrl}`);

    const response = await page.goto(listUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });

    if (response && !response.ok()) {
      throw new Error(
        `천유 상품 목록 요청 실패: HTTP ${response.status()} - ${listUrl}`,
      );
    }

    await page.waitForSelector(
      `${selectors.productCheck}, ${selectors.productLink}`,
      { timeout: config.navigationTimeoutMs },
    );

    html = await page.content();
  }

  const candidates = parseListHtml(html, pageNo, config);
  const targets = candidates
    .filter(
      (item) => !item.isSoldOut && item.hasAddButton && item.hasCountInput,
    )
    .slice(0, config.maxPerPage);

  console.log(
    `[LIST ${pageNo}] 전체 ${candidates.length} | 대상 ${targets.length}`,
  );

  return {
    html,
    candidates,
    targets,
  };
}

/** 현재 목록 페이지에서 대상 상품의 수량과 체크 상태를 지정한다. */
async function markProductsForBulkCart(page, targets, config) {
  const targetIds = targets.map((item) => String(item.productId));
  const selectors = CHEONYU_SITE.selectors.list;

  const result = await page.evaluate(
    ({ ids, qty, productCheck, countInput }) => {
      const idSet = new Set(ids.map(String));
      const selected = [];

      for (const check of document.querySelectorAll(productCheck)) {
        const productId = String(check.value || "");
        const item = check.closest("li");

        if (!idSet.has(productId)) {
          check.checked = false;
          continue;
        }

        const input = item?.querySelector(countInput);

        if (!input) {
          check.checked = false;
          continue;
        }

        input.value = String(qty);
        check.checked = true;
        selected.push(productId);
      }

      return {
        checked: selected.length,
        selected,
      };
    },
    {
      ids: targetIds,
      qty: config.cartQty,
      productCheck: selectors.productCheck,
      countInput: selectors.countInput,
    },
  );

  if (result.checked < 1) {
    throw new Error("천유 목록에서 체크된 상품이 없습니다.");
  }

  return result;
}

/** 옵션 팝업 HTML 상태를 Cheerio로 판독한다. */
function parsePopupHtml(html) {
  const $ = cheerio.load(html);
  const selectors = CHEONYU_SITE.selectors.list;

  return {
    optionTableCount: $(selectors.optionTable).length,
    manyAddCount: $(selectors.manyAddWrap).length,
    bodyText: normalizeWhitespace($("body").text()).slice(0, 500),
  };
}

/** 일괄담기 버튼을 누르고 옵션 팝업의 setOption을 자동 실행한다. */
async function clickBulkCartAndConfirm(page, pageNo) {
  const selectors = CHEONYU_SITE.selectors.list;
  const bulkButton = page.locator(selectors.bulkButton).first();

  if ((await bulkButton.count()) < 1) {
    throw new Error(`${selectors.bulkButton} 버튼을 찾지 못했습니다.`);
  }

  console.log(`[BULK ${pageNo}] 장바구니 일괄담기`);
  await bulkButton.click();

  await Promise.race([
    page.waitForFunction(() => typeof window.setOption === "function", null, {
      timeout: 30000,
    }),
    page.waitForSelector(selectors.manyAddWrap, { timeout: 30000 }),
    page.waitForTimeout(30000),
  ]).catch(() => null);

  const hasSetOption = await page.evaluate(
    () => typeof window.setOption === "function",
  );
  const popupState = {
    hasSetOption,
    ...parsePopupHtml(await page.content()),
  };

  if (hasSetOption) {
    await page.evaluate(() => window.setOption());
    await sleep(4000);

    return {
      page: pageNo,
      mode: "popup-setOption",
      popupState,
    };
  }

  await sleep(3000);

  return {
    page: pageNo,
    mode: "direct-or-unknown",
    popupState,
  };
}

/** 계산된 범위를 순회하며 대상 상품을 장바구니에 담는다. */
async function bulkAddPages(
  page,
  config,
  onProgress = () => {},
  signal,
) {
  throwIfAborted(signal);

  const { pageRange, firstPageHtml } = await resolvePageRange(page, config);
  throwIfAborted(signal);
  const allTargets = [];
  const allProductsMap = new Map();
  const pageResults = [];
  let previousSignature = "";

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

    const startedAt = performance.now();
    const cachedHtml = pageNo === 1 ? firstPageHtml : null;
    const { candidates, targets } = await collectListCandidates(
      page,
      pageNo,
      config,
      cachedHtml,
    );
    throwIfAborted(signal);

    const signature = candidates
      .map((item) => item.productId)
      .sort()
      .join(",");

    if (!candidates.length) {
      pageRange.stopReason = "empty-page";
      break;
    }

    if (previousSignature && signature === previousSignature) {
      pageRange.stopReason = "duplicate-page";
      break;
    }

    for (const candidate of candidates) {
      if (!allProductsMap.has(String(candidate.productId))) {
        allProductsMap.set(String(candidate.productId), candidate);
      }
    }

    if (targets.length > 0) {
      await markProductsForBulkCart(page, targets, config);
      const bulkResult = await clickBulkCartAndConfirm(page, pageNo);
      throwIfAborted(signal);

      allTargets.push(...targets);
      pageResults.push({
        page: pageNo,
        candidateCount: candidates.length,
        targetCount: targets.length,
        bulkResult,
        elapsedMs: +(performance.now() - startedAt).toFixed(2),
      });
    } else {
      pageResults.push({
        page: pageNo,
        candidateCount: candidates.length,
        targetCount: 0,
        skipped: true,
        elapsedMs: +(performance.now() - startedAt).toFixed(2),
      });
    }

    previousSignature = signature;
    pageRange.collectedLastPage = pageNo;
    pageRange.collectedPageCount = pageResults.length;

    onProgress({
      stage: "collecting",
      message: `${pageNo}페이지 완료`,
      currentPage: pageNo,
      pageRange,
      detectedTotalProductCount: pageRange.detectedTotalProductCount,
      collectedProductCount: allProductsMap.size,
      targetProductCount: new Set(
        allTargets.map((item) => String(item.productId)),
      ).size,
      elapsedText: formatMs(performance.now() - startedAt),
    });

    if (config.requestDelayMs > 0 && pageNo < pageRange.pageEnd) {
      await sleep(config.requestDelayMs);
      throwIfAborted(signal);
    }
  }

  throwIfAborted(signal);

  return {
    allTargets,
    allProducts: Array.from(allProductsMap.values()),
    pageResults,
    pageRange,
  };
}

module.exports = {
  CHEONYU_SITE,
  buildListUrl,
  bulkAddPages,
  detectCatalog,
  loginCheonyu,
  parseCatalogInfo,
  parseListHtml,
  parseLoginState,
  parseTotalProductCount,
  resolvePageRange,
};
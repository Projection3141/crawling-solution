//src/malls/cheonyu/site.js

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
  createNonRetryableError,
  getSafetyNumber,
  gotoWithSiteRetry,
  isRetryableSiteError,
  markSiteError,
  resetPageState,
  withSiteRetry,
} = require("../../utils/site-safety");

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

/** 공통 사이트 안전 모듈로 천유 페이지 이동을 복구한다. */
async function gotoCheonyuSafely(
  page,
  url,
  config,
  label,
  signal,
  {
    readySelector = "",
    maxAttempts = null,
  } = {},
) {
  const attempts =
    Number(maxAttempts) ||
    getSafetyNumber(config, "navigationRetryCount", 8, 3, 20);
  const hardResetEvery = getSafetyNumber(
    config,
    "navigationHardResetEvery",
    3,
    2,
    10,
  );

  return gotoWithSiteRetry(page, url, {
    label: `[CHEONYU] ${label}`,
    signal,
    maxAttempts: attempts,
    timeoutMs: config.navigationTimeoutMs,
    readySelector,
    readyTimeoutMs: config.navigationTimeoutMs,
    baseDelayMs: 900,
    maxDelayMs: 15000,
    multiplier: 1.6,
    beforeAttempt: async ({ attempt }) => {
      if (attempt > 1 && (attempt - 1) % hardResetEvery === 0) {
        console.warn(
          `[CHEONYU] ${label} 이동 상태를 초기화합니다. (${attempt}/${attempts})`,
        );
        await resetPageState(page, {
          signal,
          delayMs: 700,
        });
      }
    },
  });
}

/** 공통 계정 설정으로 천유닷컴에 로그인한다. */
async function loginCheonyu(page, config, signal) {
  const selectors = CHEONYU_SITE.selectors.login;

  console.log("[LOGIN] 천유닷컴 로그인 시작");

  await gotoCheonyuSafely(
    page,
    new URL(CHEONYU_SITE.urls.login, config.baseUrl).toString(),
    config,
    "로그인 페이지",
    signal,
    {
      readySelector: selectors.passwordInputs.join(", "),
    },
  );

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
  await gotoCheonyuSafely(
    page,
    config.baseUrl,
    config,
    "로그인 확인 페이지",
    signal,
  );

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

/** 이미 확보한 상품 목록을 페이지별로 묶는다. */
function groupProductsByPage(products) {
  const groups = new Map();

  for (const product of products) {
    const pageNo = Number(product.page || 0);

    if (!pageNo) continue;

    if (!groups.has(pageNo)) {
      groups.set(pageNo, []);
    }

    groups.get(pageNo).push(product);
  }

  return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
}

/**
 * 일반 수집으로 확보한 상품 목록을 이용해
 * 지정 상품만 목록 페이지에서 체크 후 장바구니에 담는다.
 */
async function addProductsFromListPagesToCart(
  page,
  products,
  config,
  onProgress = () => { },
  signal,
) {
  throwIfAborted(signal);

  const groups = groupProductsByPage(products);
  const pageResults = [];
  const allTargets = [];

  for (const [pageNo, pageProducts] of groups) {
    throwIfAborted(signal);

    onProgress({
      stage: "cart",
      message: `천유 ${pageNo}페이지 상품 ${pageProducts.length}개 장바구니 담기`,
      currentPage: pageNo,
    });

    const { candidates } = await collectListCandidates(
      page,
      pageNo,
      config,
      null,
      signal,
    );
    const requestMap = new Map(
      pageProducts.map((item) => [String(item.productId), item]),
    );
    const targets = candidates
      .filter((candidate) => requestMap.has(String(candidate.productId)))
      .map((candidate) => ({
        ...candidate,
        ...requestMap.get(String(candidate.productId)),
      }));

    if (targets.length !== pageProducts.length) {
      const foundIds = new Set(targets.map((item) => String(item.productId)));
      const missingIds = pageProducts
        .filter((item) => !foundIds.has(String(item.productId)))
        .map((item) => item.productId);

      throw new Error(`천유 목록에서 상품을 찾지 못했습니다: ${missingIds.join(", ")}`);
    }

    await markProductsForBulkCart(page, targets, config);

    console.log(
      `[BULK ${pageNo}] 목록 체크 상태 안정화 완료`,
    );

    console.log(
      `[BULK ${pageNo}] 목록 체크 상태 확인 대기 8초`,
    );

    await page.waitForTimeout(8000);


    const bulkResult = await clickBulkCartAndConfirm(
      page,
      pageNo,
      config,
      targets,
      signal,
    );

    allTargets.push(...targets);
    pageResults.push({
      page: pageNo,
      targetCount: targets.length,
      bulkResult,
    });
  }

  return {
    allTargets,
    pageResults,
  };
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
async function detectCatalog(page, config, signal) {
  const url = buildListUrl(1, config);
  const selectors = CHEONYU_SITE.selectors.list;

  console.log(`[PAGE DETECT] ${url}`);

  await gotoCheonyuSafely(
    page,
    url,
    config,
    "상품 목록 감지",
    signal,
    {
      readySelector: `${selectors.productCheck}, ${selectors.productLink}`,
    },
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
    const hasAddButton = item.find(selectors.addButton).length > 0;
    const hasCountInput = item.find(selectors.countInput).length > 0;
    const cartAddable = !isSoldOut && hasAddButton && hasCountInput;

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
      unavailableInCart: false,
      hasAddButton,
      hasCountInput,
      cartAddable,
      listMaxStock:
        item.find(selectors.maxStockInput).first().attr("value") || "",
      listPorderMinus:
        item.find(selectors.porderMinusInput).first().attr("value") || "",
      brandHint: inferBrand(productName),
      categoryHint: inferCategory(productName),
      packageQty: packageInfo.packageQty,
      packageUnit: packageInfo.packageUnit,
      packageText: packageInfo.packageText,
      saleStatus: cartAddable ? "ON_SALE" : "SOLD_OUT",
      price: "",
      priceText: "",
    });
  });

  return candidates;
}

/** 한 상품 목록 페이지에서 장바구니 담기 가능한 상품을 추출한다. */
async function collectListCandidates(
  page,
  pageNo,
  config,
  cachedHtml = null,
  signal,
) {
  const selectors = CHEONYU_SITE.selectors.list;
  const listUrl = buildListUrl(pageNo, config);
  let html = cachedHtml;

  if (!html) {
    console.log(`[LIST ${pageNo}] 이동: ${listUrl}`);

    await gotoCheonyuSafely(
      page,
      listUrl,
      config,
      `${pageNo}페이지 목록`,
      signal,
      {
        readySelector: `${selectors.productCheck}, ${selectors.productLink}`,
      },
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

/** 여러 상품번호를 천유 전체 목록에서 한 번의 순회로 찾는다. */
async function findCheonyuProductsByIds(
  page,
  productIds,
  config,
  onProgress = () => { },
  signal,
) {
  throwIfAborted(signal);

  const pendingIds = new Set(
    productIds.map((value) => String(value || "").trim()).filter(Boolean),
  );

  if (pendingIds.size < 1) {
    return [];
  }

  const searchConfig = {
    ...config,
    category: "-1",
    pageStart: 1,
    pageEnd: 0,
  };
  const { pageRange, firstPageHtml } = await resolvePageRange(
    page,
    searchConfig,
    signal,
  );
  const foundMap = new Map();

  for (
    let pageNo = pageRange.pageStart;
    pageNo <= pageRange.pageEnd && pendingIds.size > 0;
    pageNo += 1
  ) {
    throwIfAborted(signal);

    onProgress({
      stage: "cart-product-search",
      message: `천유 장바구니 상품 검색 ${pageNo}/${pageRange.pageEnd}페이지`,
      currentPage: pageNo,
      pageRange,
      remainingProductCount: pendingIds.size,
    });

    const { candidates } = await collectListCandidates(
      page,
      pageNo,
      searchConfig,
      pageNo === 1 ? firstPageHtml : null,
      signal,
    );

    for (const candidate of candidates) {
      const productId = String(candidate.productId);

      if (!pendingIds.has(productId)) continue;

      foundMap.set(productId, {
        ...candidate,
        page: pageNo,
      });
      pendingIds.delete(productId);
    }

    if (
      searchConfig.requestDelayMs > 0 &&
      pageNo < pageRange.pageEnd &&
      pendingIds.size > 0
    ) {
      await sleep(searchConfig.requestDelayMs);
    }
  }

  if (pendingIds.size > 0) {
    throw new Error(
      `천유 상품 목록에서 찾지 못한 상품번호: ${Array.from(pendingIds).join(", ")}`,
    );
  }

  return Array.from(foundMap.values());
}

/** 현재 목록 페이지에서 대상 상품의 수량과 체크 상태를 지정한다. */
async function markProductsForBulkCart(page, targets, config) {
  const selectors = CHEONYU_SITE.selectors.list;
  const requests = targets.map((item) => {
    const cartRequests = Array.isArray(item.cartRequests)
      ? item.cartRequests
      : [];
    const directRequest = cartRequests.find((request) => {
      const optionId = String(request.optionId ?? "0");
      return optionId === "0" || optionId === String(item.productId);
    });

    return {
      productId: String(item.productId),
      quantity: Math.max(
        1,
        Math.trunc(
          Number(
            directRequest?.quantity ||
            item.quantity ||
            config.cartQty ||
            1,
          ),
        ),
      ),
    };
  });

  const result = await page.evaluate(
    ({ requests, productCheck, countInput }) => {
      const requestMap = new Map(
        requests.map((request) => [String(request.productId), request]),
      );
      const selected = [];

      for (const check of document.querySelectorAll(productCheck)) {
        const productId = String(check.value || "");
        const request = requestMap.get(productId);
        const item = check.closest("li");

        if (!request) {
          check.checked = false;
          continue;
        }

        const input = item?.querySelector(countInput);

        if (!input) {
          check.checked = false;
          continue;
        }

        input.value = String(request.quantity);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        check.checked = true;
        selected.push({ productId, quantity: request.quantity });
      }

      return {
        checked: selected.length,
        selected,
      };
    },
    {
      requests,
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


/** 옵션 팝업에서 disabled/품절 옵션을 제외하고 선택 가능한 옵션만 체크한다. */
async function parseAndPreparePopupOptions(
  page,
  pageNo,
  config,
  requestedProducts = [],
) {
  const requests = requestedProducts.map((item) => ({
    productId: String(item.productId || ""),
    productName: String(item.productName || "").replace(/\s+/g, " ").trim(),
    hasExplicitCartRequests:
      Array.isArray(item.cartRequests) && item.cartRequests.length > 0,
    cartRequests: Array.isArray(item.cartRequests)
      ? item.cartRequests.map((request) => ({
        productId: String(item.productId || ""),
        optionId: String(request.optionId ?? "0"),
        quantity: Math.max(1, Math.trunc(Number(request.quantity) || 1)),
      }))
      : [],
  }));

  return page.evaluate(
    ({ pageNo, requests, defaultOptionQty, lowStockThreshold }) => {
      const normalize = (value) =>
        String(value || "").replace(/\s+/g, " ").trim();
      const toNumber = (value) =>
        Number(String(value || "").replace(/[^\d-]/g, "")) || 0;
      const rows = [];
      const blocks = Array.from(document.querySelectorAll(".many_add"));

      for (let productIndex = 0; productIndex < blocks.length; productIndex += 1) {
        const block = blocks[productIndex];
        const table = block.querySelector("table#opSelectedList");

        if (!table) continue;

        const subjectText = normalize(block.querySelector(".subject p")?.innerText || "");
        const requestProduct =
          requests.find(
            (request) =>
              request.productName &&
              (subjectText.includes(request.productName) ||
                request.productName.includes(subjectText)),
          ) ||
          requests[productIndex] ||
          null;
        const cartGroupId = table.querySelector("input#inIDXPOP")?.value || "";
        const brandText = normalize(block.querySelector(".coc_brd_name")?.innerText || "")
          .replace(/^\[/, "")
          .replace(/\]$/, "");
        const iconText = normalize(block.querySelector(".icon")?.innerText || "");
        const outerBoxQty = toNumber(iconText.match(/(\d+)\s*개/)?.[1] || "");
        const optionRows = Array.from(table.querySelectorAll("tr#inOptionTR"));

        for (let optionIndex = 0; optionIndex < optionRows.length; optionIndex += 1) {
          const tr = optionRows[optionIndex];
          const checkbox = tr.querySelector("input#optionCHKPOP") || tr.querySelector("input[name='optionCHKPOP']");
          const countInput = tr.querySelector("input#inOPcount");
          const rawOptionId = normalize(
            checkbox?.value || tr.querySelector("input[name='optionCHKPOP']")?.value || "",
          );
          const rawOptionText = normalize(
            tr.querySelector("td.option_txt")?.innerText ||
            tr.querySelector("td#tdOption")?.innerText ||
            "",
          );
          const hasOption = rawOptionId !== "";
          const optionId = hasOption ? rawOptionId : "0";
          const optionText = hasOption ? rawOptionText : "";
          const submitOptionId = String(tr.querySelector("input#inOPidx")?.value || "");
          const maxStockInput = tr.querySelector("input#inOPMaxStock");
          const maxStock = toNumber(maxStockInput?.value);
          const disabled = Boolean(checkbox?.disabled);
          const complete =
            Boolean(checkbox) &&
            Boolean(countInput) &&
            Boolean(maxStockInput) &&
            String(maxStockInput.value ?? "").trim() !== "";
          const selectable = complete && !disabled && maxStock > 0;
          const matchedRequest = requestProduct?.cartRequests.find((request) => {
            const requestedOptionId = String(request.optionId ?? "0");
            return requestedOptionId === optionId;
          });
          const selectedForCart = requestProduct?.hasExplicitCartRequests
            ? selectable && Boolean(matchedRequest)
            : selectable;
          const quantity = matchedRequest?.quantity || defaultOptionQty;

          if (checkbox) {
            checkbox.checked = selectedForCart;
            checkbox.dispatchEvent(new Event("input", { bubbles: true }));
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }

          if (countInput && selectedForCart) {
            countInput.value = String(quantity);
            countInput.dispatchEvent(new Event("input", { bubbles: true }));
            countInput.dispatchEvent(new Event("change", { bubbles: true }));
          }

          let stockStatus = "IN_STOCK";

          if (disabled) stockStatus = "DISABLED";
          else if (maxStock <= 0) stockStatus = "OUT_OF_STOCK";
          else if (maxStock <= lowStockThreshold) stockStatus = "LOW_STOCK";

          rows.push({
            sourceMall: "cheonyu",
            rowSource: "popup",
            page: pageNo,
            productIndex,
            optionIndex,
            productId: requestProduct?.productId || "",
            productName: requestProduct?.productName || subjectText,
            cartGroupId,
            subjectText,
            brandText,
            optionText,
            optionId,
            submitOptionId,
            hasOption,
            maxStock,
            disabled,
            selectable,
            selectedForCart,
            requestedQty: selectedForCart ? quantity : 0,
            stockStatus,
            outerBoxQty,
            addPrice: toNumber(tr.querySelector("input#inOPaddPrice")?.value),
            boxCountOpt: toNumber(tr.querySelector("input#boxCountOpt")?.value),
            boxCountOpt2: toNumber(tr.querySelector("input#boxCountOpt2")?.value),
            inoPer: toNumber(tr.querySelector("input#inoPer")?.value),
            indcPer: toNumber(tr.querySelector("input#indcPer")?.value),
            indcPer2: toNumber(tr.querySelector("input#indcPer2")?.value),
            inoPrice: toNumber(tr.querySelector("input#inoPrice")?.value),
            indcPrice: toNumber(tr.querySelector("input#indcPrice")?.value),
            indcPrice2: toNumber(tr.querySelector("input#indcPrice2")?.value),
            porderMinus: tr.querySelector("input#inPorderMinus")?.value || "",
          });
        }
      }

      if (typeof window.fnSumTotalPrice === "function") {
        window.fnSumTotalPrice();
      }

      return rows;
    },
    {
      pageNo,
      requests,
      defaultOptionQty: config.optionCartQty || config.cartQty || 1,
      lowStockThreshold: config.lowStockThreshold,
    },
  );
}

/** 현재 화면에 표시된 천유 옵션 팝업 상태를 수집한다. */
async function readCheonyuOptionPopupState(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const wrappers = Array.from(
      document.querySelectorAll(".many_add_wrap, .many_add"),
    ).filter(isVisible);

    const tables = wrappers.flatMap((wrapper) =>
      Array.from(wrapper.querySelectorAll("table#opSelectedList")),
    );

    const rows = tables.flatMap((table) =>
      Array.from(table.querySelectorAll("tr#inOptionTR")),
    );

    const completeRows = rows.filter((row) => {
      const checkbox = row.querySelector("input#optionCHKPOP");
      const maxStock = row.querySelector("input#inOPMaxStock");
      const countInput = row.querySelector("input#inOPcount");

      return (
        Boolean(checkbox) &&
        Boolean(maxStock) &&
        String(maxStock.value ?? "").trim() !== "" &&
        Boolean(countInput)
      );
    });

    const selectableRows = completeRows.filter((row) => {
      const checkbox = row.querySelector("input#optionCHKPOP");
      const maxStock = Number(
        row.querySelector("input#inOPMaxStock")?.value || 0,
      );

      return Boolean(checkbox) && !checkbox.disabled && maxStock > 0;
    });

    return {
      visibleWrapperCount: wrappers.length,
      optionTableCount: tables.length,
      optionRowCount: rows.length,
      completeRowCount: completeRows.length,
      selectableRowCount: selectableRows.length,
    };
  });
}

/** 이전 옵션 팝업이 남아 있으면 안전하게 닫는다. */
async function closeCheonyuOptionPopup(page) {
  await page
    .evaluate(() => {
      if (typeof window.closeCartIn === "function") {
        window.closeCartIn();
        return;
      }

      const cancelButton = document.querySelector(
        ".many_add_cancle, .many_add_cancel",
      );

      if (cancelButton instanceof HTMLElement) {
        cancelButton.click();
      }
    })
    .catch(() => null);

  await page.waitForTimeout(500);
}

/**
 * 품절 상태가 목록에 아직 반영되지 않은 상품의
 * 장바구니 확인 팝업을 모두 닫는다.
 */
async function confirmCheonyuUnavailableProductPopups(
  page,
  pageNo,
  requestedProducts = [],
) {
  const confirmSelector =
    '#popContent img[alt="확인"][onclick*="fnCheckCartIn"]';
  const requestedMap = new Map(
    requestedProducts.map((product) => [
      String(product?.productId || ""),
      product,
    ]),
  );
  const unavailableProductIds = new Set();
  const observedUncheckedIds = new Set();
  const unresolvedMessages = [];
  let confirmedCount = 0;

  const normalizeComparable = (value) =>
    String(value || "")
      .replace(/^\[[^\]]+\]/, "")
      .replace(/\s+/g, "")
      .toLowerCase();

  /**
   * 여러 품절 상품이 연속으로 팝업을 띄우는 경우까지 처리한다.
   */
  while (confirmedCount < 100) {
    const confirmButton = page.locator(confirmSelector).first();
    const visible = await confirmButton
      .waitFor({
        state: "visible",
        timeout: confirmedCount === 0 ? 3000 : 1200,
      })
      .then(() => true)
      .catch(() => false);

    if (!visible) {
      break;
    }

    const snapshot = await page.evaluate(
      ({ productCheck, requestedIds }) => {
        const requestedIdSet = new Set(requestedIds);
        const popup = document.querySelector("#popContent");
        const uncheckedRequestedIds = [];

        for (const check of document.querySelectorAll(productCheck)) {
          const productId = String(check.value || "");

          if (requestedIdSet.has(productId) && !check.checked) {
            uncheckedRequestedIds.push(productId);
          }
        }

        return {
          text: String(popup?.innerText || "").replace(/\s+/g, " ").trim(),
          html: String(popup?.innerHTML || ""),
          uncheckedRequestedIds,
        };
      },
      {
        productCheck: CHEONYU_SITE.selectors.list.productCheck,
        requestedIds: Array.from(requestedMap.keys()),
      },
    );

    const popupText = normalizeComparable(snapshot.text);
    const popupHtml = String(snapshot.html || "");
    const matchedIds = new Set();

    for (const [productId, product] of requestedMap) {
      const productName = normalizeComparable(
        product?.normalizedName || product?.productName,
      );

      if (
        popupHtml.includes(productId) ||
        (productName && popupText.includes(productName))
      ) {
        matchedIds.add(productId);
      }
    }

    const newUncheckedIds = snapshot.uncheckedRequestedIds.filter(
      (productId) => !observedUncheckedIds.has(productId),
    );

    for (const productId of snapshot.uncheckedRequestedIds) {
      observedUncheckedIds.add(productId);
    }

    /**
     * 팝업 문구에 상품 식별값이 없을 때는 이번 팝업 시점에
     * 새로 체크 해제된 상품이 정확히 1개인 경우에만 해당 상품으로 본다.
     */
    if (matchedIds.size < 1 && newUncheckedIds.length === 1) {
      matchedIds.add(newUncheckedIds[0]);
    }

    for (const productId of matchedIds) {
      const product = requestedMap.get(productId);

      if (!product) {
        continue;
      }

      product.unavailableInCart = true;
      product.isSoldOut = true;
      product.cartAddable = false;
      product.saleStatus = "SOLD_OUT";
      unavailableProductIds.add(productId);
    }

    if (matchedIds.size < 1) {
      unresolvedMessages.push(snapshot.text || "품절 확인 팝업 식별 실패");
    }

    await confirmButton.click({ force: true });
    confirmedCount += 1;

    /**
     * 팝업이 닫히고 다음 품절 팝업이 생성될 시간을 기다린다.
     */
    await page.waitForTimeout(500);
  }

  if (confirmedCount > 0) {
    console.warn(
      `[BULK ${pageNo}] 품절 상품 확인 팝업 ${confirmedCount}건 처리`,
      {
        unavailableProductIds: Array.from(unavailableProductIds),
        unresolvedPopupCount: unresolvedMessages.length,
      },
    );
  }

  return {
    confirmedCount,
    unavailableProductIds: Array.from(unavailableProductIds),
    unresolvedMessages,
  };
}

/**
 * 옵션 팝업 wrapper가 아니라 실제 옵션 row와 재고값이 준비될 때까지 기다린다.
 *
 * 기존 코드는 window.setOption 또는 wrapper 존재만 확인했기 때문에
 * AJAX 옵션 데이터가 들어오기 전에 파싱하는 race condition이 발생할 수 있었다.
 */
async function waitForReadyCheonyuOptionPopup(
  page,
  config,
  timeoutOverrideMs = null,
) {
  const configuredTimeout =
    Number(timeoutOverrideMs) ||
    Number(config.optionPopupWaitTimeoutMs) ||
    Number(config.navigationTimeoutMs) ||
    60000;
  const timeout = Math.max(15000, Math.min(configuredTimeout, 120000));

  await page.waitForFunction(
    () => {
      const isVisible = (element) => {
        if (!element) return false;

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const wrappers = Array.from(
        document.querySelectorAll(".many_add_wrap, .many_add"),
      ).filter(isVisible);

      if (wrappers.length < 1) return false;

      const tables = wrappers.flatMap((wrapper) =>
        Array.from(wrapper.querySelectorAll("table#opSelectedList")),
      );

      if (tables.length < 1) return false;

      const rows = tables.flatMap((table) =>
        Array.from(table.querySelectorAll("tr#inOptionTR")),
      );

      if (rows.length < 1) return false;

      const allRowsComplete = rows.every((row) => {
        const checkbox = row.querySelector("input#optionCHKPOP");
        const maxStock = row.querySelector("input#inOPMaxStock");
        const countInput = row.querySelector("input#inOPcount");

        return (
          Boolean(checkbox) &&
          Boolean(maxStock) &&
          String(maxStock.value ?? "").trim() !== "" &&
          Boolean(countInput)
        );
      });

      if (!allRowsComplete) return false;

      return rows.some((row) => {
        const checkbox = row.querySelector("input#optionCHKPOP");
        const maxStock = Number(
          row.querySelector("input#inOPMaxStock")?.value || 0,
        );

        return Boolean(checkbox) && !checkbox.disabled && maxStock > 0;
      });
    },
    null,
    { timeout },
  );

  /** DOM이 생성된 직후 계산 스크립트가 끝날 짧은 안정화 시간을 둔다. */
  await page.waitForTimeout(700);
}

/**
 * 여러 차례 팝업 AJAX가 비어 있으면 목록 문서 자체를 다시 불러온다.
 *
 * wrapper만 남고 option table이 없는 상태는 같은 DOM에서 재클릭만 반복해도
 * 이전 요청 상태가 남을 수 있으므로, 목록 페이지를 새로 열고 대상 체크를 복원한다.
 */
async function resetCheonyuBulkListPage(
  page,
  pageNo,
  config,
  requestedProducts,
  signal,
) {
  console.warn(
    `[BULK ${pageNo}] 옵션 요청 상태 초기화를 위해 목록 페이지를 새로 불러옵니다.`,
  );

  await closeCheonyuOptionPopup(page);

  const listUrl = buildListUrl(pageNo, config);
  await gotoCheonyuSafely(
    page,
    listUrl,
    config,
    `${pageNo}페이지 하드 리셋`,
    signal,
    {
      readySelector:
        `${CHEONYU_SITE.selectors.list.productCheck}, ` +
        `${CHEONYU_SITE.selectors.list.productLink}`,
      maxAttempts: 6,
    },
  );

  if (requestedProducts.length > 0) {
    await markProductsForBulkCart(page, requestedProducts, config);
  }

  await sleep(1500);
}

/** 일괄담기 버튼을 누르고 요청된 옵션만 안전하게 장바구니에 담는다. */
async function clickBulkCartAndConfirm(
  page,
  pageNo,
  config,
  requestedProducts = [],
  signal,
) {
  const selectors = CHEONYU_SITE.selectors.list;
  const maxAttempts = getSafetyNumber(
    config,
    "optionPopupMaxAttempts",
    15,
    3,
    30,
  );
  const hardResetEvery = getSafetyNumber(
    config,
    "optionPopupHardResetEvery",
    3,
    2,
    10,
  );
  let lastPopupState = null;
  let lastError = null;

  try {
    return await withSiteRetry(
      async ({ attempt }) => {
        if (attempt > 1) {
          const shouldHardReset =
            requestedProducts.length > 0 &&
            (attempt - 1) % hardResetEvery === 0;

          if (shouldHardReset) {
            await resetCheonyuBulkListPage(
              page,
              pageNo,
              config,
              requestedProducts,
              signal,
            );
          } else {
            await closeCheonyuOptionPopup(page);
          }
        }

        const bulkButton = page.locator(selectors.bulkButton).first();

        if ((await bulkButton.count()) < 1) {
          throw markSiteError(
            new Error(`${selectors.bulkButton} 버튼을 찾지 못했습니다.`),
            {
              retryable: true,
              code: "BULK_BUTTON_NOT_FOUND",
              stage: "cheonyu-popup",
            },
          );
        }

        await page.waitForFunction(
          ({ productCheck, countInput, requests }) => {
            const requestMap = new Map(
              requests.map((request) => [
                String(request.productId),
                String(request.quantity),
              ]),
            );
            let matched = 0;

            for (const check of document.querySelectorAll(productCheck)) {
              const productId = String(check.value || "");
              if (!requestMap.has(productId)) continue;

              const input = check.closest("li")?.querySelector(countInput);
              const quantityValue = input?.value ? String(input.value) : "";

              if (check.checked && quantityValue === requestMap.get(productId)) {
                matched += 1;
              }
            }

            return matched === requestMap.size;
          },
          {
            productCheck: selectors.productCheck,
            countInput: selectors.countInput,
            requests: requestedProducts.map((item) => ({
              productId: String(item.productId || ""),
              quantity: String(
                Math.max(
                  1,
                  Math.trunc(
                    Number(item.quantity || config.cartQty || 1) || 1,
                  ),
                ),
              ),
            })),
          },
          { timeout: Math.min(config.navigationTimeoutMs, 10000) },
        );

        await page.evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
              });
            }),
        );

        await page.waitForTimeout(1200);

        console.log(
          `[BULK ${pageNo}] 장바구니 일괄담기` +
          (attempt > 1 ? ` (${attempt}차 시도)` : ""),
        );


        const popupWaitTimeoutMs =
          attempt <= 5 ? 30000 : attempt <= 10 ? 45000 : 60000;

        await bulkButton.click({
          timeout:
            config.navigationTimeoutMs,
        });

        /**
         * 목록에서는 판매 중으로 표시되지만
         * 실제 장바구니에서는 품절인 상품 팝업을 처리한다.
         */
        const unavailablePopupResult =
          await confirmCheonyuUnavailableProductPopups(
            page,
            pageNo,
            requestedProducts,
          );

        await waitForReadyCheonyuOptionPopup(
          page,
          config,
          popupWaitTimeoutMs,
          requestedProducts.length,
        );

        console.log(
          `[BULK ${pageNo}] 옵션 팝업 준비 확인`
        );

        await page.waitForTimeout(5000);


        const hasSetOption = await page.evaluate(
          () => typeof window.setOption === "function",
        );

        lastPopupState = {
          hasSetOption,
          ...(await readCheonyuOptionPopupState(page)),
          ...parsePopupHtml(await page.content()),
        };

        if (!hasSetOption) {
          throw markSiteError(
            new Error("천유 옵션 확정 함수 setOption을 찾지 못했습니다."),
            {
              retryable: true,
              code: "SET_OPTION_NOT_FOUND",
              stage: "cheonyu-popup",
              details: lastPopupState,
            },
          );
        }

        const popupOptionRows = await parseAndPreparePopupOptions(
          page,
          pageNo,
          config,
          requestedProducts,
        );

        if (requestedProducts.length > 0) {
          for (const product of requestedProducts) {
            for (const request of product.cartRequests || []) {
              const requestedOptionId = String(request.optionId ?? "0");
              const matchedRow = popupOptionRows.find((row) => {
                if (String(row.productId) !== String(product.productId)) {
                  return false;
                }

                return (
                  String(row.optionId) === requestedOptionId ||
                  (requestedOptionId === String(product.productId) &&
                    String(row.optionId) === "0")
                );
              });

              if (!matchedRow) {
                throw markSiteError(
                  new Error(
                    `천유 상품 ${product.productId}에서 옵션 ` +
                    `${requestedOptionId}를 찾지 못했습니다.`,
                  ),
                  {
                    retryable: true,
                    code: "REQUESTED_OPTION_NOT_FOUND",
                    stage: "cheonyu-popup",
                  },
                );
              }

              if (!matchedRow.selectable) {
                throw createNonRetryableError(
                  `천유 상품 ${product.productId}의 옵션 ` +
                  `${requestedOptionId}는 구매할 수 없습니다.`,
                  {
                    code: "OPTION_NOT_PURCHASABLE",
                    stage: "cheonyu-popup",
                  },
                );
              }

              if (
                matchedRow.maxStock > 0 &&
                request.quantity > matchedRow.maxStock
              ) {
                throw createNonRetryableError(
                  `천유 상품 ${product.productId} 옵션 ${requestedOptionId}: ` +
                  `요청 ${request.quantity}개, 구매 가능 ` +
                  `${matchedRow.maxStock}개`,
                  {
                    code: "QUANTITY_EXCEEDS_STOCK",
                    stage: "cheonyu-popup",
                  },
                );
              }

              if (!matchedRow.selectedForCart) {
                throw markSiteError(
                  new Error(
                    `천유 상품 ${product.productId}의 옵션 ` +
                    `${requestedOptionId} 선택에 실패했습니다.`,
                  ),
                  {
                    retryable: true,
                    code: "OPTION_SELECTION_FAILED",
                    stage: "cheonyu-popup",
                  },
                );
              }
            }
          }
        }

        const selectedCount = popupOptionRows.filter(
          (item) => item.selectedForCart,
        ).length;

        if (selectedCount < 1) {
          lastPopupState = {
            ...lastPopupState,
            parsedRowCount: popupOptionRows.length,
            selectedCount,
          };

          throw markSiteError(
            new Error(
              "옵션 row는 생성됐지만 선택 가능한 천유 옵션이 없습니다.",
            ),
            {
              retryable: true,
              code: "NO_SELECTABLE_OPTIONS",
              stage: "cheonyu-popup",
              details: lastPopupState,
            },
          );
        }

        console.log(
          `[BULK ${pageNo}] 옵션 체크 상태 확인 대기 8초`,
        );

        await page.waitForTimeout(8000);


        await page.evaluate(() => window.setOption());

        await page
          .waitForFunction(
            () => {
              const wrappers = Array.from(
                document.querySelectorAll(".many_add_wrap, .many_add"),
              );

              return wrappers.every((element) => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();

                return (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity || "1") === 0 ||
                  rect.width === 0 ||
                  rect.height === 0
                );
              });
            },
            null,
            { timeout: 30000 },
          )
          .catch(() => null);

        await sleep(1500);

        return {
          page: pageNo,
          mode: "popup-setOption",
          popupState: lastPopupState,
          popupOptionRows,
          selectedCount,
          unavailablePopupResult,
          unavailableProductIds:
            unavailablePopupResult.unavailableProductIds,
          attempt,
          maxAttempts,
        };
      },
      {
        label: `천유 ${pageNo}페이지 옵션 팝업`,
        maxAttempts,
        signal,
        shouldRetry: (error) =>
          isRetryableSiteError(error, {
            signal,
            retryUnknownErrors: true,
          }),
        baseDelayMs: 1000,
        maxDelayMs: 15000,
        multiplier: 1.45,
        onRetry: async ({ error, nextAttempt }) => {
          lastError = error;
          lastPopupState = await readCheonyuOptionPopupState(page).catch(
            () => error?.details || lastPopupState,
          );

          console.warn(
            `[BULK ${pageNo}] 옵션 팝업 재시도 ` +
            `${nextAttempt}/${maxAttempts}`,
            lastPopupState,
          );
        },
      },
    );
  } catch (error) {
    lastError = error;
  }

  if (lastError?.retryable === false) {
    throw lastError;
  }

  const diagnostic = lastPopupState
    ? ` 상태=${JSON.stringify(lastPopupState)}`
    : "";

  throw new Error(
    `천유 ${pageNo}페이지 옵션 팝업 준비에 ${maxAttempts}회 실패했습니다.` +
    `${lastError ? ` 원인: ${lastError.message}` : ""}` +
    diagnostic,
  );
}

/** 계산된 범위를 순회하며 대상 상품을 장바구니에 담는다. */
async function bulkAddPages(
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
  const allTargets = [];
  const allPopupOptionRows = [];
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
      signal,
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
      const bulkResult = await clickBulkCartAndConfirm(
        page,
        pageNo,
        config,
        targets,
        signal,
      );
      throwIfAborted(signal);

      for (const productId of bulkResult.unavailableProductIds || []) {
        const product = allProductsMap.get(String(productId));

        if (!product) {
          continue;
        }

        product.unavailableInCart = true;
        product.isSoldOut = true;
        product.cartAddable = false;
        product.saleStatus = "SOLD_OUT";
      }

      allTargets.push(...targets);
      allPopupOptionRows.push(...(bulkResult.popupOptionRows || []));
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
    allPopupOptionRows,
    allProducts: Array.from(allProductsMap.values()),
    pageResults,
    pageRange,
  };
}

module.exports = {
  CHEONYU_SITE,
  buildListUrl,
  bulkAddPages,
  collectListCandidates,
  detectCatalog,
  findCheonyuProductsByIds,
  loginCheonyu,
  parseCatalogInfo,
  parseListHtml,
  parseLoginState,
  parseAndPreparePopupOptions,
  parseTotalProductCount,
  resolvePageRange,
  addProductsFromListPagesToCart,
};
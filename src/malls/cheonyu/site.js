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
  onProgress = () => {},
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

    const { candidates } = await collectListCandidates(page, pageNo, config);
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
    const bulkResult = await clickBulkCartAndConfirm(
      page,
      pageNo,
      config,
      targets,
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

/** 여러 상품번호를 천유 전체 목록에서 한 번의 순회로 찾는다. */
async function findCheonyuProductsByIds(
  page,
  productIds,
  config,
  onProgress = () => {},
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
  const { pageRange, firstPageHtml } = await resolvePageRange(page, searchConfig);
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
          const checkbox = tr.querySelector("input#optionCHKPOP");
          const countInput = tr.querySelector("input#inOPcount");
          const optionText = normalize(tr.querySelector("td#tdOption")?.innerText || "옵션없음");
          const optionId = String(tr.querySelector("input#inOPidx")?.value || "0");
          const maxStock = toNumber(tr.querySelector("input#inOPMaxStock")?.value);
          const disabled = Boolean(checkbox?.disabled);
          const selectable = Boolean(checkbox) && !disabled && maxStock > 0;
          const matchedRequest = requestProduct?.cartRequests.find((request) => {
            const requestedOptionId = String(request.optionId ?? "0");
            return (
              requestedOptionId === optionId ||
              (requestedOptionId === request.productId && optionId === "0")
            );
          });
          const selectedForCart = requestProduct
            ? selectable && Boolean(matchedRequest)
            : selectable;
          const quantity = matchedRequest?.quantity || defaultOptionQty;

          if (checkbox) {
            checkbox.checked = selectedForCart;
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
            cartGroupId,
            subjectText,
            brandText,
            optionText,
            optionId,
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
      const optionId = row.querySelector("input#inOPidx");
      const maxStock = row.querySelector("input#inOPMaxStock");
      const countInput = row.querySelector("input#inOPcount");

      return (
        Boolean(checkbox) &&
        Boolean(optionId) &&
        optionId.value !== "" &&
        Boolean(maxStock) &&
        maxStock.value !== "" &&
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
      groupIds: tables
        .map((table) => table.querySelector("input#inIDXPOP")?.value || "")
        .filter(Boolean),
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
 * 옵션 팝업 wrapper가 아니라 실제 옵션 row와 재고값이 준비될 때까지 기다린다.
 *
 * 기존 코드는 window.setOption 또는 wrapper 존재만 확인했기 때문에
 * AJAX 옵션 데이터가 들어오기 전에 파싱하는 race condition이 발생할 수 있었다.
 */
async function waitForReadyCheonyuOptionPopup(page, config) {
  const timeout = Math.max(
    30000,
    Math.min(Number(config.navigationTimeoutMs) || 60000, 90000),
  );

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
        const optionId = row.querySelector("input#inOPidx");
        const maxStock = row.querySelector("input#inOPMaxStock");
        const countInput = row.querySelector("input#inOPcount");

        return (
          Boolean(checkbox) &&
          Boolean(optionId) &&
          optionId.value !== "" &&
          Boolean(maxStock) &&
          maxStock.value !== "" &&
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

/** 일괄담기 버튼을 누르고 요청된 옵션만 장바구니에 담는다. */
async function clickBulkCartAndConfirm(
  page,
  pageNo,
  config,
  requestedProducts = [],
) {
  const selectors = CHEONYU_SITE.selectors.list;
  const maxAttempts = 3;
  let lastPopupState = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const bulkButton = page.locator(selectors.bulkButton).first();

    if ((await bulkButton.count()) < 1) {
      throw new Error(`${selectors.bulkButton} 버튼을 찾지 못했습니다.`);
    }

    if (attempt > 1) {
      console.warn(
        `[BULK ${pageNo}] 옵션 팝업 재시도 ${attempt}/${maxAttempts}`,
      );

      await closeCheonyuOptionPopup(page);
      await sleep(1000 * attempt);
    }

    console.log(
      `[BULK ${pageNo}] 장바구니 일괄담기` +
        (attempt > 1 ? ` (${attempt}차 시도)` : ""),
    );

    await bulkButton.click();

    try {
      await waitForReadyCheonyuOptionPopup(page, config);
    } catch (error) {
      lastError = error;
      lastPopupState = await readCheonyuOptionPopupState(page).catch(() => null);

      console.warn(
        `[BULK ${pageNo}] 옵션 팝업 준비 실패`,
        lastPopupState,
      );

      continue;
    }

    const hasSetOption = await page.evaluate(
      () => typeof window.setOption === "function",
    );

    lastPopupState = {
      hasSetOption,
      ...(await readCheonyuOptionPopupState(page)),
      ...parsePopupHtml(await page.content()),
    };

    if (!hasSetOption) {
      lastError = new Error("천유 옵션 확정 함수 setOption을 찾지 못했습니다.");
      continue;
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
            if (String(row.productId) !== String(product.productId)) return false;

            return (
              String(row.optionId) === requestedOptionId ||
              (requestedOptionId === String(product.productId) &&
                String(row.optionId) === "0")
            );
          });

          if (!matchedRow) {
            throw new Error(
              `천유 상품 ${product.productId}에서 옵션 ${requestedOptionId}를 찾지 못했습니다.`,
            );
          }

          if (!matchedRow.selectable) {
            throw new Error(
              `천유 상품 ${product.productId}의 옵션 ${requestedOptionId}는 구매할 수 없습니다.`,
            );
          }

          if (matchedRow.maxStock > 0 && request.quantity > matchedRow.maxStock) {
            throw new Error(
              `천유 상품 ${product.productId} 옵션 ${requestedOptionId}: ` +
                `요청 ${request.quantity}개, 구매 가능 ${matchedRow.maxStock}개`,
            );
          }

          if (!matchedRow.selectedForCart) {
            throw new Error(
              `천유 상품 ${product.productId}의 옵션 ${requestedOptionId} 선택에 실패했습니다.`,
            );
          }
        }
      }
    }

    const selectedCount = popupOptionRows.filter(
      (item) => item.selectedForCart,
    ).length;

    if (selectedCount < 1) {
      lastError = new Error(
        "옵션 row는 생성됐지만 선택 가능한 천유 옵션이 없습니다.",
      );

      lastPopupState = {
        ...lastPopupState,
        parsedRowCount: popupOptionRows.length,
        selectedCount,
      };

      console.warn(
        `[BULK ${pageNo}] 선택 가능한 옵션 없음`,
        lastPopupState,
      );

      continue;
    }

    await page.evaluate(() => window.setOption());

    /** 옵션 팝업이 닫히거나 숨겨져 실제 장바구니 반영이 시작됐는지 확인한다. */
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
      attempt,
    };
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
  onProgress = () => {},
  signal,
) {
  throwIfAborted(signal);

  const { pageRange, firstPageHtml } = await resolvePageRange(page, config);
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
      const bulkResult = await clickBulkCartAndConfirm(page, pageNo, config);
      throwIfAborted(signal);

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
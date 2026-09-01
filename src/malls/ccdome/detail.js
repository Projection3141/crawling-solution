// src/malls/ccdome/detail.js

const cheerio = require("cheerio");
const {
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
  isRetryableSiteError,
  markSiteError,
  replacePage,
  resetPageState,
  sleepWithSignal,
  withSiteRetry,
} = require("../../utils/site-safety");

const CCDOME_DETAIL = {
  selectors: {
    root: ".sub_content, .goods_view, .item_goods_sec, #contents",
    categoryItems:
      ".location_wrap .location_select .location_tit span, " +
      ".location_wrap .location_select .location_tit a span, " +
      ".location_wrap .location_tit span",
    title: ".item_info_box .item_detail_tit h3, .item_detail_tit h3, .item_tit_detail_cont h3",
    itemInfoList:
      ".item_info_box .item_detail_list dl, " +
      ".item_info_box dl, " +
      ".item_detail_list dl, " +
      ".goods_view dl",
    /**
     * 상품 이미지:
     * - Slick 초기화 후: ul > .slick-list > .slick-track > li > a > img
     * - Slick 초기화 전: ul > li > a > img
     * 두 구조를 모두 지원하며 다른 영역의 이미지는 포함하지 않는다.
     */
    mainImages:
      ".item_photo_slide ul.slider_wrap.slider_goods_nav li a img, " +
      ".item_photo_slide ul.slider_goods_nav li a img, " +
      ".item_photo_slide .slick-track li.slick-slide a img, " +
      ".item_photo_slide .slick-track li a img",

    /** 상세 이미지: detail_explain_box 안에서 가운데 정렬된 영역의 이미지만 수집한다. */
    detailImages:
      ".detail_explain_box center img, " +
      ".detail_explain_box [align='center'] img, " +
      ".detail_explain_box [align='CENTER'] img",
    detailTextScope: "#detail .detail_cont, .detail_cont, .item_goods_sec",
  },
};

/** 상대/프로토콜 생략 URL을 절대 URL로 정리한다. */
function toAbsoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();

  if (!raw || raw.startsWith("data:")) return "";

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

/** 중복과 빈 값을 제거한다. */
function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/** 이미지 태그에서 lazy 속성까지 포함해 실제 이미지 URL을 읽는다. */
function getImageUrl($, element, baseUrl) {
  const item = $(element);

  return toAbsoluteUrl(
    item.attr("data-original") ||
      item.attr("data-src") ||
      item.attr("data-lazy") ||
      item.attr("src"),
    baseUrl,
  );
}

/** dl/dt/dd 구조의 상품 정보 목록을 key-value 객체로 변환한다. */
function parseDefinitionList($, selector) {
  const result = {};

  $(selector).each((_, dl) => {
    const key = normalizeWhitespace($(dl).find("dt").first().text());
    const value = normalizeWhitespace($(dl).find("dd").first().text());

    if (key) result[key] = value;
  });

  return result;
}


/** DOM 요소의 text 또는 value 속성을 문자열로 읽는다. */
function readNodeValue($, element) {
  const item = $(element);

  return normalizeWhitespace(
    item.attr("value") ||
      item.attr("data-price") ||
      item.text(),
  );
}

/**
 * 상세페이지의 dl·tr 구조에서 label과 일치하는 값을 찾는다.
 * 과자생각 테마에 따라 판매가와 브랜드가 item_detail_list 밖에 있을 수 있다.
 */
function findLabeledDetailValue($, labels) {
  const normalizedLabels = labels.map((label) =>
    normalizeWhitespace(label),
  );
  let result = "";

  $("#contents dl, .goods_view dl, .item_info_box dl, .item_detail_list dl").each(
    (_, dl) => {
      if (result) return;

      const label = normalizeWhitespace($(dl).find("dt").first().text());

      if (!normalizedLabels.some((keyword) => label.includes(keyword))) {
        return;
      }

      result = readNodeValue($, $(dl).find("dd").first());
    },
  );

  if (result) return result;

  $("#contents tr, .goods_view tr, .item_info_box tr").each((_, tr) => {
    if (result) return;

    const cells = $(tr).find("th, td").toArray();

    for (let index = 0; index < cells.length - 1; index += 1) {
      const label = normalizeWhitespace($(cells[index]).text());

      if (!normalizedLabels.some((keyword) => label.includes(keyword))) {
        continue;
      }

      result = readNodeValue($, cells[index + 1]);
      break;
    }
  });

  return result;
}

/** selector 후보 중 처음 발견되는 값을 반환한다. */
function readFirstDetailValue($, selectors) {
  for (const selector of selectors) {
    const element = $(selector).first();

    if (!element.length) continue;

    const value = readNodeValue($, element);

    if (value) return value;
  }

  return "";
}

/** 판매가와 브랜드를 제외한 상세 항목을 specs row로 변환한다. */
function createSpecRows(itemInfo = {}) {
  return Object.entries(itemInfo)
    .filter(([label]) => {
      const normalizedLabel = normalizeWhitespace(label);

      return (
        !normalizedLabel.includes("판매가") &&
        !normalizedLabel.includes("브랜드")
      );
    })
    .map(([label, value], index) => ({
      labelKo: normalizeWhitespace(label),
      labelJa: normalizeWhitespace(label),
      valueKo: normalizeWhitespace(value),
      valueJa: normalizeWhitespace(value),
      sortOrder: index * 10,
    }))
    .filter((row) => row.labelKo && row.valueKo);
}

/** key 이름 후보로 객체 값을 찾는다. */
function pickByIncludes(source, keywords) {
  const entries = Object.entries(source || {});

  for (const keyword of keywords) {
    const found = entries.find(([key]) => key.includes(keyword));
    if (found) return found[1];
  }

  return "";
}

/** 가격 문자열에서 첫 금액을 정수로 추출한다. */
function parsePrice(value) {
  const text = normalizeWhitespace(value);
  const match = text.match(/-?\d[\d,]*/);
  return match ? toNumber(match[0]) : 0;
}

/**
 * Slick 상품 이미지 DOM이 실제로 만들어질 때까지 기다린다.
 *
 * 상세 루트(.sub_content 등)는 상품 이미지 슬라이더보다 먼저 생성될 수 있으므로,
 * 루트만 기다린 뒤 곧바로 page.content()를 읽으면 mainImageUrls가 비는 문제가 생긴다.
 */
async function prepareCcdomeDetailImages(page, config) {
  const selector = CCDOME_DETAIL.selectors.mainImages;
  const timeout = Math.max(
    10000,
    Math.min(Number(config.navigationTimeoutMs) || 60000, 60000),
  );

  await page.waitForFunction(
    (imageSelector) => {
      const images = Array.from(document.querySelectorAll(imageSelector));

      if (images.length < 1) return false;

      return images.every((image) => {
        const url =
          image.getAttribute("data-original") ||
          image.getAttribute("data-src") ||
          image.getAttribute("data-lazy") ||
          image.getAttribute("src") ||
          "";

        return String(url).trim().length > 0;
      });
    },
    selector,
    { timeout },
  );

  /** Slick이 clone·active 상태를 정리할 짧은 안정화 시간을 둔다. */
  await page.waitForTimeout(500);
}

/**
 * 브라우저에 실제로 생성된 DOM에서 과자생각 이미지 URL을 직접 읽는다.
 *
 * Slick이 JavaScript로 만든 DOM을 page.content()로 직렬화한 뒤 Cheerio로 다시
 * 파싱하면 실행 시점이나 HTML 보정에 따라 슬라이더 내부 노드가 누락될 수 있다.
 * 이미지 URL은 라이브 DOM에서 읽고 텍스트 정보만 Cheerio로 파싱한다.
 */
async function readCcdomeImageUrlsFromPage(page) {
  return page.evaluate(() => {
    const mainSelector =
      ".item_photo_slide ul.slider_wrap.slider_goods_nav li a img, " +
      ".item_photo_slide ul.slider_goods_nav li a img, " +
      ".item_photo_slide .slick-track li.slick-slide a img, " +
      ".item_photo_slide .slick-track li a img";
    const detailSelector =
      ".detail_explain_box center img, " +
      ".detail_explain_box [align='center'] img, " +
      ".detail_explain_box [align='CENTER'] img";

    const readUrl = (image) => {
      const raw =
        image.getAttribute("data-original") ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-lazy") ||
        image.getAttribute("src") ||
        "";

      const value = String(raw).trim();
      if (!value || value.startsWith("data:")) return "";

      try {
        return new URL(value, window.location.href).toString();
      } catch {
        return "";
      }
    };

    const collect = (selector) =>
      Array.from(document.querySelectorAll(selector))
        .map(readUrl)
        .filter(Boolean)
        .filter((url, index, urls) => urls.indexOf(url) === index);

    return {
      mainImageUrls: collect(mainSelector),
      introImageUrls: collect(detailSelector),
      diagnostics: {
        mainMatchedCount: document.querySelectorAll(mainSelector).length,
        detailMatchedCount: document.querySelectorAll(detailSelector).length,
        sliderClass: document
          .querySelector(".item_photo_slide ul")
          ?.getAttribute("class") || "",
      },
    };
  });
}

/** 상세 설명 영역의 이미지 URL을 추출한다. */
function parseDetailImages($, config) {
  const selectors = CCDOME_DETAIL.selectors;
  const urls = [];

  $(selectors.detailImages).each((_, img) => {
    urls.push(getImageUrl($, img, config.baseUrl));
  });

  return unique(urls);
}

/** 대표/썸네일 이미지 URL을 추출한다. */
function parseMainImages($, config) {
  const urls = [];

  $(CCDOME_DETAIL.selectors.mainImages).each((_, img) => {
    urls.push(getImageUrl($, img, config.baseUrl));
  });

  return unique(urls);
}


/**
 * JavaScript 적용 후 실제 DOM에서 판매가와 브랜드를 읽는다.
 * 상세 HTML 직렬화 시 동적 가격 영역이 누락되는 경우를 보완한다.
 */
async function readCcdomeProductMetaFromPage(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      String(value || "").replace(/\s+/g, " ").trim();

    const readValue = (element) =>
      normalize(
        element?.getAttribute?.("value") ||
          element?.getAttribute?.("data-price") ||
          element?.textContent ||
          "",
      );

    const findByLabel = (labels) => {
      const normalizedLabels = labels.map(normalize);
      const scopes = document.querySelectorAll(
        "#contents dl, .goods_view dl, .item_info_box dl, " +
          ".item_detail_list dl",
      );

      for (const scope of scopes) {
        const label = normalize(scope.querySelector("dt")?.textContent);

        if (!normalizedLabels.some((keyword) => label.includes(keyword))) {
          continue;
        }

        const value = readValue(scope.querySelector("dd"));
        if (value) return value;
      }

      const rows = document.querySelectorAll(
        "#contents tr, .goods_view tr, .item_info_box tr",
      );

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th, td"));

        for (let index = 0; index < cells.length - 1; index += 1) {
          const label = normalize(cells[index].textContent);

          if (!normalizedLabels.some((keyword) => label.includes(keyword))) {
            continue;
          }

          const value = readValue(cells[index + 1]);
          if (value) return value;
        }
      }

      return "";
    };

    const firstValue = (selectors) => {
      for (const selector of selectors) {
        const value = readValue(document.querySelector(selector));
        if (value) return value;
      }

      return "";
    };

    return {
      salePriceText:
        findByLabel(["판매가"]) ||
        firstValue([
          ".item_money_box .item_price dd strong",
          ".item_money_box .item_price dd",
          ".item_info_box .item_price dd strong",
          ".item_info_box .item_price dd",
          "input[name='goodsPrice']",
          "input[name='goods_price']",
          "input[name='set_goods_price']",
          "input[name='goodsDcPrice']",
        ]),
      brandText: findByLabel(["브랜드"]),
    };
  });
}

/** 과자생각 상품 상세 HTML을 표준 상세 row로 변환한다. */
function parseCcdomeDetailHtml(html, product, config) {
  const $ = cheerio.load(html);
  const selectors = CCDOME_DETAIL.selectors;
  const categoryItems = $(selectors.categoryItems)
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean)
    .filter((value) => ![">", "홈"].includes(value));

  const itemInfo = parseDefinitionList($, selectors.itemInfoList);
  const specRows = createSpecRows(itemInfo);
  const productName =
    normalizeProductName($(selectors.title).first().text()) ||
    normalizeProductName(product.productName);
  const packageInfo = parsePackageInfo(productName);
  const mainImageUrls = parseMainImages($, config);
  const introImageUrls = parseDetailImages($, config);

  const expiryDate = pickByIncludes(itemInfo, ["소비기한", "유통기한"]);
  const salePriceText =
    pickByIncludes(itemInfo, ["판매가"]) ||
    findLabeledDetailValue($, ["판매가"]) ||
    readFirstDetailValue($, [
      ".item_money_box .item_price dd strong",
      ".item_money_box .item_price dd",
      ".item_info_box .item_price dd strong",
      ".item_info_box .item_price dd",
      "input[name='goodsPrice']",
      "input[name='goods_price']",
      "input[name='set_goods_price']",
      "input[name='goodsDcPrice']",
    ]);
  const brandText =
    pickByIncludes(itemInfo, ["브랜드"]) ||
    findLabeledDetailValue($, ["브랜드"]);
  const unitPriceText = pickByIncludes(itemInfo, ["낱개가", "개당"]);
  const boxComposition = pickByIncludes(itemInfo, ["박스구성", "박스 구성"]);
  const modelName = pickByIncludes(itemInfo, ["모델명", "상품코드", "모델"]);

  return {
    sourceMall: config.mall,
    categoryCode: config.category,
    productId: String(product.productId || ""),
    productUrl: product.productUrl,
    productName,
    brandHint:
      normalizeWhitespace(brandText) ||
      product.brandHint ||
      inferBrand(productName),
    categoryHint: product.categoryHint || inferCategory(productName),

    categoryDepth1: categoryItems[0] || "",
    categoryDepth2: categoryItems[1] || "",
    categoryDepth3: categoryItems[2] || "",

    productNo: String(product.productId || ""),
    barcode: "",
    outerBoxText: boxComposition,
    outerBoxQty: toNumber(boxComposition.match(/(\d+)\s*(?:개입|개|EA|ea|입)/)?.[1] || ""),
    consumerPrice: 0,

    /** CCDOME 상세 전용 필드 */
    expiryDate,
    originalPrice: parsePrice(salePriceText) || product.price || 0,
    salePrice: parsePrice(salePriceText) || product.price || 0,
    salePriceText,
    unitPrice: parsePrice(unitPriceText),
    unitPriceText,
    boxComposition,
    modelName,

    manufacturer: "",
    material: "",
    packageSize: "",
    weight: "",
    origin: "",
    certification: "",
    warehouse: "",
    targetAge: "",
    warranty: "",
    asContact: "",

    my3plAvailable: "",
    my3plInboundFee: "",
    my3plOutboundFee: "",
    my3plStorageFee: "",

    packageQty: packageInfo.packageQty,
    packageUnit: packageInfo.packageUnit,
    packageText: packageInfo.packageText,
    specRows,

    mainImageUrls,
    thumbnailImageUrls: mainImageUrls,
    introImageUrls,
    mainImageUrlsText: mainImageUrls.join(" | "),
    thumbnailImageUrlsText: mainImageUrls.join(" | "),
    introImageUrlsText: introImageUrls.join(" | "),

    rawDetailInfo: JSON.stringify(itemInfo),
  };
}

/** 신규 상세 작업 탭에 공통 이벤트를 연결한다. */
async function setupCcdomeDetailWorkerPage(workerPage) {
  workerPage.on("dialog", async (dialog) => {
    await dialog.dismiss().catch(() => null);
  });
}

/** 과자생각 상세페이지들을 안전한 병렬 작업자로 수집한다. */
async function collectCcdomeDetails(
  page,
  products,
  config,
  onProgress = () => {},
  signal,
) {
  const targets = Array.from(
    new Map(
      (products || [])
        .filter((item) => item?.productUrl)
        .map((item) => [String(item.productId), item]),
    ).values(),
  );
  const limitedTargets = targets;

  if (limitedTargets.length < 1) return [];

  const concurrency = Math.min(
    limitedTargets.length,
    getSafetyNumber(config, "detailConcurrency", 5, 1, 5),
  );
  const retryCount = getSafetyNumber(
    config,
    "detailRetryCount",
    6,
    2,
    12,
  );
  const hardResetEvery = getSafetyNumber(
    config,
    "detailHardResetEvery",
    3,
    2,
    6,
  );
  const context = page.context();
  const workers = [];
  const details = new Array(limitedTargets.length);
  let nextIndex = 0;
  let completedCount = 0;

  for (let index = 0; index < concurrency; index += 1) {
    const workerPage = await context.newPage();
    await setupCcdomeDetailWorkerPage(workerPage);
    workers.push({ page: workerPage, workerIndex: index });
  }

  async function collectOne(worker, product, targetIndex) {
    let lastError = null;

    try {
      return await withSiteRetry(
        async () => {
          const response = await gotoWithSiteRetry(
            worker.page,
            product.productUrl,
            {
              label: `과자생각 상세 상품 ${product.productId}`,
              signal,
              maxAttempts: 1,
              timeoutMs: config.navigationTimeoutMs,
              readySelector: CCDOME_DETAIL.selectors.root,
              readyTimeoutMs: config.navigationTimeoutMs,
            },
          );

          if (response && !response.ok()) {
            throw markSiteError(
              new Error(`HTTP ${response.status()}`),
              {
                retryable: response.status() >= 500 || response.status() === 429,
                statusCode: response.status(),
                stage: "ccdome-detail",
              },
            );
          }

          await prepareCcdomeDetailImages(worker.page, config);

          const liveImages = await readCcdomeImageUrlsFromPage(worker.page);
          const liveMeta = await readCcdomeProductMetaFromPage(worker.page);
          const detail = parseCcdomeDetailHtml(
            await worker.page.content(),
            product,
            config,
          );

          const liveOriginalPrice = parsePrice(liveMeta.salePriceText);

          if (liveOriginalPrice > 0) {
            detail.salePriceText = liveMeta.salePriceText;
            detail.originalPrice = liveOriginalPrice;
            detail.salePrice = liveOriginalPrice;
          }

          if (liveMeta.brandText) {
            detail.brandHint = normalizeWhitespace(liveMeta.brandText);
          }

          console.log("[CCDOME DETAIL META]", {
            productId: product.productId,
            salePriceText: detail.salePriceText || "",
            originalPrice: detail.originalPrice || null,
            brandHint: detail.brandHint || "",
          });

          /** Slick 메인 이미지는 직렬화된 HTML이 아니라 라이브 DOM 결과를 사용한다. */
          detail.mainImageUrls = liveImages.mainImageUrls;
          detail.thumbnailImageUrls = liveImages.mainImageUrls;
          detail.introImageUrls = liveImages.introImageUrls;
          detail.detailImageUrls = liveImages.introImageUrls;
          detail.images = {
            main_img: liveImages.mainImageUrls,
            detail_img: liveImages.introImageUrls,
          };
          detail.mainImageUrlsText = liveImages.mainImageUrls.join(" | ");
          detail.thumbnailImageUrlsText = liveImages.mainImageUrls.join(" | ");
          detail.introImageUrlsText = liveImages.introImageUrls.join(" | ");

          console.log("[CCDOME DETAIL IMAGE]", {
            productId: product.productId,
            mainImageCount: liveImages.mainImageUrls.length,
            detailImageCount: liveImages.introImageUrls.length,
            ...liveImages.diagnostics,
          });

          if (!detail?.productId || !detail?.productName) {
            throw markSiteError(
              new Error("과자생각 상세 핵심 필드가 비어 있습니다."),
              {
                retryable: true,
                code: "DETAIL_VALIDATION_FAILED",
                stage: "ccdome-detail",
              },
            );
          }

          if (!Array.isArray(detail.mainImageUrls) || detail.mainImageUrls.length < 1) {
            throw markSiteError(
              new Error("과자생각 메인 상품 이미지가 아직 준비되지 않았습니다."),
              {
                retryable: true,
                code: "MAIN_IMAGE_NOT_READY",
                stage: "ccdome-detail-image",
              },
            );
          }

          return detail;
        },
        {
          label: `과자생각 상세 상품 ${product.productId}`,
          maxAttempts: retryCount,
          signal,
          shouldRetry: (error) =>
            isRetryableSiteError(error, {
              signal,
              retryUnknownErrors: true,
            }),
          baseDelayMs: 1000,
          maxDelayMs: 20000,
          multiplier: 1.7,
          onRetry: async ({ error, attempt, nextAttempt }) => {
            lastError = error;

            onProgress({
              stage: "detail",
              message:
                `과자생각 상세 재시도 ${nextAttempt}/${retryCount} · ` +
                `상품 ${targetIndex + 1}/${limitedTargets.length}`,
              currentDetailIndex: completedCount,
              detailTargetCount: limitedTargets.length,
              productId: product.productId,
              workerIndex: worker.workerIndex + 1,
              detailAttempt: nextAttempt,
            });

            if (attempt % hardResetEvery === 0) {
              console.warn(
                `[CCDOME DETAIL] 작업자 ${worker.workerIndex + 1} 탭 교체`,
              );
              worker.page = await replacePage(worker.page, {
                signal,
                setupPage: setupCcdomeDetailWorkerPage,
              });
            } else {
              await resetPageState(worker.page, {
                signal,
                delayMs: 700,
              });
            }
          },
        },
      );
    } catch (error) {
      lastError = error;
    }

    return {
      sourceMall: config.mall,
      categoryCode: config.category,
      productId: product.productId,
      productUrl: product.productUrl,
      productName: product.productName,
      brandHint: product.brandHint || inferBrand(product.productName),
      categoryHint: product.categoryHint || inferCategory(product.productName),
      detailError: lastError?.message || "상세 수집 실패",
    };
  }

  async function runWorker(worker) {
    if (worker.workerIndex > 0) {
      await sleepWithSignal(worker.workerIndex * 300, signal);
    }

    while (true) {
      throwIfAborted(signal);

      const targetIndex = nextIndex;
      nextIndex += 1;

      if (targetIndex >= limitedTargets.length) return;

      const product = limitedTargets[targetIndex];

      onProgress({
        stage: "detail",
        message:
          `과자생각 상세 수집 중: ${completedCount}/${limitedTargets.length} ` +
          `(작업자 ${worker.workerIndex + 1}, 상품 ${targetIndex + 1})`,
        currentDetailIndex: completedCount,
        detailTargetCount: limitedTargets.length,
        productId: product.productId,
        workerIndex: worker.workerIndex + 1,
        detailConcurrency: concurrency,
      });

      details[targetIndex] = await collectOne(worker, product, targetIndex);
      completedCount += 1;

      onProgress({
        stage: "detail",
        message: `과자생각 상세 수집 중: ${completedCount}/${limitedTargets.length}`,
        currentDetailIndex: completedCount,
        detailTargetCount: limitedTargets.length,
        productId: product.productId,
        workerIndex: worker.workerIndex + 1,
        detailConcurrency: concurrency,
      });

      if (
        Number(config.detailRequestDelayMs) > 0 &&
        completedCount < limitedTargets.length
      ) {
        await sleepWithSignal(Number(config.detailRequestDelayMs), signal);
      }
    }
  }

  try {
    await Promise.all(workers.map((worker) => runWorker(worker)));
  } finally {
    await Promise.all(
      workers.map((worker) => worker.page.close().catch(() => null)),
    );
  }

  return details.filter(Boolean);
}

module.exports = {
  CCDOME_DETAIL,
  collectCcdomeDetails,
  parseCcdomeDetailHtml,
};

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
    itemInfoList: ".item_info_box .item_detail_list dl, .item_detail_list dl",
    /**
     * 첨부한 코드의 이미지 수집 경로를 그대로 사용한다.
     */
    mainImages:
      ".item_photo_view .item_photo_big #mainImage img, " +
      ".item_photo_big span.img_photo_big #mainImage img, " +
      ".item_photo_big #mainImage img",
    detailImages:
      ".detail_explain_box center img, " +
      ".detail_explain_box [align='center'] img, " +
      ".detail_explain_box [align='CENTER'] img",
    detailTextScope:
      "#detail .detail_cont, " +
      "#detail, " +
      ".detail_cont, " +
      ".detail_explain_box, " +
      ".txt-manual, " +
      ".item_goods_sec",
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
  const productName =
    normalizeProductName($(selectors.title).first().text()) ||
    normalizeProductName(product.productName);
  const packageInfo = parsePackageInfo(productName);
  const mainImageUrls = parseMainImages($, config);
  const introImageUrls = parseDetailImages($, config);

  const expiryDate = pickByIncludes(itemInfo, ["소비기한", "유통기한"]);
  const salePriceText = pickByIncludes(itemInfo, ["판매가"]);
  const unitPriceText = pickByIncludes(itemInfo, ["낱개가", "개당"]);
  const boxComposition = pickByIncludes(itemInfo, ["박스구성", "박스 구성"]);
  const modelName = pickByIncludes(itemInfo, ["모델명", "상품코드", "모델"]);

  return {
    sourceMall: config.mall,
    categoryCode: config.category,
    productId: String(product.productId || ""),
    productUrl: product.productUrl,
    productName,
    brandHint: product.brandHint || inferBrand(productName),
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
  const limitedTargets =
    Number(config.detailMaxProducts) > 0
      ? targets.slice(0, Number(config.detailMaxProducts))
      : targets;

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

          if (typeof prepareCcdomeDetailImages === "function") {
            await prepareCcdomeDetailImages(worker.page);
          }

          const detail = parseCcdomeDetailHtml(
            await worker.page.content(),
            product,
            config,
          );

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

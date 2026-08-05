// src/malls/cheonyu/detail.js

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

const CHEONYU_DETAIL = {
  selectors: {
    root: "#productView",
    category1: "#navCateTit1",
    category2: "#navCateTit2",
    category3: "#navCateTit3",
    productName: ".info_wrap .pdt_name span",
    topInfo: ".pdt-top-info",
    infoNumber: ".pdt-top-info .info-number",
    outerBox: ".pdt-top-info .inbox",
    consumerPrice: ".pdt_code .pdt_code_last strong",
    smallPhotoLinks: "#viewSmallPhoto a, .small_photo a",
    smallPhotoImages: "#viewSmallPhoto img, .small_photo img",
    mainImages:
      "#productView .photo_wrap .main_photo img, " +
      "#productView .photo_wrap .big_img img, " +
      "#productView .view_photo img, " +
      "#productView img#mainImg, " +
      "#productView img[id*='mainImage'], " +
      "#productView .pdt_photo img",
    introImages:
      "#tab_01 #viewContent img, " +
      "#viewContent img, " +
      ".pic#viewContent img, " +
      "img[src*='image3.cheonyu.com'], " +
      "img[data-src*='image3.cheonyu.com']",
    detailSpecTable: '#productView table.info',
    detailSpecRows: '#productView table.info tbody tr',
  },
};

/** 상대/절대 이미지 경로를 절대 URL로 정규화한다. */
function toAbsoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();

  if (!raw || raw.startsWith("data:")) return "";

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

function isUsefulImageUrl(url) {
  const value = String(url || "").trim();

  if (!value) return false;
  if (value === "tites") return false;
  if (value.startsWith("data:")) return false;
  if (/blank|noimg|loading|spinner/i.test(value)) return false;

  return /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(value) ||
    value.includes("image3.cheonyu.com");
}

function getImageCandidateUrls($, image, baseUrl) {
  const item = $(image);
  const urls = [];

  const attributes = [
    "src",
    "data-src",
    "data-original",
    "data-lazy",
    "data-url",
    "lazy",
  ];

  for (const attr of attributes) {
    const url = toAbsoluteUrl(item.attr(attr), baseUrl);

    if (isUsefulImageUrl(url)) {
      urls.push(url);
    }
  }

  const srcset = item.attr("srcset") || item.attr("data-srcset") || "";

  if (srcset) {
    for (const part of srcset.split(",")) {
      const url = toAbsoluteUrl(part.trim().split(/\s+/)[0], baseUrl);

      if (isUsefulImageUrl(url)) {
        urls.push(url);
      }
    }
  }

  return urls;
}

/** 썸네일 onmouseover="changeImg('...')"에서 원본 이미지 경로를 추출한다. */
function extractChangeImgUrl(onmouseover) {
  const text = String(onmouseover || "");
  const match = text.match(/changeImg\s*\(\s*['"]([^'"]+)['"]/i);
  return match?.[1] || "";
}

/** 중복과 빈 값을 제거한다. */
function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/** /thumb/ 중복 이미지인지 확인한다. */
function isThumbnailImageUrl(value) {
  return /\/thumb\//i.test(String(value || ""));
}

/**
 * 대표 이미지 selector와 상품번호가 포함된 이미지 URL을 함께 확인한다.
 * 천유 상품 대표 이미지는 /_DATA/product/.../{productId}_*.jpg 형태도 사용한다.
 */
function parseMainImageUrls($, productId, config) {
  const urls = [];

  $(CHEONYU_DETAIL.selectors.mainImages).each((_, image) => {
    urls.push(...getImageCandidateUrls($, image, config.baseUrl));
  });

  $("#productView img").each((_, image) => {
    const candidates = getImageCandidateUrls($, image, config.baseUrl);

    for (const url of candidates) {
      if (
        productId &&
        url.includes(`/${productId}_`) &&
        !url.includes("image3.cheonyu.com") &&
        !url.includes("image4.cheonyu.com")
      ) {
        urls.push(url);
      }
    }
  });

  return unique(urls).filter(
    (url) => !isThumbnailImageUrl(url),
  );
}

/** th/td가 반복되는 상세 table을 key-value 객체로 변환한다. */
function parseKeyValueTable($, table) {
  const result = {};

  table.find("tr").each((_, tr) => {
    const cells = $(tr).children("th,td").toArray();

    for (let index = 0; index < cells.length - 1; index += 1) {
      const cell = cells[index];

      if (String(cell.tagName).toLowerCase() !== "th") continue;

      const key = normalizeWhitespace($(cell).text());
      const value = normalizeWhitespace($(cells[index + 1]).text());

      if (key) {
        result[key] = value;
      }
    }
  });

  return result;
}


/** 상세 table의 모든 th/td 쌍을 백엔드 specs 원본 row로 변환한다. */
function parseSpecRows($, selector) {
  const rows = [];
  const seen = new Set();

  $(selector).each((_, tr) => {
    const cells = $(tr).children("th,td").toArray();

    for (let index = 0; index < cells.length - 1; index += 1) {
      const cell = cells[index];

      if (String(cell.tagName).toLowerCase() !== "th") {
        continue;
      }

      const nextCell = cells[index + 1];

      if (String(nextCell?.tagName).toLowerCase() !== "td") {
        continue;
      }

      const label = normalizeWhitespace($(cell).text());
      const value = normalizeWhitespace($(nextCell).text());

      if (!label || !value || seen.has(label)) {
        continue;
      }

      seen.add(label);
      rows.push({
        labelKo: label,
        labelJa: label,
        valueKo: value,
        valueJa: value,
        sortOrder: rows.length * 10,
      });
    }
  });

  return rows;
}

/** key 이름 일부가 일치하는 상세값을 가져온다. */
function pickByIncludes(source, keywords) {
  const entries = Object.entries(source || {});

  for (const keyword of keywords) {
    const found = entries.find(([key]) => key.includes(keyword));

    if (found) return found[1];
  }

  return "";
}

/** 상세 옵션 영역의 체크 가능한 옵션을 보조적으로 수집한다. */
function parseDetailOptions($) {
  const options = [];

  $(".info_wrap input[type='checkbox'], .info_wrap input[type='radio']").each((index, input) => {
    const item = $(input);
    const parentText = normalizeWhitespace(item.closest("label, li, tr, div").text());
    const optionName =
      normalizeWhitespace(item.attr("title")) ||
      normalizeWhitespace(item.attr("value")) ||
      parentText;

    if (!optionName) return;

    options.push({
      optionIndex: index,
      optionName,
      disabled: item.is(":disabled") || item.attr("disabled") !== undefined,
      checked: item.is(":checked") || item.attr("checked") !== undefined,
    });
  });

  return options;
}

/** 마이3PL 비용 안내 table을 파싱한다. */
function parseMy3pl($) {
  const table = $("table")
    .filter((_, element) => {
      const text = normalizeWhitespace($(element).text());
      return text.includes("마이3PL 가능여부") || text.includes("입고비용");
    })
    .first();

  if (!table.length) {
    return {
      available: "",
      inboundFee: "",
      outboundFee: "",
      storageFee: "",
      raw: {},
    };
  }

  const raw = parseKeyValueTable($, table);

  return {
    available: pickByIncludes(raw, ["마이3PL 가능여부", "가능여부"]),
    inboundFee: toNumber(pickByIncludes(raw, ["입고비용"])),
    outboundFee: toNumber(pickByIncludes(raw, ["출고비용"])),
    storageFee: toNumber(pickByIncludes(raw, ["보관비용"])),
    raw,
  };
}

async function prepareDetailImages(page) {
  /**
   * 천유 상세 이미지는 하단 상세 영역에 lazy 로딩으로 붙는 경우가 있다.
   * domcontentloaded 직후 바로 page.content()를 읽으면 src가 비어 있거나
   * placeholder 상태일 수 있으므로 상세 영역까지 스크롤을 내려준다.
   */
  await page
    .evaluate(async () => {
      const targets = [
        document.querySelector("#tab_01"),
        document.querySelector("#viewContent"),
        document.querySelector(".pic#viewContent"),
        document.body,
      ].filter(Boolean);

      for (const target of targets) {
        target.scrollIntoView?.({
          block: "center",
          behavior: "instant",
        });

        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 700));
    })
    .catch(() => null);

  await page
    .waitForSelector(
      [
        "#tab_01 #viewContent img[src]",
        "#viewContent img[src]",
        ".pic#viewContent img[src]",
        "img[src*='image3.cheonyu.com']",
      ].join(", "),
      {
        timeout: 8000,
      },
    )
    .catch(() => null);
}

/** 천유 상품 상세 HTML을 허브용 상세 row로 정규화한다. */
function parseDetailHtml(html, product, config) {
  const $ = cheerio.load(html);
  const selectors = CHEONYU_DETAIL.selectors;

  const categoryDepth1 = normalizeWhitespace($(selectors.category1).first().text());
  const categoryDepth2 = normalizeWhitespace($(selectors.category2).first().text());
  const categoryDepth3 = normalizeWhitespace($(selectors.category3).first().text());

  const infoNumbers = $(selectors.infoNumber)
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter(Boolean);

  const productNo = infoNumbers[0] || product.productId || "";
  const barcode = infoNumbers[1] || "";
  const productName =
    normalizeProductName($(selectors.productName).first().text()) ||
    normalizeProductName(product.productName);
  const outerBoxText = normalizeWhitespace($(selectors.outerBox).first().text());
  const outerBoxQty = toNumber(outerBoxText.match(/(\d+)\s*EA/i)?.[1] || "");
  const consumerPrice = toNumber($(selectors.consumerPrice).first().text());

  const thumbnailImageUrls = unique(
    $(selectors.smallPhotoLinks)
      .map((_, element) =>
        toAbsoluteUrl(
          extractChangeImgUrl($(element).attr("onmouseover")),
          config.baseUrl,
        ),
      )
      .get()
      .concat(
        $(selectors.smallPhotoImages)
          .map((_, element) => getImageCandidateUrls($, element, config.baseUrl))
          .get()
          .flat(),
      ),
  );

  const mainImageUrls = unique([
    ...parseMainImageUrls(
      $,
      String(product.productId || productNo || ""),
      config,
    ),
    ...thumbnailImageUrls.filter(
      (url) => !isThumbnailImageUrl(url),
    ),
  ]);

  const introImageUrls = unique(
    [
      ...$(selectors.introImages)
        .map((_, element) => getImageCandidateUrls($, element, config.baseUrl))
        .get()
        .flat(),

      ...$("img[src*='image3.cheonyu.com'], img[data-src*='image3.cheonyu.com']")
        .map((_, element) => getImageCandidateUrls($, element, config.baseUrl))
        .get()
        .flat(),
    ],
  );

  const specRows = parseSpecRows($, selectors.detailSpecRows);
  const detailSpecRaw = Object.fromEntries(
    specRows.map((row) => [row.labelKo, row.valueKo]),
  );
  const my3pl = parseMy3pl($);
  const packageInfo = parsePackageInfo(productName);

  return {
    sourceMall: config.mall,
    categoryCode: config.category,
    productId: String(product.productId || productNo || ""),
    productUrl: product.productUrl,
    productName,
    brandHint: product.brandHint || inferBrand(productName),
    categoryHint: inferCategory(productName),
    categoryDepth1,
    categoryDepth2,
    categoryDepth3,
    productNo,
    barcode,
    outerBoxText,
    outerBoxQty,
    consumerPrice,
    manufacturer: pickByIncludes(detailSpecRaw, ["제조사/수입사", "제조사"]),
    material: pickByIncludes(detailSpecRaw, ["소재"]),
    packageSize: pickByIncludes(detailSpecRaw, ["포장 사이즈", "포장사이즈"]),
    weight: pickByIncludes(detailSpecRaw, ["무게"]),
    origin: pickByIncludes(detailSpecRaw, ["원산지"]),
    certification: pickByIncludes(detailSpecRaw, ["인증", "허가"]),
    warehouse: pickByIncludes(detailSpecRaw, ["물류 창고", "물류창고"]),
    targetAge: pickByIncludes(detailSpecRaw, ["사용 대상 연령", "대상 연령"]),
    warranty: pickByIncludes(detailSpecRaw, ["품질보증기준"]),
    asContact: pickByIncludes(detailSpecRaw, ["A/S", "전화번호"]),
    my3plAvailable: my3pl.available,
    my3plInboundFee: my3pl.inboundFee,
    my3plOutboundFee: my3pl.outboundFee,
    my3plStorageFee: my3pl.storageFee,
    packageQty: packageInfo.packageQty,
    packageUnit: packageInfo.packageUnit,
    packageText: packageInfo.packageText,
    detailOptions: JSON.stringify(parseDetailOptions($)),
    specRows,

    /** 백엔드 상품 이미지 구조의 원본 필드다. */
    mainImageUrls,
    detailImageUrls: introImageUrls,
    thumbnailImageUrls,
    introImageUrls,
    images: {
      main_img: mainImageUrls,
      detail_img: introImageUrls,
    },
    mainImageUrlsText: mainImageUrls.join(" | "),
    thumbnailImageUrlsText: thumbnailImageUrls.join(" | "),
    introImageUrlsText: introImageUrls.join(" | "),
    rawDetailSpec: detailSpecRaw,
    rawMy3pl: my3pl.raw,
  };
}

/** 신규 상세 작업 탭에 공통 이벤트를 연결한다. */
async function setupCheonyuDetailWorkerPage(workerPage) {
  workerPage.on("dialog", async (dialog) => {
    await dialog.dismiss().catch(() => null);
  });
}

/** 일반 수집으로 확보한 상품 URL을 안전한 병렬 작업자로 수집한다. */
async function collectCheonyuDetails(
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

  /** 기존 목록 탭은 건드리지 않고 상세 전용 탭만 만든다. */
  for (let index = 0; index < concurrency; index += 1) {
    const workerPage = await context.newPage();
    await setupCheonyuDetailWorkerPage(workerPage);
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
              label: `천유 상세 상품 ${product.productId}`,
              signal,
              maxAttempts: 1,
              timeoutMs: config.navigationTimeoutMs,
              readySelector: CHEONYU_DETAIL.selectors.root,
              readyTimeoutMs: config.navigationTimeoutMs,
            },
          );

          if (response && !response.ok()) {
            throw markSiteError(
              new Error(`HTTP ${response.status()}`),
              {
                retryable: response.status() >= 500 || response.status() === 429,
                statusCode: response.status(),
                stage: "cheonyu-detail",
              },
            );
          }

          if (typeof prepareDetailImages === "function") {
            await prepareDetailImages(worker.page);
          }

          const detail = parseDetailHtml(
            await worker.page.content(),
            product,
            config,
          );

          if (!detail?.productId || !detail?.productName) {
            throw markSiteError(
              new Error("천유 상세 핵심 필드가 비어 있습니다."),
              {
                retryable: true,
                code: "DETAIL_VALIDATION_FAILED",
                stage: "cheonyu-detail",
              },
            );
          }

          return detail;
        },
        {
          label: `천유 상세 상품 ${product.productId}`,
          maxAttempts: retryCount,
          signal,
          shouldRetry: (error) =>
            isRetryableSiteError(error, {
              signal,
              retryUnknownErrors: true,
            }),
          baseDelayMs: 800,
          maxDelayMs: 15000,
          multiplier: 1.6,
          onRetry: async ({ error, attempt, nextAttempt }) => {
            lastError = error;

            onProgress({
              stage: "detail",
              message:
                `천유 상세 재시도 ${nextAttempt}/${retryCount} · ` +
                `상품 ${targetIndex + 1}/${limitedTargets.length}`,
              currentDetailIndex: completedCount,
              detailTargetCount: limitedTargets.length,
              productId: product.productId,
              workerIndex: worker.workerIndex + 1,
              detailAttempt: nextAttempt,
            });

            if (attempt % hardResetEvery === 0) {
              console.warn(
                `[CHEONYU DETAIL] 작업자 ${worker.workerIndex + 1} 탭 교체`,
              );
              worker.page = await replacePage(worker.page, {
                signal,
                setupPage: setupCheonyuDetailWorkerPage,
              });
            } else {
              await resetPageState(worker.page, {
                signal,
                delayMs: 500,
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
      detailError: lastError?.message || "상세 수집 실패",
    };
  }

  async function runWorker(worker) {
    if (worker.workerIndex > 0) {
      await sleepWithSignal(worker.workerIndex * 250, signal);
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
          `천유 상세 수집 중: ${completedCount}/${limitedTargets.length} ` +
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
        message: `천유 상세 수집 중: ${completedCount}/${limitedTargets.length}`,
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
  CHEONYU_DETAIL,
  collectCheonyuDetails,
  parseDetailHtml,
};

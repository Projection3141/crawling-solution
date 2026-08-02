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
    mainPhotoLinks:
      "#viewSmallPhoto a[onmouseover*='changeImg'], " +
      ".small_photo a[onmouseover*='changeImg']",
    detailImages:
      "#tab_01 #viewContent img[src*='image3.cheonyu.com'], " +
      "#tab_01 #viewContent img[data-src*='image3.cheonyu.com'], " +
      "#viewContent img[src*='image3.cheonyu.com'], " +
      "#viewContent img[data-src*='image3.cheonyu.com'], " +
      "img[src*='image3.cheonyu.com'], " +
      "img[data-src*='image3.cheonyu.com'], " +
      "img[data-original*='image3.cheonyu.com']",
    detailSpecTable: 'table.info[alt="제품상세정보"]',
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

/** 수집 결과로 사용할 수 있는 원본 이미지 URL인지 확인한다. */
function isUsefulImageUrl(url) {
  const value = String(url || "").trim();

  if (!value) return false;
  if (value === "tites") return false;
  if (value.startsWith("data:")) return false;
  if (/\/thumb\//i.test(value)) return false;
  if (/blank|noimg|loading|spinner/i.test(value)) return false;

  return (
    /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(value) ||
    value.includes("image3.cheonyu.com")
  );
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

  /**
 * 썸네일 img의 /thumb/ 주소는 읽지 않는다.
 * onmouseover="changeImg('/_DATA/product/...jpg')"의 원본 경로만 읽는다.
 */
  const mainImageUrls = unique(
    $(selectors.mainPhotoLinks)
      .map((_, element) =>
        toAbsoluteUrl(
          extractChangeImgUrl(
            $(element).attr("onmouseover"),
          ),
          config.baseUrl,
        ),
      )
      .get()
      .filter(isUsefulImageUrl),
  );

  /**
   * image3.cheonyu.com 상세 이미지 중 첫 번째 이미지만
   * detail_img 문자열로 사용한다.
   */
  const detailImageUrls = unique(
    $(selectors.detailImages)
      .map((_, element) =>
        getImageCandidateUrls(
          $,
          element,
          config.baseUrl,
        ),
      )
      .get()
      .flat()
      .filter((url) =>
        url.includes("image3.cheonyu.com"),
      ),
  );

  const detailImageUrl =
    detailImageUrls[0] || "";

  const detailSpecRaw = parseKeyValueTable($, $(selectors.detailSpecTable).first());
  const packageInfo = parsePackageInfo(productName);

  return {
    sourceMall: config.mall,
    categoryCode: config.category,
    productId: String(product.productId || productNo || ""),
    productUrl: product.productUrl,
    productName,
    brandHint: inferBrand(productName),
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
    packageQty: packageInfo.packageQty,
    packageUnit: packageInfo.packageUnit,
    packageText: packageInfo.packageText,
    detailOptions: JSON.stringify(parseDetailOptions($)),
    mainImageUrls,
    detailImageUrl,
    mainImageUrlsText: mainImageUrls.join(" | "),
    thumbnailImageUrlsText: mainImageUrls.join(" | "),
    introImageUrlsText: detailImageUrl,
    rawDetailSpec: detailSpecRaw,
  };
}

/** 일반 수집으로 확보한 상품 URL을 순회하며 상세 정보를 수집한다. */
async function collectCheonyuDetails(page, products, config, onProgress = () => { }, signal) {
  const targets = Array.from(
    new Map(
      products
        .filter((item) => item.productUrl)
        .map((item) => [String(item.productId), item]),
    ).values(),
  );

  const limitedTargets =
    config.detailMaxProducts > 0
      ? targets.slice(0, config.detailMaxProducts)
      : targets;
  const details = [];

  for (let index = 0; index < limitedTargets.length; index += 1) {
    throwIfAborted(signal);

    const product = limitedTargets[index];

    onProgress({
      stage: "detail",
      message: `상세 수집 중: ${index + 1}/${limitedTargets.length}`,
      currentDetailIndex: index + 1,
      detailTargetCount: limitedTargets.length,
      productId: product.productId,
    });

    try {
      const response = await page.goto(product.productUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });

      if (response && !response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      await page
        .waitForSelector(CHEONYU_DETAIL.selectors.root, {
          timeout: config.navigationTimeoutMs,
        })
        .catch(() => null);

      await prepareDetailImages(page);

      const html = await page.content();
      details.push(parseDetailHtml(html, product, config));
    } catch (error) {
      details.push({
        sourceMall: config.mall,
        categoryCode: config.category,
        productId: product.productId,
        productUrl: product.productUrl,
        productName: product.productName,
        detailError: error.message,
      });
    }

    if (config.detailRequestDelayMs > 0 && index < limitedTargets.length - 1) {
      await sleep(config.detailRequestDelayMs);
    }
  }

  return details;
}

module.exports = {
  CHEONYU_DETAIL,
  collectCheonyuDetails,
  parseDetailHtml,
};

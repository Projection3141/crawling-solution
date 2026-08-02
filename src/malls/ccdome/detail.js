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

const CCDOME_DETAIL = {
  selectors: {
    root: ".sub_content, .goods_view, .item_goods_sec, #contents",

    categoryItems:
      ".location_wrap .location_select .location_tit span, " +
      ".location_wrap .location_select .location_tit a span, " +
      ".location_wrap .location_tit span",

    title:
      ".item_info_box .item_detail_tit h3, " +
      ".item_detail_tit h3, " +
      ".item_tit_detail_cont h3",

    itemInfoList:
      ".item_info_box .item_detail_list dl, " +
      ".item_detail_list dl",

    mainImages:
      ".item_photo_slide img, " +
      ".item_photo_big img, " +
      ".item_photo_view img, " +
      ".item_photo_box img, " +
      ".slider_goods_nav img, " +
      "img[src*='godomall-storage.cdn-nhncommerce.com/goods/']",

    detailImages:
      "#detail img, " +
      ".detail_cont img, " +
      ".detail_explain_box img, " +
      ".txt-manual img, " +
      ".item_goods_sec img[src*='gi.esmplus.com'], " +
      ".item_goods_sec img[src*='godomall-storage.cdn-nhncommerce.com'], " +
      "img[src*='gi.esmplus.com'], " +
      "img[data-src*='gi.esmplus.com'], " +
      "img[data-original*='gi.esmplus.com'], " +
      "img[src*='godomall-storage.cdn-nhncommerce.com'], " +
      "img[data-src*='godomall-storage.cdn-nhncommerce.com'], " +
      "img[data-original*='godomall-storage.cdn-nhncommerce.com']",

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

/** 실제 상품 이미지로 쓸 수 있는 URL인지 확인한다. */
function isUsefulImageUrl(url) {
  const value = String(url || "").trim();

  if (!value) return false;
  if (value === "tites") return false;
  if (value.startsWith("data:")) return false;
  if (/blank|noimg|loading|spinner|icon|btn_|arrow/i.test(value)) return false;

  return (
    /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(value) ||
    value.includes("gi.esmplus.com") ||
    value.includes("godomall-storage.cdn-nhncommerce.com")
  );
}

/** 이미지 태그에서 lazy/srcset 속성까지 포함해 실제 이미지 URL 후보를 모두 읽는다. */
function getImageCandidateUrls($, element, baseUrl) {
  const item = $(element);
  const urls = [];

  const attributes = [
    "src",
    "data-src",
    "data-original",
    "data-lazy",
    "data-url",
    "data-img",
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

/** dl/dt/dd 구조의 상품 정보 목록을 key-value 객체로 변환한다. */
function parseDefinitionList($, selector) {
  const result = {};

  $(selector).each((_, dl) => {
    const key = normalizeWhitespace($(dl).find("dt").first().text());
    const value = normalizeWhitespace($(dl).find("dd").first().text());

    if (key) {
      result[key] = value;
    }
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

/**
 * 과자생각 상세 이미지 lazy 로딩을 유도한다.
 *
 * 상세 이미지는 #detail, .detail_explain_box, .txt-manual 하단에 있으며
 * 화면 근처까지 스크롤해야 src/data-src가 실제 URL로 채워지는 경우가 있다.
 */
async function prepareCcdomeDetailImages(page, config) {
  await page
    .evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const targets = [
        document.querySelector("#detail"),
        document.querySelector(".detail_explain_box"),
        document.querySelector(".txt-manual"),
        document.querySelector(".detail_cont"),
        document.querySelector(".item_goods_sec"),
        document.body,
      ].filter(Boolean);

      for (const target of targets) {
        target.scrollIntoView?.({
          block: "center",
          behavior: "instant",
        });

        await wait(400);
      }

      /**
       * 상세 이미지가 아주 아래에 붙어 있는 경우를 대비해
       * 중간과 하단을 한 번씩 밟아준다.
       */
      window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.55));
      await wait(500);

      window.scrollTo(0, document.body.scrollHeight);
      await wait(800);
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const images = Array.from(document.querySelectorAll("img"));

        return images.some((image) => {
          const src =
            image.getAttribute("src") ||
            image.getAttribute("data-src") ||
            image.getAttribute("data-original") ||
            image.getAttribute("data-lazy") ||
            "";

          return (
            src.includes("gi.esmplus.com") ||
            src.includes("godomall-storage.cdn-nhncommerce.com") ||
            /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(src)
          );
        });
      },
      null,
      {
        timeout: Math.min(config.navigationTimeoutMs || 60000, 10000),
      },
    )
    .catch(() => null);
}

/** 상세 설명 영역의 이미지 URL을 추출한다. */
function parseDetailImages($, config) {
  const selectors = CCDOME_DETAIL.selectors;
  const urls = [];

  $(selectors.detailImages).each((_, img) => {
    urls.push(...getImageCandidateUrls($, img, config.baseUrl));
  });

  /**
   * selector가 일부 빗나가도 상세 전용 외부 이미지 도메인은 fallback으로 다시 확인한다.
   */
  $(
    "img[src*='gi.esmplus.com'], " +
      "img[data-src*='gi.esmplus.com'], " +
      "img[data-original*='gi.esmplus.com'], " +
      "img[src*='godomall-storage.cdn-nhncommerce.com'], " +
      "img[data-src*='godomall-storage.cdn-nhncommerce.com'], " +
      "img[data-original*='godomall-storage.cdn-nhncommerce.com']",
  ).each((_, img) => {
    urls.push(...getImageCandidateUrls($, img, config.baseUrl));
  });

  return unique(urls);
}

/** 대표/썸네일 이미지 URL을 추출한다. */
function parseMainImages($, config) {
  const urls = [];

  $(CCDOME_DETAIL.selectors.mainImages).each((_, img) => {
    urls.push(...getImageCandidateUrls($, img, config.baseUrl));
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
    outerBoxQty: toNumber(
      boxComposition.match(/(\d+)\s*(?:개입|개|EA|ea|입)/)?.[1] || "",
    ),
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

/** 과자생각 상세페이지들을 순회하며 상세 row를 수집한다. */
async function collectCcdomeDetails(
  page,
  products,
  config,
  onProgress = () => {},
  signal,
) {
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
      message: `과자생각 상세 수집 중: ${index + 1}/${limitedTargets.length}`,
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
        .waitForSelector(CCDOME_DETAIL.selectors.root, {
          timeout: config.navigationTimeoutMs,
        })
        .catch(() => null);

      /**
       * 상세 이미지 영역까지 스크롤해서 lazy 이미지 URL이 DOM에 들어오게 만든 뒤
       * HTML을 읽는다.
       */
      await prepareCcdomeDetailImages(page, config);

      const html = await page.content();
      details.push(parseCcdomeDetailHtml(html, product, config));
    } catch (error) {
      details.push({
        sourceMall: config.mall,
        categoryCode: config.category,
        productId: product.productId,
        productUrl: product.productUrl,
        productName: product.productName,
        brandHint: product.brandHint || inferBrand(product.productName),
        categoryHint: product.categoryHint || inferCategory(product.productName),
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
  CCDOME_DETAIL,
  collectCcdomeDetails,
  parseCcdomeDetailHtml,
  prepareCcdomeDetailImages,
};
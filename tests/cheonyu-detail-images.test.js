const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const {
  parseDetailHtml,
  prepareDetailImages,
} = require("../src/malls/cheonyu/detail");
const { createBackendProducts } = require("../src/utils/backend-product");

const config = { mall: "cheonyu", baseUrl: "https://www.cheonyu.com" };
const product = { productId: "95546", productName: "상세 이미지 검증" };
const image1 = "https://image1.cheonyu.com/202605131778654586.png";
const image4 = "https://image4.cheonyu.com/202403221711089535.jpg";
const extensionlessImage = "https://playobje.diskn.com/v89hTPdyke";
const cdnImages = [1, 2, 3, 4, 5].map((number) =>
  `https://image${number}.cheonyu.com/${product.productId}_detail${number}.png`,
);
const externalImages = [1, 2, 3].map((index) =>
  `http://jamstudio1.cafe24.com/web/upload/20272028%EB%8B%AC%EB%A0%A5${index}.png`,
);
const imagesHtml = (urls) => urls.map((url) => `<img loading="lazy" src="${url}">`).join("");
const wrap = (body) => `<div id="productView">${body}</div>`;
const parse = (html) => parseDetailHtml(html, product, config);

test("이전·현재 상세 영역에서 도메인과 확장자에 관계없이 모든 URL을 순서대로 저장한다", async () => {
  const expected = [image4, image1, ...externalImages];
  for (const id of ["viewContent", "viewPcontent"]) {
    const detail = parse(wrap(`<div id="tab_01"><div id="${id}" class="pic">
      <center>${imagesHtml([...expected, image1])}</center></div></div>`));
    assert.deepEqual(detail.introImageUrls, expected);
    const [backend] = await createBackendProducts({
      collectionMode: "detail", products: [product], detailItems: [detail],
    });
    assert.deepEqual(backend.descriptionImageUrls, expected);
  }
});

test("상세 본문 ID가 바뀌면 상품상세 탭의 pic 영역을 사용한다", () => {
  const detail = parse(wrap(`<div id="tab_01"><section class="pic" id="futureContent">
    ${imagesHtml(externalImages)}</section></div>`));
  assert.deepEqual(detail.introImageUrls, externalImages);
});

test("탭과 본문 ID가 모두 바뀌어도 제품상세정보 표 옆의 pic 영역을 찾는다", () => {
  const detail = parse(wrap(`<section id="futureTab">
    <div class="pic" id="futureContent">${imagesHtml(externalImages)}</div>
    <div style="display:none">원본 상세 텍스트</div>
    <div class="info" alt="제품상세정보"><table></table></div>
  </section><section id="recommendations"><div class="pic">
    <img src="https://image3.cheonyu.com/unrelated.jpg"></div></section>`));
  assert.deepEqual(detail.introImageUrls, externalImages);
});

test("상세 영역을 찾았으면 추천상품·브랜드·대표 이미지와 섞지 않는다", () => {
  for (const urls of [externalImages, []]) {
    const detail = parse(wrap(`<div id="viewItemWith">
      <img src="https://image3.cheonyu.com/recommend.jpg"></div>
      <div class="photo_wrap"><img src="https://image3.cheonyu.com/main.jpg"></div>
      <div id="viewBrandPop"><img src="https://image3.cheonyu.com/brand.jpg"></div>
      <div id="tab_01"><div class="tab_design"><img src="/images/tab.png"></div>
      <div class="pic" id="viewPcontent">${imagesHtml(urls)}</div></div>`));
    assert.deepEqual(detail.introImageUrls, urls);
  }
});

test("상세 영역이 없어도 image1~5의 모든 URL 속성을 탐색하고 대표 이미지와 분리한다", () => {
  for (const attribute of ["src", "data-src", "data-original", "data-lazy", "data-url", "lazy", "srcset", "data-srcset"]) {
    const html = cdnImages.map((url) => `<img ${attribute}="${url}">`).join("");
    const detail = parse(wrap(`<div>${html}</div><div id="viewItemWith">
      ${imagesHtml(cdnImages.map((url) => url.replace("detail", "recommend")))}</div>`));
    assert.deepEqual(detail.introImageUrls, cdnImages, attribute);
    assert.deepEqual(detail.mainImageUrls, [], attribute);
  }
});

test("image1~5는 확장자가 없는 이미지 URL도 수집한다", () => {
  const urls = cdnImages.map((url) => url.replace(".png", ""));
  assert.deepEqual(parse(wrap(imagesHtml(urls))).introImageUrls, urls);
});

test("상세 영역의 외부 img는 확장자가 없어도 최종 상세 이미지 배열에 저장한다", async () => {
  for (const id of ["viewPcontent", "viewContent", "futureContent"]) {
    const detail = parse(wrap(`<div id="tab_01"><div class="pic" id="${id}">
      ${imagesHtml([extensionlessImage, image1, extensionlessImage])}</div></div>`));
    assert.deepEqual(detail.introImageUrls, [extensionlessImage, image1]);
    const [backend] = await createBackendProducts({
      collectionMode: "detail", products: [product], detailItems: [detail],
    });
    assert.deepEqual(backend.descriptionImageUrls, [extensionlessImage, image1]);
  }
});

test("확장자 없는 lazy·srcset URL도 지원하되 상세 영역 밖이나 비 HTTP 주소는 제외한다", () => {
  for (const attribute of ["src", "data-src", "data-original", "data-lazy", "data-url", "lazy", "srcset", "data-srcset"]) {
    const detail = parse(wrap(`<div class="photo_wrap"><img src="${extensionlessImage}"></div>
      <img src="https://other.example/outside">
      <div id="viewPcontent"><img ${attribute}="${extensionlessImage}">
      <img src="data:image/png;base64,AAAA"><img src="blob:https://other.example/123">
      <img src="javascript:void(0)"><img src="/loading.gif"></div>`));
    assert.deepEqual(detail.introImageUrls, [extensionlessImage], attribute);
    assert.deepEqual(detail.mainImageUrls, [], attribute);
  }
  assert.deepEqual(parse(wrap(imagesHtml([extensionlessImage]))).introImageUrls, []);
});

test("새 구조에서도 lazy 속성과 srcset의 모든 URL을 수집하고 중복을 제거한다", () => {
  const detail = parse(wrap(`<div id="tab_01"><div class="pic" id="changed">
    <img src="/loading.gif" data-original="${image1}">
    <img data-src="${externalImages[0]}">
    <img srcset="${externalImages[0]} 1x, ${externalImages[1]} 2x">
    <img data-srcset="${externalImages[2]} 1000w">
  </div></div>`));
  assert.deepEqual(detail.introImageUrls, [image1, ...externalImages]);
});

// 외부 사이트에 접속하지 않고 실제 브라우저의 비동기 DOM·URL 대기를 확인한다.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { chromium } = require("playwright");

test("이미지를 표시하지 않는 브라우저에서도 변경된 영역의 비동기 URL을 기다린다", {
  skip: !fs.existsSync(chromium.executablePath()),
}, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--blink-settings=imagesEnabled=false"] });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => route.abort());
    for (const [tabId, contentId, extra, urls = externalImages] of [
      ["tab_01", "viewPcontent", "", [extensionlessImage, ...externalImages]],
      ["tab_01", "futureContent", ""],
      ["futureTab", "futureContent", '<div class="info" alt="제품상세정보"></div>'],
      ["futureTab", "unrecognizedContent", "", cdnImages],
    ]) {
      const page = await context.newPage();
      await page.setContent(wrap(`<div id="viewItemWith">
        <img src="https://image3.cheonyu.com/unrelated.jpg"></div>
        <div id="${tabId}"><div class="pic" id="${contentId}">
        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==">
        </div>${extra}</div>`));
      await page.evaluate(({ id, urls }) => {
        setTimeout(() => {
          const container = document.getElementById(id);
          container.replaceChildren(...urls.map((url) => {
            const image = document.createElement("img");
            image.setAttribute("data-original", url);
            return image;
          }));
        }, 2200);
      }, { id: contentId, urls });
      await prepareDetailImages(page);
      assert.deepEqual(parse(await page.content()).introImageUrls, urls);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

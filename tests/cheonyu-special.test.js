const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseDetailHtml } = require("../src/malls/cheonyu/detail");

const config = { mall: "cheonyu", baseUrl: "https://www.cheonyu.com" };
const product = { productId: "93796", productName: "특별상품 마크 검증" };
const photo = (body = "", wrapper = "detaile_info_wrap") =>
  `<div id="productView"><div class="${wrapper}"><div class="photo_wrap"><div class="large_photo">${body}</div></div></div></div>`;
const mark = (code) => `<div class="mark_area" style="background-image: url('/images/circle400_${code}.png?2606');"></div>`;
const parse = (html) => {
  const { special, specialObserved } = parseDetailHtml(html, product, config);
  return { special, specialObserved };
};

test("천유 circle400 마크 13종을 지정한 특별상품 이름으로 저장한다", () => {
  const names = {
    5: "가챠", 6: "super 초특가", 7: "도전최저가", 8: "핫템",
    10: "눈물의 땡처리", 11: "시즌오프", 12: "블랙딜", 14: "마지막 반값",
    15: "랜덤가챠", 16: "착한 상품", 17: "반짝할인", 18: "직수입", 20: "크리스마스",
  };
  for (const [code, special] of Object.entries(names)) {
    assert.deepEqual(parse(photo(mark(code))), { special, specialObserved: true }, code);
  }
});

test("천유 실제 예시 마크와 두 상세영역 철자를 모두 지원한다", () => {
  // 실제 93796은 circle400_8.png?2606, 60549는 circle400_16.png?2504를 사용한다.
  for (const wrapper of ["detaile_info_wrap", "detail_info_wrap"]) {
    assert.deepEqual(parse(photo(mark(8), wrapper)), { special: "핫템", specialObserved: true });
    assert.deepEqual(parse(photo(mark(16).replace("2606", "2504"), wrapper)), { special: "착한 상품", specialObserved: true });
  }
});

test("천유 마크 URL의 쿼리·해시와 따옴표 형태가 바뀌어도 파일명으로 식별한다", () => {
  for (const style of [
    "background-image:url(/images/circle400_8.png?circle400_16.png#other)",
    "color:red; BACKGROUND-IMAGE : url(&quot;https://www.cheonyu.com/images/circle400_8.png?v=2&quot;) !important;",
    "background-image: url('//www.cheonyu.com/images/circle400_8.png'); display: block",
  ]) {
    assert.deepEqual(parse(photo(`<div class="mark_area" style="${style}"></div>`)), {
      special: "핫템", specialObserved: true,
    }, style);
  }
});

test("천유 정상 대표사진 영역에 마크가 없거나 미등록 코드면 null을 관측한다", () => {
  for (const body of ["", "<figure><img src='/product.jpg'></figure>", mark(9), mark(999)]) {
    assert.deepEqual(parse(photo(body)), { special: null, specialObserved: true }, body);
  }
});

test("천유 다른 상품·추천·상세설명의 마크는 현재 상품 special에 섞지 않는다", () => {
  const recommendations = `<section id="viewItemWith"><div class="detaile_info_wrap"><div class="photo_wrap">
    <div class="large_photo">${mark(16)}</div></div></div></section>`;
  const html = photo(mark(8)).replace("</div></div></div></div>", `</div></div></div>${recommendations}</div>`);
  assert.deepEqual(parse(html + `<aside>${mark(20)}</aside>`), { special: "핫템", specialObserved: true });
  assert.deepEqual(parse(photo("") + recommendations), { special: null, specialObserved: true });
  assert.deepEqual(parse(`<div id="productView">${recommendations}<div id="viewPcontent">${mark(16)}</div></div>`), {
    special: null, specialObserved: false,
  });
});

test("천유 대표사진 영역이 없거나 복수이면 마크 미관측으로 남긴다", () => {
  for (const html of ["", "<div id='productView'></div>", photo(mark(8)) + photo(mark(16))]) {
    assert.deepEqual(parse(html), { special: null, specialObserved: false }, html);
  }
});

test("천유 마크가 모호하거나 배경이미지 파일명이 정확하지 않으면 임의 분류하지 않는다", () => {
  for (const body of [
    mark(8) + mark(16),
    '<div class="mark_area"></div>',
    '<div class="mark_area" style="background-image: none"></div>',
    '<div class="mark_area" style="background-image: url(/images/circle400_8.png), url(/images/circle400_16.png)"></div>',
    '<div class="mark_area" style="background-image: url(/images/circle400_8.png); background-image: url(/images/circle400_16.png)"></div>',
    '<div class="mark_area" style="border-image: url(/images/circle400_8.png)"></div>',
    '<div class="mark_area" style="background-image: url(/images/not_circle400_8.png)"></div>',
    '<div class="mark_area" style="background-image: url(/images/unrelated.png?circle400_8.png)"></div>',
    '<div class="mark_area" style="background-image: url(data:image/png;base64,circle400_8.png)"></div>',
  ]) {
    assert.deepEqual(parse(photo(body)), { special: null, specialObserved: true }, body);
  }
});

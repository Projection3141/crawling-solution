const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseDetailHtml } = require("../src/malls/cheonyu/detail");
const { parseCcdomeDetailHtml } = require("../src/malls/ccdome/detail");

const readDepths = (row) => [1, 2, 3, 4, 5].map((depth) => row[`categoryDepth${depth}`]);
const cheonyuConfig = { mall: "cheonyu", baseUrl: "https://www.cheonyu.com" };
const ccdomeConfig = { mall: "ccdome", baseUrl: "https://www.ccdome.co.kr" };
const product = { productId: "79136", productName: "카테고리 검증 상품" };
const categoryDropdown = (depth, label, items) => `<div class="select-list-group">
  <a class="action-select"><span id="navCateTit${depth}">${label}</span></a>
  <div class="wrap-list-select"><ul id="navCate${depth}">${items}</ul></div></div>`;
const categoryItem = (label, { dataId, href = "#", selected = false } = {}) =>
  `<li${dataId === undefined ? "" : ` data-cateid="${dataId}"`}${selected ? ' class="selected"' : ""}>
    <a href="${href}"><span class="txt">${label}</span></a></li>`;

test("천유 실제 예시의 세 단계 경로는 슬래시를 이름으로 유지하고 빈 뎁스를 전달한다", () => {
  // 상품 79136의 공개 HTML에서 확인한 선택자와 카테고리 표기다.
  const html = `<div id="navCateTit1">패션잡화</div>
    <div id="navCateTit2">여름 / 겨울 /시즌 상품</div>
    <div id="navCateTit3">마스크 / 장갑 / 안대</div>`;
  const row = parseDetailHtml(html, product, cheonyuConfig);

  assert.deepEqual(readDepths(row), [
    "패션잡화", "여름 / 겨울 /시즌 상품", "마스크 / 장갑 / 안대", "", "",
  ]);
});

test("천유 네 번째와 다섯 번째 경로도 정규화 후 전달한다", () => {
  const html = ["문구", "필기구", "펜", "색상 / 종류", "검정"]
    .map((name, index) => `<div id="navCateTit${index + 1}">  ${name}\n </div>`)
    .join("");
  const row = parseDetailHtml(html, product, cheonyuConfig);

  assert.deepEqual(readDepths(row), ["문구", "필기구", "펜", "색상 / 종류", "검정"]);
});

test("과자생각 경로의 선택된 카테고리만 읽고 다른 메뉴와 HOME은 제외한다", () => {
  // 공개 상품 1000004615의 breadcrumb 구조와 카테고리 표기를 사용한다.
  const html = `<div class="location_wrap"><div class="location_cont">
    <em><a class="local_home">HOME</a></em><span>&gt;</span>
    ${["전체상품", "젤리/카라멜/캔디", "사탕/캔디"].map((name) => `
      <div class="location_select"><div class="location_tit"><a><span>${name}</span></a></div>
        <ul style="display:none"><li><a><span>다른 메뉴</span></a></li></ul>
      </div><span>&gt;</span>`).join("")}
    </div></div>`;
  const row = parseCcdomeDetailHtml(html, product, ccdomeConfig);

  assert.deepEqual(readDepths(row), ["전체상품", "젤리/카라멜/캔디", "사탕/캔디", "", ""]);
});

test("과자생각 경로가 다섯 단계면 순서대로 모두 전달한다", () => {
  const html = `<div class="location_wrap">${["전체상품", "과자", "쿠키", "맛 / 종류", "초코"]
    .map((name) => `<div class="location_select"><div class="location_tit"><a><span> ${name} </span></a></div></div>`)
    .join("")}</div>`;
  const row = parseCcdomeDetailHtml(html, product, ccdomeConfig);

  assert.deepEqual(readDepths(row), ["전체상품", "과자", "쿠키", "맛 / 종류", "초코"]);
});

test("천유 실제 95371의 선택된 최심 카테고리 ID 152를 문자열로 읽는다", () => {
  const html = `<nav><a href="/product/list.html?cateIDX=999">캐릭터 파우치</a></nav>` +
    categoryDropdown(1, "패션잡화", categoryItem("패션잡화", { dataId: "C", selected: true })) +
    categoryDropdown(2, "파우치 / 지갑", categoryItem("파우치 / 지갑", { dataId: "C01", selected: true })) +
    categoryDropdown(3, "캐릭터 파우치", [
      categoryItem("전체", { dataId: "23" }),
      categoryItem("심플 파우치", { dataId: "150" }),
      categoryItem("캐릭터 파우치", { dataId: "152", selected: true }),
    ].join(""));
  const row = parseDetailHtml(html, {
    ...product, productId: "95371", productUrl: "https://www.cheonyu.com/product/view.html?qIDX=95371&cateIDX=888",
  }, { ...cheonyuConfig, category: "777" });

  assert.equal(row.categoryId, "152");
  assert.equal(typeof row.categoryId, "string");
});

test("천유 카테고리 ID를 선택된 경로의 cateIDX 링크에서도 읽는다", () => {
  const html = categoryDropdown(3, "캐릭터 파우치", [
    categoryItem("다른 분류", { href: "/product/list.html?cateIDX=999" }),
    categoryItem("캐릭터 파우치", { href: "/product/list.html?cateIDX=152", selected: true }),
  ].join(""));
  assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, "152");
});

test("천유 같은 이름의 메뉴는 현재 드롭다운의 선택 표시로 구별한다", () => {
  const html = categoryDropdown(2, "파우치", categoryItem("캐릭터 파우치", { dataId: "998" })) +
    categoryDropdown(3, "캐릭터 파우치", [
      categoryItem("캐릭터 파우치", { dataId: "999" }),
      categoryItem("캐릭터 파우치", { dataId: "152", selected: true }),
    ].join(""));
  assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, "152");
});

test("천유 선택 표시가 없으면 같은 드롭다운에서 이름이 유일할 때만 ID를 읽는다", () => {
  const unique = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { dataId: "152" }));
  const ambiguous = categoryDropdown(3, "캐릭터 파우치", [
    categoryItem("캐릭터 파우치", { dataId: "152" }),
    categoryItem("캐릭터 파우치", { dataId: "999" }),
  ].join(""));
  assert.equal(parseDetailHtml(unique, product, cheonyuConfig).categoryId, "152");
  assert.equal(parseDetailHtml(ambiguous, product, cheonyuConfig).categoryId, null);
});

test("천유 ID가 양수 숫자열이 아니거나 표시·링크와 모순되면 null이다", () => {
  for (const dataId of ["", "C01", "0", "000000", "-1", "1.5", "152abc"]) {
    const html = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { dataId, selected: true }));
    assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, null, dataId);
  }
  const conflict = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", {
    dataId: "152", href: "/product/list.html?cateIDX=999", selected: true,
  }));
  const mismatchedLabel = categoryDropdown(3, "캐릭터 파우치", categoryItem("다른 이름", { dataId: "152", selected: true }));
  const multiSelected = categoryDropdown(3, "캐릭터 파우치", [
    categoryItem("캐릭터 파우치", { dataId: "152", selected: true }),
    categoryItem("캐릭터 파우치", { dataId: "999", selected: true }),
  ].join(""));
  for (const html of [conflict, mismatchedLabel, multiSelected]) {
    assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, null);
  }
});

test("천유 잘못된 cateIDX·다른 호스트·상품 링크는 카테고리 ID로 쓰지 않는다", () => {
  for (const href of [
    "/product/list.html?cateIDX=0", "/product/list.html?cateIDX=152x",
    "/product/list.html?cateIDX=152&amp;cateIDX=999",
    "https://other.example/product/list.html?cateIDX=152",
    "/product/view.html?qIDX=95371&amp;cateIDX=152",
  ]) {
    const html = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { href, selected: true }));
    assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, null, href);
  }
});

test("천유 최심 ID가 없으면 상위·전역 메뉴·수집 설정으로 대체하지 않는다", () => {
  const upper = categoryDropdown(2, "파우치 / 지갑", categoryItem("파우치 / 지갑", { dataId: "23", selected: true }));
  for (const lower of [
    '<span id="navCateTit3">캐릭터 파우치</span>',
    categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { selected: true })),
  ]) {
    const html = upper + lower + '<a href="/product/list.html?cateIDX=152">캐릭터 파우치</a>';
    assert.equal(parseDetailHtml(html, {
      ...product, productUrl: "https://www.cheonyu.com/product/view.html?qIDX=95371&cateIDX=888",
    }, { ...cheonyuConfig, category: "777" }).categoryId, null);
  }
  assert.equal(parseDetailHtml("", product, cheonyuConfig).categoryId, null);
});

test("천유 다섯 번째 단계까지 존재하면 그 단계에 연결된 ID만 사용한다", () => {
  const html = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { dataId: "152", selected: true })) +
    categoryDropdown(4, "종류", categoryItem("종류", { dataId: "153", selected: true })) +
    categoryDropdown(5, "동전 지갑", categoryItem("동전 지갑", { dataId: "154", selected: true }));
  assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, "154");
});

test("천유 카테고리 ID의 선행 0과 긴 숫자 문자열을 그대로 보존한다", () => {
  for (const dataId of ["000152", "9007199254740992999"]) {
    const html = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", { dataId, selected: true }));
    assert.equal(parseDetailHtml(html, product, cheonyuConfig).categoryId, dataId);
    const linked = categoryDropdown(3, "캐릭터 파우치", categoryItem("캐릭터 파우치", {
      href: `/product/list.html?cateIDX=${dataId}`, selected: true,
    }));
    assert.equal(parseDetailHtml(linked, product, cheonyuConfig).categoryId, dataId);
  }
});

test("과자생각 실제 상품 폼의 cateCd만 읽고 선행 0을 보존한다", () => {
  // 공개 상품 1000005467의 form#frmView에서 확인한 원본 코드다.
  const html = `<input name="cateCd" value="999999">
    <form id="otherProduct"><input name="cateCd" value="888888"></form>
    <form id="frmView"><input type="hidden" name="goodsNo" value="1000005467">
      <input type="hidden" name="cateCd" value="021001"></form>`;
  const row = parseCcdomeDetailHtml(html, {
    ...product, productId: "1000005467",
    productUrl: "https://ccdome.co.kr/goods/goods_view.php?goodsNo=1000005467&cateCd=777777",
  }, { ...ccdomeConfig, category: "666666", categoryCode: "555555" });

  assert.equal(row.categoryId, "021001");
  assert.equal(typeof row.categoryId, "string");
});

test("과자생각 상품 폼의 코드가 없으면 전역 입력·URL·수집 설정으로 대체하지 않는다", () => {
  for (const html of [
    "",
    '<input name="cateCd" value="021001"><form id="frmView"></form>',
    '<form id="otherProduct"><input name="cateCd" value="021001"></form>',
    '<div id="frmView"><input name="cateCd" value="021001"></div>',
    '<form id="frmView"><input name="cateCd" value="021001" form="otherProduct"></form>',
  ]) {
    const row = parseCcdomeDetailHtml(html, {
      ...product, productUrl: "https://ccdome.co.kr/goods/goods_view.php?goodsNo=1000005467&cateCd=021001",
    }, { ...ccdomeConfig, category: "021001", categoryCode: "021001" });
    assert.equal(row.categoryId, null, html);
  }
});

test("과자생각 상품 폼의 잘못된 코드와 중복 입력은 null이다", () => {
  for (const value of ["", "0", "000000", "-021001", "021.001", "021001abc", "2e4", "021 001"]) {
    const html = `<form id="frmView"><input name="cateCd" value="${value}"></form>`;
    assert.equal(parseCcdomeDetailHtml(html, product, ccdomeConfig).categoryId, null, value);
  }
  for (const html of [
    '<form id="frmView"><input name="cateCd"></form>',
    '<form id="frmView"><input name="cateCd" value="021001"><input name="cateCd" value="021002"></form>',
    '<form id="frmView"><input name="cateCd" value="021001"></form><form id="frmView"><input name="cateCd" value="021002"></form>',
  ]) {
    assert.equal(parseCcdomeDetailHtml(html, product, ccdomeConfig).categoryId, null, html);
  }
  const padded = '<form id="frmView"><input name="cateCd" value=" 021001 "></form>';
  assert.equal(parseCcdomeDetailHtml(padded, product, ccdomeConfig).categoryId, "021001");
});

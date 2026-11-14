const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const archiveDirectory = mkdtempSync(path.join(os.tmpdir(), "cheonyu-option-stock-"));
process.env.PRODUCT_ARCHIVE_DIRECTORY = archiveDirectory;
after(() => rmSync(archiveDirectory, { recursive: true, force: true }));
const { getCheonyuCartFallbackProductIds, parseListHtml } = require("../src/malls/cheonyu/site");
const {
  createCheonyuPopupInventoryItems,
  mergeCheonyuDetailInventoryItems,
  probeCheonyuCartStock,
} = require("../src/malls/cheonyu/cart-stock");
const { parseCartHtml } = require("../src/malls/cheonyu/cart");
const { parseDetailHtml } = require("../src/malls/cheonyu/detail");
const { createBackendProducts } = require("../src/utils/backend-product");
const { ARCHIVE_PATH, updateProductArchive } = require("../src/utils/product-archive");
writeFileSync(ARCHIVE_PATH, JSON.stringify({ cheonyu: [], ccdome: [] }));

const config = {
  mall: "cheonyu",
  baseUrl: "https://www.cheonyu.com",
  collectionMode: "detail",
  category: "-1",
  lowStockThreshold: 10,
  navigationTimeoutMs: 1000,
  cartCoverageReadAttempts: 1,
};

function product(productId, productName = "테스트 상품") {
  return {
    sourceMall: "cheonyu",
    productId,
    productName,
    productUrl: `${config.baseUrl}/product/view.html?qIDX=${productId}`,
  };
}

function popupRow(productId, optionId, optionText, maxStock) {
  return {
    productId,
    optionId,
    submitOptionId: optionId,
    optionText,
    productName: "테스트 상품",
    hasOption: optionId !== "0",
    complete: true,
    productMatchMode: "dom-id",
    maxStock,
    stockStatus: maxStock > 0 ? "IN_STOCK" : "OUT_OF_STOCK",
    selectable: maxStock > 0,
    selectedForCart: maxStock > 0,
    requestedQty: maxStock > 0 ? 1 : 0,
  };
}

function detailHtml(productId, barcode) {
  return `<div id="productView">
    <div class="info_wrap"><div class="pdt_name"><span>테스트 상품</span></div></div>
    <div class="pdt-top-info">
      <span class="info-number">${productId}</span><span class="info-number">${barcode}</span>
    </div>
    <div class="pdt_code"><div class="pdt_code_last"><strong>1,000</strong></div></div>
  </div>`;
}

function cartRowHtml(productId, optionText, barcode, maxStock = 20) {
  return `<tr class="tr-nth"><td>
    <input name="cartCheck" id="cartCheck" value="cart-${productId}-${optionText}">
    <input name="inPIDX" id="inPIDX" value="${productId}">
    <div class="product_dsc"><a class="c" href="/product/view.html?qIDX=${productId}">테스트 상품</a></div>
    <span class="dtfont-pd">상품번호 [ ${productId} ] ${barcode}</span>
    <ul class="option_list">${optionText ? `<li>${optionText}</li>` : ""}</ul>
    <input name="num01" id="inPcount" value="1">
    <input name="inMaxStock" id="inMaxStock" value="${maxStock}">
    <input id="inOnePrice" value="500">
  </td></tr>`;
}

test("비로그인 옵션의 ID와 이름을 읽되 disabled는 품절로 해석하지 않는다", () => {
  const guest = { ...config, anonymousCollection: true };
  const [candidate] = parseListHtml(`<ul><li>
    <a class="pLink" href="/product/view.html?qIDX=12345">상품</a>
    <div class="m_pdt_list_icon"><img src="/image_1/btn_option.gif"></div>
  </li></ul>`, 1, guest);
  assert.equal(candidate.hasOptionHint, true);
  assert.equal(candidate.isSoldOut, false);
  assert.equal(candidate.saleStatus, null);
  const optionsHtml = `<div class="option_wrap"><table id="opSelectedList"><tbody>
    <tr><td><input type="checkbox" id="optionCHK" value="119570" disabled></td><td class="option_txt">블루</td></tr>
    <tr><td><input type="checkbox" id="optionCHK" value="119571" disabled></td><td class="option_txt">핑크</td></tr>
    <tr><td><input type="checkbox" id="optionCHK" value="119570" disabled></td><td class="option_txt">중복</td></tr>
    <tr><td><input type="checkbox" id="optionCHKAdd" value="9211" disabled></td><td class="option_txt">추가 상품</td></tr>
  </tbody></table></div>`;
  const detail = parseDetailHtml(detailHtml("12345", "8800000012345").replace(
    '<div class="pdt-top-info">', optionsHtml + '<div class="pdt-top-info">',
  ), candidate, guest);
  const options = JSON.parse(detail.detailOptions);
  assert.deepEqual(options.map(({ optionId, optionName }) => ({ optionId, optionName })), [
    { optionId: "119570", optionName: "블루" }, { optionId: "119571", optionName: "핑크" },
  ]);
  assert.ok(options.every(option => option.disabled && !Object.hasOwn(option, "isSoldOut")));
});

test("신상품 상세 저장은 수량이 확인된 옵션 재고만 반영한다", async () => {
  const product = {
    id: "91737", sourceMall: "cheonyu", inventoryObserved: true,
    type: "OPTION", stockQuantity: 19, stockStatus: "IN_STOCK", saleStatus: "ON_SALE",
    options: [
      { id: "11", nameKo: "블루", stockQuantity: 19, status: "ON_SALE" },
      { id: "12", nameKo: "핑크", stockQuantity: 0, status: "SOLD_OUT" },
    ],
  };
  await updateProductArchive([product], { source: "general" });
  const detail = {
    ...product,
    stockQuantity: 0,
    options: [
      { id: "11", nameKo: "블루", barcode: "0012345678901", stockQuantity: 0, status: "SOLD_OUT" },
      { id: "12", nameKo: "핑크", stockQuantity: null, status: "ON_SALE" },
    ],
  };
  const normal = (await updateProductArchive([detail], { source: "detail" })).currentProducts[0];
  assert.equal(normal.options[0].barcode, "0012345678901");
  assert.equal(normal.options[0].stockQuantity, 19);
  const optIn = { source: "detail", includeDetailOptionStock: true };
  const unverified = (await updateProductArchive([{ ...detail, inventoryObserved: false }], optIn)).currentProducts[0];
  assert.equal(unverified.options[0].stockQuantity, 19);
  const verified = (await updateProductArchive([detail], optIn)).currentProducts[0];
  assert.equal(verified.type, "OPTION");
  assert.equal(verified.stockQuantity, 19);
  assert.deepEqual(verified.options.map(({ stockQuantity, status }) => ({ stockQuantity, status })), [
    { stockQuantity: 0, status: "SOLD_OUT" }, { stockQuantity: 0, status: "SOLD_OUT" },
  ]);
});

test("일반 수집은 팝업 재고가 완전한 옵션·SINGLE을 장바구니에 추가하지 않는다", () => {
  const products = [product("12345"), product("12346"), product("12347")];
  const ids = getCheonyuCartFallbackProductIds({
    collectionMode: "general",
    selectableProducts: products,
    popupOptionRows: [
      popupRow("12345", "11", "빨강", 20),
      popupRow("12346", "0", "", 20),
      { ...popupRow("12347", "12", "파랑", 20), complete: false },
    ],
    completePopupProductIds: ["12345", "12346"],
  });
  assert.deepEqual(ids, ["12347"]);
});

test("상세 수집은 팝업 재고가 완전해도 옵션 상품을 장바구니 대상으로 포함한다", () => {
  const ids = getCheonyuCartFallbackProductIds({
    collectionMode: "detail",
    selectableProducts: [product("12345"), product("12346"), product("12347")],
    popupOptionRows: [
      popupRow("12345", "11", "빨강", 20),
      popupRow("12345", "12", "파랑", 20),
      popupRow("12346", "0", "", 20),
      { ...popupRow("12347", "13", "검정", 20), complete: false },
      popupRow("12348", "14", "품절", 0),
    ],
    completePopupProductIds: ["12345", "12346", "12348"],
  });
  assert.deepEqual(ids, ["12345", "12347"]);
});

test("상세 대표 바코드와 실제 장바구니의 옵션별 바코드를 각각 저장하고 품절 옵션을 보존한다", async () => {
  const representativeBarcode = "8800000012345";
  const products = [{ ...product("12345"), barcode: representativeBarcode }];
  const popupOptionRows = [
    popupRow("12345", "11", "빨강", 20),
    popupRow("12345", "12", "파랑", 30),
    popupRow("12345", "13", "검정", 0),
  ];
  const popupItems = createCheonyuPopupInventoryItems({
    products, popupOptionRows, directProductIds: ["12345"], config,
  });
  // 장바구니 순서는 팝업과 달라도 옵션명으로 정확한 ID를 찾아야 한다.
  const html = `<table id="cartTable">
    ${cartRowHtml("12345", "파랑", "8800000000012", 30)}
    ${cartRowHtml("12345", "빨강", "0012345678901", 20)}
  </table>`;
  const visitedUrls = [];
  const page = {
    goto: async (url) => { visitedUrls.push(url); return { ok: () => true }; },
    waitForSelector: async () => {},
    content: async () => html,
  };
  const cartResult = await probeCheonyuCartStock(page, {}, config, products, { popupOptionRows });
  assert.deepEqual(visitedUrls, [`${config.baseUrl}/order/cart.html`]);
  assert.equal(cartResult.coverage.optionCoverageComplete, true);
  const inventoryItems = mergeCheonyuDetailInventoryItems(popupItems, cartResult.inventoryItems);
  assert.equal(inventoryItems.length, 3);
  // 병합은 원본 팝업 배열을 바꾸지 않고 대표 바코드의 옵션 전파를 차단한다.
  assert.equal(popupItems[0].barcode, representativeBarcode);
  const detail = parseDetailHtml(detailHtml("12345", representativeBarcode), products[0], config);
  const [result] = await createBackendProducts({
    collectionMode: "detail", products, inventoryItems, detailItems: [detail],
  });
  assert.equal(result.type, "OPTION");
  assert.equal(result.barcode, representativeBarcode);
  const options = new Map(result.options.map((option) => [option.id, option]));
  assert.equal(options.size, 3);
  assert.equal(options.get("11").barcode, "0012345678901");
  assert.equal(options.get("12").barcode, "8800000000012");
  assert.equal(options.get("13").barcode, null);
  assert.equal(options.get("13").stockQuantity, 0);
  assert.equal(result.stockQuantity, 50);
});

test("SINGLE 대표 바코드는 상세페이지에서만 가져오고 옵션 배열을 만들지 않는다", async () => {
  const single = product("12346");
  const popupItems = createCheonyuPopupInventoryItems({
    products: [single],
    popupOptionRows: [popupRow("12346", "0", "", 20)],
    directProductIds: ["12346"], config,
  });
  const [result] = await createBackendProducts({
    collectionMode: "detail", products: [single], inventoryItems: popupItems,
    detailItems: [parseDetailHtml(detailHtml("12346", "8800000012346"), single, config)],
  });
  assert.equal(result.type, "SINGLE");
  assert.equal(result.barcode, "8800000012346");
  assert.deepEqual(result.options, []);

  const [withoutDetailBarcode] = await createBackendProducts({
    collectionMode: "detail", products: [single],
    inventoryItems: [{ ...popupItems[0], barcode: "8800000000099" }],
    detailItems: [parseDetailHtml(detailHtml("12346", ""), single, config)],
  });
  assert.equal(withoutDetailBarcode.barcode, null);
});

test("장바구니의 잘못된 길이 바코드를 옵션 바코드로 저장하지 않는다", () => {
  for (const barcode of ["880000000001", "88000000000123", ""]) {
    const [row] = parseCartHtml(
      `<table id="cartTable">${cartRowHtml("12345", "빨강", barcode)}</table>`, config,
    );
    assert.equal(row.barcode, null);
  }
});

test("상세는 상품이 보여도 누락 옵션을 다시 읽고 일반은 기존 상품 단위 확인을 유지한다", async (t) => {
  t.mock.method(console, "warn", () => {});
  const products = [product("12345")];
  const popupOptionRows = [
    popupRow("12345", "11", "빨강", 20),
    popupRow("12345", "12", "파랑", 30),
  ];
  for (const collectionMode of ["detail", "general"]) {
    let readCount = 0;
    const page = {
      goto: async () => ({ ok: () => true }),
      waitForSelector: async () => {},
      content: async () => {
        readCount += 1;
        return `<table id="cartTable">
          ${cartRowHtml("12345", "빨강", "0012345678901", 20)}
          ${readCount > 1 ? cartRowHtml("12345", "파랑", "8800000000012", 30) : ""}
        </table>`;
      },
    };
    const result = await probeCheonyuCartStock(page, {}, {
      ...config, collectionMode, cartCoverageReadAttempts: 2, cartCoverageRetryDelayMs: 500,
    }, products, { popupOptionRows });
    assert.equal(result.coverage.complete, true);
    assert.equal(readCount, collectionMode === "detail" ? 2 : 1);
    assert.equal(result.coverage.optionCoverageComplete, collectionMode === "detail");
    if (collectionMode === "detail") {
      assert.equal(result.inventoryItems.find((row) => row.optionId === "12").barcode, "8800000000012");
    }
  }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseListHtml, collectListCandidates } = require("../src/malls/cheonyu/site");
const { createBackendProducts } = require("../src/utils/backend-product");
const { createCheonyuPopupInventoryItems } = require("../src/malls/cheonyu/cart-stock");
const { parseCartHtml } = require("../src/malls/cheonyu/cart");
const { writeJson } = require("../src/utils/files");

const config = {
  mall: "cheonyu", baseUrl: "https://www.cheonyu.com",
  collectionMode: "general", maxPerPage: 150, pageSize: 150,
};
const itemHtml = (id, price, extra = "") => `<li><div>
  <input name="inPcheck" id="inPcheck" value="${id}">
  <a class="pLink" href="/product/view.html?qIDX=${id}">상품</a>
  <div class="m_pdt_list_name">가격 확인 상품 ${id}</div>
  <div class="m_pdt_list_icon"><div class="m_pdt_icon_wrap">할인 30%</div>
    <span class="sale">${price}<span class="won">원</span></span></div>
  <div class="m_pdt_list_price"><span class="sale">29,250원</span></div>
  <input name="inPcount" id="inPcount" value="1"><button id="btn_addCart"></button>
  ${extra}</div></li>`;
const listHtml = (...items) => `<div class="m_list"><ul>${items.join("")}</ul></div>`;
const parsePrice = price => parseListHtml(listHtml(itemHtml("95546", price)), 1, config);

test("목록의 상품별 m_pdt_list_icon .sale에서 소비자가를 읽는다", () => {
  const html = listHtml(itemHtml("90977", "45,000"), itemHtml("95546", "11,550", '<div class="soldout_bg"></div>'));
  for (const collectionMode of ["general", "detail"]) {
    const products = parseListHtml(html, 1, { ...config, collectionMode });
    assert.deepEqual(products.map(item => [item.productId, item.consumerPrice]), [["90977", 45000], ["95546", 11550]]);
    assert.equal(products[1].isSoldOut, true);
  }
});

test("소비자가 확인은 기존 목록 HTML을 재사용하고 상품 상세페이지를 요청하지 않는다", async () => {
  const page = new Proxy({}, { get() { throw new Error("추가 브라우저 요청이 발생했습니다."); } });
  const result = await collectListCandidates(page, 1, config, listHtml(itemHtml("90977", "45,000")));
  assert.equal(result.candidates[0].consumerPrice, 45000);
  assert.equal(result.targets[0].consumerPrice, 45000);
});

test("소비자가 누락·0·음수는 미관측으로 처리하며 다른 sale 가격을 사용하지 않는다", async () => {
  for (const price of ["", "가격 없음", "0", "-100"]) {
    const products = parsePrice(price);
    assert.equal(products[0].consumerPrice, null);
    const [backend] = await createBackendProducts({ collectionMode: "general", products });
    assert.equal(backend.originalPrice, null);
  }
  const html = listHtml(itemHtml("95546", "45,000").replace('class="m_pdt_list_icon"', 'class="missing_icon"'));
  assert.equal(parseListHtml(html, 1, config)[0].consumerPrice, null);
});

test("목록 소비자가를 originalPrice에 연결하고 기존 상세 수집값은 누락 시에만 보완한다", async () => {
  const products = parsePrice("45,000");
  const detailItems = [{ productId: "95546", sourceMall: "cheonyu", consumerPrice: 47000 }];
  const [general] = await createBackendProducts({
    collectionMode: "general", products,
    inventoryItems: [{ productId: "95546", hasOption: false, onePrice: 29250 }],
  });
  assert.equal(general.originalPrice, 45000);
  assert.equal(general.wholesalePrice, 29250);
  const [detail] = await createBackendProducts({ collectionMode: "detail", products, detailItems });
  assert.equal(detail.originalPrice, 45000);
  const [fallback] = await createBackendProducts({ collectionMode: "detail", products: parsePrice(""), detailItems });
  assert.equal(fallback.originalPrice, 47000);
});

test("95769의 낱개 도매가를 사용하고 박스 가격이나 예전 1개 적용가로 바꾸지 않는다", async () => {
  const products = parseListHtml(listHtml(itemHtml("95769", "18,500")), 1, config);
  const inventoryItems = [
    { optionId: "119570", optionText: "블루", maxStock: 528 },
    { optionId: "119571", optionText: "핑크", maxStock: 540 },
  ].map(row => ({
    ...row, productId: "95769", hasOption: true,
    onePrice: 11100, boxPrice: 10545, effectivePrice: 10545,
  }));
  for (const unitPriceAtOne of [null, 10545]) {
    const [backend] = await createBackendProducts({
      collectionMode: "general", products,
      inventoryItems: inventoryItems.map(row => ({ ...row, unitPriceAtOne })),
    });
    assert.equal(backend.originalPrice, 18500);
    assert.equal(backend.wholesalePrice, 11100);
    assert.equal(backend.stockQuantity, 1068);
    assert.equal(backend.options.length, 2);
  }
});

test("팝업의 inoPrice가 없으면 할인 가격만 있어도 낱개 도매가를 만들지 않는다", async () => {
  const products = parsePrice("18,500");
  for (const inoPrice of [undefined, null, 0, -100, "잘못된 값", 11100]) {
    const inventoryItems = createCheonyuPopupInventoryItems({
      products, directProductIds: ["95546"], config,
      popupOptionRows: [{
        productId: "95546", complete: true, maxStock: 528,
        inoPrice, indcPrice: 10545, boxCountOpt: 2,
        indcPrice2: 9990, boxCountOpt2: 10,
      }],
    });
    assert.equal(inventoryItems[0].onePrice, inoPrice === 11100 ? 11100 : 0);
    assert.equal(inventoryItems[0].boxPrice, 9990);
    assert.equal(Object.hasOwn(inventoryItems[0], "unitPriceAtOne"), false);
    const [backend] = await createBackendProducts({ collectionMode: "general", products, inventoryItems });
    assert.equal(backend.wholesalePrice, inoPrice === 11100 ? 11100 : null);
    assert.equal(backend.originalPrice, 18500);
  }
});

test("장바구니의 inOnePrice를 낱개 도매가로 사용한다", async () => {
  const products = parsePrice("18,500");
  const inventoryItems = parseCartHtml(`<table id="cartTable"><tr class="tr-nth"><td>
    <a href="/product/view.html?qIDX=95546">상품</a>
    <input id="inOnePrice" value="11100"><input id="inBoxPrice" value="10545">
  </td></tr></table>`, config);
  assert.equal(inventoryItems[0].onePrice, 11100);
  assert.equal(inventoryItems[0].boxPrice, 10545);
  const [backend] = await createBackendProducts({ collectionMode: "general", products, inventoryItems });
  assert.equal(backend.wholesalePrice, 11100);
});

test("두 원화 가격과 10엔 올림값을 일반 수집의 아카이브·result.json에 함께 갱신한다", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cheonyu-prices-"));
  const previousDirectory = process.env.PRODUCT_ARCHIVE_DIRECTORY;
  process.env.PRODUCT_ARCHIVE_DIRECTORY = directory;
  const { ARCHIVE_PATH, updateProductArchive } = require("../src/utils/product-archive");
  const resultPath = path.join(directory, "result.json");
  const conversion = { rate: "0.1", createdAt: "2026-09-29T06:00:00.000Z" };
  const image = "https://example.com/detail.png";
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify([{
    id: "95546", sourceMall: "cheonyu", originalPrice: 11550, wholesalePrice: 7520,
    yenWholesalePrice: 752, yenOriginalsalePrice: 1155, descriptionImageUrls: [image],
  }]));
  async function save(consumerPrice, wholesalePrice, snapshot = conversion) {
    const backend = await createBackendProducts({
      collectionMode: "general", products: parsePrice(consumerPrice),
      inventoryItems: [{ productId: "95546", hasOption: false, onePrice: wholesalePrice }],
    });
    const result = await updateProductArchive(backend, { source: "general", conversion: snapshot });
    writeJson(resultPath, result.currentProducts);
    const storedArchive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
    assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), storedArchive.cheonyu);
    assert.deepEqual(storedArchive.ccdome, []);
    assert.deepEqual(result.currentProducts[0].descriptionImageUrls, [image]);
    const item = result.currentProducts[0];
    return [item.originalPrice, item.wholesalePrice, item.yenOriginalsalePrice, item.yenWholesalePrice];
  }
  try {
    assert.deepEqual(await save("11,550", 7520), [11550, 7520, 1160, 760]);
    assert.deepEqual(await save("18,720", 12000), [18720, 12000, 1880, 1200]);
    // 한 가격을 관측하지 못해도 다른 가격의 갱신은 계속한다.
    assert.deepEqual(await save("", 9000), [18720, 9000, 1880, 900]);
    assert.deepEqual(await save("18,800", null), [18800, 9000, 1880, 900]);
    // 환율 실패 시 바뀐 원화값은 저장하고 해당 환산값은 비운 뒤 재조회로 복구한다.
    assert.deepEqual(await save("20,000", 9500, null), [20000, 9500, null, null]);
    assert.deepEqual(await save("20,000", 9500), [20000, 9500, 2000, 950]);
  } finally {
    if (previousDirectory === undefined) delete process.env.PRODUCT_ARCHIVE_DIRECTORY;
    else process.env.PRODUCT_ARCHIVE_DIRECTORY = previousDirectory;
    for (const file of [ARCHIVE_PATH, `${ARCHIVE_PATH}.before-mall-groups.bak`, resultPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

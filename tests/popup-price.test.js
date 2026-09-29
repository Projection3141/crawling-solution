const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { parseAndPreparePopupOptions } = require("../src/malls/cheonyu/site");
const { createCheonyuPopupInventoryItems } = require("../src/malls/cheonyu/cart-stock");
const { createBackendProducts } = require("../src/utils/backend-product");

function row(optionId, maxStock, fields = {}) {
  return `<tr id="inOptionTR"><td>
    <input type="checkbox" id="optionCHKPOP" value="${optionId}">
    ${Object.entries({
      inOPcount: 999, inOPidx: optionId, inOPMaxStock: maxStock,
      inoPrice: 11100, indcPrice: 10545, indcPrice2: 9990,
      boxCountOpt: 2, boxCountOpt2: 10, ...fields,
    }).map(([id, value]) => `<input id="${id}" value="${value}">`).join("")}
    </td><td class="option_txt">옵션 ${optionId}</td></tr>`;
}

test("팝업 표시 가격·재계산 함수에 의존하지 않고 낱개 도매가를 저장한다", async (t) => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {}),
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const products = [{ productId: "95769", productName: "머그컵", consumerPrice: 18500 }];
  const config = { mall: "cheonyu", lowStockThreshold: 10, optionCartQty: 999 };

  // 1개부터 할인이 적용되는 조건이어도 낱개 기본 가격이 기준이다.
  for (const thresholds of [{}, { boxCountOpt: 1 }, { boxCountOpt: 1, boxCountOpt2: 1 }]) {
    await page.setContent(`<div class="many_add" data-product-id="95769">
      <p class="subject">머그컵</p><table id="opSelectedList">
      ${row("119570", 528, thresholds)}${row("119571", 540, thresholds)}</table></div>`);
    await page.evaluate(() => {
      window.priceRecalculationCalls = 0;
      window.fnPcountCheckPop = () => { window.priceRecalculationCalls += 1; };
    });
    const popupOptionRows = await parseAndPreparePopupOptions(page, 1, config, products, false);
    assert.equal(popupOptionRows.length, 2);
    assert.ok(popupOptionRows.every(item => item.complete && item.productId === "95769"));
    assert.equal(await page.evaluate(() => window.priceRecalculationCalls), 0);
    assert.deepEqual(await page.locator("input#inOPcount").evaluateAll(nodes => nodes.map(node => node.value)), ["999", "999"]);
    assert.deepEqual(await page.locator("input#optionCHKPOP").evaluateAll(nodes => nodes.map(node => node.checked)), [false, false]);
    const inventoryItems = createCheonyuPopupInventoryItems({
      products, popupOptionRows, directProductIds: ["95769"], config,
    });
    assert.ok(inventoryItems.every(item => item.onePrice === 11100));
    const [backend] = await createBackendProducts({ collectionMode: "general", products, inventoryItems });
    assert.equal(backend.wholesalePrice, 11100);
    assert.equal(backend.originalPrice, 18500);
    assert.equal(backend.stockQuantity, 1068);
  }
});

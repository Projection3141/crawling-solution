process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { test, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "new-product-options-"));
process.env.PRODUCT_ARCHIVE_DIRECTORY = path.join(root, "archive");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { ARCHIVE_PATH, readProductArchive } = require("../src/utils/product-archive");
const { readDetailCollectionState } = require("../src/utils/detail-collection-state");
fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
fs.writeFileSync(ARCHIVE_PATH, JSON.stringify({ cheonyu: [{ id: "97001", nameKo: "기존 상품" }], ccdome: [] }));
mock.method(require("../translate/convert"), "createConversionSnapshot", async () => null);
const { resolveRunConfig } = require("../src/config");
const { runCollection } = require("../src/crawler");
const { getRecentMonths } = require("../src/malls/cheonyu/lifecycle-collection");

const existingId = "97001";
const singleId = "97002";
const optionId = "97003";
const reviewOptionId = "97004";
const laterOptionId = "97005";
const samePageOptionId = "97006";
const ambiguousOptionId = "97007";
const allExcludedOptionId = "97008";
const unmatchedName = "현장에서 변경한 옵션명";
const detailOptionName = "3 실버하트";
const popupOptionName = `${detailOptionName} (3개)`;
const cartBarcode = "0012345678901";
const starName = "5. 실버스타";
const starBarcode = "0012345678902";
const representativeBarcode = "8800000012345";
const home = '<a href="/product/news.html"><img alt="신상품 더보기"></a>';
const logout = '<a href="/member/logout.html">로그아웃</a>';

function config(account = {}) {
  return resolveRunConfig({
    mall: "cheonyu", collectionKind: "newProducts", showBrowser: false,
    cheonyuProxyServer: "http://gw.dataimpulse.com:823",
    cheonyuProxyUsername: "fixture-user", cheonyuProxyPassword: "fixture-proxy-password",
    pageSize: 3, requestDelayMs: 0, detailRequestDelayMs: 0,
    navigationTimeoutMs: 3000, outDir: root, ...account,
  }, {}, root);
}

function listProduct(id) {
  return `<li><div>
    <a class="pLink" href="/product/view.html?qIDX=${id}">상품</a>
    <div class="m_pdt_list_name">상품 ${id}</div>
    ${id === singleId ? "" : '<div class="m_pdt_list_icon"><img src="/image_1/btn_option.gif"></div>'}
    <input name="inPcheck" id="inPcheck" type="checkbox" value="${id}">
    <input name="inPcount" id="inPcount" value="1"><button id="btn_addCart">담기</button>
  </div></li>`;
}

function detail(id) {
  const starDetailName = [ambiguousOptionId, allExcludedOptionId].includes(id) ? detailOptionName : starName;
  const options = id !== singleId ? `<div class="option_wrap"><table id="opSelectedList"><tbody>
    <tr><td><input type="checkbox" id="optionCHK" value="11" disabled></td><td class="option_txt">${detailOptionName} (현 재고 3개)</td></tr>
    <tr><td><input type="checkbox" id="optionCHK" value="12" disabled></td><td class="option_txt">빨강</td></tr>
    <tr><td><input type="checkbox" id="optionCHK" value="13" disabled></td><td class="option_txt">${starDetailName} (현 재고 5개)</td></tr>
    </tbody></table></div>` : "";
  return `<div id="productView"><div class="info_wrap"><div class="pdt_name"><span>상품 ${id}</span></div></div>
    <div class="pdt-top-info"><span class="info-number">${id}</span><span class="info-number">${representativeBarcode}</span></div>
    <div class="pdt_code"><div class="pdt_code_last"><strong>12,000</strong></div></div>
    ${options}<div id="tab_01"><img src="https://image1.cheonyu.com/image/product/detail.jpg"></div></div>`;
}

function popupRow(id, name, quantity) {
  return `<tr id="inOptionTR"><td class="option_txt">${name}</td><td>
    <input type="checkbox" id="optionCHKPOP" value="${id}" ${quantity ? "" : "disabled"}>
    <input id="inOPcount" value="1"><input id="inOPMaxStock" value="${quantity}">
    <input id="inOPidx" value="${id}"><input id="inOPaddPrice" value="600"><input id="inoPrice" value="4300">
  </td></tr>`;
}

function cartGroupId(id) {
  return id === optionId ? "fixture-group" : `fixture-group-${id}`;
}

function newsPage(loggedIn, prematureSubmit, { products, pagination }) {
  const list = `<div id="sub_list"><ul>${products.map(listProduct).join("")}</ul></div>${pagination}`;
  if (!loggedIn) return list;
  const discardOnly = products.includes(allExcludedOptionId);
  const popups = Object.fromEntries(products.filter(id => id !== singleId && id !== existingId).map(id => [id,
    `<div class="many_add" data-product-id="${id}">
      <div class="subject"><p>상품 ${id}</p></div><table id="opSelectedList"><tbody>
        <tr><td><input type="hidden" id="inIDXPOP" value="${cartGroupId(id)}"></td></tr>
        ${popupRow("11", popupOptionName, 3)}${popupRow("12", "빨강", 0)}${popupRow("13", `${starName} (5개)`, 5)}
      </tbody></table></div>`,
  ]));
  return logout + list + `<button class="all_add_btn" onclick="showPopup()">옵션 확인</button>
    <div id="popups"></div><script>
      const popups = ${JSON.stringify(popups)};
      const checkedProducts = () => [...document.querySelectorAll('input[name=inPcheck]:checked')].map(input => input.value);
      const post = form => fetch('/order/ajaxCartAddCheck.php', { method: 'POST', body: new URLSearchParams(form) });
      const submit = addStr => post({ stepCode: '6', cartCode: '', addStr });
      window.showPopup = async () => {
        const products = checkedProducts();
        if (${prematureSubmit}) {
          await submit('fixture-group@@11,1').catch(() => null);
        } else {
          await post({ inIDX: products.join(','), inCount: products.map(() => '1').join(',') });
        }
        document.querySelector('#popups').innerHTML = products.map(id => popups[id]).join('');
      };
      const hidePopup = () => { document.querySelector('#popups').innerHTML = ''; };
      window.closeCartIn = () => {
        if (${discardOnly} && document.querySelector('.many_add') && !confirm('선택한 옵션을 취소할까요?')) return;
        hidePopup();
      };
      if (${discardOnly}) window.disablePopup = hidePopup;
      window.setOption = async () => {
        const groups = [...document.querySelectorAll('.many_add')].map(popup => {
          const selected = [...popup.querySelectorAll('tr[id=inOptionTR]')].filter(row =>
            row.querySelector('input[id=optionCHKPOP]').checked);
          const data = selected.map(row => [row.querySelector('input[id=inOPidx]').value, row.querySelector('input[id=inOPcount]').value].join(','));
          return popup.querySelector('input[id=inIDXPOP]').value + '@@' + data.join('|');
        });
        await submit(groups.join('##'));
        window.closeCartIn();
      };
    </script>`;
}

function cartRow({ id, cartId, name = "", barcode, quantity, maxStock }) {
  return `<tr class="tr-nth"><td>
    <input name="cartCheck" id="cartCheck" value="${cartId}">
    <input name="inPIDX" id="inPIDX" value="${cartId}">
    <div class="product_dsc"><a class="c" href="/product/view.html?qIDX=${id}">상품 ${id}</a></div>
    <span class="dtfont-pd">상품번호 [ ${id} ] ${barcode}</span>
    <ul class="option_list">${name ? `<li>${name}</li>` : ""}</ul>
    <input name="num01" id="inPcount" value="${quantity}">
    <input name="inMaxStock" id="inMaxStock" value="${maxStock}">
    <input id="inOnePrice" value="4300">
  </td></tr>`;
}

function cartStockAdjustment(cart) {
  const affectedIds = Array.from(cart.keys()).filter(id => !id.endsWith("-star"));
  const rows = affectedIds.map(id => `<tr id="cartListOver"><td>
    <input id="inPIDXOver" value="${id}"><input id="inMaxStockOver" value="0">
    <input id="inPcountOver" value="${cart.get(id).quantity}">
  </td></tr>`).join("");
  const popup = `<div class="cart_err_pop">주문 수량이 현재 재고보다 초과되었습니다.
    <table class="poptb">${rows}</table></div>`;
  return `<div id="popContent"></div><script>
    window.GetInfoComplete = 1;
    window.isOver = 1;
    setTimeout(() => document.querySelector('#popContent').innerHTML = ${JSON.stringify(popup)}, 1750);
  </script>`;
}

function fixture({ prematureSubmit = false, reviewMismatch = false } = {}) {
  const [currentMonth] = getRecentMonths();
  const pagination = `<div class="pagination"><a href="?cateIDX=ALL&amp;searchDate=${currentMonth}&amp;page=3">3</a></div>`;
  const pages = reviewMismatch ? new Map([
    ["1", { products: [reviewOptionId, samePageOptionId, ambiguousOptionId], pagination }],
    ["2", { products: [laterOptionId], pagination: "" }],
    ["3", { products: [allExcludedOptionId], pagination: "" }],
  ]) : new Map([
    ["1", { products: [existingId, singleId, optionId], pagination: "" }],
  ]);
  const contexts = [], requests = [], submits = [], deletes = [], unexpected = [], dialogs = [];
  const cart = new Map([["cart-existing", {
    id: "97999", cartId: "cart-existing", barcode: "8800000097999", quantity: 3, maxStock: 40,
  }]]);
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return { close: () => browser.close(), async newContext(options) {
      const index = contexts.push(options) - 1;
      const context = await browser.newContext({ ...options, proxy: undefined });
      context.on("dialog", dialog => { dialogs.push(dialog.message()); });
      let loggedIn = false;
      let selectedProducts = [];
      context.request.get = async url => {
        assert.equal(index, 1);
        assert.equal(url, "https://api.ipify.org?format=json");
        return { ok: () => true, json: async () => ({ ip: "192.0.2.1" }), dispose: async () => {} };
      };
      context.request.post = async (url, { form }) => {
        assert.equal(index, 1);
        assert.equal(loggedIn, true);
        assert.equal(new URL(url).pathname, "/order/ajaxCart.php");
        assert.equal(form.mode, "delete");
        for (const id of form.qIDX.split(",")) {
          deletes.push(id);
          cart.delete(id);
        }
        return { ok: () => true, status: () => 200, text: async () => "ok" };
      };
      await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        requests.push({ index, pathname: url.pathname, id: url.searchParams.get("qIDX"), loggedIn });
        let body;
        if (/\.(png|jpg|gif)$/.test(url.pathname)) return route.fulfill({ body: "", contentType: "image/jpeg" });
        if (url.pathname === "/") body = loggedIn ? logout + home : home;
        else if (url.pathname === "/product/news.html") {
          assert.equal(url.searchParams.get("cateIDX"), "ALL");
          body = url.searchParams.get("searchDate") === currentMonth
            ? newsPage(loggedIn, prematureSubmit, pages.get(url.searchParams.get("page")))
            : '<div id="sub_list">등록된 상품이 없습니다.</div>';
        } else if (url.pathname === "/product/view.html") {
          assert.equal(index, 0);
          assert.equal(loggedIn, false);
          body = detail(url.searchParams.get("qIDX"));
        } else if (url.pathname === "/member/login.html") {
          assert.equal(index, 1);
          body = '<form method="post" action="/member/loginResult.html"><input name="inMID"><input name="inMPW" type="password"><button type="submit">로그인</button></form>';
        } else if (url.pathname === "/member/loginResult.html") {
          assert.equal(index, 1);
          assert.equal(request.method(), "POST");
          assert.equal(new URLSearchParams(request.postData()).get("inMID"), "fixture-member");
          loggedIn = true;
          body = logout;
        } else if (url.pathname === "/order/cart.html") {
          assert.equal(index, 1);
          assert.equal(loggedIn, true);
          body = logout + `<table id="cartTable">${Array.from(cart.values(), cartRow).join("")}</table>` + cartStockAdjustment(cart);
        } else if (url.pathname === "/order/ajaxCartAddCheck.php") {
          assert.equal(index, 1);
          assert.equal(loggedIn, true);
          assert.equal(request.method(), "POST");
          const form = Object.fromEntries(new URLSearchParams(request.postData()));
          if (form.stepCode === "6") {
            const addStr = selectedProducts.map(id => `${cartGroupId(id)}@@${id === ambiguousOptionId ? "" : "11,1|13,1"}`).join("##");
            assert.deepEqual(form, { stepCode: "6", cartCode: "", addStr });
            submits.push({ products: selectedProducts, optionData: form.addStr });
            for (const id of selectedProducts.filter(id => id !== ambiguousOptionId)) {
              const cartId = id === optionId ? "cart-added" : `cart-${id}`;
              cart.set(cartId, { id, cartId, name: detailOptionName,
                barcode: cartBarcode, quantity: 1, maxStock: 3 });
              const starId = `${cartId}-star`;
              cart.set(starId, { id, cartId: starId, name: id === reviewOptionId ? unmatchedName : starName,
                barcode: starBarcode, quantity: 1, maxStock: 2 });
            }
          } else {
            selectedProducts = form.inIDX.split(",");
            assert.ok(selectedProducts.every(id => [optionId, reviewOptionId, samePageOptionId, laterOptionId,
              ambiguousOptionId, allExcludedOptionId].includes(id)));
            assert.equal(form.inCount, selectedProducts.map(() => "1").join(","));
          }
          body = "ok";
        } else {
          unexpected.push(url.pathname);
          return route.fulfill({ status: 404, body: "Unexpected request" });
        }
        return route.fulfill({ body, contentType: "text/html; charset=utf-8" });
      });
      return context;
    } };
  } };
  return { browserType, contexts, requests, submits, deletes, cart, unexpected, dialogs };
}

function assertOptionProduct(product, productId = optionId) {
  assert.equal(product.id, productId);
  assert.equal(product.type, "OPTION");
  assert.equal(product.barcode, representativeBarcode);
  assert.equal(product.originalPrice, 12000);
  assert.equal(product.wholesalePrice, null);
  assert.deepEqual(product.options.map(({ id, nameKo, barcode, stockQuantity, status }) =>
    ({ id, nameKo, barcode, stockQuantity, status })), [
    { id: "11", nameKo: popupOptionName, barcode: cartBarcode, stockQuantity: 0, status: "SOLD_OUT" },
    { id: "12", nameKo: "빨강", barcode: null, stockQuantity: 0, status: "SOLD_OUT" },
    { id: "13", nameKo: `${starName} (5개)`, barcode: starBarcode, stockQuantity: 2, status: "ON_SALE" },
  ]);
}

test("new options match all three labels and save the latest cart stock when a shortage popup opens", async () => {
  const guest = fixture();
  const pending = await runCollection(config(), { runId: "option-pending", browserType: guest.browserType });
  assert.deepEqual(pending.payload.products.map(product => product.id), [singleId]);
  assert.equal(pending.payload.summary.optionPendingCount, 1);
  assert.equal(guest.contexts.length, 1);
  assert.deepEqual(guest.unexpected, []);
  assert.ok(!guest.requests.some(request => /member|order/.test(request.pathname)));
  const pendingArchive = await readProductArchive();
  assert.ok(!pendingArchive.products[`cheonyu:${optionId}`]);
  const pendingState = await readDetailCollectionState();
  assert.equal(pendingState.products[`cheonyu:${optionId}`].detailStatus, "failed");

  const memberConfig = config({ accountId: "fixture-member", accountPw: "fixture-password" });
  const premature = fixture({ prematureSubmit: true });
  await assert.rejects(runCollection(memberConfig, {
    runId: "option-premature-submit", browserType: premature.browserType,
  }), /확인하지 않은 장바구니 담기 요청을 차단했습니다/);
  assert.deepEqual(premature.submits, []);
  assert.deepEqual(premature.deletes, []);
  assert.deepEqual(Array.from(premature.cart.keys()), ["cart-existing"]);
  assert.ok(!(await readProductArchive()).products[`cheonyu:${optionId}`]);

  const authenticated = fixture();
  let checkpointResult;
  const result = await runCollection(memberConfig, {
    runId: "option-enriched", browserType: authenticated.browserType,
    onProgress(progress) {
      if (progress.stage === "detail-page-saved" && progress.savedCheckpoint.savedThroughPage === 1) {
        checkpointResult = JSON.parse(fs.readFileSync(progress.savedCheckpoint.files.detailResult, "utf8"));
      }
    },
  });
  assert.equal(authenticated.contexts.length, 2);
  const [guestContext, cartContext] = authenticated.contexts;
  assert.equal(new URL(guestContext.proxy.server).port, "823");
  assert.match(new URL(cartContext.proxy.server).port, /^1\d{4}$|^20000$/);
  assert.match(cartContext.proxy.username, /sessttl\.60/);
  assert.deepEqual(authenticated.unexpected, []);
  assert.deepEqual(authenticated.requests.filter(request => request.pathname === "/product/view.html")
    .map(({ id, index, loggedIn }) => ({ id, index, loggedIn })), [{ id: optionId, index: 0, loggedIn: false }]);
  assert.equal(authenticated.requests.filter(request => request.pathname === "/member/loginResult.html").length, 1);
  assert.ok(authenticated.requests.filter(request => request.index === 0)
    .every(request => !request.loggedIn && !/member|order/.test(request.pathname)));
  assert.deepEqual(authenticated.submits, [{ products: [optionId], optionData: "fixture-group@@11,1|13,1" }]);
  assert.deepEqual(authenticated.deletes, ["cart-added", "cart-added-star"]);
  assert.deepEqual(Array.from(authenticated.cart.keys()), ["cart-existing"]);
  assert.equal(authenticated.cart.get("cart-existing").quantity, 3);

  assert.equal(result.payload.summary.optionPendingCount, 0);
  assert.equal(result.payload.summary.optionBarcodeCount, 2);
  assertOptionProduct(result.payload.products[0]);
  assertOptionProduct(checkpointResult[0]);
  const archived = (await readProductArchive()).products[`cheonyu:${optionId}`];
  assertOptionProduct({ ...archived, options: Object.values(archived.options) });
  const checkpointRows = JSON.parse(fs.readFileSync(
    path.join(root, "cheonyu", "option-enriched", "detail-pages", "page-000001.json"), "utf8",
  )).inventoryItems;
  assert.equal(checkpointRows.find(row => row.optionId === "11").barcode, cartBarcode);
  assert.ok(checkpointRows.every(row => !Object.hasOwn(row, "onePrice") && !Object.hasOwn(row, "addPrice")));
  assert.match(fs.readFileSync(result.files.inventory, "utf8"), new RegExp(cartBarcode));
});

test("defer ambiguous and mismatched option labels and finish collecting the rest of the batch and the next page", async () => {
  const scenario = fixture({ reviewMismatch: true });
  const result = await runCollection(config({ accountId: "fixture-member", accountPw: "fixture-password" }), {
    runId: "option-review", browserType: scenario.browserType,
  });
  assert.deepEqual(scenario.unexpected, []);
  assert.deepEqual(scenario.dialogs, []);
  assert.deepEqual(scenario.submits.map(({ products }) => products), [[reviewOptionId, samePageOptionId, ambiguousOptionId], [laterOptionId]]);
  assert.ok(scenario.submits[0].optionData.split("##").includes(`${cartGroupId(ambiguousOptionId)}@@`));
  assert.deepEqual(scenario.deletes, [`cart-${samePageOptionId}`, `cart-${samePageOptionId}-star`,
    `cart-${laterOptionId}`, `cart-${laterOptionId}-star`]);
  assert.deepEqual(Array.from(scenario.cart.keys()), ["cart-existing", `cart-${reviewOptionId}`, `cart-${reviewOptionId}-star`]);
  assert.equal(scenario.cart.get("cart-existing").quantity, 3);
  assert.equal(scenario.cart.get(`cart-${reviewOptionId}`).quantity, 1);
  assert.equal(scenario.cart.get(`cart-${reviewOptionId}-star`).quantity, 1);

  const { products, summary } = result.payload;
  assert.deepEqual(products.map(product => product.id), [samePageOptionId, laterOptionId]);
  assertOptionProduct(products[0], samePageOptionId);
  assertOptionProduct(products[1], laterOptionId);
  assert.equal(summary.optionPendingCount, 3);
  assert.equal(summary.optionReviewCount, 3);
  const reviewById = new Map(summary.optionReviewItems.map(item => [item.productId, item]));
  const cartReview = reviewById.get(reviewOptionId);
  assert.equal(cartReview.sourcePage, 1);
  assert.equal(cartReview.cartRowsRemain, true);
  const mismatch = cartReview.reasons.find(reason => reason.code === "CART_OPTION_LABEL_MISMATCH");
  assert.equal(mismatch.cartOption, unmatchedName);
  assert.equal(mismatch.cartBarcode, starBarcode);
  const ambiguous = reviewById.get(ambiguousOptionId);
  assert.equal(ambiguous.sourcePage, 1);
  assert.equal(ambiguous.cartRowsRemain, false);
  assert.ok(ambiguous.reasons.some(reason => reason.code === "AMBIGUOUS_OPTION_LABEL" && reason.optionId === "13"));
  const allExcluded = reviewById.get(allExcludedOptionId);
  assert.equal(allExcluded.sourcePage, 3);
  assert.equal(allExcluded.cartRowsRemain, false);
  assert.ok(allExcluded.reasons.some(reason => reason.code === "AMBIGUOUS_OPTION_LABEL"));
  assert.equal(path.basename(result.files.optionReview), "option-review.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(result.files.optionReview, "utf8")), summary.optionReviewItems);

  const archive = await readProductArchive();
  assert.ok(!archive.products[`cheonyu:${reviewOptionId}`]);
  assert.ok(!archive.products[`cheonyu:${ambiguousOptionId}`]);
  assert.ok(!archive.products[`cheonyu:${allExcludedOptionId}`]);
  for (const id of [samePageOptionId, laterOptionId]) {
    const archived = archive.products[`cheonyu:${id}`];
    assertOptionProduct({ ...archived, options: Object.values(archived.options) }, id);
  }
});

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
const cartBarcode = "0012345678901";
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
  const options = id === optionId ? `<div class="option_wrap"><table id="opSelectedList"><tbody>
    <tr><td><input type="checkbox" id="optionCHK" value="11" disabled></td><td class="option_txt">파랑</td></tr>
    <tr><td><input type="checkbox" id="optionCHK" value="12" disabled></td><td class="option_txt">빨강</td></tr>
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

function newsPage(loggedIn, prematureSubmit) {
  const list = `<div id="sub_list"><ul>${[existingId, singleId, optionId].map(listProduct).join("")}</ul></div>`;
  if (!loggedIn) return list;
  const popup = `<div class="many_add" data-product-id="${optionId}">
    <div class="subject"><p>상품 ${optionId}</p></div><table id="opSelectedList"><tbody>
      <tr><td><input type="hidden" id="inIDXPOP" value="fixture-group"></td></tr>
      ${popupRow("11", "파랑", 7)}${popupRow("12", "빨강", 0)}
    </tbody></table></div>`;
  return logout + list + `<button class="all_add_btn" onclick="showPopup()">옵션 확인</button>
    <div id="popups"></div><script>
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
        document.querySelector('#popups').innerHTML = ${JSON.stringify(popup)};
      };
      window.closeCartIn = () => { document.querySelector('#popups').innerHTML = ''; };
      window.setOption = async () => {
        const selected = [...document.querySelectorAll('tr[id=inOptionTR]')].filter(row =>
          row.querySelector('input[id=optionCHKPOP]').checked);
        const data = selected.map(row => [row.querySelector('input[id=inOPidx]').value, row.querySelector('input[id=inOPcount]').value].join(','));
        await submit(document.querySelector('input[id=inIDXPOP]').value + '@@' + data.join('|'));
        window.closeCartIn();
      };
    </script>`;
}

function cartRow({ id, cartId, name = "", barcode, quantity, maxStock }) {
  return `<tr class="tr-nth"><td>
    <input name="cartCheck" id="cartCheck" value="${cartId}">
    <input name="inPIDX" id="inPIDX" value="${id}">
    <div class="product_dsc"><a class="c" href="/product/view.html?qIDX=${id}">상품 ${id}</a></div>
    <span class="dtfont-pd">상품번호 [ ${id} ] ${barcode}</span>
    <ul class="option_list">${name ? `<li>${name}</li>` : ""}</ul>
    <input name="num01" id="inPcount" value="${quantity}">
    <input name="inMaxStock" id="inMaxStock" value="${maxStock}">
    <input id="inOnePrice" value="4300">
  </td></tr>`;
}

function fixture({ prematureSubmit = false } = {}) {
  const [currentMonth] = getRecentMonths();
  const contexts = [], requests = [], submits = [], deletes = [], unexpected = [];
  const cart = new Map([["cart-existing", {
    id: "97999", cartId: "cart-existing", barcode: "8800000097999", quantity: 3, maxStock: 40,
  }]]);
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return { close: () => browser.close(), async newContext(options) {
      const index = contexts.push(options) - 1;
      const context = await browser.newContext({ ...options, proxy: undefined });
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
        assert.deepEqual(form, { mode: "delete", qIDX: "cart-added" });
        deletes.push(form.qIDX);
        cart.delete(form.qIDX);
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
          body = url.searchParams.get("searchDate") === currentMonth ? newsPage(loggedIn, prematureSubmit)
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
          body = logout + `<table id="cartTable">${Array.from(cart.values(), cartRow).join("")}</table>`;
        } else if (url.pathname === "/order/ajaxCartAddCheck.php") {
          assert.equal(index, 1);
          assert.equal(loggedIn, true);
          assert.equal(request.method(), "POST");
          const form = Object.fromEntries(new URLSearchParams(request.postData()));
          if (form.stepCode === "6") {
            assert.deepEqual(form, { stepCode: "6", cartCode: "", addStr: "fixture-group@@11,1" });
            submits.push({ products: selectedProducts, optionData: form.addStr });
            cart.set("cart-added", { id: optionId, cartId: "cart-added", name: "파랑",
              barcode: cartBarcode, quantity: 1, maxStock: 7 });
          } else {
            assert.deepEqual(form, { inIDX: optionId, inCount: "1" });
            selectedProducts = form.inIDX.split(",");
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
  return { browserType, contexts, requests, submits, deletes, cart, unexpected };
}

function assertOptionProduct(product) {
  assert.equal(product.id, optionId);
  assert.equal(product.type, "OPTION");
  assert.equal(product.barcode, representativeBarcode);
  assert.equal(product.originalPrice, 12000);
  assert.equal(product.wholesalePrice, null);
  assert.deepEqual(product.options.map(({ id, nameKo, barcode, stockQuantity, status }) =>
    ({ id, nameKo, barcode, stockQuantity, status })), [
    { id: "11", nameKo: "파랑", barcode: cartBarcode, stockQuantity: 7, status: "ON_SALE" },
    { id: "12", nameKo: "빨강", barcode: null, stockQuantity: 0, status: "SOLD_OUT" },
  ]);
}

test("new options wait for a cart account, then a separate sticky session saves verified option rows", async () => {
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
  assert.deepEqual(authenticated.submits, [{ products: [optionId], optionData: "fixture-group@@11,1" }]);
  assert.deepEqual(authenticated.deletes, ["cart-added"]);
  assert.deepEqual(Array.from(authenticated.cart.keys()), ["cart-existing"]);

  assert.equal(result.payload.summary.optionPendingCount, 0);
  assert.equal(result.payload.summary.optionBarcodeCount, 1);
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

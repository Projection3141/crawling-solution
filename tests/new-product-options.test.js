const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const filename = path.resolve(__dirname, "../src/malls/cheonyu/new-product-options.js");
const source = fs.readFileSync(filename, "utf8");
const localRequire = createRequire(filename);
const baselineRow = { cartCheckId: "existing", productId: "55", requestedQty: 3, optionText: "기존" };
const config = { mall: "cheonyu", category: "ALL", collectionMode: "detail", baseUrl: "https://fixture.invalid" };
const listUrl = "https://fixture.invalid/product/news.html?page=2";
const endpoint = "https://fixture.invalid/order/ajaxCartAddCheck.php";
const options = [
  { productId: "66", optionId: "101", optionText: "A / B", cartGroupId: "group66", submitOptionId: "101", hasOption: true, complete: true,
    maxStock: 5, selectedForCart: true, requestedQty: 1 },
  { productId: "66", optionId: "102", optionText: "품절", hasOption: true, complete: true,
    maxStock: 0, selectedForCart: false, stockStatus: "OUT_OF_STOCK", requestedQty: 0 },
];
const products = [
  { productId: "66", detailOptions: JSON.stringify(options.map(row => ({
    optionId: row.optionId, optionName: row.optionText,
  }))) },
  { productId: "77", detailOptions: "[]" },
];

function fixture({ rows = [baselineRow], onSubmit, popupRows = options, barcode = "8801234567890", targets = products,
  preflight, quantity = 1 } = {}) {
  let cart = rows.map(row => ({ ...row }));
  let submissions = 0;
  const deletes = [];
  let activeGuard;
  const page = {
    async route(matcher, guard) {
      assert.equal(matcher(new URL(endpoint)), true);
      activeGuard = guard;
    },
    async unroute() { activeGuard = undefined; },
  };
  async function post(body) {
    let dispatched = false;
    await activeGuard({
      request: () => ({ method: () => "POST", url: () => endpoint, postData: () => body }),
      fallback: async () => { dispatched = true; },
      abort: async () => {},
    });
    return dispatched;
  }
  const site = {
    parseLoginState: () => ({ loggedIn: true }),
    async addProductsFromListPagesToCart(_page, requested, settings) {
      assert.deepEqual(Array.from(requested, product => product.productId), ["66"]);
      assert.equal(requested[0].page, 2);
      assert.equal(settings.listUrl, listUrl);
      assert.equal(settings.optionCartQty, 1);
      assert.equal(settings.anonymousCollection, false);
      assert.equal(await post("inIDX=66&inCount=1"), true);
      if (preflight) {
        assert.equal(await post(preflight), false);
        throw new Error("request aborted");
      }
      await settings.onCartSubmission(["66"], popupRows.filter(row => row.selectedForCart), popupRows);
      if (!await post(`stepCode=6&cartCode=&addStr=group66@@101,${quantity}`)) throw new Error("request aborted");
      submissions++;
      cart.push({ cartCheckId: `added-${submissions}`, productId: "66",
        requestedQty: 1, optionText: "A/B", barcode });
      await onSubmit?.(submissions);
      return { pageResults: [{ bulkResult: { excludedProductIds: [], popupOptionRows: popupRows } }] };
    },
  };
  const cartUtils = {
    readCartHtml: async () => JSON.stringify(cart),
    parseCartHtml: html => JSON.parse(html),
    async clearCartByCartIds(_context, ids) {
      deletes.push(...ids);
      cart = cart.filter(row => !ids.includes(row.cartCheckId));
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => ({
    "./site": site, "./cart": cartUtils,
  }[name] || localRequire(name)), AbortController, AbortSignal, URL, URLSearchParams }, { filename });
  const operation = module.exports.createNewProductOptionProbe(config, { listUrl, sourcePage: 2, products: targets });
  const read = connection => operation({ ...connection, page });
  read.hasPendingCart = operation.hasPendingCart;
  return { read, deletes, get submissions() { return submissions; }, get cart() { return cart; } };
}

test("collects the verified option barcode and preserves unrelated existing cart rows", async () => {
  const f = fixture();
  const result = await f.read({});
  assert.deepEqual(Array.from(result.inventoryItems, row => [row.optionId, row.barcode, row.maxStock]), [
    ["101", "8801234567890", 5],
    ["102", null, 0],
  ]);
  assert.deepEqual(f.deletes, ["added-1"]);
  assert.deepEqual(f.cart, [baselineRow]);
  assert.equal(f.read.hasPendingCart(), false);
});

test("does not add a product already present in the account's cart", async () => {
  const existing = { ...baselineRow, productId: "66" };
  const f = fixture({ rows: [existing] });
  await assert.rejects(f.read({}), /이미 장바구니/);
  assert.equal(f.submissions, 0);
  assert.deepEqual(f.cart, [existing]);
  assert.deepEqual(f.deletes, []);
});

test("a lost tunnel preserves ownership for same-account cleanup before another page attempt", async () => {
  const f = fixture({ onSubmit(attempt) {
    if (attempt === 1) throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED");
  } });
  await assert.rejects(f.read({}), /ERR_TUNNEL_CONNECTION_FAILED/);
  assert.equal(f.read.hasPendingCart(), true);
  assert.deepEqual(f.deletes, []);
  await f.read({});
  assert.equal(f.read.hasPendingCart(), false);
  assert.deepEqual(f.deletes, ["added-1", "added-2"]);
  assert.deepEqual(f.cart, [baselineRow]);
});

test("authentication denial does not trigger additional cart requests", async () => {
  const f = fixture({ onSubmit() { throw Object.assign(new Error("HTTP 407"), { statusCode: 407 }); } });
  await assert.rejects(f.read({}), { statusCode: 407 });
  assert.equal(f.read.hasPendingCart(), true);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.submissions, 1);
});

test("an ambiguous option label aborts before any cart write", async () => {
  const f = fixture({ popupRows: [options[0], { ...options[0], optionId: "102", submitOptionId: "102", optionText: "A/B" }] });
  await assert.rejects(f.read({}), /고유하게 대조/);
  assert.equal(f.submissions, 0);
  assert.equal(f.read.hasPendingCart(), false);
});

test("a missing barcode fails the collection after removing only the owned row", async () => {
  const f = fixture({ barcode: null });
  await assert.rejects(f.read({}), /바코드를 확인하지 못했습니다/);
  assert.deepEqual(f.deletes, ["added-1"]);
  assert.deepEqual(f.cart, [baselineRow]);
  assert.equal(f.read.hasPendingCart(), false);
});

test("an option badge can be confirmed using the authenticated popup when public IDs are hidden", async () => {
  const f = fixture({ targets: [{ productId: "66", hasOptionHint: true, detailOptions: "[]" }] });
  const result = await f.read({});
  assert.equal(result.inventoryItems.find(row => row.optionId === "101").barcode, "8801234567890");
  assert.deepEqual(f.cart, [baselineRow]);
});

test("the initial bulk click cannot bypass the popup and write a cart row", async () => {
  const f = fixture({ preflight: "stepCode=6&cartCode=unknown" });
  await assert.rejects(f.read({}), /확인하지 않은 장바구니 담기 요청/);
  assert.equal(f.submissions, 0);
  assert.equal(f.read.hasPendingCart(), false);
  assert.deepEqual(f.cart, [baselineRow]);
});

test("the authenticated option write must match the journaled option and quantity", async () => {
  const f = fixture({ quantity: 2 });
  await assert.rejects(f.read({}), /확인하지 않은 장바구니 담기 요청/);
  assert.equal(f.submissions, 0);
  assert.equal(f.read.hasPendingCart(), false);
  assert.deepEqual(f.cart, [baselineRow]);
});

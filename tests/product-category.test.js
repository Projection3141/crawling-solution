const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProduct, normalizeProductCategory, normalizeCategoryId } = require("../src/utils/product-schema");
const { createBackendProducts } = require("../src/utils/backend-product");

const emptyCategory = { depth1: null, depth2: null, depth3: null, depth4: null, depth5: null };

test("카테고리는 다섯 키의 문자열 또는 null이며 이름 속 슬래시는 보존한다", () => {
  assert.deepEqual(createProduct("1").category, emptyCategory);
  const first = createProduct("1");
  first.category.depth1 = "변경";
  assert.deepEqual(createProduct("2").category, emptyCategory);
  assert.deepEqual(normalizeProductCategory({
    depth1: "  패션잡화  ", depth2: "여름 / 겨울 /시즌 상품", depth3: "마스크 / 장갑 / 안대",
    depth4: "\n ", depth5: null, depth6: "범위 밖",
  }), {
    depth1: "패션잡화", depth2: "여름 / 겨울 /시즌 상품", depth3: "마스크 / 장갑 / 안대",
    depth4: null, depth5: null,
  });
  assert.deepEqual(normalizeProductCategory({ depth1: 0, depth2: false, depth3: {}, depth4: [] }), emptyCategory);
});

test("상세 경로는 category에 유지하고 categoryId에는 확인한 코드를 문자열로 전달한다", async () => {
  const detail = { productId: "79136", sourceMall: "cheonyu", productName: "테스트 상품",
    categoryId: "152",
    categoryDepth1: "패션잡화", categoryDepth2: "여름 / 겨울 /시즌 상품",
    categoryDepth3: "마스크 / 장갑 / 안대" };
  const [three] = await createBackendProducts({ collectionMode: "detail", detailItems: [detail] });
  assert.deepEqual(three.category, { ...emptyCategory,
    depth1: detail.categoryDepth1, depth2: detail.categoryDepth2, depth3: detail.categoryDepth3 });
  assert.equal(three.categoryId, "152");
  const [five] = await createBackendProducts({ collectionMode: "detail", detailItems: [{
    ...detail, categoryDepth4: "방한", categoryDepth5: "성인용",
  }] });
  assert.equal(five.category.depth4, "방한");
  assert.equal(five.category.depth5, "성인용");
  assert.equal(five.categoryId, "152");
});

test("일반 수집의 카테고리 추정값이나 숫자 코드를 실제 계층으로 만들지 않는다", async () => {
  const product = { productId: "79136", sourceMall: "cheonyu", categoryHint: "문구", categoryCode: "42" };
  const [general] = await createBackendProducts({ products: [product] });
  const [detail] = await createBackendProducts({ collectionMode: "detail", products: [product], detailItems: [product] });
  assert.deepEqual(general.category, emptyCategory);
  assert.deepEqual(detail.category, emptyCategory);
  assert.equal(general.categoryId, null);
  assert.equal(detail.categoryId, null);
});

test("categoryId는 문자열로 통일하고 앞자리 0과 긴 코드를 보존한다", () => {
  assert.equal(createProduct("1").categoryId, null);
  for (const value of [152, "152", " 152 "]) {
    assert.equal(normalizeCategoryId(value), "152");
  }
  for (const value of ["0152", "021001", "9007199254740993"]) {
    assert.equal(normalizeCategoryId(value), value);
  }
  for (const value of [null, undefined, "", "캐릭터 파우치", 0, "000", -1, 1.5, "1.5", "1e2", true, {},
    Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeCategoryId(value), null);
  }
});

test("모든 쇼핑몰의 상세 카테고리 코드는 문자열로 전송하고 과자생각의 앞자리 0을 보존한다", async () => {
  for (const [sourceMall, productId, categoryId, expected] of [
    ["cheonyu", "95371", 152, "152"],
    ["ccdome", "1000005467", "021001", "021001"],
    ["future_mall", "new-1", "001234", "001234"],
  ]) {
    const [product] = await createBackendProducts({ collectionMode: "detail", detailItems: [{
      sourceMall, productId, categoryId,
    }] });
    assert.equal(product.categoryId, expected);
    assert.equal(JSON.parse(JSON.stringify(product)).categoryId, expected);
  }
});

test("이전 상세 성공 상품을 선택 범위에서 재수집하고 새 규격 완료 후에는 제외한다", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "category-state-test-"));
  const archivePath = require.resolve("../src/utils/product-archive");
  const statePath = require.resolve("../src/utils/detail-collection-state");
  const archiveModule = require(archivePath);
  const previousState = require.cache[statePath];
  require.cache[archivePath].exports = { ...archiveModule, ARCHIVE_DIRECTORY: directory };
  delete require.cache[statePath];
  const state = require(statePath);
  require.cache[archivePath].exports = archiveModule;
  t.after(() => {
    if (previousState) require.cache[statePath] = previousState;
    else delete require.cache[statePath];
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("category-state-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(state.DETAIL_STATE_PATH, JSON.stringify({ schemaVersion: 1, products: {
    "cheonyu:79136": { mall: "cheonyu", productId: "79136", detailStatus: "success", detailDataSchemaVersion: 4 },
    "cheonyu:2": { mall: "cheonyu", productId: "2", detailStatus: "success", detailDataSchemaVersion: 4 },
    "cheonyu:3": { mall: "cheonyu", productId: "3", detailStatus: "success", detailDataSchemaVersion: state.DETAIL_DATA_SCHEMA_VERSION },
  } }));
  const selected = [{ productId: "79136" }, { productId: "3" }];
  assert.deepEqual(await state.selectPendingDetailProductIds("cheonyu", selected), ["79136"]);
  await state.recordDetailOutcomes({ mall: "cheonyu", detailItems: [{ productId: "79136", consumerPrice: 1000 }] });
  assert.deepEqual(await state.selectPendingDetailProductIds("cheonyu", selected), []);
});

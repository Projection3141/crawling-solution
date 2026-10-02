const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBackendProducts } = require("../src/utils/backend-product");

function fixture(t, initial) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mall-archive-test-"));
  const modulePath = require.resolve("../src/utils/product-archive");
  const previousDirectory = process.env.PRODUCT_ARCHIVE_DIRECTORY;
  const previousVersion = process.env.PRODUCT_ARCHIVE_VERSION;
  const previousModule = require.cache[modulePath];
  let api;
  try {
    process.env.PRODUCT_ARCHIVE_DIRECTORY = directory;
    process.env.PRODUCT_ARCHIVE_VERSION = "1.4.1";
    delete require.cache[modulePath];
    api = require(modulePath);
  } finally {
    if (previousDirectory === undefined) delete process.env.PRODUCT_ARCHIVE_DIRECTORY;
    else process.env.PRODUCT_ARCHIVE_DIRECTORY = previousDirectory;
    if (previousVersion === undefined) delete process.env.PRODUCT_ARCHIVE_VERSION;
    else process.env.PRODUCT_ARCHIVE_VERSION = previousVersion;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  }
  if (initial !== undefined) fs.writeFileSync(api.ARCHIVE_PATH, JSON.stringify(initial));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("mall-archive-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...api,
    directory,
    backupPath: `${api.ARCHIVE_PATH}.before-mall-groups.bak`,
    readStored: () => JSON.parse(fs.readFileSync(api.ARCHIVE_PATH, "utf8")),
  };
}

test("기존 배열을 백업하고 상품 필드·옵션·sourceMall을 유지한 쇼핑몰별 배열로 저장한다", async (t) => {
  const items = [
    { id: "95546", sourceMall: "cheonyu", nameKo: "문구", stockQuantity: 0,
      descriptionImageUrls: ["https://example.test/detail.png"],
      options: [{ id: "red", nameKo: "빨강", nameJa: "赤", stockQuantity: 0 }] },
    { id: "1000000001", sourceMall: "ccdome", nameKo: "과자", stockQuantity: null },
  ];
  const f = fixture(t, items);
  const original = fs.readFileSync(f.ARCHIVE_PATH, "utf8");
  const expected = f.archiveToProductArray(await f.readProductArchive());
  assert.equal(fs.existsSync(f.backupPath), false);
  assert.equal(fs.readFileSync(f.ARCHIVE_PATH, "utf8"), original);
  await f.updateProductArchive([]);
  const stored = f.readStored();
  assert.deepEqual(Object.keys(stored), ["cheonyu", "ccdome"]);
  assert.deepEqual([...stored.cheonyu, ...stored.ccdome], expected);
  assert.equal(stored.cheonyu[0].sourceMall, "cheonyu");
  assert.equal(stored.cheonyu[0].options[0].stockQuantity, 0);
  assert.equal(fs.readFileSync(f.backupPath, "utf8"), original);
  await f.updateProductArchive([{ id: "95546", sourceMall: "cheonyu", nameKo: "변경" }]);
  assert.equal(fs.readFileSync(f.backupPath, "utf8"), original);
  assert.equal(f.readStored().cheonyu[0].nameKo, "변경");
});

test("쇼핑몰 간 같은 상품 ID를 분리하고 실행 결과·전송·번역용 배열을 유지한다", async (t) => {
  const f = fixture(t, { cheonyu: [], ccdome: [] });
  await f.updateProductArchive([
    { id: "42", sourceMall: "cheonyu", nameKo: "천유 상품", nameJa: "文具" },
    { id: "42", sourceMall: "ccdome", nameKo: "과자 상품", nameJa: "菓子" },
  ]);
  const result = await f.updateProductArchive([{ id: "42", sourceMall: "cheonyu", nameKo: "수정 상품" }]);
  assert.ok(Array.isArray(result.currentProducts));
  assert.equal(result.currentProducts.length, 1);
  assert.equal(result.currentProducts[0].sourceMall, "cheonyu");
  const reread = await f.readProductArchive();
  const flat = f.archiveToProductArray(reread);
  assert.ok(Array.isArray(flat));
  assert.equal(flat.length, 2);
  assert.equal(flat.find((p) => p.sourceMall === "ccdome").nameKo, "과자 상품");
  assert.deepEqual(flat.map((p) => p.sku), ["CHEONYU-42", "CCDOME-42"]);
  assert.equal(f.archiveToTranslationItems(reread, "ccdome")[0].nameJa, "菓子");
  assert.throws(() => f.archiveToProductArray(reread, ["42"]), /사이트 구분/);
  assert.equal(fs.existsSync(f.backupPath), false);
});

test("새 쇼핑몰 배열을 자동 생성하고 빈 쇼핑몰 그룹도 다시 저장할 때 보존한다", async (t) => {
  const f = fixture(t, { cheonyu: [], ccdome: [], future_mall: [] });
  await f.updateProductArchive([{ id: "new-1", sourceMall: "new_mall", nameKo: "새 상품" }]);
  await f.updateProductArchive([]);
  const stored = f.readStored();
  assert.deepEqual(stored.cheonyu, []);
  assert.deepEqual(stored.ccdome, []);
  assert.deepEqual(stored.future_mall, []);
  assert.equal(stored.new_mall[0].sourceMall, "new_mall");
  assert.equal(stored.new_mall[0].id, "new-1");
});

test("그룹 키로 누락된 sourceMall을 복원하고 이후 상품에도 보존한다", async (t) => {
  const f = fixture(t, { new_mall: [{ id: "42", nameKo: "신규 쇼핑몰" }] });
  await f.updateProductArchive([]);
  assert.equal(f.readStored().new_mall[0].sourceMall, "new_mall");
  assert.equal(f.readStored().new_mall[0].sku, "NEW_MALL-42");
});

test("이전 상품 ID 객체와 객체·배열 wrapper를 읽어 ID 범위로 쇼핑몰을 식별한다", async (t) => {
  const products = { "95546": { nameKo: "문구" }, "1000000001": { nameKo: "과자" } };
  const array = Object.entries(products).map(([id, item]) => ({ ...item, id }));
  for (const value of [products, { version: 1, products }, { version: 1, products: array }, { products: array }]) {
    const f = fixture(t, value);
    await f.updateProductArchive([]);
    assert.equal(f.readStored().cheonyu[0].id, "95546");
    assert.equal(f.readStored().ccdome[0].id, "1000000001");
    assert.ok(fs.existsSync(f.backupPath));
  }
});

test("그룹 불일치·잘못된 배열·중복 상품은 기존 파일을 덮어쓰지 않는다", async (t) => {
  const cases = [
    { value: { cheonyu: [{ id: "1", sourceMall: "ccdome" }] }, error: /sourceMall이 다릅니다/ },
    { value: { cheonyu: [], ccdome: {} }, error: /형식이 올바르지/ },
    { value: { cheonyu: [{ nameKo: "ID 없음" }] }, error: /상품 ID가 없는/ },
    { value: { cheonyu: [{ id: "1" }, { id: "1" }] }, error: /중복 상품/ },
  ];
  for (const { value, error } of cases) {
    const f = fixture(t, value);
    const before = fs.readFileSync(f.ARCHIVE_PATH, "utf8");
    await assert.rejects(f.updateProductArchive([]), error);
    assert.equal(fs.readFileSync(f.ARCHIVE_PATH, "utf8"), before);
    assert.equal(fs.existsSync(f.backupPath), false);
  }
});

test("쇼핑몰을 판별할 수 없는 기존 상품은 임의 분류하거나 삭제하지 않는다", async (t) => {
  const f = fixture(t, [{ id: "unidentified", nameKo: "보존할 상품" }]);
  const before = fs.readFileSync(f.ARCHIVE_PATH, "utf8");
  await assert.rejects(f.updateProductArchive([]), /sourceMall을 지정하세요/);
  assert.equal(fs.readFileSync(f.ARCHIVE_PATH, "utf8"), before);
});

test("이전 버전에서 이관할 때 원본은 보존하고 현재 버전만 쇼핑몰별로 생성한다", async (t) => {
  const f = fixture(t);
  const previousPath = path.join(f.directory, "v1.4.0_archive.json");
  const previous = JSON.stringify([{ id: "123", sourceMall: "cheonyu", nameKo: "이전 상품" }]);
  fs.writeFileSync(previousPath, previous);
  const archive = await f.readProductArchive();
  assert.equal(f.archiveToProductArray(archive)[0].nameKo, "이전 상품");
  assert.equal(f.readStored().cheonyu[0].id, "123");
  assert.deepEqual(f.readStored().ccdome, []);
  assert.equal(fs.readFileSync(previousPath, "utf8"), previous);
});

test("category를 아카이브·결과에 저장하고 일반·번역·미관측 상세 수집에서는 보존한다", async (t) => {
  const f = fixture(t, { cheonyu: [], ccdome: [] });
  const category = { depth1: "패션잡화", depth2: "여름 / 겨울 /시즌 상품",
    depth3: "마스크 / 장갑 / 안대", depth4: "방한", depth5: "성인용" };
  const item = { id: "79136", sourceMall: "cheonyu", nameKo: "상품" };
  const added = await f.updateProductArchive([{ ...item, category }], { source: "detail" });
  assert.deepEqual(added.currentProducts[0].category, category);
  assert.deepEqual(f.readStored().cheonyu[0].category, category);
  for (const source of ["general", "translation", "detail"]) {
    await f.updateProductArchive([{ ...item, category: {} }], { source });
    assert.deepEqual(f.readStored().cheonyu[0].category, category);
  }
  const shortened = { ...category, depth4: null, depth5: null };
  await f.updateProductArchive([{ ...item, category: shortened }], { source: "detail" });
  assert.deepEqual(f.archiveToProductArray(await f.readProductArchive())[0].category, shortened);
});

test("이전 이름 형태 categoryId를 null로 바꾸고 상위 경로를 임의 추정하지 않는다", async (t) => {
  const f = fixture(t, [{ id: "79136", sourceMall: "cheonyu", categoryId: "마스크 / 장갑 / 안대" }]);
  await f.updateProductArchive([]);
  assert.deepEqual(f.readStored().cheonyu[0].category, {
    depth1: null, depth2: null, depth3: null, depth4: null, depth5: null,
  });
  assert.equal(f.readStored().cheonyu[0].categoryId, null);
});

test("문자열 categoryId를 저장·전송용 배열에 유지하고 미관측 수집으로 지우지 않는다", async (t) => {
  const category = { depth1: "패션잡화", depth2: "파우치 / 지갑", depth3: "캐릭터 파우치", depth4: null, depth5: null };
  const item = { id: "95371", sourceMall: "cheonyu", nameKo: "미피 코리 동전지갑", category };
  const f = fixture(t, { cheonyu: [{ ...item, categoryId: "캐릭터 파우치" }], ccdome: [] });
  const result = await f.updateProductArchive([{ ...item, categoryId: "152" }], { source: "detail" });
  assert.equal(result.currentProducts[0].categoryId, "152");
  assert.equal(f.readStored().cheonyu[0].categoryId, "152");
  for (const source of ["general", "translation", "detail"]) {
    await f.updateProductArchive([{ ...item, categoryId: null }], { source });
    assert.equal(f.readStored().cheonyu[0].categoryId, "152");
    assert.deepEqual(f.readStored().cheonyu[0].category, category);
  }
  assert.equal(f.archiveToProductArray(await f.readProductArchive())[0].categoryId, "152");
});

test("기존 숫자 ID는 문자열로 변환하고 과자생각 문자열의 앞자리 0은 읽고 저장할 때 보존한다", async (t) => {
  const f = fixture(t, {
    cheonyu: [{ id: "95371", sourceMall: "cheonyu", categoryId: 152 }],
    ccdome: [{ id: "1000005467", sourceMall: "ccdome", categoryId: "021001" }],
  });
  const products = f.archiveToProductArray(await f.readProductArchive());
  assert.equal(products[0].categoryId, "152");
  assert.equal(products[1].categoryId, "021001");
  await f.updateProductArchive([]);
  assert.equal(f.readStored().cheonyu[0].categoryId, "152");
  assert.equal(f.readStored().ccdome[0].categoryId, "021001");
});

test("새 상세 경로가 달라지고 번호를 못 읽으면 예전 카테고리 번호를 연결하지 않는다", async (t) => {
  const item = { id: "95371", sourceMall: "cheonyu" };
  const category = { depth1: "패션잡화", depth2: "파우치 / 지갑", depth3: "캐릭터 파우치", depth4: null, depth5: null };
  const f = fixture(t, { cheonyu: [{ ...item, category, categoryId: 152 }], ccdome: [] });
  await f.updateProductArchive([{ ...item, categoryId: null }], { source: "detail" });
  assert.equal(f.readStored().cheonyu[0].categoryId, "152");
  const changedCategory = { ...category, depth3: "동전지갑" };
  await f.updateProductArchive([{ ...item, category: changedCategory, categoryId: null }], { source: "detail" });
  assert.equal(f.readStored().cheonyu[0].categoryId, null);
  assert.deepEqual(f.readStored().cheonyu[0].category, changedCategory);
});

test("과자생각 상세 코드의 앞자리 0을 병합·보존하고 다음 상세에서 실제 코드로 교체한다", async (t) => {
  const item = { id: "1000005467", sourceMall: "ccdome", category: { depth1: "간식", depth2: "과자" } };
  const f = fixture(t, { cheonyu: [], ccdome: [{ ...item, categoryId: 21001 }] });
  // 숫자로 저장해 잃은 0을 추정하지 않고, 상세에서 읽은 원문으로 교체한다.
  assert.equal(f.archiveToProductArray(await f.readProductArchive())[0].categoryId, "21001");
  const result = await f.updateProductArchive([{ ...item, categoryId: "021001" }], { source: "detail" });
  assert.equal(result.currentProducts[0].categoryId, "021001");
  assert.equal(f.readStored().ccdome[0].categoryId, "021001");
  for (const source of ["general", "translation", "detail"]) {
    await f.updateProductArchive([{ ...item, categoryId: null }], { source });
    assert.equal(f.readStored().ccdome[0].categoryId, "021001");
  }
  const payload = { type: "아카이브", data: f.archiveToProductArray(await f.readProductArchive()) };
  assert.equal(JSON.parse(JSON.stringify(payload)).data[0].categoryId, "021001");
});

test("기존 아카이브에는 special을 null로 보완하고 내부 관측 플래그를 저장하지 않는다", async (t) => {
  const f = fixture(t, { cheonyu: [{ id: "93796", sourceMall: "cheonyu" }], ccdome: [] });
  assert.equal(f.archiveToProductArray(await f.readProductArchive())[0].special, null);
  await f.updateProductArchive([]);
  assert.equal(f.readStored().cheonyu[0].special, null);
  assert.equal(Object.hasOwn(f.readStored().cheonyu[0], "specialObserved"), false);
});

test("천유 특별 마크를 저장·전송하고 정상 상세에서 마크가 사라지면 null로 갱신한다", async (t) => {
  const f = fixture(t, { cheonyu: [], ccdome: [] });
  for (const special of ["핫템", "착한 상품", null]) {
    const products = await createBackendProducts({ collectionMode: "detail", detailItems: [{
      productId: "93796", sourceMall: "cheonyu", consumerPrice: 1000,
      special, specialObserved: true,
    }] });
    assert.equal(products[0].special, special);
    assert.equal(products[0].specialObserved, true);
    const result = await f.updateProductArchive(products, { source: "detail" });
    assert.equal(result.currentProducts[0].special, special);
    assert.equal(f.readStored().cheonyu[0].special, special);
    assert.equal(Object.hasOwn(result.currentProducts[0], "specialObserved"), false);
    const payload = { type: "아카이브", data: f.archiveToProductArray(await f.readProductArchive()) };
    const sent = JSON.parse(JSON.stringify(payload)).data[0];
    assert.equal(sent.special, special);
    assert.equal(Object.hasOwn(sent, "specialObserved"), false);
  }
});

test("일반·번역·실패하거나 미관측인 상세 수집은 기존 특별 마크를 유지한다", async (t) => {
  const item = { id: "93796", sourceMall: "cheonyu", special: "핫템" };
  const f = fixture(t, { cheonyu: [item], ccdome: [] });
  for (const source of ["general", "translation"]) {
    await f.updateProductArchive([{ ...item, special: null, specialObserved: true }], { source });
    assert.equal(f.readStored().cheonyu[0].special, "핫템");
  }
  for (const detail of [
    {},
    { special: null, specialObserved: false, consumerPrice: 1000 },
    { special: "착한 상품", specialObserved: false, consumerPrice: 1000 },
    { special: null, specialObserved: true, consumerPrice: 1000, detailError: "상세 수집 실패" },
    { special: "착한 상품", specialObserved: true, consumerPrice: 1000, detailError: "상세 수집 실패" },
    { special: null, specialObserved: true, consumerPrice: 0 },
  ]) {
    const products = await createBackendProducts({ collectionMode: "detail", detailItems: [{
      productId: item.id, sourceMall: "cheonyu", ...detail,
    }] });
    assert.equal(products[0].specialObserved, false);
    await f.updateProductArchive(products, { source: "detail" });
    assert.equal(f.readStored().cheonyu[0].special, "핫템");
  }
  await f.updateProductArchive([{ ...item, special: null }], { source: "detail" });
  assert.equal(f.readStored().cheonyu[0].special, "핫템");
});

test("천유 외 쇼핑몰에서는 special이 null이며 천유 마크 갱신 규칙을 적용하지 않는다", async (t) => {
  const f = fixture(t, { cheonyu: [], ccdome: [] });
  const products = await createBackendProducts({ collectionMode: "detail", detailItems: [{
    productId: "1000005467", sourceMall: "ccdome", consumerPrice: 1000,
    special: "핫템", specialObserved: true,
  }] });
  assert.equal(products[0].special, null);
  assert.equal(products[0].specialObserved, false);
  const result = await f.updateProductArchive(products, { source: "detail" });
  assert.equal(result.currentProducts[0].special, null);
});

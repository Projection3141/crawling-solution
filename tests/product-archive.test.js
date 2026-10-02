const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

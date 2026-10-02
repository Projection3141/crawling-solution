const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fixture(t, adapterRun) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "full-catalog-run-"));
  const savedModules = new Map();
  const remember = (name) => {
    const id = require.resolve(name);
    if (!savedModules.has(id)) savedModules.set(id, require.cache[id]);
    return id;
  };
  const stub = (name, exports) => {
    const id = remember(name);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const archiveId = remember("../src/utils/product-archive");
  const previousDirectory = process.env.PRODUCT_ARCHIVE_DIRECTORY;
  const previousVersion = process.env.PRODUCT_ARCHIVE_VERSION;
  let archive;
  try {
    process.env.PRODUCT_ARCHIVE_DIRECTORY = directory;
    process.env.PRODUCT_ARCHIVE_VERSION = "1.5.0";
    delete require.cache[archiveId];
    archive = require(archiveId);
  } finally {
    if (previousDirectory === undefined) delete process.env.PRODUCT_ARCHIVE_DIRECTORY;
    else process.env.PRODUCT_ARCHIVE_DIRECTORY = previousDirectory;
    if (previousVersion === undefined) delete process.env.PRODUCT_ARCHIVE_VERSION;
    else process.env.PRODUCT_ARCHIVE_VERSION = previousVersion;
  }
  const initial = {
    cheonyu: ["93796", "60549", "94000", "96000"].map((id) => ({
      id, sourceMall: "cheonyu", saleStatus: "ON_SALE", stockQuantity: 7,
    })),
    ccdome: [{ id: "94000", sourceMall: "ccdome", saleStatus: "ON_SALE" }],
  };
  fs.writeFileSync(archive.ARCHIVE_PATH, JSON.stringify(initial));
  stub("../src/malls/cheonyu", { run: (...args) => adapterRun(archive, ...args) });
  stub("../src/malls/ccdome", { run: (...args) => adapterRun(archive, ...args) });
  stub("../src/utils/detail-collection-state", {
    observeDetailProducts: async () => ({ pendingProductIds: [], path: null }),
    recordDetailOutcomes: async () => ({ succeededProductIds: [], failedProductIds: [] }),
  });
  stub("../translate/convert", { createConversionSnapshot: async () => null });
  stub("../translate/translate", {
    translateResultData: async () => ({ translatedItems: [], skippedOptions: [] }),
  });
  const crawlerId = remember("../src/crawler");
  delete require.cache[crawlerId];
  const { runCollection } = require(crawlerId);
  t.after(() => {
    for (const [id, previous] of savedModules) {
      if (previous) require.cache[id] = previous;
      else delete require.cache[id];
    }
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("full-catalog-run-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    archive,
    read: () => JSON.parse(fs.readFileSync(archive.ARCHIVE_PATH, "utf8")),
    run: (input = {}, options = {}) => runCollection({
      mall: "cheonyu", mallLabel: "천유", category: "-1", collectionMode: "general",
      pageStart: 1, pageEnd: 0, pageSize: 2, pageOrder: "forward", baseOutDir: directory,
      ...input,
    }, { runId: "test-run", ...options }),
  };
}

function completedResult(config) {
  const products = [
    { productId: "93796", sourceMall: config.mall, productName: "판매중", isSoldOut: false },
    { productId: "60549", sourceMall: config.mall, productName: "품절", isSoldOut: true },
    { productId: "96000", sourceMall: config.mall, productName: "목록에는 있지만 재고 미관측" },
  ];
  const inventoryItems = [{ productId: "93796", sourceMall: config.mall, hasOption: false, maxStock: 5 }];
  return {
    products, inventoryItems, productSummaries: [], detailItems: [],
    summary: {
      mall: config.mall, category: config.category, collectionMode: config.collectionMode,
      finishedAt: new Date().toISOString(),
      pageRange: { mode: "auto", pageStart: 1, pageEnd: 2, requestedPageEnd: 0,
        detectedLastPage: 2, detectedTotalProductCount: 3, collectedLastPage: config.pageOrder === "reverse" ? 1 : 2,
        collectedPageCount: 2, pageOrder: config.pageOrder, stopReason: "completed-range" },
      collectedPages: [1, 2], detectedTotalProductCount: 3, collectedProductCount: 3,
      targetProductCount: 2, soldOutProductCount: 1, elapsedMs: 1, countMatched: true,
    },
  };
}

test("전체 일반 수집의 마지막 저장에만 누락 상품을 HIDDEN으로 넣고 결과 JSON에도 포함한다", async (t) => {
  const f = fixture(t, async (archive, config, { onCycleArchive }) => {
    const result = completedResult(config);
    await onCycleArchive({ cycleNo: 1, products: result.products.slice(0, 1), inventoryItems: result.inventoryItems });
    assert.equal((await archive.readProductArchive()).products["cheonyu:94000"].saleStatus, "ON_SALE");
    // 수집 도중 다른 실행에서 추가한 상품은 시작 시점 후보에 포함되지 않는다.
    await archive.updateProductArchive([{ id: "95000", sourceMall: config.mall, nameKo: "새로 발견한 상품" }]);
    return result;
  });
  const result = await f.run();
  const products = new Map(result.payload.products.map((product) => [product.id, product]));
  assert.equal(products.get("93796").saleStatus, "ON_SALE");
  assert.equal(products.get("60549").saleStatus, "SOLD_OUT");
  assert.equal(products.get("94000").saleStatus, "HIDDEN");
  assert.equal(products.get("94000").stockQuantity, 7);
  assert.equal(products.get("96000").saleStatus, "ON_SALE");
  assert.equal(result.payload.summary.fullCatalogScanCompleted, true);
  assert.equal(result.payload.summary.hiddenProductCount, 1);
  assert.equal(f.read().ccdome[0].saleStatus, "ON_SALE");
  assert.notEqual(f.read().cheonyu.find((product) => product.id === "95000").saleStatus, "HIDDEN");
  assert.deepEqual(JSON.parse(fs.readFileSync(result.files.result, "utf8")), result.payload.products);
  assert.equal(result.payload.products.some((product) => Object.hasOwn(product, "listingObserved")), false);
});

test("범위 제한·상세 수집·불완전 목록에서는 HIDDEN을 적용하지 않는다", async (t) => {
  const cases = [
    { config: { category: "152" } },
    { config: { pageStart: 2 } },
    { config: { pageEnd: 2 } },
    { config: { collectionMode: "detail" } },
    { change: (result) => { result.summary.collectedPages = [1]; } },
    { change: (result) => { result.summary.detectedTotalProductCount = 4; } },
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(`보호 조건 ${index + 1}`, async (sub) => {
      const f = fixture(sub, async (_archive, config) => {
        const result = completedResult(config);
        item.change?.(result);
        return result;
      });
      const result = await f.run(item.config);
      assert.equal(result.payload.summary.fullCatalogScanCompleted, false);
      assert.equal(result.payload.summary.hiddenProductCount, 0);
      assert.equal(f.read().cheonyu.find((product) => product.id === "94000").saleStatus, "ON_SALE");
    });
  }
});

test("일부 범위 일반 수집에서도 다시 발견한 HIDDEN은 현재 판매 상태로 복원한다", async (t) => {
  const f = fixture(t, async (_archive, config) => completedResult(config));
  const stored = f.read();
  for (const product of stored.cheonyu) {
    if (product.id !== "94000") product.saleStatus = "HIDDEN";
  }
  fs.writeFileSync(f.archive.ARCHIVE_PATH, JSON.stringify(stored));
  const result = await f.run({ category: "152" });
  const products = new Map(result.payload.products.map((product) => [product.id, product]));
  assert.equal(products.get("93796").saleStatus, "ON_SALE");
  assert.equal(products.get("60549").saleStatus, "SOLD_OUT");
  assert.equal(products.get("96000").saleStatus, "ON_SALE");
  assert.equal(products.get("96000").stockQuantity, 7);
  assert.equal(result.payload.summary.fullCatalogScanCompleted, false);
  assert.equal(result.payload.summary.hiddenProductCount, 0);
});

test("부분 저장 후 실패·취소하면 기존 미발견 상품을 숨기지 않는다", async (t) => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? "취소" : "실패", async (sub) => {
      const controller = new AbortController();
      const f = fixture(sub, async (_archive, config, { onCycleArchive }) => {
        const result = completedResult(config);
        await onCycleArchive({ cycleNo: 1, products: result.products.slice(0, 1), inventoryItems: result.inventoryItems });
        if (cancelled) {
          controller.abort();
          return result;
        }
        throw new Error("목록 수집 실패");
      });
      await assert.rejects(f.run({}, { signal: controller.signal }));
      assert.equal(f.read().cheonyu.find((product) => product.id === "94000").saleStatus, "ON_SALE");
    });
  }
});

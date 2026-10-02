const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isFullCatalogRequested, getCompletedFullCatalogScan } = require("../src/utils/full-catalog-scan");

const makeConfig = (mall = "cheonyu", patch = {}) => ({
  mall, category: mall === "cheonyu" ? "-1" : "017", collectionMode: "general",
  pageStart: 1, pageEnd: 0, pageOrder: "forward", ...patch,
});
const makeResult = (mall = "cheonyu") => ({
  summary: {
    mall, category: mall === "cheonyu" ? "-1" : "017", collectionMode: "general",
    finishedAt: "2026-10-06T01:00:00.000Z",
    detectedTotalProductCount: 5, collectedProductCount: 5,
    collectedPages: [1, 2, 3], ...(mall === "ccdome" ? { countMatched: true } : {}),
    pageRange: {
      mode: "auto", pageStart: 1, pageEnd: 3, requestedPageEnd: 0,
      detectedLastPage: 3, detectedTotalProductCount: 5,
      collectedLastPage: 3, collectedPageCount: 3, stopReason: "completed-range",
      ...(mall === "cheonyu" ? { pageOrder: "forward", traversalStartPage: 1, resumePage: 4 } : {}),
    },
  },
  products: ["101", "102", "103", "104", "105"].map((productId) => ({ productId, sourceMall: mall })),
});

test("두 쇼핑몰의 전체 카테고리 자동 범위 일반 수집만 요청으로 판별한다", () => {
  for (const mall of ["cheonyu", "ccdome"]) {
    assert.equal(isFullCatalogRequested(makeConfig(mall)), true);
    for (const patch of [
      { collectionMode: "detail" }, { pageStart: 2 }, { pageEnd: 3 },
      { category: mall === "cheonyu" ? "152" : "021001" }, { mall: "unknown" },
    ]) assert.equal(isFullCatalogRequested(makeConfig(mall, patch)), false, JSON.stringify(patch));
  }
  assert.equal(isFullCatalogRequested(), false);
  assert.equal(isFullCatalogRequested(null), false);
  assert.equal(getCompletedFullCatalogScan(makeConfig(), null), null);
});

test("설정과 같은 규칙으로 전체 카테고리 URL을 정규화한다", () => {
  assert.equal(isFullCatalogRequested(makeConfig("cheonyu", { category: "https://www.cheonyu.com/product/list.html?cateIDX=-1" })), true);
  assert.equal(isFullCatalogRequested(makeConfig("ccdome", { category: "https://www.ccdome.co.kr/goods/goods_list.php?cateCd=017" })), true);
  assert.equal(isFullCatalogRequested(makeConfig("ccdome", { category: "https://www.ccdome.co.kr/goods/goods_list.php?cateCd=017001" })), false);
});

test("전체 페이지와 상품 수가 일치하는 두 쇼핑몰 완료 결과를 반환한다", () => {
  for (const mall of ["cheonyu", "ccdome"]) {
    const result = makeResult(mall);
    const before = structuredClone(result);
    assert.deepEqual(getCompletedFullCatalogScan(makeConfig(mall), result), {
      sourceMall: mall, observedProductIds: ["101", "102", "103", "104", "105"],
    });
    assert.deepEqual(result, before);
  }
});

test("천유 여러 차수는 전체 페이지 합집합을 쓰고 마지막 limit-reached도 완료로 판별한다", () => {
  const result = makeResult();
  Object.assign(result.summary.pageRange, { collectedPageCount: 1, traversalStartPage: 3, stopReason: "limit-reached" });
  result.summary.cycleCount = 2;
  result.summary.cycleHealthHistory = [
    { cycleNo: 1, collectedPageCount: 2, collectedNow: 4, stopReason: "limit-reached" },
    { cycleNo: 2, collectedPageCount: 1, collectedNow: 1, stopReason: "limit-reached" },
  ];
  assert.equal(getCompletedFullCatalogScan(makeConfig(), result)?.observedProductIds.length, 5);
});

test("천유 역순 전체 수집은 최종 1페이지와 모든 차수의 페이지 합집합으로 판별한다", () => {
  const result = makeResult();
  Object.assign(result.summary.pageRange, {
    pageOrder: "reverse", collectedLastPage: 1, collectedPageCount: 1,
    traversalStartPage: 1, resumePage: 0, stopReason: "limit-reached",
  });
  assert.equal(getCompletedFullCatalogScan(makeConfig("cheonyu", { pageOrder: "reverse" }), result)?.sourceMall, "cheonyu");
  assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null);
});

test("천유 재사용 범위의 자연 종료로 stopReason이 빠져도 전체 완료 증거가 있으면 허용한다", () => {
  for (const pageOrder of ["forward", "reverse"]) {
    const result = makeResult();
    result.summary.cycleCount = 2;
    Object.assign(result.summary.pageRange, {
      pageOrder, collectedLastPage: pageOrder === "reverse" ? 1 : 3,
      traversalStartPage: pageOrder === "reverse" ? 1 : 3, collectedPageCount: 1,
    });
    delete result.summary.pageRange.stopReason;
    const config = makeConfig("cheonyu", { pageOrder });
    assert.equal(getCompletedFullCatalogScan(config, result)?.observedProductIds.length, 5);
    result.summary.collectedPages = [1, 3];
    assert.equal(getCompletedFullCatalogScan(config, result), null);
  }
  const singleCycle = makeResult();
  delete singleCycle.summary.pageRange.stopReason;
  assert.equal(getCompletedFullCatalogScan(makeConfig(), singleCycle), null);
});

test("페이지 구멍·중복·범위 불일치와 마지막 페이지 미도달은 숨김 판정에서 제외한다", () => {
  for (const pages of [[1, 3], [1, 1, 3], [1, 2, 4], [1, 2, null], [], null]) {
    const result = makeResult();
    result.summary.collectedPages = pages;
    assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null, JSON.stringify(pages));
  }
  for (const patch of [
    { pageEnd: 2 }, { detectedLastPage: null }, { collectedLastPage: 2 },
    { collectedPageCount: 0 }, { pageStart: 2 }, { requestedPageEnd: 3 }, { mode: "manual" },
  ]) {
    const result = makeResult();
    Object.assign(result.summary.pageRange, patch);
    assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null, JSON.stringify(patch));
  }
});

test("조기 종료·중단·오류와 완료 시각 미확인은 전체 스캔으로 판별하지 않는다", () => {
  for (const mall of ["cheonyu", "ccdome"]) {
    for (const stopReason of ["empty-page", "duplicate-page", "no-new-products", "aborted", "error", ""]) {
      const result = makeResult(mall);
      result.summary.pageRange.stopReason = stopReason;
      assert.equal(getCompletedFullCatalogScan(makeConfig(mall), result), null, `${mall}:${stopReason}`);
    }
    for (const patch of [{ aborted: true }, { cancelled: true }, { interrupted: true }, { error: "실패" }]) {
      const result = makeResult(mall);
      Object.assign(result, patch);
      assert.equal(getCompletedFullCatalogScan(makeConfig(mall), result), null, JSON.stringify(patch));
    }
  }
  for (const patch of [{ finishedAt: null }, { finishedAt: "invalid" }, { status: "running" }, { aborted: true }]) {
    const result = makeResult();
    Object.assign(result.summary, patch);
    assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null, JSON.stringify(patch));
  }
  assert.equal(getCompletedFullCatalogScan(makeConfig("cheonyu", { signal: { aborted: true } }), makeResult()), null);
});

test("빈 목록·총수 미확인·서로 다른 총수·중복 ID·타 쇼핑몰 상품은 숨김 판정에서 제외한다", () => {
  for (const count of [null, 0, "", 4, 6, NaN]) {
    const result = makeResult();
    result.summary.pageRange.detectedTotalProductCount = count;
    assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null, String(count));
  }
  for (const change of [
    (result) => { result.products = []; },
    (result) => { result.products.pop(); },
    (result) => { result.products[4].productId = "101"; },
    (result) => { result.products[4].productId = ""; },
    (result) => { result.products[4].sourceMall = "ccdome"; },
    (result) => { result.summary.detectedTotalProductCount = 4; },
    (result) => { result.summary.collectedProductCount = 4; },
    (result) => { result.summary.countMatched = false; },
    (result) => { result.summary.mall = "ccdome"; },
    (result) => { result.summary.category = "152"; },
    (result) => { result.summary.collectionMode = "detail"; },
  ]) {
    const result = makeResult();
    change(result);
    assert.equal(getCompletedFullCatalogScan(makeConfig(), result), null);
  }
});

test("과자생각은 completed-range와 countMatched 및 전체 페이지 수를 확인한다", () => {
  for (const change of [
    (result) => { result.summary.pageRange.stopReason = "limit-reached"; },
    (result) => { result.summary.countMatched = null; },
    (result) => { result.summary.pageRange.collectedPageCount = 2; },
  ]) {
    const result = makeResult("ccdome");
    change(result);
    assert.equal(getCompletedFullCatalogScan(makeConfig("ccdome"), result), null);
  }
});

test("목록에서 확인한 품절·재고 수집 제외 상품도 관측 ID에 유지한다", () => {
  const result = makeResult();
  Object.assign(result.products[0], { isSoldOut: true, unavailableInCart: true });
  result.summary.excludedProductCount = 1;
  result.summary.cartCoverage = { complete: false, missingProductIds: ["101"] };
  assert.ok(getCompletedFullCatalogScan(makeConfig(), result).observedProductIds.includes("101"));
});

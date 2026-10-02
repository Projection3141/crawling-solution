// src/utils/full-catalog-scan.js
// 목적: 전체 목록의 페이지와 상품 수가 일치하는 완료 수집만 판별해 미관측 상품 숨김에 사용할 ID를 제공한다.

const { MALLS, normalizeCategory } = require("../config");

function readInteger(value, minimum = 0) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function getMall(config = {}) {
  const mall = String(config?.mall || "").trim().toLowerCase();
  return Object.hasOwn(MALLS, mall) ? mall : null;
}

/** 전체 카테고리의 첫 페이지부터 자동 마지막 페이지까지 요청한 일반 수집인지 확인한다. */
function isFullCatalogRequested(config = {}) {
  const mall = getMall(config);
  return Boolean(mall && config.collectionMode === "general" &&
    normalizeCategory(config.category, mall) === MALLS[mall].defaultCategory &&
    readInteger(config.pageStart, 1) === 1 && readInteger(config.pageEnd) === 0);
}

function hasIncompleteState(value) {
  return Boolean(value && (
    value.aborted === true || value.cancelled === true || value.canceled === true ||
    value.interrupted === true || value.error || value.signal?.aborted === true
  ));
}

/** 완료 메타데이터·전체 페이지·고유 상품 수가 모두 일치할 때만 숨김 판정용 목록을 반환한다. */
function getCompletedFullCatalogScan(config = {}, result = {}) {
  if (!isFullCatalogRequested(config) || hasIncompleteState(config) || hasIncompleteState(result)) return null;

  const sourceMall = getMall(config);
  const summary = result?.summary;
  const range = summary?.pageRange;
  if (!summary || !range || hasIncompleteState(summary) || hasIncompleteState(range)) return null;
  if (summary.mall !== sourceMall || summary.collectionMode !== "general" ||
      normalizeCategory(summary.category, sourceMall) !== MALLS[sourceMall].defaultCategory ||
      typeof summary.finishedAt !== "string" || !Number.isFinite(Date.parse(summary.finishedAt))) return null;
  if (summary.status !== undefined && !["completed", "success", "succeeded"].includes(summary.status)) return null;
  if (range.mode !== "auto" || readInteger(range.requestedPageEnd) !== 0 || readInteger(range.pageStart, 1) !== 1) return null;

  const lastPage = readInteger(range.detectedLastPage, 1);
  if (lastPage === null || readInteger(range.pageEnd, 1) !== lastPage) return null;
  const totalCount = readInteger(range.detectedTotalProductCount, 1);
  if (totalCount === null || readInteger(summary.detectedTotalProductCount, 1) !== totalCount ||
      readInteger(summary.collectedProductCount, 1) !== totalCount || summary.countMatched === false) return null;

  // 천유는 모든 차수의 페이지 합집합을 summary에, 마지막 차수의 페이지 수를 pageRange에 기록한다.
  const pages = summary.collectedPages;
  if (!Array.isArray(pages) || pages.length !== lastPage) return null;
  const pageNumbers = pages.map((page) => readInteger(page, 1));
  if (pageNumbers.some((page) => page === null || page > lastPage) || new Set(pageNumbers).size !== lastPage) return null;
  const lastCyclePageCount = readInteger(range.collectedPageCount, 1);
  if (lastCyclePageCount === null || lastCyclePageCount > lastPage) return null;

  if (sourceMall === "cheonyu") {
    const pageOrder = config.pageOrder === "reverse" ? "reverse" : "forward";
    // 재사용한 천유 범위는 stopReason을 지우므로, 여러 차수의 자연 종료에는 값이 없을 수 있다.
    const traversalStart = readInteger(range.traversalStartPage, 1);
    const completedResumedRange = range.stopReason === undefined &&
      readInteger(summary.cycleCount, 2) !== null && traversalStart !== null && traversalStart <= lastPage;
    if (range.pageOrder !== pageOrder ||
        (!completedResumedRange && !["completed-range", "limit-reached"].includes(range.stopReason))) return null;
    if (readInteger(range.collectedLastPage, 1) !== (pageOrder === "reverse" ? 1 : lastPage)) return null;
  } else {
    if (range.stopReason !== "completed-range" || summary.countMatched !== true ||
        readInteger(range.collectedLastPage, 1) !== lastPage || lastCyclePageCount !== lastPage) return null;
  }

  const products = result.products;
  if (!Array.isArray(products) || products.length !== totalCount) return null;
  const observedProductIds = [];
  const seen = new Set();
  for (const product of products) {
    if (!product || (product.sourceMall && product.sourceMall !== sourceMall)) return null;
    const value = product.productId;
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1)) return null;
    const id = String(value).trim();
    if (!/^\d+$/.test(id) || !/[1-9]/.test(id) || seen.has(id)) return null;
    seen.add(id);
    observedProductIds.push(id);
  }

  return { sourceMall, observedProductIds };
}

module.exports = { isFullCatalogRequested, getCompletedFullCatalogScan };

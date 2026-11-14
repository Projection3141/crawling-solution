// Persist completed detail pages without changing browser request scheduling.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

async function writeJsonAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function getCompletedCyclePages(products, pageRange) {
  const lastPage = Number(pageRange?.collectedLastPage);
  const partialLastPage = pageRange?.stopReason === "limit-reached" &&
    Number(pageRange?.resumePage) === lastPage ? lastPage : null;
  return Array.from(new Set(products.map((product) => Number(product.page))))
    .filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0 && pageNo !== partialLastPage);
}

function createDetailCheckpointWriter({
  config,
  files,
  createBackendProducts,
  updateProductArchive,
  getConversionSnapshot,
  getGeneralProducts = () => [],
  onProgress = () => {},
  writeJson = writeJsonAtomically,
}) {
  let savedPages = new Set();
  let detailProducts = new Map();
  let queue = Promise.resolve();

  async function savePage({ pageNo, pageRange, products = [], inventoryItems = [], detailItems = [] }) {
    if (!Number.isInteger(pageNo) || pageNo < 1) {
      throw new Error("상세 중간 저장 페이지 번호가 올바르지 않습니다.");
    }
    const savedAt = new Date().toISOString();
    // Keep the original page data even if later archive or conversion work fails.
    await writeJson(path.join(files.runDir, "detail-pages", `page-${String(pageNo).padStart(6, "0")}.json`), {
      mall: config.mall, pageNo, pageRange, savedAt, products, inventoryItems, detailItems,
    });
    const normalized = await createBackendProducts({
      consumerPriceOnly: config.consumerPriceOnly,
      collectionMode: "detail", products, inventoryItems, detailItems,
      lowStockThreshold: Number(config.lowStockThreshold) || 10,
    });
    const archive = await updateProductArchive(normalized, {
      source: "detail",
      includeDetailOptionStock: config.collectionKind === "newProducts",
      conversion: normalized.length ? await getConversionSnapshot() : null,
    });
    const nextProducts = new Map(detailProducts);
    for (const product of archive.currentProducts || []) nextProducts.set(String(product.id), product);
    const combined = new Map(getGeneralProducts().map((product) => [String(product.id), product]));
    for (const [id, product] of nextProducts) combined.set(id, product);
    await writeJson(files.detailResultJson, Array.from(nextProducts.values()));
    await writeJson(files.resultJson, Array.from(combined.values()));
    // Success bookkeeping remains at the original finalization point, after
    // translation. A failed run must not make pending mode skip unfinished work.

    const nextPages = new Set(savedPages).add(pageNo);
    const pageStart = Number(pageRange?.pageStart) || Number(config.pageStart) || pageNo;
    const pageEnd = Number(pageRange?.pageEnd) || Number(config.pageEnd) || pageNo;
    const reverse = config.mall === "cheonyu" && config.pageOrder === "reverse";
    let savedThroughPage = null;
    for (let candidate = reverse ? pageEnd : pageStart;
      reverse ? candidate >= pageStart : candidate <= pageEnd;
      candidate += reverse ? -1 : 1) {
      if (!nextPages.has(candidate)) break;
      savedThroughPage = candidate;
    }
    const savedCheckpoint = {
      phase: "detail", pageStart, pageEnd,
      pageOrder: reverse ? "desc" : "asc",
      savedThroughPage,
      savedPages: Array.from(nextPages).sort((a, b) => a - b),
      outputDirectory: files.runDir,
      files: { result: files.resultJson, detailResult: files.detailResultJson },
      savedAt,
    };
    await writeJson(path.join(files.runDir, "detail-checkpoint.json"), savedCheckpoint);
    savedPages = nextPages;
    detailProducts = nextProducts;
    onProgress({
      stage: "detail-page-saved",
      message: `상세 ${pageNo}페이지 수집 결과를 저장했습니다.`,
      savedCheckpoint,
    });
    return savedCheckpoint;
  }

  return {
    savePage(payload) {
      // Different workers can complete pages together; serialize only persistence.
      queue = queue.then(() => savePage(payload));
      return queue;
    },
  };
}

module.exports = { createDetailCheckpointWriter, writeJsonAtomically, getCompletedCyclePages };

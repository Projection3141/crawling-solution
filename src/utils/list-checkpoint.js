// Keep completed list pages recoverable before cart reconciliation or details finish.
const path = require("node:path");
const { writeJsonAtomically } = require("./detail-checkpoint");

function createListCheckpointWriter({ config, files, onProgress = () => {}, writeJson = writeJsonAtomically }) {
  let savedPages = new Map();
  let queue = Promise.resolve();

  async function savePage({ pageNo, pageRange, products = [], targets = [], popupOptionItems = [], excludedProducts = [], pageResult = null }) {
    if (!Number.isInteger(pageNo) || pageNo < 1) {
      throw new Error("목록 중간 저장 페이지 번호가 올바르지 않습니다.");
    }
    const savedAt = new Date().toISOString();
    const pageFile = path.join(files.runDir, "list-pages", `page-${String(pageNo).padStart(6, "0")}.json`);
    const incomplete = { dataKind: "raw-list", inventoryComplete: false, detailComplete: false };
    // Raw observations must not overwrite normalized inventory or mark a product's
    // detail collection as completed. Cart reconciliation is still pending here.
    await writeJson(pageFile, {
      version: 1, mall: config.mall, ...incomplete, pageNo, pageRange, savedAt,
      products, targets, popupOptionItems, excludedProducts, pageResult,
    });

    const nextPages = new Map(savedPages).set(pageNo, {
      pageNo, file: pageFile, productCount: products.length,
      popupOptionCount: popupOptionItems.length, savedAt,
    });
    const pageStart = Number(pageRange?.pageStart) || Number(config.pageStart) || pageNo;
    const pageEnd = Number(pageRange?.pageEnd) || Number(config.pageEnd) || pageNo;
    const reverse = config.pageOrder === "reverse";
    let savedThroughPage = null;
    for (let candidate = reverse ? pageEnd : pageStart;
      reverse ? candidate >= pageStart : candidate <= pageEnd;
      candidate += reverse ? -1 : 1) {
      if (!nextPages.has(candidate)) break;
      savedThroughPage = candidate;
    }
    const checkpointFile = path.join(files.runDir, "list-checkpoint.json");
    const checkpoint = {
      version: 1, phase: "list", ...incomplete, pageStart, pageEnd,
      pageOrder: reverse ? "desc" : "asc", savedThroughPage,
      savedPages: Array.from(nextPages.keys()).sort((a, b) => a - b),
      outputDirectory: files.runDir, files: { listCheckpoint: checkpointFile }, savedAt,
    };
    await writeJson(checkpointFile, {
      ...checkpoint,
      pages: Array.from(nextPages.values()).sort((a, b) => a.pageNo - b.pageNo),
      note: config.anonymousCollection
        ? "공개 목록 원본입니다. 상품 상세정보 수집과 최종 결과 변환의 완료를 뜻하지 않습니다."
        : "목록과 옵션 팝업의 원본입니다. 장바구니 재고 대조, 상세 수집 및 최종 결과 변환은 완료되지 않았습니다. 이 자료만으로 다음 페이지부터 자동 재개하지 않습니다.",
    });
    savedPages = nextPages;
    onProgress({
      stage: "list-page-saved",
      message: config.anonymousCollection
        ? `${pageNo}페이지 공개 목록을 저장했습니다. 대상 상품의 상세정보를 확인합니다.`
        : `${pageNo}페이지 목록 원본을 저장했습니다. 장바구니 재고·상세 수집은 계속 진행합니다.`,
      savedCheckpoint: checkpoint,
    });
    return checkpoint;
  }

  return {
    savePage(payload) {
      queue = queue.then(() => savePage(payload));
      return queue;
    },
  };
}

module.exports = { createListCheckpointWriter };

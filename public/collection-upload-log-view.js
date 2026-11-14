// 전송 로그 화면의 조회·렌더링·페이지 이동을 담당한다.
(() => {
  window.createCollectionUploadLogView = function createCollectionUploadLogView({
    document,
    getApi,
    showError,
  }) {
    const elements = {
      collectionUploadLogList: document.querySelector("#collectionUploadLogList"),
      collectionUploadLogPageInfo: document.querySelector("#collectionUploadLogPageInfo"),
      collectionUploadLogPreviousButton: document.querySelector("#collectionUploadLogPreviousButton"),
      collectionUploadLogNextButton: document.querySelector("#collectionUploadLogNextButton"),
      openCollectionUploadLogDirectoryButton: document.querySelector("#openCollectionUploadLogDirectoryButton"),
    };
    const state = {
      collectionUploadLogPage: 1,
      collectionUploadLogTotalPages: 1,
    };

    function formatCollectionUploadSentAt(value) {
      if (!value) return "시각 확인 불가";

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) return String(value);

      return new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(date);
    }

    function renderCollectionUploadLogs(result) {
      state.collectionUploadLogPage = result?.page || 1;
      state.collectionUploadLogTotalPages = result?.totalPages || 1;
      elements.collectionUploadLogList.replaceChildren();

      const items = Array.isArray(result?.items) ? result.items : [];

      if (items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "upload-log-empty";
        empty.textContent = "아직 저장된 수집정보 전송 로그가 없습니다.";
        elements.collectionUploadLogList.append(empty);
      } else {
        items.forEach((item) => {
          const article = document.createElement("article");
          article.className = "upload-log-item";

          const heading = document.createElement("div");
          heading.className = "upload-log-item-heading";
          const title = document.createElement("strong");
          title.textContent = `${item.type || "수집정보"} · ${formatCollectionUploadSentAt(item.sentAt)}`;
          const badge = document.createElement("span");
          badge.className = `upload-log-status ${item.success ? "success" : "error"}`;
          badge.textContent = item.success ? "요청 성공" : "요청 실패";
          heading.append(title, badge);

          const details = document.createElement("p");
          details.className = "upload-log-details";
          const itemCount = Number.isFinite(item.itemCount)
            ? `${item.itemCount.toLocaleString()}개`
            : "확인 불가";
          const status = item.status === null
            ? "응답 없음"
            : `HTTP ${item.status}`;
          details.textContent = `${item.method || "POST"} · 데이터 ${itemCount} · ${status} · ${item.dateDirectory}/${item.fileName}`;
          article.append(heading, details);

          if (item.sampleProductIds?.length > 0) {
            const sample = document.createElement("p");
            sample.className = "upload-log-sample";
            sample.textContent = `데이터 ID 예시: ${item.sampleProductIds.join(", ")}`;
            article.append(sample);
          }

          if (item.error) {
            const error = document.createElement("p");
            error.className = "upload-log-error";
            error.textContent = item.error;
            article.append(error);
          }

          elements.collectionUploadLogList.append(article);
        });
      }

      elements.collectionUploadLogPageInfo.textContent =
        `${state.collectionUploadLogPage} / ${state.collectionUploadLogTotalPages} · 총 ${(result?.totalCount || 0).toLocaleString()}건`;
      elements.collectionUploadLogPreviousButton.disabled =
        state.collectionUploadLogPage <= 1;
      elements.collectionUploadLogNextButton.disabled =
        state.collectionUploadLogPage >= state.collectionUploadLogTotalPages;
    }

    async function loadCollectionUploadLogs(page = 1) {
      try {
        const result = await getApi().getCollectionUploadLogs(page);
        renderCollectionUploadLogs(result);
      } catch (error) {
        elements.collectionUploadLogList.textContent =
          `전송 로그를 불러오지 못했습니다: ${error.message}`;
      }
    }

    function bindEvents() {
      elements.collectionUploadLogPreviousButton.addEventListener("click", () => {
        void loadCollectionUploadLogs(state.collectionUploadLogPage - 1);
      });
      elements.collectionUploadLogNextButton.addEventListener("click", () => {
        void loadCollectionUploadLogs(state.collectionUploadLogPage + 1);
      });
      elements.openCollectionUploadLogDirectoryButton.addEventListener(
        "click",
        async () => {
          try {
            await getApi().openCollectionUploadLogDirectory();
          } catch (error) {
            showError(`전송 로그 폴더를 열지 못했습니다: ${error.message}`);
          }
        },
      );
    }

    return { load: loadCollectionUploadLogs, bindEvents };
  };
})();

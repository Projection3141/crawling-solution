const elements = {
  form: document.querySelector("#collectorForm"),
  mall: document.querySelector("#mall"),
  category: document.querySelector("#category"),
  accountId: document.querySelector("#accountId"),
  accountPw: document.querySelector("#accountPw"),
  browserMode: document.querySelector("#browserMode"),
  outputDirectory: document.querySelector("#outputDirectory"),
  chooseOutputButton: document.querySelector("#chooseOutputButton"),
  openSettingsButton: document.querySelector("#openSettingsButton"),
  pageStart: document.querySelector("#pageStart"),
  pageEnd: document.querySelector("#pageEnd"),
  pageSize: document.querySelector("#pageSize"),
  runButton: document.querySelector("#runButton"),
  cancelButton: document.querySelector("#cancelButton"),
  mallHelp: document.querySelector("#mallHelp"),
  categoryHelp: document.querySelector("#categoryHelp"),
  envHint: document.querySelector("#envHint"),
  appBadge: document.querySelector("#appBadge"),
  statusBadge: document.querySelector("#statusBadge"),
  statusMessage: document.querySelector("#statusMessage"),
  errorMessage: document.querySelector("#errorMessage"),
  successMessage: document.querySelector("#successMessage"),
  progressBar: document.querySelector("#progressBar"),
  metricPages: document.querySelector("#metricPages"),
  metricDetected: document.querySelector("#metricDetected"),
  metricCollected: document.querySelector("#metricCollected"),
  metricTargets: document.querySelector("#metricTargets"),
  metricSummaries: document.querySelector("#metricSummaries"),
  metricSoldOut: document.querySelector("#metricSoldOut"),
  metricElapsed: document.querySelector("#metricElapsed"),
  saveInventoryButton: document.querySelector("#saveInventoryButton"),
  saveSummaryButton: document.querySelector("#saveSummaryButton"),
  saveProductsButton: document.querySelector("#saveProductsButton"),
  openResultDirectoryButton: document.querySelector(
    "#openResultDirectoryButton",
  ),
};

const state = {
  defaults: null,
  current: null,
  elapsedTimer: null,
  unsubscribe: null,
};

const RUNNING_STATUSES = new Set([
  "running",
  "canceling",
]);

const FILE_BUTTONS = {
  inventory: elements.saveInventoryButton,
  summary: elements.saveSummaryButton,
  products: elements.saveProductsButton,
};

/** 숫자형 입력이 비어 있지 않을 때만 payload에 추가한다. */
function setNumberIfPresent(payload, key, input) {
  if (input.value.trim() === "") return;
  payload[key] = Number(input.value);
}

/**
 * 화면 입력값으로 수집 payload를 생성한다.
 *
 * 비어 있는 값은 payload에 넣지 않으므로
 * main process의 공통 .env 설정이 다음 우선순위로 사용된다.
 */
function buildPayload() {
  const payload = {};

  if (elements.mall.value) {
    payload.mall = elements.mall.value;
  }

  if (elements.category.value.trim()) {
    payload.category =
      elements.category.value.trim();
  }

  if (elements.accountId.value.trim()) {
    payload.accountId =
      elements.accountId.value.trim();
  }

  if (elements.accountPw.value) {
    payload.accountPw =
      elements.accountPw.value;
  }

  if (elements.browserMode.value === "show") {
    payload.showBrowser = true;
  }

  if (elements.browserMode.value === "hide") {
    payload.showBrowser = false;
  }

  setNumberIfPresent(
    payload,
    "pageStart",
    elements.pageStart,
  );

  setNumberIfPresent(
    payload,
    "pageEnd",
    elements.pageEnd,
  );

  setNumberIfPresent(
    payload,
    "pageSize",
    elements.pageSize,
  );

  return payload;
}

/** 쇼핑몰 선택에 따라 카테고리 안내를 갱신한다. */
function updateMallHelp() {
  const selectedKey =
    elements.mall.value ||
    state.defaults?.envDefaults?.mall;

  const mall = state.defaults?.malls?.find(
    (item) => item.key === selectedKey,
  );

  if (!mall) return;

  elements.mallHelp.textContent =
    `${mall.label} · ${mall.baseUrl}`;

  elements.category.placeholder =
    `비우면 전체 카테고리 ${mall.defaultCategory} 사용`;

  elements.categoryHelp.textContent =
    `${mall.categoryLabel}: ${mall.categoryPlaceholder}`;
}

/** 실행 중에는 수집 설정을 잠그고 취소 버튼만 활성화한다. */
function setRunning(running) {
  elements.runButton.disabled = running;
  elements.runButton.textContent =
    running ? "수집 중..." : "수집 시작";

  elements.cancelButton.disabled = !running;
  elements.chooseOutputButton.disabled = running;

  for (const control of elements.form.querySelectorAll(
    "input:not([readonly]), select",
  )) {
    control.disabled = running;
  }
}

/** 상태 badge를 갱신한다. */
function setStatus(status) {
  const labels = {
    idle: "대기",
    running: "실행 중",
    canceling: "취소 중",
    canceled: "취소됨",
    completed: "완료",
    failed: "실패",
  };

  elements.statusBadge.className =
    `status-badge ${status || "idle"}`;

  elements.statusBadge.textContent =
    labels[status] || status || "대기";
}

/** 값이 없으면 하이픈을 표시한다. */
function displayNumber(value) {
  return value === null ||
    value === undefined ||
    value === ""
    ? "-"
    : Number(value).toLocaleString("ko-KR");
}

/** 밀리초를 사용자용 실행 시간 문자열로 변환한다. */
function formatElapsed(ms) {
  const value = Number(ms) || 0;

  if (value < 1000) {
    return `${Math.floor(value)}ms`;
  }

  if (value < 60000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor(
    (value % 60000) / 1000,
  );

  return `${minutes}m ${seconds}s`;
}

/** 수집 페이지 범위를 사용자 친화적인 문자열로 변환한다. */
function formatPageRange(progress, summary) {
  const range =
    progress?.pageRange ||
    summary?.pageRange;

  if (!range) return "-";

  const current =
    progress?.currentPage ||
    range.collectedLastPage;

  const start =
    range.pageStart ?? "-";

  const end =
    range.pageEnd ?? "-";

  return current
    ? `${start} ~ ${current} / ${end}`
    : `${start} ~ ${end}`;
}

/** 페이지 진행률을 계산한다. */
function getProgressPercent(currentState) {
  const status = currentState?.status;

  if (status === "completed") return 100;
  if (status === "canceled") return 0;
  if (status === "failed") return 0;

  const progress = currentState?.progress;
  const summary = currentState?.summary;
  const range =
    progress?.pageRange ||
    summary?.pageRange;

  const current =
    progress?.currentPage ||
    range?.collectedLastPage;

  if (!range || !current || !range.pageEnd) {
    return RUNNING_STATUSES.has(status) ? 8 : 0;
  }

  const total = Math.max(
    1,
    range.pageEnd - range.pageStart + 1,
  );

  const done = Math.max(
    0,
    current - range.pageStart + 1,
  );

  return Math.min(
    98,
    Math.max(5, (done / total) * 100),
  );
}

/** 완료된 결과 파일에 따라 저장 버튼을 활성화한다. */
function updateResultFiles(files) {
  let anyAvailable = false;

  for (const [fileType, button] of Object.entries(
    FILE_BUTTONS,
  )) {
    const available =
      Boolean(files?.[fileType]?.available);

    button.disabled = !available;
    button.classList.toggle(
      "disabled",
      !available,
    );

    anyAvailable ||= available;
  }

  elements.openResultDirectoryButton.disabled =
    !anyAvailable;
}

/** 오류 메시지를 표시한다. */
function showError(message) {
  clearSuccess();

  elements.errorMessage.hidden = false;
  elements.errorMessage.textContent = message;
}

/** 오류 메시지를 숨긴다. */
function clearError() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = "";
}

/** 성공 메시지를 표시한다. */
function showSuccess(message) {
  clearError();

  elements.successMessage.hidden = false;
  elements.successMessage.textContent = message;
}

/** 성공 메시지를 숨긴다. */
function clearSuccess() {
  elements.successMessage.hidden = true;
  elements.successMessage.textContent = "";
}

/** 실행 중에는 화면의 소요 시간을 계속 증가시킨다. */
function syncElapsedTicker(currentState) {
  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }

  if (
    !RUNNING_STATUSES.has(currentState?.status) ||
    !currentState?.startedAtMs
  ) {
    return;
  }

  state.elapsedTimer = window.setInterval(() => {
    elements.metricElapsed.textContent =
      formatElapsed(
        Date.now() - currentState.startedAtMs,
      );
  }, 500);
}

/** 수집 상태를 화면의 지표와 파일 버튼에 반영한다. */
function renderState(currentState) {
  state.current = currentState;

  const progress =
    currentState?.progress || {};

  const summary =
    currentState?.summary || {};

  const status =
    currentState?.status || "idle";

  setStatus(status);
  setRunning(RUNNING_STATUSES.has(status));

  elements.statusMessage.textContent =
    progress.message ||
    (status === "completed"
      ? "수집이 완료되었습니다."
      : "수집 설정을 입력한 뒤 시작하세요.");

  elements.metricPages.textContent =
    formatPageRange(progress, summary);

  elements.metricDetected.textContent =
    displayNumber(
      summary.detectedTotalProductCount ??
        progress.detectedTotalProductCount,
    );

  elements.metricCollected.textContent =
    displayNumber(
      summary.collectedProductCount ??
        progress.collectedProductCount,
    );

  elements.metricTargets.textContent =
    displayNumber(
      summary.targetProductCount ??
        progress.targetProductCount,
    );

  elements.metricSummaries.textContent =
    displayNumber(
      summary.productSummaryCount ??
        progress.productSummaryCount,
    );

  elements.metricSoldOut.textContent =
    displayNumber(
      summary.soldOutProductCount ??
        progress.soldOutProductCount,
    );

  elements.metricElapsed.textContent =
    progress.elapsedText ||
    summary.elapsedText ||
    formatElapsed(progress.elapsedMs);

  elements.progressBar.value =
    getProgressPercent(currentState);

  if (status === "failed") {
    showError(
      currentState.error ||
        progress.message ||
        "수집 작업이 실패했습니다.",
    );
  } else if (status === "canceled") {
    showSuccess("수집 작업을 취소했습니다.");
  } else {
    clearError();

    if (status !== "completed") {
      clearSuccess();
    }
  }

  updateResultFiles(currentState.files);
  syncElapsedTicker(currentState);
}

/** Electron main process에서 기본값과 앱 정보를 불러온다. */
async function loadDefaults() {
  const defaults =
    await window.collectorApp.getDefaults();

  state.defaults = defaults;

  for (const mall of defaults.malls) {
    const option =
      document.createElement("option");

    option.value = mall.key;
    option.textContent =
      `${mall.label} (${mall.baseUrl})`;

    elements.mall.append(option);
  }

  elements.outputDirectory.value =
    defaults.outputDirectory;

  elements.appBadge.textContent =
    `로컬 앱 v${defaults.app.version}`;

  elements.appBadge.classList.add(
    "connected",
  );

  const loadedEnvText =
    defaults.loadedEnvFiles.length > 0
      ? `${defaults.loadedEnvFiles.length}개 .env 로드`
      : ".env 미사용";

  const accountText =
    defaults.envDefaults.hasAccountId &&
    defaults.envDefaults.hasAccountPw
      ? "계정 설정됨"
      : "계정 미설정";

  elements.envHint.textContent =
    `${loadedEnvText} · ` +
    `기본 ${defaults.envDefaults.mall} · ` +
    `PAGE_END ${defaults.envDefaults.pageEnd} · ` +
    accountText;

  updateMallHelp();
}

/** 사용자가 결과 기본 폴더를 선택한다. */
async function chooseOutputDirectory() {
  clearError();
  clearSuccess();

  try {
    const result =
      await window.collectorApp.chooseOutputDirectory();

    elements.outputDirectory.value =
      result.outputDirectory;

    if (!result.canceled) {
      showSuccess("결과 기본 폴더를 변경했습니다.");
    }
  } catch (error) {
    showError(error.message);
  }
}

/** 새 수집 작업을 시작한다. */
async function handleSubmit(event) {
  event.preventDefault();

  clearError();
  clearSuccess();
  updateResultFiles(null);
  setRunning(true);
  setStatus("running");

  elements.statusMessage.textContent =
    "수집 작업을 준비하고 있습니다.";

  elements.progressBar.value = 3;

  const payload = buildPayload();

  /** 사용자 입력 비밀번호는 main process 호출 직후 화면에서 제거한다. */
  elements.accountPw.value = "";

  try {
    const currentState =
      await window.collectorApp.start(payload);

    renderState(currentState);
  } catch (error) {
    setRunning(false);
    setStatus("failed");
    showError(error.message);
  }
}

/** 현재 수집 작업을 정상 취소한다. */
async function cancelCollection() {
  clearError();
  clearSuccess();

  try {
    const currentState =
      await window.collectorApp.cancel();

    renderState(currentState);
  } catch (error) {
    showError(error.message);
  }
}

/** 결과 CSV 하나를 사용자 선택 경로로 복사한다. */
async function saveResultFile(fileType) {
  clearError();
  clearSuccess();

  try {
    const result =
      await window.collectorApp.saveResultFile(
        fileType,
      );

    if (!result.canceled) {
      showSuccess(
        `${result.fileName} 파일을 저장했습니다.`,
      );
    }
  } catch (error) {
    showError(error.message);
  }
}

/** 원본 결과 폴더를 파일 탐색기로 연다. */
async function openResultDirectory() {
  clearError();
  clearSuccess();

  try {
    await window.collectorApp.openResultDirectory();
  } catch (error) {
    showError(error.message);
  }
}

/** 사용자 .env 파일이 위치하는 설정 폴더를 연다. */
async function openSettingsDirectory() {
  clearError();
  clearSuccess();

  try {
    await window.collectorApp.openSettingsDirectory();

    showSuccess(
      "설정 폴더를 열었습니다. .env.example을 복사해 .env로 사용할 수 있습니다.",
    );
  } catch (error) {
    showError(error.message);
  }
}

/** Electron preload API 존재 여부를 확인하고 화면을 초기화한다. */
async function initialize() {
  if (!window.collectorApp) {
    throw new Error(
      "Electron preload API를 찾지 못했습니다.",
    );
  }

  state.unsubscribe =
    window.collectorApp.onStateChanged(
      renderState,
    );

  await loadDefaults();

  const currentState =
    await window.collectorApp.getState();

  renderState(currentState);
}

elements.form.addEventListener(
  "submit",
  handleSubmit,
);

elements.mall.addEventListener(
  "change",
  updateMallHelp,
);

elements.chooseOutputButton.addEventListener(
  "click",
  chooseOutputDirectory,
);

elements.cancelButton.addEventListener(
  "click",
  cancelCollection,
);

elements.openSettingsButton.addEventListener(
  "click",
  openSettingsDirectory,
);

elements.openResultDirectoryButton.addEventListener(
  "click",
  openResultDirectory,
);

elements.saveInventoryButton.addEventListener(
  "click",
  () => saveResultFile("inventory"),
);

elements.saveSummaryButton.addEventListener(
  "click",
  () => saveResultFile("summary"),
);

elements.saveProductsButton.addEventListener(
  "click",
  () => saveResultFile("products"),
);

window.addEventListener("beforeunload", () => {
  state.unsubscribe?.();

  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
  }
});

initialize().catch((error) => {
  elements.appBadge.textContent =
    "초기화 실패";

  setStatus("failed");
  showError(error.message);
});
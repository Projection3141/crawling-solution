// public/app.js

const ACCOUNT_STORAGE_KEY = "mall-collector-accounts-v1";
const SELECTED_ACCOUNT_STORAGE_KEY = "mall-collector-selected-account-id";

const elements = {
  form: document.querySelector("#collectorForm"),
  mall: document.querySelector("#mall"),
  category: document.querySelector("#category"),
  accountSelect: document.querySelector("#accountSelect"),
  accountHelp: document.querySelector("#accountHelp"),
  openAccountManagerButton: document.querySelector("#openAccountManagerButton"),
  accountManagerModal: document.querySelector("#accountManagerModal"),
  closeAccountManagerButton: document.querySelector("#closeAccountManagerButton"),
  cancelAccountManagerButton: document.querySelector("#cancelAccountManagerButton"),
  accountRegisterName: document.querySelector("#accountRegisterName"),
  accountRegisterId: document.querySelector("#accountRegisterId"),
  accountRegisterPw: document.querySelector("#accountRegisterPw"),
  registerAccountButton: document.querySelector("#registerAccountButton"),
  accountList: document.querySelector("#accountList"),
  collectionMode: document.querySelector("#collectionMode"),
  collectionModeHelp: document.querySelector("#collectionModeHelp"),
  generalGuide: document.querySelector("#generalGuide"),
  detailGuide: document.querySelector("#detailGuide"),
  runMode: document.querySelector("#runMode"),
  runModeHelp: document.querySelector("#runModeHelp"),
  repeatSettings: document.querySelector("#repeatSettings"),
  repeatValue: document.querySelector("#repeatValue"),
  repeatUnit: document.querySelector("#repeatUnit"),
  browserMode: document.querySelector("#browserMode"),
  outputDirectory: document.querySelector("#outputDirectory"),
  chooseOutputButton: document.querySelector("#chooseOutputButton"),
  openSettingsButton: document.querySelector("#openSettingsButton"),
  pageStart: document.querySelector("#pageStart"),
  pageEnd: document.querySelector("#pageEnd"),
  detailMaxProducts: document.querySelector("#detailMaxProducts"),
  detailRequestDelayMs: document.querySelector("#detailRequestDelayMs"),
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
  metricDetails: document.querySelector("#metricDetails"),
  metricDetected: document.querySelector("#metricDetected"),
  metricCollected: document.querySelector("#metricCollected"),
  metricTargets: document.querySelector("#metricTargets"),
  metricSummaries: document.querySelector("#metricSummaries"),
  metricSoldOut: document.querySelector("#metricSoldOut"),
  metricElapsed: document.querySelector("#metricElapsed"),
  saveInventoryButton: document.querySelector("#saveInventoryButton"),
  saveSummaryButton: document.querySelector("#saveSummaryButton"),
  saveProductsButton: document.querySelector("#saveProductsButton"),
  saveDetailsButton: document.querySelector("#saveDetailsButton"),
  openResultDirectoryButton: document.querySelector("#openResultDirectoryButton"),
};

const state = {
  defaults: null,
  current: null,
  accounts: [],
  elapsedTimer: null,
  unsubscribe: null,
  repeat: {
    active: false,
    timerId: null,
    basePayload: null,
    lastScheduledJobKey: "",
    nextRunAt: null,
  },
};

const RUNNING_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "canceling",
]);

const FILE_BUTTONS = {
  inventory: elements.saveInventoryButton,
  summary: elements.saveSummaryButton,
  products: elements.saveProductsButton,
  details: elements.saveDetailsButton,
};

function createAccountId() {
  return `account_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function readStoredAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatDetailProgress(progress, summary) {
  const target =
    progress?.detailTargetCount ??
    summary?.detailTargetCount ??
    0;

  if (!target) return "-";

  const current =
    progress?.currentDetailIndex ??
    summary?.detailItemCount ??
    0;

  return `${displayNumber(current)} / ${displayNumber(target)}`;
}

function writeStoredAccounts(accounts) {
  localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
}

function maskPassword(password) {
  const text = String(password || "");

  if (!text) return "";
  if (text.length <= 2) return "*".repeat(text.length);

  return `${text.slice(0, 1)}${"*".repeat(Math.max(text.length - 2, 4))}${text.slice(-1)}`;
}

function loadAccounts() {
  state.accounts = readStoredAccounts();
  renderAccountSelect();
  renderAccountList();
  updateEnvHint();
}

function getSelectedAccount() {
  const selectedId = elements.accountSelect.value;
  if (!selectedId) return null;
  return state.accounts.find((account) => account.id === selectedId) || null;
}

function renderAccountSelect() {
  const savedSelectedId = localStorage.getItem(SELECTED_ACCOUNT_STORAGE_KEY) || "";
  const currentValue = elements.accountSelect.value || savedSelectedId;
  const hasSavedAccount = state.accounts.some((account) => account.id === currentValue);

  elements.accountSelect.replaceChildren();

  const envOption = document.createElement("option");
  envOption.value = "";
  envOption.textContent = ".env 계정 사용";
  elements.accountSelect.append(envOption);

  for (const account of state.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    elements.accountSelect.append(option);
  }

  elements.accountSelect.value = hasSavedAccount ? currentValue : "";
  updateAccountHelp();
}

function renderAccountList() {
  elements.accountList.replaceChildren();

  if (state.accounts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "등록된 계정이 없습니다.";
    elements.accountList.append(empty);
    return;
  }

  for (const account of state.accounts) {
    const item = document.createElement("article");
    item.className = "account-item";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    const loginId = document.createElement("span");
    const password = document.createElement("span");

    name.textContent = account.name;
    loginId.textContent = `ID: ${account.loginId}`;
    password.textContent = `PW: ${maskPassword(account.password)}`;

    info.append(name, loginId, password);

    const actions = document.createElement("div");
    actions.className = "account-actions";

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "secondary-button";
    renameButton.textContent = "이름 변경";
    renameButton.addEventListener("click", () => renameAccount(account.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", () => deleteAccount(account.id));

    actions.append(renameButton, deleteButton);
    item.append(info, actions);
    elements.accountList.append(item);
  }
}

function updateAccountHelp() {
  const account = getSelectedAccount();

  if (account) {
    elements.accountHelp.textContent = `${account.name} 계정으로 실행합니다. ID: ${account.loginId}`;
    localStorage.setItem(SELECTED_ACCOUNT_STORAGE_KEY, account.id);
    return;
  }

  localStorage.removeItem(SELECTED_ACCOUNT_STORAGE_KEY);

  const envAccountReady =
    state.defaults?.envDefaults?.hasAccountId &&
    state.defaults?.envDefaults?.hasAccountPw;

  elements.accountHelp.textContent = envAccountReady
    ? "등록 계정을 선택하지 않으면 공통 .env 계정을 사용합니다."
    : "등록 계정을 선택하세요. .env 계정은 현재 설정되어 있지 않습니다.";
}

function registerAccount() {
  clearError();
  clearSuccess();

  const name = normalizeText(elements.accountRegisterName.value);
  const loginId = normalizeText(elements.accountRegisterId.value);
  const password = String(elements.accountRegisterPw.value || "");

  if (!name) {
    showError("등록할 이름을 입력하세요.");
    return;
  }

  if (!loginId) {
    showError("계정 ID를 입력하세요.");
    return;
  }

  if (!password) {
    showError("계정 비밀번호를 입력하세요.");
    return;
  }

  if (state.accounts.some((account) => account.name === name)) {
    showError("이미 같은 이름의 계정이 있습니다.");
    return;
  }

  const now = new Date().toISOString();
  const account = {
    id: createAccountId(),
    name,
    loginId,
    password,
    createdAt: now,
    updatedAt: now,
  };

  state.accounts = [...state.accounts, account];
  writeStoredAccounts(state.accounts);

  elements.accountRegisterName.value = "";
  elements.accountRegisterId.value = "";
  elements.accountRegisterPw.value = "";

  renderAccountSelect();
  elements.accountSelect.value = account.id;
  updateAccountHelp();
  renderAccountList();
  showSuccess(`"${account.name}" 계정을 등록했습니다.`);
}

function renameAccount(accountId) {
  clearError();
  clearSuccess();

  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;

  const nextName = normalizeText(window.prompt("변경할 이름을 입력하세요.", account.name));

  if (!nextName || nextName === account.name) return;

  if (state.accounts.some((item) => item.id !== accountId && item.name === nextName)) {
    showError("이미 같은 이름의 계정이 있습니다.");
    return;
  }

  state.accounts = state.accounts.map((item) =>
    item.id === accountId
      ? {
        ...item,
        name: nextName,
        updatedAt: new Date().toISOString(),
      }
      : item,
  );

  writeStoredAccounts(state.accounts);
  renderAccountSelect();
  elements.accountSelect.value = accountId;
  updateAccountHelp();
  renderAccountList();
  showSuccess("계정 이름을 변경했습니다.");
}

function deleteAccount(accountId) {
  clearError();
  clearSuccess();

  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;

  if (!window.confirm(`"${account.name}" 계정을 삭제하시겠습니까?`)) {
    return;
  }

  state.accounts = state.accounts.filter((item) => item.id !== accountId);
  writeStoredAccounts(state.accounts);

  if (elements.accountSelect.value === accountId) {
    elements.accountSelect.value = "";
    localStorage.removeItem(SELECTED_ACCOUNT_STORAGE_KEY);
  }

  renderAccountSelect();
  renderAccountList();
  updateAccountHelp();
  showSuccess("계정을 삭제했습니다.");
}

function openAccountManager() {
  clearError();
  clearSuccess();
  elements.accountManagerModal.hidden = false;
  elements.accountRegisterName.focus();
}

function closeAccountManager() {
  elements.accountManagerModal.hidden = true;
}

/** 숫자형 입력이 비어 있지 않을 때만 payload에 추가한다. */
function setNumberIfPresent(payload, key, input) {
  if (!input || input.value.trim() === "") return;
  payload[key] = Number(input.value);
}

function getExecutionOptions() {
  const runMode = elements.runMode.value === "repeat" ? "repeat" : "once";
  const repeatUnit = ["hour", "day", "week"].includes(elements.repeatUnit.value)
    ? elements.repeatUnit.value
    : "hour";
  const repeatValue = Math.max(1, Math.trunc(Number(elements.repeatValue.value || 1)));

  return {
    runMode,
    repeatUnit,
    repeatValue,
  };
}

function getRepeatIntervalMs(options) {
  const value = Math.max(1, Number(options.repeatValue || 1));

  if (options.repeatUnit === "day") return value * 24 * 60 * 60 * 1000;
  if (options.repeatUnit === "week") return value * 7 * 24 * 60 * 60 * 1000;

  return value * 60 * 60 * 1000;
}

function formatRepeatUnit(unit) {
  if (unit === "day") return "일";
  if (unit === "week") return "주";
  return "시간";
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
    payload.category = elements.category.value.trim();
  }

  const selectedAccount = getSelectedAccount();

  if (selectedAccount) {
    payload.accountId = selectedAccount.loginId;
    payload.accountPw = selectedAccount.password;
    payload.accountName = selectedAccount.name;
    payload.localCredentialId = selectedAccount.id;
  }

  payload.collectionMode = elements.collectionMode.value === "detail" ? "detail" : "general";
  payload.executionOptions = getExecutionOptions();

  if (elements.browserMode.value === "show") {
    payload.showBrowser = true;
  }

  if (elements.browserMode.value === "hide") {
    payload.showBrowser = false;
  }

  setNumberIfPresent(payload, "pageStart", elements.pageStart);
  setNumberIfPresent(payload, "pageEnd", elements.pageEnd);
  setNumberIfPresent(payload, "detailMaxProducts", elements.detailMaxProducts);
  setNumberIfPresent(payload, "detailRequestDelayMs", elements.detailRequestDelayMs);

  return payload;
}

/** 쇼핑몰 선택에 따라 카테고리 안내를 갱신한다. */
function updateMallHelp() {
  const selectedKey = elements.mall.value || state.defaults?.envDefaults?.mall;
  const mall = state.defaults?.malls?.find((item) => item.key === selectedKey);

  if (!mall) return;

  elements.mallHelp.textContent = `${mall.label} · ${mall.baseUrl}`;
  elements.category.placeholder = `비우면 전체 카테고리 ${mall.defaultCategory} 사용`;
  elements.categoryHelp.textContent = `${mall.categoryLabel}: ${mall.categoryPlaceholder}`;
}

function updateCollectionModeGuide() {
  const isDetail = elements.collectionMode.value === "detail";

  elements.collectionModeHelp.textContent = isDetail
    ? "상세 수집은 일반 수집 후 각 상품 상세페이지까지 진입합니다."
    : "일반 수집은 목록과 장바구니 기반 재고 데이터를 빠르게 수집합니다.";

  elements.generalGuide.classList.toggle("active", !isDetail);
  elements.detailGuide.classList.toggle("active", isDetail);
}

function updateRunModeGuide() {
  const isRepeat = elements.runMode.value === "repeat";

  elements.repeatSettings.hidden = !isRepeat;
  elements.runModeHelp.textContent = isRepeat
    ? "수집 완료 후 지정한 주기만큼 대기하고 다시 실행합니다."
    : "1회 실행은 수집 완료 후 자동 종료됩니다.";
}

function updateEnvHint() {
  if (!state.defaults) return;

  const loadedEnvText =
    state.defaults.loadedEnvFiles.length > 0
      ? `${state.defaults.loadedEnvFiles.length}개 .env 로드`
      : ".env 미사용";

  const envAccountText =
    state.defaults.envDefaults.hasAccountId && state.defaults.envDefaults.hasAccountPw
      ? "환경 계정 설정됨"
      : "환경 계정 미설정";

  const localAccountText = `등록 계정 ${state.accounts.length}개`;

  elements.envHint.textContent =
    `${loadedEnvText} · ` +
    `기본 ${state.defaults.envDefaults.mall} · ` +
    `PAGE_END ${state.defaults.envDefaults.pageEnd} · ` +
    `${envAccountText} · ` +
    localAccountText;
}

/** 실행 중에는 수집 설정을 잠그고 취소 버튼만 활성화한다. */
function setRunning(locked) {
  elements.runButton.disabled = locked;

  const currentStatus = state.current?.status;
  const repeatWaiting = state.repeat.active && !RUNNING_STATUSES.has(currentStatus);

  elements.runButton.textContent = repeatWaiting
    ? "반복 예약 중..."
    : locked
      ? "수집 중..."
      : "수집 시작";

  elements.cancelButton.disabled = !locked;
  elements.cancelButton.textContent = state.repeat.active ? "반복 중지" : "수집 취소";
  elements.chooseOutputButton.disabled = locked;
  elements.openAccountManagerButton.disabled = locked;

  for (const control of elements.form.querySelectorAll("input:not([readonly]), select")) {
    control.disabled = locked;
  }
}

/** 상태 badge를 갱신한다. */
function setStatus(status) {
  const labels = {
    idle: "대기",
    queued: "대기 중",
    running: "실행 중",
    waiting: "반복 대기",
    canceling: "취소 중",
    canceled: "취소됨",
    stopped: "중지됨",
    completed: "완료",
    failed: "실패",
  };

  elements.statusBadge.className = `status-badge ${status || "idle"}`;
  elements.statusBadge.textContent = labels[status] || status || "대기";
}

/** 값이 없으면 하이픈을 표시한다. */
function displayNumber(value) {
  return value === null || value === undefined || value === ""
    ? "-"
    : Number(value).toLocaleString("ko-KR");
}

/** 밀리초를 사용자용 실행 시간 문자열로 변환한다. */
function formatElapsed(ms) {
  const value = Number(ms) || 0;

  if (value < 1000) return `${Math.floor(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;

  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);

  return `${minutes}m ${seconds}s`;
}

/** 수집 페이지 범위를 사용자 친화적인 문자열로 변환한다. */
function formatPageRange(progress, summary) {
  const range = progress?.pageRange || summary?.pageRange;

  if (!range) return "-";

  const current = progress?.currentPage || range.collectedLastPage;
  const start = range.pageStart ?? "-";
  const end = range.pageEnd ?? "-";

  return current ? `${start} ~ ${current} / ${end}` : `${start} ~ ${end}`;
}

/** 페이지 진행률을 계산한다. */
function getProgressPercent(currentState) {
  const status = currentState?.status;

  if (status === "completed") return 100;
  if (["canceled", "stopped", "failed"].includes(status)) return 0;

  const progress = currentState?.progress;
  const summary = currentState?.summary;
  const range = progress?.pageRange || summary?.pageRange;
  const current = progress?.currentPage || range?.collectedLastPage;

  if (!range || !current || !range.pageEnd) {
    return RUNNING_STATUSES.has(status) ? 8 : 0;
  }

  const total = Math.max(1, range.pageEnd - range.pageStart + 1);
  const done = Math.max(0, current - range.pageStart + 1);

  if (
    currentState?.progress?.stage === "detail" &&
    currentState.progress.detailTargetCount
  ) {
    const current = Number(currentState.progress.currentDetailIndex || 0);
    const total = Number(currentState.progress.detailTargetCount || 1);

    return Math.min(
      99,
      Math.max(5, (current / total) * 100),
    );
  }

  return Math.min(98, Math.max(5, (done / total) * 100));
}

/** 완료된 결과 파일에 따라 저장 버튼을 활성화한다. */
function updateResultFiles(files) {
  let anyAvailable = false;

  for (const [fileType, button] of Object.entries(FILE_BUTTONS)) {
    const available = Boolean(files?.[fileType]?.available);

    button.disabled = !available;
    button.classList.toggle("disabled", !available);
    anyAvailable ||= available;
  }

  elements.openResultDirectoryButton.disabled = !anyAvailable;
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

function clearRepeatTimer() {
  if (!state.repeat.timerId) return;

  window.clearTimeout(state.repeat.timerId);
  state.repeat.timerId = null;
  state.repeat.nextRunAt = null;
}

function stopRepeatScheduler() {
  clearRepeatTimer();
  state.repeat.active = false;
  state.repeat.basePayload = null;
  state.repeat.lastScheduledJobKey = "";
  state.repeat.nextRunAt = null;
}

function getCurrentJobKey(currentState) {
  return String(
    currentState?.id ||
    currentState?.jobId ||
    currentState?.runId ||
    currentState?.summary?.finishedAt ||
    currentState?.summary?.startedAt ||
    "",
  );
}

function maybeScheduleRepeat(currentState) {
  if (!state.repeat.active || !state.repeat.basePayload) return;
  if (currentState?.status !== "completed") return;
  if (state.repeat.timerId) return;

  const jobKey = getCurrentJobKey(currentState);

  if (jobKey && state.repeat.lastScheduledJobKey === jobKey) {
    return;
  }

  state.repeat.lastScheduledJobKey = jobKey;

  const executionOptions = state.repeat.basePayload.executionOptions || getExecutionOptions();
  const intervalMs = getRepeatIntervalMs(executionOptions);
  const nextRunAt = new Date(Date.now() + intervalMs);

  state.repeat.nextRunAt = nextRunAt.toISOString();
  setStatus("waiting");
  setRunning(true);
  elements.statusMessage.textContent =
    `다음 반복 실행 대기 중: ${nextRunAt.toLocaleString("ko-KR")} ` +
    `(${executionOptions.repeatValue}${formatRepeatUnit(executionOptions.repeatUnit)} 후)`;

  state.repeat.timerId = window.setTimeout(async () => {
    state.repeat.timerId = null;

    if (!state.repeat.active || !state.repeat.basePayload) return;

    try {
      clearError();
      clearSuccess();
      setStatus("running");
      setRunning(true);
      elements.statusMessage.textContent = "반복 수집 작업을 준비하고 있습니다.";
      elements.progressBar.value = 3;

      const nextState = await window.collectorApp.start({
        ...state.repeat.basePayload,
      });

      handleStateChanged(nextState);
    } catch (error) {
      stopRepeatScheduler();
      setRunning(false);
      setStatus("failed");
      showError(error.message);
    }
  }, intervalMs);
}

/** 실행 중에는 화면의 소요 시간을 계속 증가시킨다. */
function syncElapsedTicker(currentState) {
  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }

  if (!RUNNING_STATUSES.has(currentState?.status) || !currentState?.startedAtMs) {
    return;
  }

  state.elapsedTimer = window.setInterval(() => {
    elements.metricElapsed.textContent = formatElapsed(Date.now() - currentState.startedAtMs);
  }, 500);
}

/** 수집 상태를 화면의 지표와 파일 버튼에 반영한다. */
function renderState(currentState) {
  state.current = currentState;

  const progress = currentState?.progress || {};
  const summary = currentState?.summary || {};
  const status = currentState?.status || "idle";
  const locked = RUNNING_STATUSES.has(status) || state.repeat.active;

  setStatus(status);
  setRunning(locked);

  elements.statusMessage.textContent =
    progress.message ||
    (status === "completed"
      ? "수집이 완료되었습니다."
      : "수집 설정을 입력한 뒤 시작하세요.");

  elements.metricPages.textContent = formatPageRange(progress, summary);

  elements.metricDetected.textContent = displayNumber(
    summary.detectedTotalProductCount ?? progress.detectedTotalProductCount,
  );

  elements.metricCollected.textContent = displayNumber(
    summary.collectedProductCount ?? progress.collectedProductCount,
  );

  elements.metricTargets.textContent = displayNumber(
    summary.targetProductCount ?? progress.targetProductCount,
  );

  elements.metricDetails.textContent =
    formatDetailProgress(progress, summary);

  elements.metricSummaries.textContent = displayNumber(
    summary.productSummaryCount ?? progress.productSummaryCount,
  );

  elements.metricSoldOut.textContent = displayNumber(
    summary.soldOutProductCount ?? progress.soldOutProductCount,
  );

  elements.metricElapsed.textContent =
    progress.elapsedText || summary.elapsedText || formatElapsed(progress.elapsedMs);

  elements.progressBar.value = getProgressPercent(currentState);

  if (status === "failed") {
    stopRepeatScheduler();
    showError(currentState.error || progress.message || "수집 작업이 실패했습니다.");
  } else if (status === "canceled" || status === "stopped") {
    stopRepeatScheduler();
    showSuccess("수집 작업을 중지했습니다.");
  } else {
    clearError();

    if (status !== "completed") {
      clearSuccess();
    }
  }

  updateResultFiles(currentState.files);
  syncElapsedTicker(currentState);
}

function handleStateChanged(currentState) {
  renderState(currentState);
  maybeScheduleRepeat(currentState);
}

/** Electron main process에서 기본값과 앱 정보를 불러온다. */
async function loadDefaults() {
  const defaults = await window.collectorApp.getDefaults();
  state.defaults = defaults;

  for (const mall of defaults.malls) {
    const option = document.createElement("option");
    option.value = mall.key;
    option.textContent = `${mall.label} (${mall.baseUrl})`;
    elements.mall.append(option);
  }

  elements.outputDirectory.value = defaults.outputDirectory;
  elements.appBadge.textContent = `로컬 앱 v${defaults.app.version}`;
  elements.appBadge.classList.add("connected");

  updateEnvHint();
  updateMallHelp();
  updateAccountHelp();
}

/** 사용자가 결과 기본 폴더를 선택한다. */
async function chooseOutputDirectory() {
  clearError();
  clearSuccess();

  try {
    const result = await window.collectorApp.chooseOutputDirectory();
    elements.outputDirectory.value = result.outputDirectory;

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

  elements.statusMessage.textContent = "수집 작업을 준비하고 있습니다.";
  elements.progressBar.value = 3;

  const payload = buildPayload();

  state.repeat.active = payload.executionOptions.runMode === "repeat";
  state.repeat.basePayload = state.repeat.active ? { ...payload } : null;
  state.repeat.lastScheduledJobKey = "";
  clearRepeatTimer();

  try {
    const currentState = await window.collectorApp.start(payload);
    handleStateChanged(currentState);
  } catch (error) {
    stopRepeatScheduler();
    setRunning(false);
    setStatus("failed");
    showError(error.message);
  }
}

/** 현재 수집 작업 또는 반복 예약을 정상 취소한다. */
async function cancelCollection() {
  clearError();
  clearSuccess();

  const shouldCancelCurrentJob = RUNNING_STATUSES.has(state.current?.status);
  stopRepeatScheduler();

  if (!shouldCancelCurrentJob) {
    setRunning(false);
    setStatus("stopped");
    elements.statusMessage.textContent = "반복 실행 예약을 중지했습니다.";
    showSuccess("반복 실행 예약을 중지했습니다.");
    return;
  }

  try {
    const currentState = await window.collectorApp.cancel();
    handleStateChanged(currentState);
  } catch (error) {
    showError(error.message);
  }
}

/** 결과 CSV 하나를 사용자 선택 경로로 복사한다. */
async function saveResultFile(fileType) {
  clearError();
  clearSuccess();

  try {
    const result = await window.collectorApp.saveResultFile(fileType);

    if (!result.canceled) {
      showSuccess(`${result.fileName} 파일을 저장했습니다.`);
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
    showSuccess("설정 폴더를 열었습니다. .env.example을 복사해 .env로 사용할 수 있습니다.");
  } catch (error) {
    showError(error.message);
  }
}

/** Electron preload API 존재 여부를 확인하고 화면을 초기화한다. */
async function initialize() {
  if (!window.collectorApp) {
    throw new Error("Electron preload API를 찾지 못했습니다.");
  }

  state.unsubscribe = window.collectorApp.onStateChanged(handleStateChanged);

  await loadDefaults();
  loadAccounts();
  updateCollectionModeGuide();
  updateRunModeGuide();

  const currentState = await window.collectorApp.getState();
  handleStateChanged(currentState);
}

elements.form.addEventListener("submit", handleSubmit);
elements.mall.addEventListener("change", updateMallHelp);
elements.accountSelect.addEventListener("change", updateAccountHelp);
elements.openAccountManagerButton.addEventListener("click", openAccountManager);
elements.closeAccountManagerButton.addEventListener("click", closeAccountManager);
elements.cancelAccountManagerButton.addEventListener("click", closeAccountManager);
elements.registerAccountButton.addEventListener("click", registerAccount);
elements.collectionMode.addEventListener("change", updateCollectionModeGuide);
elements.runMode.addEventListener("change", updateRunModeGuide);
elements.chooseOutputButton.addEventListener("click", chooseOutputDirectory);
elements.cancelButton.addEventListener("click", cancelCollection);
elements.openSettingsButton.addEventListener("click", openSettingsDirectory);
elements.openResultDirectoryButton.addEventListener("click", openResultDirectory);
elements.saveInventoryButton.addEventListener("click", () => saveResultFile("inventory"));
elements.saveSummaryButton.addEventListener("click", () => saveResultFile("summary"));
elements.saveProductsButton.addEventListener("click", () => saveResultFile("products"));
elements.saveDetailsButton.addEventListener("click", () => saveResultFile("details"));

elements.accountManagerModal.addEventListener("click", (event) => {
  if (event.target === elements.accountManagerModal) {
    closeAccountManager();
  }
});

window.addEventListener("beforeunload", () => {
  state.unsubscribe?.();
  clearRepeatTimer();

  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
  }
});

initialize().catch((error) => {
  elements.appBadge.textContent = "초기화 실패";
  setStatus("failed");
  showError(error.message);
});

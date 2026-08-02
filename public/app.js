// public/app.js

const ACCOUNT_STORAGE_KEY = "mall-collector-accounts-v1";
const SELECTED_ACCOUNT_STORAGE_KEY = "mall-collector-selected-account-id";

const CART_ACCOUNT_STORAGE_KEYS = Object.freeze({
  cheonyu: "mall-collector-cart-account-cheonyu",
  ccdome: "mall-collector-cart-account-ccdome",
});

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
  mallHelp: document.querySelector("#mallHelp"),
  categoryHelp: document.querySelector("#categoryHelp"),
  envHint: document.querySelector("#envHint"),
  appBadge: document.querySelector("#appBadge"),

  activeRunCount: document.querySelector("#activeRunCount"),
  runList: document.querySelector("#runList"),
  errorMessage: document.querySelector("#errorMessage"),
  successMessage: document.querySelector("#successMessage"),

  saveInventoryButton: document.querySelector("#saveInventoryButton"),
  saveSummaryButton: document.querySelector("#saveSummaryButton"),
  saveProductsButton: document.querySelector("#saveProductsButton"),
  saveDetailsButton: document.querySelector("#saveDetailsButton"),
  openResultDirectoryButton: document.querySelector("#openResultDirectoryButton"),

  cartCheonyuAccountSelect:
    document.querySelector("#cartCheonyuAccountSelect"),
  cartCcdomeAccountSelect:
    document.querySelector("#cartCcdomeAccountSelect"),
  cartUploadButton:
    document.querySelector("#cartUploadButton"),
  cartUploadMessage:
    document.querySelector("#cartUploadMessage"),
};

const state = {
  defaults: null,
  accounts: [],
  applicationState: {
    runs: [],
    activeRunCount: 0,
    latestCompletedRunId: "",
    cart: {
      running: false,
      lockedAccountKeys: [],
    },
  },
  unsubscribe: null,
  elapsedTimer: null,
  latestResultRunId: "",
  repeatPlans: new Map(),
  repeatTimers: new Map(),
};

const RUNNING_STATUSES = new Set([
  "queued",
  "running",
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

/** 사이트별 장바구니 계정 선택 목록을 갱신한다. */
function renderCartAccountSelects() {
  const targets = [
    {
      site: "cheonyu",
      label: "천유닷컴",
      select: elements.cartCheonyuAccountSelect,
    },
    {
      site: "ccdome",
      label: "과자생각",
      select: elements.cartCcdomeAccountSelect,
    },
  ];

  for (const target of targets) {
    if (!target.select) continue;

    const previousValue =
      target.select.value ||
      localStorage.getItem(CART_ACCOUNT_STORAGE_KEYS[target.site]) ||
      "";

    target.select.replaceChildren();

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = `${target.label} 계정 선택`;
    target.select.append(emptyOption);

    for (const account of state.accounts) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = `${account.name} (${account.loginId})`;
      target.select.append(option);
    }

    if (state.accounts.some((account) => account.id === previousValue)) {
      target.select.value = previousValue;
    }
  }
}

function loadAccounts() {
  state.accounts = readStoredAccounts();
  renderAccountSelect();
  renderAccountList();
  renderCartAccountSelects();
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
  renderCartAccountSelects();
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
  renderCartAccountSelects();
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
  renderCartAccountSelects();
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

/** 수집 시작 IPC를 요청하는 짧은 동안만 시작 버튼을 잠근다. */
function setSubmitting(submitting) {
  elements.runButton.disabled = submitting;
  elements.runButton.textContent = submitting
    ? "실행 추가 중..."
    : "수집 실행 추가";
}

/** 실행 상태명을 사용자용 문자열로 변환한다. */
function getStatusLabel(status) {
  const labels = {
    idle: "대기",
    queued: "대기 중",
    running: "실행 중",
    canceling: "취소 중",
    canceled: "취소됨",
    completed: "완료",
    failed: "실패",
  };

  return labels[status] || status || "대기";
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

/** 실행 카드의 진행률을 계산한다. */
function getProgressPercent(run) {
  const status = run?.status;

  if (status === "completed") return 100;
  if (["canceled", "failed"].includes(status)) return 0;

  const progress = run?.progress || {};
  const summary = run?.summary || {};

  if (
    progress.stage === "detail" &&
    progress.detailTargetCount
  ) {
    const current = Number(progress.currentDetailIndex || 0);
    const total = Number(progress.detailTargetCount || 1);

    return Math.min(99, Math.max(5, (current / total) * 100));
  }

  const range = progress.pageRange || summary.pageRange;
  const current = progress.currentPage || range?.collectedLastPage;

  if (!range || !current || !range.pageEnd) {
    return RUNNING_STATUSES.has(status) ? 8 : 0;
  }

  const total = Math.max(1, range.pageEnd - range.pageStart + 1);
  const done = Math.max(0, current - range.pageStart + 1);

  return Math.min(98, Math.max(5, (done / total) * 100));
}

/** 최근 완료 실행의 결과 파일 버튼을 갱신한다. */
function updateResultFiles(files, runId = "") {
  let anyAvailable = false;

  for (const [fileType, button] of Object.entries(FILE_BUTTONS)) {
    const available = Boolean(files?.[fileType]?.available);

    button.disabled = !available;
    button.classList.toggle("disabled", !available);
    anyAvailable ||= available;
  }

  state.latestResultRunId = anyAvailable ? runId : "";
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

/** 특정 실행의 반복 타이머와 계획을 제거한다. */
function clearRepeatPlan(runId) {
  const timerId = state.repeatTimers.get(runId);

  if (timerId) {
    window.clearTimeout(timerId);
    state.repeatTimers.delete(runId);
  }

  state.repeatPlans.delete(runId);
}

/** 모든 반복 타이머를 정리한다. */
function clearAllRepeatPlans() {
  for (const timerId of state.repeatTimers.values()) {
    window.clearTimeout(timerId);
  }

  state.repeatTimers.clear();
  state.repeatPlans.clear();
}

/** 완료된 반복 실행별로 다음 실행을 예약한다. */
function scheduleRepeatRuns(applicationState) {
  const runs = Array.isArray(applicationState?.runs)
    ? applicationState.runs
    : [];

  for (const run of runs) {
    const plan = state.repeatPlans.get(run.id);

    if (!plan || run.status !== "completed") continue;
    if (state.repeatTimers.has(run.id)) continue;

    const executionOptions =
      plan.basePayload.executionOptions || {
        repeatValue: 1,
        repeatUnit: "hour",
      };
    const intervalMs = getRepeatIntervalMs(executionOptions);
    const nextRunAt = new Date(Date.now() + intervalMs);

    plan.nextRunAt = nextRunAt.toISOString();

    const timerId = window.setTimeout(async () => {
      state.repeatTimers.delete(run.id);
      state.repeatPlans.delete(run.id);

      try {
        const nextRun = await window.collectorApp.start({
          ...plan.basePayload,
        });

        state.repeatPlans.set(nextRun.id, {
          basePayload: {
            ...plan.basePayload,
          },
          nextRunAt: null,
        });

        handleStateChanged(await window.collectorApp.getState());
      } catch (error) {
        showError(`반복 수집 실행 실패: ${error.message}`);
      }
    }, intervalMs);

    state.repeatTimers.set(run.id, timerId);
  }
}

/** 실행 카드에 표시할 소요 시간을 계산한다. */
function getRunElapsedText(run) {
  if (
    RUNNING_STATUSES.has(run?.status) &&
    run?.startedAtMs
  ) {
    return formatElapsed(Date.now() - run.startedAtMs);
  }

  return (
    run?.progress?.elapsedText ||
    run?.summary?.elapsedText ||
    formatElapsed(run?.progress?.elapsedMs)
  );
}

/** 지표 카드 DOM을 생성한다. */
function createMetricCard(label, value) {
  const article = document.createElement("article");
  article.className = "metric-card";

  const title = document.createElement("span");
  title.textContent = label;

  const strong = document.createElement("strong");
  strong.textContent = value;

  article.append(title, strong);
  return article;
}

/** 실행 한 건을 독립적인 상태 카드로 렌더링한다. */
function createRunCard(run) {
  const card = document.createElement("article");
  card.className = "run-card";
  card.dataset.runId = run.id;

  const header = document.createElement("div");
  header.className = "status-header";

  const titleWrap = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "section-kicker";
  kicker.textContent = run.id;

  const title = document.createElement("h3");
  const mallLabel =
    run.request?.mall === "cheonyu"
      ? "천유닷컴"
      : run.request?.mall === "ccdome"
        ? "과자생각"
        : run.request?.mall || "쇼핑몰";
  const modeLabel =
    run.request?.collectionMode === "detail"
      ? "상세 수집"
      : "일반 수집";
  title.textContent =
    `${mallLabel} · ${modeLabel} · ` +
    `${run.request?.accountName || ".env 계정"}`;

  titleWrap.append(kicker, title);

  const badge = document.createElement("span");
  badge.className = `status-badge ${run.status || "idle"}`;
  badge.textContent = getStatusLabel(run.status);

  header.append(titleWrap, badge);

  const progressBar = document.createElement("progress");
  progressBar.className = "progress-bar";
  progressBar.max = 100;
  progressBar.value = getProgressPercent(run);
  progressBar.setAttribute("aria-label", `${title.textContent} 진행률`);

  const message = document.createElement("p");
  message.className = "status-message";
  message.textContent =
    run.progress?.message ||
    (run.status === "completed"
      ? "수집이 완료되었습니다."
      : "수집을 준비하고 있습니다.");

  card.append(header, progressBar, message);

  if (run.error) {
    const error = document.createElement("p");
    error.className = "error-message";
    error.textContent = run.error;
    card.append(error);
  }

  const metrics = document.createElement("div");
  metrics.className = "metrics-grid";
  const progress = run.progress || {};
  const summary = run.summary || {};

  metrics.append(
    createMetricCard("수집 페이지", formatPageRange(progress, summary)),
    createMetricCard(
      "전체 상품 감지 수",
      displayNumber(
        summary.detectedTotalProductCount ??
        progress.detectedTotalProductCount,
      ),
    ),
    createMetricCard(
      "수집 전체 상품 수",
      displayNumber(
        summary.collectedProductCount ??
        progress.collectedProductCount,
      ),
    ),
    createMetricCard(
      "일반 수집 대상 수",
      displayNumber(
        summary.targetProductCount ??
        progress.targetProductCount,
      ),
    ),
    createMetricCard(
      "상세 수집 상품 수",
      formatDetailProgress(progress, summary),
    ),
    createMetricCard(
      "상품 요약 수",
      displayNumber(
        summary.productSummaryCount ??
        progress.productSummaryCount,
      ),
    ),
    createMetricCard(
      "품절 상품 수",
      displayNumber(
        summary.soldOutProductCount ??
        progress.soldOutProductCount,
      ),
    ),
    createMetricCard("소요 시간", getRunElapsedText(run)),
  );

  card.append(metrics);

  const actions = document.createElement("div");
  actions.className = "form-actions";

  if (RUNNING_STATUSES.has(run.status)) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "danger-button";
    cancelButton.textContent = "이 실행 취소";
    cancelButton.addEventListener("click", () => cancelRun(run.id));
    actions.append(cancelButton);
  }

  const repeatPlan = state.repeatPlans.get(run.id);

  if (repeatPlan && state.repeatTimers.has(run.id)) {
    const stopRepeatButton = document.createElement("button");
    stopRepeatButton.type = "button";
    stopRepeatButton.className = "secondary-button";
    stopRepeatButton.textContent = "반복 예약 중지";
    stopRepeatButton.addEventListener("click", () => {
      clearRepeatPlan(run.id);
      renderRunList(state.applicationState);
      showSuccess("해당 실행의 반복 예약을 중지했습니다.");
    });

    const repeatText = document.createElement("p");
    repeatText.className = "form-note";
    repeatText.textContent =
      `다음 실행: ${new Date(repeatPlan.nextRunAt).toLocaleString("ko-KR")}`;

    actions.append(stopRepeatButton, repeatText);
  }

  if (run.outputDirectory) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "secondary-button";
    openButton.textContent = "결과 폴더 열기";
    openButton.addEventListener("click", () =>
      openResultDirectory(run.id),
    );
    actions.append(openButton);
  }

  for (const [fileType, file] of Object.entries(run.files || {})) {
    if (!file?.available) continue;

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "secondary-button";
    saveButton.textContent = `${file.label} 저장`;
    saveButton.addEventListener("click", () =>
      saveResultFile(fileType, run.id),
    );
    actions.append(saveButton);
  }

  if (actions.childElementCount > 0) {
    card.append(actions);
  }

  return card;
}

/** 전체 실행 목록을 렌더링한다. */
function renderRunList(applicationState) {
  const runs = Array.isArray(applicationState?.runs)
    ? applicationState.runs
    : [];
  const activeCount = runs.filter((run) =>
    RUNNING_STATUSES.has(run.status),
  ).length;

  elements.activeRunCount.textContent =
    `실행 중 ${activeCount}건 · 전체 ${runs.length}건`;

  elements.runList.replaceChildren();

  if (runs.length < 1) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "아직 실행한 수집 작업이 없습니다.";
    elements.runList.append(empty);
  } else {
    for (const run of runs) {
      elements.runList.append(createRunCard(run));
    }
  }

  const latestCompletedRun =
    runs.find(
      (run) =>
        run.id === applicationState?.latestCompletedRunId &&
        run.status === "completed",
    ) ||
    runs.find((run) => run.status === "completed") ||
    null;

  updateResultFiles(
    latestCompletedRun?.files,
    latestCompletedRun?.id || "",
  );

  const cartRunning = Boolean(applicationState?.cart?.running);
  elements.cartUploadButton.disabled = cartRunning;
  elements.cartUploadButton.textContent = cartRunning
    ? "장바구니 처리 중..."
    : "장바구니 담기";
}

/** 실행 상태 이벤트를 처리한다. */
function handleStateChanged(applicationState) {
  state.applicationState = applicationState || {
    runs: [],
  };

  renderRunList(state.applicationState);
  scheduleRepeatRuns(state.applicationState);
}

/** 실행 중 카드의 시간을 계속 갱신한다. */
function startElapsedTicker() {
  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
  }

  state.elapsedTimer = window.setInterval(() => {
    if (
      state.applicationState?.runs?.some((run) =>
        RUNNING_STATUSES.has(run.status),
      )
    ) {
      renderRunList(state.applicationState);
    }
  }, 500);
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

/** 이후 실행에 적용할 결과 기본 폴더를 변경한다. */
async function chooseOutputDirectory() {
  clearError();
  clearSuccess();

  try {
    const result = await window.collectorApp.chooseOutputDirectory();
    elements.outputDirectory.value = result.outputDirectory;

    if (!result.canceled) {
      showSuccess(
        "결과 기본 폴더를 변경했습니다. 이미 실행 중인 작업에는 기존 폴더가 유지됩니다.",
      );
    }
  } catch (error) {
    showError(error.message);
  }
}

/** 현재 설정으로 새 수집 작업을 하나 추가한다. */
async function handleSubmit(event) {
  event.preventDefault();

  clearError();
  clearSuccess();
  setSubmitting(true);

  const payload = buildPayload();

  try {
    const run = await window.collectorApp.start(payload);

    if (payload.executionOptions.runMode === "repeat") {
      state.repeatPlans.set(run.id, {
        basePayload: {
          ...payload,
        },
        nextRunAt: null,
      });
    }

    handleStateChanged(await window.collectorApp.getState());

    showSuccess(
      `${payload.collectionMode === "detail" ? "상세" : "일반"} 수집 실행을 추가했습니다.`,
    );
  } catch (error) {
    showError(error.message);
  } finally {
    setSubmitting(false);
  }
}

/** 특정 실행만 취소한다. */
async function cancelRun(runId) {
  clearError();
  clearSuccess();
  clearRepeatPlan(runId);

  try {
    const applicationState = await window.collectorApp.cancel(runId);
    handleStateChanged(applicationState);
  } catch (error) {
    showError(error.message);
  }
}

/** 로컬 계정 식별자로 등록 계정을 찾는다. */
function getAccountByLocalId(accountId) {
  return state.accounts.find((account) => account.id === accountId) || null;
}

/** 선택된 사이트별 로그인 계정으로 장바구니 요청 payload를 만든다. */
function buildCartBatchPayload() {
  const accounts = {};
  const cheonyuAccount = getAccountByLocalId(
    elements.cartCheonyuAccountSelect.value,
  );
  const ccdomeAccount = getAccountByLocalId(
    elements.cartCcdomeAccountSelect.value,
  );

  if (cheonyuAccount) {
    accounts.cheonyu = {
      accountId: cheonyuAccount.loginId,
      accountPw: cheonyuAccount.password,
      accountName: cheonyuAccount.name,
      localCredentialId: cheonyuAccount.id,
    };
  }

  if (ccdomeAccount) {
    accounts.ccdome = {
      accountId: ccdomeAccount.loginId,
      accountPw: ccdomeAccount.password,
      accountName: ccdomeAccount.name,
      localCredentialId: ccdomeAccount.id,
    };
  }

  if (!accounts.cheonyu && !accounts.ccdome) {
    throw new Error("천유닷컴 또는 과자생각 계정을 선택하세요.");
  }

  return {
    accounts,
    showBrowser: elements.browserMode.value === "show",
  };
}

/** uploader GET 응답을 받아 사이트별 실제 장바구니 작업을 실행한다. */
async function submitCartUpload() {
  clearError();
  clearSuccess();

  let payload;

  try {
    payload = buildCartBatchPayload();
  } catch (error) {
    elements.cartUploadMessage.textContent = error.message;
    showError(error.message);
    return;
  }

  elements.cartUploadButton.disabled = true;
  elements.cartUploadButton.textContent = "장바구니 처리 중...";
  elements.cartUploadMessage.textContent =
    "Uploader에서 장바구니 상품 목록을 불러오고 있습니다.";

  try {
    const result = await window.collectorApp.uploadCartItems(payload);

    /** 개발자 도구에서 uploader GET 응답 전체를 확인한다. */
    console.log("[CART UPLOADER RESPONSE]", result?.items || []);

    const cheonyuCount = result?.results?.cheonyu?.requestCount || 0;
    const ccdomeCount = result?.results?.ccdome?.requestCount || 0;
    const message =
      `장바구니 처리가 완료되었습니다. ` +
      `천유 ${cheonyuCount}건, 과자생각 ${ccdomeCount}건`;

    elements.cartUploadMessage.textContent = message;
    showSuccess(message);
  } catch (error) {
    elements.cartUploadMessage.textContent =
      `장바구니 처리 실패: ${error.message}`;
    showError(error.message);
  } finally {
    elements.cartUploadButton.disabled = false;
    elements.cartUploadButton.textContent = "장바구니 담기";
  }
}

/** 결과 CSV 하나를 사용자 선택 경로로 복사한다. */
async function saveResultFile(
  fileType,
  runId = state.latestResultRunId,
) {
  clearError();
  clearSuccess();

  try {
    const result = await window.collectorApp.saveResultFile(
      fileType,
      runId,
    );

    if (!result.canceled) {
      showSuccess(`${result.fileName} 파일을 저장했습니다.`);
    }
  } catch (error) {
    showError(error.message);
  }
}

/** 원본 결과 폴더를 파일 탐색기로 연다. */
async function openResultDirectory(
  runId = state.latestResultRunId,
) {
  clearError();
  clearSuccess();

  try {
    await window.collectorApp.openResultDirectory(runId);
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
  startElapsedTicker();
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
elements.openSettingsButton.addEventListener("click", openSettingsDirectory);
elements.openResultDirectoryButton.addEventListener(
  "click",
  () => openResultDirectory(state.latestResultRunId),
);
elements.saveInventoryButton.addEventListener(
  "click",
  () => saveResultFile("inventory", state.latestResultRunId),
);
elements.saveSummaryButton.addEventListener(
  "click",
  () => saveResultFile("summary", state.latestResultRunId),
);
elements.saveProductsButton.addEventListener(
  "click",
  () => saveResultFile("products", state.latestResultRunId),
);
elements.saveDetailsButton.addEventListener(
  "click",
  () => saveResultFile("details", state.latestResultRunId),
);
elements.cartUploadButton.addEventListener(
  "click",
  submitCartUpload,
);

elements.cartCheonyuAccountSelect.addEventListener("change", () => {
  localStorage.setItem(
    CART_ACCOUNT_STORAGE_KEYS.cheonyu,
    elements.cartCheonyuAccountSelect.value,
  );
});

elements.cartCcdomeAccountSelect.addEventListener("change", () => {
  localStorage.setItem(
    CART_ACCOUNT_STORAGE_KEYS.ccdome,
    elements.cartCcdomeAccountSelect.value,
  );
});

elements.accountManagerModal.addEventListener("click", (event) => {
  if (event.target === elements.accountManagerModal) {
    closeAccountManager();
  }
});

window.addEventListener("beforeunload", () => {
  state.unsubscribe?.();
  clearAllRepeatPlans();

  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
  }
});

initialize().catch((error) => {
  elements.appBadge.textContent = "초기화 실패";
  showError(error.message);
});

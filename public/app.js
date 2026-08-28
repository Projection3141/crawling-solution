// public/app.js

const ACCOUNT_STORAGE_KEY = "mall-collector-accounts-v1";
const SELECTED_ACCOUNT_STORAGE_KEY = "mall-collector-selected-account-id";
const PROXY_PROFILE_STORAGE_KEY = "mall-collector-proxy-profile-id";
const OPENAI_PROFILE_STORAGE_KEY = "mall-collector-openai-profile-id";
const CHEONYU_USER_AGENT_STORAGE_KEY = "mall-collector-cheonyu-user-agent";

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
  repeatScheduleType: document.querySelector("#repeatScheduleType"),
  repeatIntervalControl: document.querySelector("#repeatIntervalControl"),
  repeatValue: document.querySelector("#repeatValue"),
  repeatUnit: document.querySelector("#repeatUnit"),
  repeatTimeControl: document.querySelector("#repeatTimeControl"),
  repeatTime: document.querySelector("#repeatTime"),
  repeatScheduleHelp: document.querySelector("#repeatScheduleHelp"),
  browserMode: document.querySelector("#browserMode"),
  cheonyuProxyProfileSelect: document.querySelector("#cheonyuProxyProfileSelect"),
  cheonyuProxyHelp: document.querySelector("#cheonyuProxyHelp"),
  openProxyManagerButton: document.querySelector("#openProxyManagerButton"),
  proxyManagerModal: document.querySelector("#proxyManagerModal"),
  closeProxyManagerButton: document.querySelector("#closeProxyManagerButton"),
  cancelProxyManagerButton: document.querySelector("#cancelProxyManagerButton"),
  proxyFormTitle: document.querySelector("#proxyFormTitle"),
  proxyRegisterName: document.querySelector("#proxyRegisterName"),
  proxyRegisterServer: document.querySelector("#proxyRegisterServer"),
  proxyRegisterUsername: document.querySelector("#proxyRegisterUsername"),
  proxyRegisterPassword: document.querySelector("#proxyRegisterPassword"),
  saveProxyProfileButton: document.querySelector("#saveProxyProfileButton"),
  proxyProfileList: document.querySelector("#proxyProfileList"),
  proxyManagerMessage: document.querySelector("#proxyManagerMessage"),
  cheonyuUserAgent: document.querySelector("#cheonyuUserAgent"),
  cheonyuUserAgentHelp: document.querySelector("#cheonyuUserAgentHelp"),
  openAiProfileSelect: document.querySelector("#openAiProfileSelect"),
  openAiProfileHelp: document.querySelector("#openAiProfileHelp"),
  openOpenAiManagerButton: document.querySelector("#openOpenAiManagerButton"),
  openAiManagerModal: document.querySelector("#openAiManagerModal"),
  closeOpenAiManagerButton: document.querySelector("#closeOpenAiManagerButton"),
  cancelOpenAiManagerButton: document.querySelector("#cancelOpenAiManagerButton"),
  openAiFormTitle: document.querySelector("#openAiFormTitle"),
  openAiRegisterName: document.querySelector("#openAiRegisterName"),
  openAiRegisterKey: document.querySelector("#openAiRegisterKey"),
  saveOpenAiProfileButton: document.querySelector("#saveOpenAiProfileButton"),
  openAiProfileList: document.querySelector("#openAiProfileList"),
  openAiManagerMessage: document.querySelector("#openAiManagerMessage"),
  outputDirectory: document.querySelector("#outputDirectory"),
  chooseOutputButton: document.querySelector("#chooseOutputButton"),
  openSettingsButton: document.querySelector("#openSettingsButton"),
  uploadApiSettingsForm: document.querySelector("#uploadApiSettingsForm"),
  uploadApiUrl: document.querySelector("#uploadApiUrl"),
  uploadApiUrlHelp: document.querySelector("#uploadApiUrlHelp"),
  saveUploadApiUrlButton: document.querySelector("#saveUploadApiUrlButton"),
  pageStart: document.querySelector("#pageStart"),
  pageEnd: document.querySelector("#pageEnd"),
  detailMaxProducts: document.querySelector("#detailMaxProducts"),
  detailRequestDelayMs: document.querySelector("#detailRequestDelayMs"),
  runButton: document.querySelector("#runButton"),
  mallHelp: document.querySelector("#mallHelp"),
  categoryHelp: document.querySelector("#categoryHelp"),
  appBadge: document.querySelector("#appBadge"),
  shippingToggleButton: document.querySelector("#shippingToggleButton"),
  shippingStatusText: document.querySelector("#shippingStatusText"),
  collectionUploadToggleButton: document.querySelector("#collectionUploadToggleButton"),
  collectionUploadStatusText: document.querySelector("#collectionUploadStatusText"),

  activeRunCount: document.querySelector("#activeRunCount"),
  runList: document.querySelector("#runList"),
  errorMessage: document.querySelector("#errorMessage"),
  successMessage: document.querySelector("#successMessage"),

  cartCheonyuAccountSelect:
    document.querySelector("#cartCheonyuAccountSelect"),
  cartCheonyuProxyProfileSelect:
    document.querySelector("#cartCheonyuProxyProfileSelect"),
  cartCcdomeAccountSelect:
    document.querySelector("#cartCcdomeAccountSelect"),
  cartUploadButton:
    document.querySelector("#cartUploadButton"),
  cartUploadMessage:
    document.querySelector("#cartUploadMessage"),
  collectionUploadLogList:
    document.querySelector("#collectionUploadLogList"),
  collectionUploadLogPageInfo:
    document.querySelector("#collectionUploadLogPageInfo"),
  collectionUploadLogPreviousButton:
    document.querySelector("#collectionUploadLogPreviousButton"),
  collectionUploadLogNextButton:
    document.querySelector("#collectionUploadLogNextButton"),
  openCollectionUploadLogDirectoryButton:
    document.querySelector("#openCollectionUploadLogDirectoryButton"),
};

const state = {
  defaults: null,
  collectionUploadLogPage: 1,
  collectionUploadLogTotalPages: 1,
  accounts: [],
  credentialProfiles: {
    proxies: [],
    openAiKeys: [],
  },
  editingProxyProfileId: "",
  editingOpenAiProfileId: "",
  applicationState: {
    runs: [],
    activeRunCount: 0,
    latestCompletedRunId: "",
    cart: {
      running: false,
      lockedAccountKeys: [],
    },
    shipping: {
      enabled: false,
      collectionUploadEnabled: true,
      running: false,
      lastError: "",
      lastRecordCount: 0,
      nextRunAt: null,
    },
  },
  unsubscribe: null,
  elapsedTimer: null,
  latestResultRunId: "",
  repeatPlans: new Map(),
  repeatTimers: new Map(),
  repeatLaunching: new Set(),
};

const RUNNING_STATUSES = new Set([
  "queued",
  "running",
  "canceling",
]);

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

function getProxyProfile(profileId) {
  return state.credentialProfiles.proxies.find(
    (profile) => profile.id === profileId,
  ) || null;
}

function getOpenAiProfile(profileId) {
  return state.credentialProfiles.openAiKeys.find(
    (profile) => profile.id === profileId,
  ) || null;
}

function setManagerMessage(element, message = "", type = "error") {
  if (!element) return;

  element.hidden = !message;
  element.textContent = message;
  element.className = type === "success" ? "success-message" : "error-message";
}

function isProfileUsedByRepeatPlans(fieldName, profileId) {
  return Array.from(state.repeatPlans.values()).some(
    (plan) => String(plan?.basePayload?.[fieldName] || "") === profileId,
  );
}

/** 등록된 프록시를 수집·장바구니 선택 목록에 동일하게 표시한다. */
function renderProxyProfileSelects(preferredId = null) {
  const profiles = state.credentialProfiles.proxies;
  const hasPreferredId = preferredId !== null && preferredId !== undefined;
  const savedId = hasPreferredId
    ? String(preferredId || "")
    : localStorage.getItem(PROXY_PROFILE_STORAGE_KEY) ||
      elements.cheonyuProxyProfileSelect?.value ||
      "";
  const selectedId = profiles.some((profile) => profile.id === savedId)
    ? savedId
    : "";

  for (const select of [
    elements.cheonyuProxyProfileSelect,
    elements.cartCheonyuProxyProfileSelect,
  ].filter(Boolean)) {
    select.replaceChildren();

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "프록시 사용 안 함";
    select.append(emptyOption);

    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      select.append(option);
    }

    select.value = selectedId;
  }

  if (selectedId) {
    localStorage.setItem(PROXY_PROFILE_STORAGE_KEY, selectedId);
  } else {
    localStorage.removeItem(PROXY_PROFILE_STORAGE_KEY);
  }

  const selected = getProxyProfile(selectedId);
  elements.cheonyuProxyHelp.textContent = selected
    ? `${selected.name}부터 시작해 천유 10페이지마다 다음 등록 프록시로 변경합니다.`
    : "프록시를 사용하지 않고 직접 연결합니다.";
}

/** 수집과 장바구니의 프록시 선택을 동일하게 유지한다. */
function syncProxyProfileSelection(source) {
  const value = String(source?.value || "");
  renderProxyProfileSelects(value);
}

function renderOpenAiProfileSelect(preferredId = null) {
  const profiles = state.credentialProfiles.openAiKeys;
  const hasPreferredId = preferredId !== null && preferredId !== undefined;
  const savedId = hasPreferredId
    ? String(preferredId || "")
    : localStorage.getItem(OPENAI_PROFILE_STORAGE_KEY) ||
      elements.openAiProfileSelect?.value ||
      "";
  const selectedId = profiles.some((profile) => profile.id === savedId)
    ? savedId
    : "";

  elements.openAiProfileSelect.replaceChildren();
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "API 키 선택";
  elements.openAiProfileSelect.append(emptyOption);

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.keyHint})`;
    elements.openAiProfileSelect.append(option);
  }

  elements.openAiProfileSelect.value = selectedId;

  if (selectedId) {
    localStorage.setItem(OPENAI_PROFILE_STORAGE_KEY, selectedId);
  } else {
    localStorage.removeItem(OPENAI_PROFILE_STORAGE_KEY);
  }

  const selected = getOpenAiProfile(selectedId);
  elements.openAiProfileHelp.textContent = selected
    ? `${selected.name} API 키로 번역합니다.`
    : "번역에 사용할 API 키를 선택하세요.";
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
    emptyOption.textContent = `${target.label} 계정 선택 안 함`;
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
  envOption.textContent = "계정 선택 안 함";
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

function applyCredentialProfiles(summary, selections = {}) {
  state.credentialProfiles = {
    proxies: Array.isArray(summary?.proxies) ? summary.proxies : [],
    openAiKeys: Array.isArray(summary?.openAiKeys) ? summary.openAiKeys : [],
  };

  renderProxyProfileSelects(
    Object.hasOwn(selections, "proxyProfileId")
      ? selections.proxyProfileId
      : null,
  );
  renderOpenAiProfileSelect(
    Object.hasOwn(selections, "openAiProfileId")
      ? selections.openAiProfileId
      : null,
  );
  renderProxyProfileList();
  renderOpenAiProfileList();
}

async function loadCredentialProfiles() {
  const summary = await window.collectorApp.getCredentialProfiles();
  applyCredentialProfiles(summary);
}

function resetProxyProfileForm() {
  state.editingProxyProfileId = "";
  elements.proxyFormTitle.textContent = "프록시 등록";
  elements.saveProxyProfileButton.textContent = "등록";
  elements.proxyRegisterName.value = "";
  elements.proxyRegisterServer.value = "";
  elements.proxyRegisterUsername.value = "";
  elements.proxyRegisterPassword.value = "";
}

function editProxyProfile(profileId) {
  const profile = getProxyProfile(profileId);
  if (!profile) return;

  state.editingProxyProfileId = profile.id;
  elements.proxyFormTitle.textContent = "프록시 수정";
  elements.saveProxyProfileButton.textContent = "수정 저장";
  elements.proxyRegisterName.value = profile.name;
  elements.proxyRegisterServer.value = profile.server;
  elements.proxyRegisterUsername.value = profile.username || "";
  elements.proxyRegisterPassword.value = "";
  setManagerMessage(elements.proxyManagerMessage);
  elements.proxyRegisterName.focus();
}

function renderProxyProfileList() {
  elements.proxyProfileList.replaceChildren();

  if (state.credentialProfiles.proxies.length < 1) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "등록된 프록시가 없습니다.";
    elements.proxyProfileList.append(empty);
    return;
  }

  for (const profile of state.credentialProfiles.proxies) {
    const item = document.createElement("article");
    item.className = "account-item";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    const server = document.createElement("span");
    const authentication = document.createElement("span");
    name.textContent = profile.name;
    server.textContent = `주소: ${profile.server}`;
    authentication.textContent = profile.username
      ? `인증: ${profile.username} / 비밀번호 설정됨`
      : "인증: 사용 안 함";
    info.append(name, server, authentication);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "수정";
    editButton.addEventListener("click", () => editProxyProfile(profile.id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", () => deleteProxyProfile(profile.id));
    actions.append(editButton, deleteButton);
    item.append(info, actions);
    elements.proxyProfileList.append(item);
  }
}

async function saveProxyProfile() {
  clearError();
  clearSuccess();
  setManagerMessage(elements.proxyManagerMessage);

  const editingProfile = Boolean(state.editingProxyProfileId);
  const previouslySelectedId = elements.cheonyuProxyProfileSelect?.value || "";

  const profile = {
    ...(state.editingProxyProfileId ? { id: state.editingProxyProfileId } : {}),
    name: normalizeText(elements.proxyRegisterName.value),
    server: elements.proxyRegisterServer.value.trim(),
    username: elements.proxyRegisterUsername.value.trim(),
  };
  const password = String(elements.proxyRegisterPassword.value || "");
  if (password) profile.password = password;

  try {
    const result = await window.collectorApp.saveProxyProfile(profile);
    applyCredentialProfiles(result.summary, {
      proxyProfileId: editingProfile
        ? previouslySelectedId
        : result.selectedId,
    });
    resetProxyProfileForm();
    setManagerMessage(
      elements.proxyManagerMessage,
      "프록시 정보를 저장했습니다.",
      "success",
    );
  } catch (error) {
    setManagerMessage(elements.proxyManagerMessage, error.message);
  }
}

async function deleteProxyProfile(profileId) {
  const profile = getProxyProfile(profileId);

  if (isProfileUsedByRepeatPlans("proxyProfileId", profileId)) {
    setManagerMessage(
      elements.proxyManagerMessage,
      "반복 수집에서 사용 중인 프록시입니다. 해당 반복 수집을 먼저 중지하세요.",
    );
    return;
  }

  if (!profile || !window.confirm(`"${profile.name}" 프록시를 삭제하시겠습니까?`)) return;

  try {
    const summary = await window.collectorApp.deleteProxyProfile(profileId);
    applyCredentialProfiles(summary);
    if (state.editingProxyProfileId === profileId) resetProxyProfileForm();
    setManagerMessage(
      elements.proxyManagerMessage,
      "프록시를 삭제했습니다.",
      "success",
    );
  } catch (error) {
    setManagerMessage(elements.proxyManagerMessage, error.message);
  }
}

function openProxyManager() {
  clearError();
  clearSuccess();
  setManagerMessage(elements.proxyManagerMessage);
  elements.proxyManagerModal.hidden = false;
  elements.proxyRegisterName.focus();
}

function closeProxyManager() {
  elements.proxyManagerModal.hidden = true;
  setManagerMessage(elements.proxyManagerMessage);
  resetProxyProfileForm();
}

function resetOpenAiProfileForm() {
  state.editingOpenAiProfileId = "";
  elements.openAiFormTitle.textContent = "API 키 등록";
  elements.saveOpenAiProfileButton.textContent = "등록";
  elements.openAiRegisterName.value = "";
  elements.openAiRegisterKey.value = "";
}

function editOpenAiProfile(profileId) {
  const profile = getOpenAiProfile(profileId);
  if (!profile) return;

  state.editingOpenAiProfileId = profile.id;
  elements.openAiFormTitle.textContent = "API 키 수정";
  elements.saveOpenAiProfileButton.textContent = "수정 저장";
  elements.openAiRegisterName.value = profile.name;
  elements.openAiRegisterKey.value = "";
  setManagerMessage(elements.openAiManagerMessage);
  elements.openAiRegisterName.focus();
}

function renderOpenAiProfileList() {
  elements.openAiProfileList.replaceChildren();

  if (state.credentialProfiles.openAiKeys.length < 1) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "등록된 API 키가 없습니다.";
    elements.openAiProfileList.append(empty);
    return;
  }

  for (const profile of state.credentialProfiles.openAiKeys) {
    const item = document.createElement("article");
    item.className = "account-item";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    const keyHint = document.createElement("span");
    name.textContent = profile.name;
    keyHint.textContent = `키: ${profile.keyHint}`;
    info.append(name, keyHint);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary-button";
    editButton.textContent = "수정";
    editButton.addEventListener("click", () => editOpenAiProfile(profile.id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", () => deleteOpenAiProfile(profile.id));
    actions.append(editButton, deleteButton);
    item.append(info, actions);
    elements.openAiProfileList.append(item);
  }
}

async function saveOpenAiProfile() {
  clearError();
  clearSuccess();
  setManagerMessage(elements.openAiManagerMessage);

  const editingProfile = Boolean(state.editingOpenAiProfileId);
  const previouslySelectedId = elements.openAiProfileSelect?.value || "";

  const profile = {
    ...(state.editingOpenAiProfileId ? { id: state.editingOpenAiProfileId } : {}),
    name: normalizeText(elements.openAiRegisterName.value),
  };
  const apiKey = elements.openAiRegisterKey.value.trim();
  if (apiKey) profile.apiKey = apiKey;

  try {
    const result = await window.collectorApp.saveOpenAiProfile(profile);
    applyCredentialProfiles(result.summary, {
      openAiProfileId: editingProfile
        ? previouslySelectedId
        : result.selectedId,
    });
    resetOpenAiProfileForm();
    setManagerMessage(
      elements.openAiManagerMessage,
      "OpenAI API 키를 저장했습니다.",
      "success",
    );
  } catch (error) {
    setManagerMessage(elements.openAiManagerMessage, error.message);
  }
}

async function deleteOpenAiProfile(profileId) {
  const profile = getOpenAiProfile(profileId);

  if (isProfileUsedByRepeatPlans("openAiProfileId", profileId)) {
    setManagerMessage(
      elements.openAiManagerMessage,
      "반복 수집에서 사용 중인 API 키입니다. 해당 반복 수집을 먼저 중지하세요.",
    );
    return;
  }

  if (!profile || !window.confirm(`"${profile.name}" API 키를 삭제하시겠습니까?`)) return;

  try {
    const summary = await window.collectorApp.deleteOpenAiProfile(profileId);
    applyCredentialProfiles(summary);
    if (state.editingOpenAiProfileId === profileId) resetOpenAiProfileForm();
    setManagerMessage(
      elements.openAiManagerMessage,
      "OpenAI API 키를 삭제했습니다.",
      "success",
    );
  } catch (error) {
    setManagerMessage(elements.openAiManagerMessage, error.message);
  }
}

function openOpenAiManager() {
  clearError();
  clearSuccess();
  setManagerMessage(elements.openAiManagerMessage);
  elements.openAiManagerModal.hidden = false;
  elements.openAiRegisterName.focus();
}

function closeOpenAiManager() {
  elements.openAiManagerModal.hidden = true;
  setManagerMessage(elements.openAiManagerMessage);
  resetOpenAiProfileForm();
}

/** 숫자형 입력이 비어 있지 않을 때만 payload에 추가한다. */
function setNumberIfPresent(payload, key, input) {
  if (!input || input.value.trim() === "") return;
  payload[key] = Number(input.value);
}

function getExecutionOptions() {
  const runMode = elements.runMode.value === "repeat" ? "repeat" : "once";
  const repeatScheduleType = elements.repeatScheduleType.value === "dailyTime"
    ? "dailyTime"
    : "interval";
  const repeatUnit = ["minute", "hour", "day", "week"].includes(
    elements.repeatUnit.value,
  )
    ? elements.repeatUnit.value
    : "hour";
  const repeatValue = Math.max(1, Math.trunc(Number(elements.repeatValue.value || 1)));
  const repeatTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(elements.repeatTime.value)
    ? elements.repeatTime.value
    : "09:00";

  return {
    runMode,
    repeatScheduleType,
    repeatUnit,
    repeatValue,
    repeatTime,
  };
}

function getRepeatIntervalMs(options) {
  const value = Math.max(1, Number(options.repeatValue || 1));

  if (options.repeatUnit === "minute") return value * 60 * 1000;
  if (options.repeatUnit === "day") return value * 24 * 60 * 60 * 1000;
  if (options.repeatUnit === "week") return value * 7 * 24 * 60 * 60 * 1000;

  return value * 60 * 60 * 1000;
}

/** 반복 방식에 따라 현재 시점 이후의 정확한 다음 실행 시각을 계산한다. */
function getNextRepeatRunAt(options, fromMs = Date.now()) {
  if (options.repeatScheduleType === "dailyTime") {
    const [hour, minute] = String(options.repeatTime || "09:00")
      .split(":")
      .map(Number);
    const nextRunAt = new Date(fromMs);

    nextRunAt.setHours(
      Number.isInteger(hour) ? hour : 9,
      Number.isInteger(minute) ? minute : 0,
      0,
      0,
    );

    if (nextRunAt.getTime() <= fromMs) {
      nextRunAt.setDate(nextRunAt.getDate() + 1);
    }

    return nextRunAt;
  }

  return new Date(fromMs + getRepeatIntervalMs(options));
}

function formatRepeatUnit(unit) {
  if (unit === "minute") return "분";
  if (unit === "day") return "일";
  if (unit === "week") return "주";
  return "시간";
}

/**
 * 화면 입력값으로 수집 payload를 생성한다.
 *
 * 비어 있는 일반 설정은 코드 기본값을 사용한다.
 * 프록시와 OpenAI API 키는 등록 프로필 ID만 전달한다.
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

  const effectiveMall =
    elements.mall.value || state.defaults?.envDefaults?.mall || "cheonyu";

  if (effectiveMall === "cheonyu" && elements.cheonyuProxyProfileSelect?.value) {
    payload.proxyProfileId = elements.cheonyuProxyProfileSelect.value;
  }

  const cheonyuUserAgent = elements.cheonyuUserAgent?.value.trim();
  if (cheonyuUserAgent) {
    payload.cheonyuUserAgent = cheonyuUserAgent;
  }

  if (!elements.openAiProfileSelect?.value) {
    throw new Error("번역에 사용할 OpenAI API 키를 선택하세요.");
  }

  payload.openAiProfileId = elements.openAiProfileSelect.value;

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
    ? "수집이 성공하거나 실패해도 중지 전까지 다음 실행을 계속 예약합니다."
    : "1회 실행은 수집 완료 후 자동 종료됩니다.";

  updateRepeatScheduleGuide();
}

function updateRepeatScheduleGuide() {
  const usesDailyTime = elements.repeatScheduleType.value === "dailyTime";

  elements.repeatIntervalControl.hidden = usesDailyTime;
  elements.repeatTimeControl.hidden = !usesDailyTime;
  elements.repeatScheduleHelp.textContent = usesDailyTime
    ? "매일 선택한 시각에 실행합니다. 수집 중 해당 시각이 지나면 다음 날 실행합니다."
    : "이전 수집이 끝난 뒤 지정한 주기만큼 대기하고 다음 수집을 실행합니다.";
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

  if (range.pageOrder === "reverse") {
    return current ? `${end} → ${current} / ${start}` : `${end} → ${start}`;
  }

  return current ? `${start} → ${current} / ${end}` : `${start} → ${end}`;
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
  const done = range.pageOrder === "reverse"
    ? Math.max(0, range.pageEnd - current + 1)
    : Math.max(0, current - range.pageStart + 1);

  return Math.min(98, Math.max(5, (done / total) * 100));
}

/** 최근 완료 실행의 결과 파일 버튼을 갱신한다. */
function updateResultFiles(files, runId = "") {
  const anyAvailable = Object.values(files || {}).some(
    (file) => file?.available === true,
  );

  state.latestResultRunId = anyAvailable ? runId : "";
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

/** 운송정보 자동 전송 ON/OFF 상태를 버튼에 표시한다. */
function renderShippingState(shipping = {}) {
  if (!elements.shippingToggleButton) return;

  const enabled = shipping.enabled === true;
  const running = shipping.running === true;

  elements.shippingToggleButton.classList.toggle(
    "enabled",
    enabled,
  );
  elements.shippingToggleButton.classList.toggle(
    "shipping-off",
    !enabled,
  );
  elements.shippingToggleButton.setAttribute(
    "aria-pressed",
    String(enabled),
  );

  if (running && enabled) {
    elements.shippingToggleButton.textContent =
      "운송정보 서버 전송 중...";
  } else {
    elements.shippingToggleButton.textContent =
      `운송정보 서버 전송 ${enabled ? "ON" : "OFF"}`;
  }

  if (shipping.lastError) {
    elements.shippingToggleButton.title =
      `마지막 전송 오류: ${shipping.lastError}`;
    if (elements.shippingStatusText) {
      elements.shippingStatusText.textContent = "운송 자동전송 오류";
    }
    return;
  }

  if (shipping.lastSuccessAt) {
    const successTime = new Date(
      shipping.lastSuccessAt,
    ).toLocaleString("ko-KR");

    elements.shippingToggleButton.title =
      `마지막 성공: ${successTime} · ${Number(
        shipping.lastRecordCount || 0,
      ).toLocaleString("ko-KR")}건`;
    if (elements.shippingStatusText) {
      elements.shippingStatusText.textContent = enabled
        ? "운송 자동전송 동작 중"
        : "운송 자동전송 중지";
    }
    return;
  }

  elements.shippingToggleButton.title = enabled
    ? "앱 실행 직후 전송하고 이후 1시간마다 반복합니다."
    : "운송정보 자동 전송이 꺼져 있습니다.";

  if (elements.shippingStatusText) {
    elements.shippingStatusText.textContent = enabled
      ? ""
      : "";
  }
}

/** 수집정보 아카이브 자동 전송 ON/OFF 상태를 표시한다. */
function renderCollectionUploadState(shipping = {}) {
  if (!elements.collectionUploadToggleButton) return;

  const enabled = shipping.collectionUploadEnabled !== false;
  const running = shipping.running === true;

  elements.collectionUploadToggleButton.classList.toggle(
    "enabled",
    enabled,
  );
  elements.collectionUploadToggleButton.classList.toggle(
    "shipping-off",
    !enabled,
  );
  elements.collectionUploadToggleButton.setAttribute(
    "aria-pressed",
    String(enabled),
  );
  elements.collectionUploadToggleButton.textContent = running && enabled
    ? "수집정보 서버 전송 중..."
    : `수집정보 서버 전송 ${enabled ? "ON" : "OFF"}`;
  elements.collectionUploadToggleButton.title = enabled
    ? "앱 실행 직후 전송하고 이후 1시간마다 아카이브를 전송합니다."
    : "수집정보 자동 전송이 꺼져 있습니다.";

  if (elements.collectionUploadStatusText) {
    elements.collectionUploadStatusText.textContent = enabled
      ? "수집정보 자동전송 동작 중"
      : "수집정보 자동전송 중지";
  }
}

/** 수집정보 아카이브 자동 전송 ON/OFF를 변경한다. */
async function toggleCollectionUploadEnabled() {
  clearError();
  clearSuccess();

  const currentEnabled =
    state.applicationState?.shipping?.collectionUploadEnabled !== false;
  const nextEnabled = !currentEnabled;

  elements.collectionUploadToggleButton.disabled = true;

  try {
    await window.collectorApp.setCollectionUploadEnabled(
      nextEnabled,
    );
    handleStateChanged(
      await window.collectorApp.getState(),
    );
    showSuccess(
      `수집정보 서버 전송을 ${nextEnabled ? "켰습니다" : "껐습니다"}.`,
    );
  } catch (error) {
    showError(error.message);
  } finally {
    elements.collectionUploadToggleButton.disabled = false;
  }
}

/** 운송정보 자동 전송 ON/OFF를 변경한다. */
async function toggleShippingEnabled() {
  clearError();
  clearSuccess();

  const currentEnabled =
    state.applicationState?.shipping?.enabled === true;
  const nextEnabled = !currentEnabled;

  elements.shippingToggleButton.disabled = true;

  try {
    await window.collectorApp.setShippingEnabled(
      nextEnabled,
    );

    const applicationState =
      await window.collectorApp.getState();

    handleStateChanged(applicationState);
    showSuccess(
      `운송정보 서버 전송을 ${nextEnabled ? "켰습니다" : "껐습니다"}.`,
    );
  } catch (error) {
    showError(error.message);
  } finally {
    elements.shippingToggleButton.disabled = false;
  }
}

/** 특정 실행의 반복 타이머와 계획을 제거한다. */
function clearRepeatPlan(runId) {
  const timerId = state.repeatTimers.get(runId);

  if (timerId) {
    window.clearTimeout(timerId);
    state.repeatTimers.delete(runId);
  }

  state.repeatLaunching.delete(runId);
  state.repeatPlans.delete(runId);
}

/** 모든 반복 타이머를 정리한다. */
function clearAllRepeatPlans() {
  for (const timerId of state.repeatTimers.values()) {
    window.clearTimeout(timerId);
  }

  state.repeatTimers.clear();
  state.repeatLaunching.clear();
  state.repeatPlans.clear();
}

/** 성공 또는 실패로 끝난 반복 실행별로 다음 실행을 예약한다. */
function scheduleRepeatRuns(applicationState) {
  const runs = Array.isArray(applicationState?.runs)
    ? applicationState.runs
    : [];

  for (const run of runs) {
    const plan = state.repeatPlans.get(run.id);

    if (!plan) continue;

    if (run.status === "canceled") {
      clearRepeatPlan(run.id);
      continue;
    }

    if (!["completed", "failed"].includes(run.status)) continue;

    if (!plan.terminalStatusHandled) {
      if (run.status === "failed") {
        plan.consecutiveFailureCount =
          Number(plan.consecutiveFailureCount || 0) + 1;
      } else {
        plan.consecutiveFailureCount = 0;
      }

      const mall = String(
        plan.basePayload.mall ||
          state.defaults?.envDefaults?.mall ||
          "cheonyu",
      ).toLowerCase();
      plan.nextPageOrder =
        run.status === "failed" &&
        plan.consecutiveFailureCount >= 2 &&
        mall === "cheonyu"
          ? "reverse"
          : "forward";
      plan.terminalStatusHandled = true;

      if (plan.nextPageOrder === "reverse") {
        console.warn(
          `[REPEAT] 천유 수집이 ${plan.consecutiveFailureCount}회 연속 실패해 ` +
            "다음 실행은 마지막 페이지부터 역순으로 진행합니다.",
        );
      }
    }

    if (
      state.repeatTimers.has(run.id) ||
      state.repeatLaunching.has(run.id)
    ) continue;

    const executionOptions =
      plan.basePayload.executionOptions || {
        repeatScheduleType: "interval",
        repeatValue: 1,
        repeatUnit: "hour",
      };
    const nextRunAt = getNextRepeatRunAt(executionOptions);
    const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());

    plan.nextRunAt = nextRunAt.toISOString();

    const timerId = window.setTimeout(async () => {
      state.repeatLaunching.add(run.id);
      let launchError = null;

      try {
        if (state.repeatPlans.get(run.id) !== plan) return;

        const nextPageOrder =
          plan.nextPageOrder === "reverse" ? "reverse" : "forward";
        const nextRunPayload = {
          ...plan.basePayload,
          pageOrder: nextPageOrder,
        };
        const nextRun = await window.collectorApp.start(nextRunPayload);
        const carriedFailureCount =
          nextPageOrder === "reverse"
            ? 0
            : Number(plan.consecutiveFailureCount || 0);

        state.repeatPlans.delete(run.id);
        state.repeatPlans.set(nextRun.id, {
          basePayload: {
            ...plan.basePayload,
            pageOrder: "forward",
          },
          nextRunAt: null,
          consecutiveFailureCount: carriedFailureCount,
          nextPageOrder: "forward",
          terminalStatusHandled: false,
        });

        handleStateChanged(await window.collectorApp.getState());
      } catch (error) {
        launchError = error;
        plan.nextRunAt = null;
        showError(
          `반복 수집 실행 요청 실패: ${error.message} 다음 일정은 유지됩니다.`,
        );
      } finally {
        state.repeatTimers.delete(run.id);
        state.repeatLaunching.delete(run.id);
      }

      if (launchError) {
        scheduleRepeatRuns(state.applicationState);
        renderRunList(state.applicationState);
      }
    }, delayMs);

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
    `${run.request?.accountName || ".env 계정"}` +
    (run.request?.proxyEnabled
      ? ` · 프록시 ${run.request?.proxyProfileName || "등록 프로필"}`
      : "");

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

  const progressExcludedProducts = Array.isArray(run.progress?.excludedProducts)
    ? run.progress.excludedProducts
    : [];
  const collectionWarnings = Array.isArray(run.summary?.collectionWarnings)
    ? run.summary.collectionWarnings
    : Array.isArray(run.progress?.collectionWarnings)
      ? run.progress.collectionWarnings
      : progressExcludedProducts.map((item) => ({
          message:
            `${Number(item?.page) || "해당"}페이지에서 ` +
            `${String(item?.reason || "상품 체크박스 또는 수량 입력 비활성화")} ` +
            `상태인 상품(${String(item?.productId || "번호 미확인")})의 ` +
            `장바구니 재고 수집을 제외하고 계속 진행합니다.`,
        }));

  if (collectionWarnings.length > 0) {
    const warning = document.createElement("div");
    warning.className = "warning-message";

    for (const item of collectionWarnings) {
      const line = document.createElement("p");
      line.textContent = String(item?.message || item || "").trim();

      if (line.textContent) warning.append(line);
    }

    if (warning.childElementCount > 0) card.append(warning);
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
      "수집할 상품 개수",
      displayNumber(
        summary.collectedProductCount ??
        progress.collectedProductCount,
      ),
    ),
    createMetricCard(
      "수집 가능한 상품 수(일반)",
      displayNumber(
        summary.targetProductCount ??
        progress.targetProductCount,
      ),
    ),
    createMetricCard(
      "상세 수집 진행 수",
      formatDetailProgress(progress, summary),
    ),
    createMetricCard(
      "수집한 상품 수(품절 제외, 옵션 포함)",
      displayNumber(
        summary.inventoryRowCount ?? progress.inventoryRowCount ??
        summary.productSummaryCount ?? progress.productSummaryCount,
      ),
    ),
    createMetricCard(
      "품절 상품 수",
      displayNumber(
        summary.soldOutProductCount ??
        progress.soldOutProductCount,
      ),
    ),
  );

  if (run.request?.mall === "cheonyu") {
    metrics.append(
      createMetricCard(
        "장바구니 재고 수집 제외 상품 수",
        displayNumber(
          summary.excludedProductCount ??
          progress.excludedProductCount ??
          0,
        ),
      ),
    );
  }

  metrics.append(createMetricCard("소요 시간", getRunElapsedText(run)));

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
      `다음 실행: ${new Date(repeatPlan.nextRunAt).toLocaleString("ko-KR")}` +
      (repeatPlan.nextPageOrder === "reverse"
        ? " · 마지막 페이지부터 역순 수집"
        : "");

    actions.append(stopRepeatButton, repeatText);
  }

  if (!RUNNING_STATUSES.has(run.status)) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger-button run-delete-button";
    deleteButton.textContent = "목록에서 삭제";
    deleteButton.addEventListener("click", () =>
      deleteRunFromList(run.id),
    );
    actions.append(deleteButton);
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
  renderShippingState(state.applicationState.shipping);
  renderCollectionUploadState(state.applicationState.shipping);
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
  elements.appBadge.textContent = `v${defaults.app.version}`;
  elements.appBadge.classList.add("connected");

  elements.cheonyuUserAgent.value =
    localStorage.getItem(CHEONYU_USER_AGENT_STORAGE_KEY) || "";

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

  let payload;

  try {
    payload = buildPayload();
    const run = await window.collectorApp.start(payload);

    if (payload.executionOptions.runMode === "repeat") {
      state.repeatPlans.set(run.id, {
        basePayload: {
          ...payload,
          pageOrder: "forward",
        },
        nextRunAt: null,
        consecutiveFailureCount: 0,
        nextPageOrder: "forward",
        terminalStatusHandled: false,
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

/**
 * 완료·실패·취소된 실행을 화면 목록에서 제거한다.
 * 실제 결과 폴더와 파일은 유지한다.
 */
async function deleteRunFromList(runId) {
  clearError();
  clearSuccess();

  const run = state.applicationState?.runs?.find(
    (item) => item.id === runId,
  );

  if (!run) {
    return;
  }

  if (RUNNING_STATUSES.has(run.status)) {
    showError(
      "실행 중인 작업은 목록에서 삭제할 수 없습니다. 먼저 실행을 취소하세요.",
    );
    return;
  }

  const confirmed = window.confirm(
    `실행 결과 ${runId}을(를) 목록에서 삭제하시겠습니까?\n\n` +
      "결과 폴더와 실제 파일은 삭제되지 않습니다.",
  );

  if (!confirmed) return;

  clearRepeatPlan(runId);

  try {
    const applicationState = await window.collectorApp.deleteRun(runId);
    handleStateChanged(applicationState);
    showSuccess("실행 결과를 목록에서 삭제했습니다. 결과 파일은 유지됩니다.");
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

  const payload = {
    accounts,
    showBrowser: elements.browserMode.value === "show",
    cheonyuUserAgent: elements.cheonyuUserAgent?.value.trim() || undefined,
  };

  if (accounts.cheonyu) {
    payload.proxyProfileId = elements.cartCheonyuProxyProfileSelect?.value || "";
  }

  return payload;
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
    showSuccess("설정 폴더를 열었습니다. 사용자별 값을 덮어쓰려면 이 폴더에 .env를 만드세요.");
  } catch (error) {
    showError(error.message);
  }
}

function renderUploadApiSettings(settings = {}) {
  const uploadApiUrl = String(settings.uploadApiUrl || "").trim();
  elements.uploadApiUrl.value = uploadApiUrl;
  elements.uploadApiUrlHelp.textContent = settings.isDefault
    ? "기본 URL을 사용 중입니다. 장바구니 조회, 운송정보, 수집정보 전송에 공통 적용됩니다."
    : "사용자 설정 URL을 사용 중입니다. 세 가지 업로드 요청에 즉시 공통 적용됩니다.";
}

async function loadUploadApiSettings() {
  const settings = await window.collectorApp.getUploadApiSettings();
  renderUploadApiSettings(settings);
}

async function saveUploadApiSettings(event) {
  event.preventDefault();
  clearError();
  clearSuccess();

  const requestedUrl = elements.uploadApiUrl.value.trim();

  if (requestedUrl) {
    let parsed;

    try {
      parsed = new URL(requestedUrl);
    } catch {
      showError("Upload API URL 형식을 확인해 주세요.");
      elements.uploadApiUrl.focus();
      return;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      showError("Upload API URL은 HTTP 또는 HTTPS 주소만 사용할 수 있습니다.");
      elements.uploadApiUrl.focus();
      return;
    }
  }

  elements.saveUploadApiUrlButton.disabled = true;
  elements.saveUploadApiUrlButton.textContent = "저장 중";

  try {
    const settings = await window.collectorApp.saveUploadApiSettings({
      uploadApiUrl: requestedUrl,
    });
    renderUploadApiSettings(settings);
    showSuccess(
      requestedUrl
        ? "Upload API URL을 저장했습니다."
        : "Upload API URL을 기본값으로 복원했습니다.",
    );
  } catch (error) {
    showError(error.message);
  } finally {
    elements.saveUploadApiUrlButton.disabled = false;
    elements.saveUploadApiUrlButton.textContent = "저장";
  }
}

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
      badge.textContent = item.success ? "전송 성공" : "전송 실패";
      heading.append(title, badge);

      const details = document.createElement("p");
      details.className = "upload-log-details";
      const itemCount = Number.isFinite(item.itemCount)
        ? `${item.itemCount.toLocaleString()}개`
        : "확인 불가";
      const status = item.status === null
        ? "응답 없음"
        : `HTTP ${item.status}`;
      details.textContent = `데이터 ${itemCount} · ${status} · ${item.dateDirectory}/${item.fileName}`;
      article.append(heading, details);

      if (item.sampleProductIds?.length > 0) {
        const sample = document.createElement("p");
        sample.className = "upload-log-sample";
        sample.textContent = `상품 ID 예시: ${item.sampleProductIds.join(", ")}`;
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
    const result = await window.collectorApp.getCollectionUploadLogs(page);
    renderCollectionUploadLogs(result);
  } catch (error) {
    elements.collectionUploadLogList.textContent =
      `전송 로그를 불러오지 못했습니다: ${error.message}`;
  }
}

/** Electron preload API 존재 여부를 확인하고 화면을 초기화한다. */
async function initialize() {
  if (!window.collectorApp) {
    throw new Error("Electron preload API를 찾지 못했습니다.");
  }

  state.unsubscribe = window.collectorApp.onStateChanged(handleStateChanged);

  await loadDefaults();
  await loadCredentialProfiles();
  await loadUploadApiSettings();
  await loadCollectionUploadLogs(1);
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
elements.openProxyManagerButton.addEventListener("click", openProxyManager);
elements.closeProxyManagerButton.addEventListener("click", closeProxyManager);
elements.cancelProxyManagerButton.addEventListener("click", closeProxyManager);
elements.saveProxyProfileButton.addEventListener("click", saveProxyProfile);
elements.openOpenAiManagerButton.addEventListener("click", openOpenAiManager);
elements.closeOpenAiManagerButton.addEventListener("click", closeOpenAiManager);
elements.cancelOpenAiManagerButton.addEventListener("click", closeOpenAiManager);
elements.saveOpenAiProfileButton.addEventListener("click", saveOpenAiProfile);
elements.uploadApiSettingsForm.addEventListener("submit", saveUploadApiSettings);
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
      await window.collectorApp.openCollectionUploadLogDirectory();
    } catch (error) {
      showError(`전송 로그 폴더를 열지 못했습니다: ${error.message}`);
    }
  },
);
elements.collectionMode.addEventListener("change", updateCollectionModeGuide);
elements.runMode.addEventListener("change", updateRunModeGuide);
elements.repeatScheduleType.addEventListener("change", updateRepeatScheduleGuide);
elements.cheonyuProxyProfileSelect.addEventListener("change", (event) => {
  syncProxyProfileSelection(event.currentTarget);
});
elements.cartCheonyuProxyProfileSelect.addEventListener("change", (event) => {
  syncProxyProfileSelection(event.currentTarget);
});
elements.openAiProfileSelect.addEventListener("change", (event) => {
  renderOpenAiProfileSelect(event.currentTarget.value);
});
elements.cheonyuUserAgent.addEventListener("change", (event) => {
  const value = event.currentTarget.value.trim();
  event.currentTarget.value = value;

  if (value) {
    localStorage.setItem(CHEONYU_USER_AGENT_STORAGE_KEY, value);
  } else {
    localStorage.removeItem(CHEONYU_USER_AGENT_STORAGE_KEY);
  }
});
elements.chooseOutputButton.addEventListener("click", chooseOutputDirectory);
elements.openSettingsButton?.addEventListener(
  "click",
  openSettingsDirectory,
);
elements.cartUploadButton.addEventListener(
  "click",
  submitCartUpload,
);

elements.shippingToggleButton.addEventListener(
  "click",
  toggleShippingEnabled,
);
elements.collectionUploadToggleButton.addEventListener(
  "click",
  toggleCollectionUploadEnabled,
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

elements.proxyManagerModal.addEventListener("click", (event) => {
  if (event.target === elements.proxyManagerModal) closeProxyManager();
});

elements.openAiManagerModal.addEventListener("click", (event) => {
  if (event.target === elements.openAiManagerModal) closeOpenAiManager();
});

window.addEventListener("beforeunload", () => {
  state.unsubscribe?.();
  clearAllRepeatPlans();

  if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
  }
});

// 사이드바 뷰 전환 기능
function switchView(viewName) {
  const viewMap = {
    dashboard: "collectionView",
    "new-collection": "collectionView",
    runs: "runsView",
    cart: "cartView",
    results: "downloadView",
    settings: "settingsView",
  };

  const targetViewId = viewMap[viewName];
  if (!targetViewId) return;

  // 모든 뷰 섹션 숨기기
  document.querySelectorAll(".view-section").forEach((section) => {
    section.classList.remove("active");
  });

  // 해당 뷰 표시
  const targetView = document.getElementById(targetViewId);
  if (targetView) {
    targetView.classList.add("active");
  }

  // 네비게이션 항목 활성화 상태 업데이트
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.remove("active");
  });
  document
    .querySelector(`.nav-item[data-view="${viewName}"]`)
    ?.classList.add("active");

  if (viewName === "results") {
    void loadCollectionUploadLogs(1);
  }
}

// 사이드바 네비게이션 이벤트 처리
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    const viewName = item.getAttribute("data-view");
    switchView(viewName);
  });
});

initialize().catch((error) => {
  elements.appBadge.textContent = "초기화 실패";
  showError(error.message);
});

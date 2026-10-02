// electron/credential-store.js
// 목적: 프록시·OpenAI API 키·운송장 계정의 등록 정보를 암호화하여 저장하고 관리한다.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STORE_VERSION = 1;

function normalizeText(value, label, maxLength = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (!text) throw new Error(`${label}을(를) 입력하세요.`);
  if (text.length > maxLength) {
    throw new Error(`${label}은(는) ${maxLength}자 이하로 입력하세요.`);
  }

  return text;
}

function createEmptyData() {
  return {
    version: STORE_VERSION,
    proxies: [],
    openAiKeys: [],
    shippingAccounts: [],
    selectedShippingAccountId: "",
  };
}

function normalizeStoredData(value) {
  if (!value || typeof value !== "object") {
    throw new Error("등록 정보 파일 형식이 올바르지 않습니다.");
  }

  if (value.version !== STORE_VERSION) {
    throw new Error("지원하지 않는 등록 정보 파일 버전입니다.");
  }

  return {
    version: STORE_VERSION,
    proxies: Array.isArray(value.proxies) ? value.proxies : [],
    openAiKeys: Array.isArray(value.openAiKeys) ? value.openAiKeys : [],
    shippingAccounts: Array.isArray(value.shippingAccounts) ? value.shippingAccounts : [],
    selectedShippingAccountId: String(value.selectedShippingAccountId || ""),
  };
}

function createCredentialStore({ safeStorage, userDataDir, normalizeProxyCredentials }) {
  const filePath = path.resolve(userDataDir, "credentials.bin");

  function ensureEncryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error(
        "Windows 보안 저장소를 사용할 수 없어 계정/프록시/API 키를 저장할 수 없습니다.",
      );
    }
  }

  function readData() {
    ensureEncryptionAvailable();

    if (!fs.existsSync(filePath)) return createEmptyData();

    try {
      const encrypted = fs.readFileSync(filePath);
      const plainText = safeStorage.decryptString(encrypted);
      return normalizeStoredData(JSON.parse(plainText));
    } catch {
      throw new Error(
        "등록된 계정/프록시/API 키 정보를 읽을 수 없습니다. 설정 파일이 손상되었거나 다른 Windows 사용자로 생성되었습니다.",
      );
    }
  }

  function writeData(data) {
    ensureEncryptionAvailable();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const encrypted = safeStorage.encryptString(JSON.stringify(data));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      fs.writeFileSync(tempPath, encrypted, { mode: 0o600 });
      fs.renameSync(tempPath, filePath);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  function createSummary(data = readData()) {
    return {
      proxies: data.proxies.map((profile) => ({
        id: profile.id,
        name: profile.name,
        server: profile.server,
        username: profile.username || "",
        hasPassword: Boolean(profile.password),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
      openAiKeys: data.openAiKeys.map((profile) => ({
        id: profile.id,
        name: profile.name,
        keyHint: profile.apiKey
          ? `••••${String(profile.apiKey).slice(-4)}`
          : "",
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
      shippingAccounts: data.shippingAccounts.map((profile) => ({
        id: profile.id,
        name: profile.name,
        loginId: profile.loginId,
        hasPassword: Boolean(profile.password),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
      selectedShippingAccountId: data.selectedShippingAccountId,
    };
  }

  function assertUniqueName(items, id, name, label) {
    const duplicated = items.some(
      (item) => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );

    if (duplicated) throw new Error(`이미 같은 이름의 ${label}이(가) 있습니다.`);
  }

  function saveProxy(input = {}) {
    const data = readData();
    const id = String(input.id || "").trim();
    const existing = id
      ? data.proxies.find((profile) => profile.id === id)
      : null;

    if (id && !existing) throw new Error("수정할 프록시를 찾을 수 없습니다.");

    const name = normalizeText(input.name, "프록시 등록 이름", 80);
    const username = String(input.username || "").trim();
    const passwordProvided = Object.hasOwn(input, "password") && input.password !== "";

    if (!username && passwordProvided) {
      throw new Error("프록시 비밀번호를 입력하려면 사용자 이름도 입력하세요.");
    }

    const password = username
      ? passwordProvided
        ? String(input.password)
        : String(existing?.password || "")
      : "";

    assertUniqueName(data.proxies, id, name, "프록시");

    const normalized = normalizeProxyCredentials(
      {
        server: input.server,
        username,
        password,
      },
      "등록 프록시",
    );
    const now = new Date().toISOString();
    const profile = {
      id: existing?.id || `proxy_${randomUUID()}`,
      name,
      server: normalized.server,
      username: normalized.username || "",
      password: normalized.password || "",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    data.proxies = existing
      ? data.proxies.map((item) => item.id === existing.id ? profile : item)
      : [...data.proxies, profile];
    writeData(data);

    return {
      summary: createSummary(data),
      selectedId: profile.id,
    };
  }

  function saveOpenAiKey(input = {}) {
    const data = readData();
    const id = String(input.id || "").trim();
    const existing = id
      ? data.openAiKeys.find((profile) => profile.id === id)
      : null;

    if (id && !existing) throw new Error("수정할 OpenAI API 키를 찾을 수 없습니다.");

    const name = normalizeText(input.name, "API 키 등록 이름", 80);
    const apiKeyProvided = Object.hasOwn(input, "apiKey") && input.apiKey !== "";
    const apiKey = apiKeyProvided
      ? String(input.apiKey).trim()
      : String(existing?.apiKey || "");

    if (!apiKey) throw new Error("OpenAI API 키를 입력하세요.");
    if (apiKey.length > 2048 || /[\r\n\0]/.test(apiKey)) {
      throw new Error("OpenAI API 키 형식이 올바르지 않습니다.");
    }

    assertUniqueName(data.openAiKeys, id, name, "API 키");

    const now = new Date().toISOString();
    const profile = {
      id: existing?.id || `openai_${randomUUID()}`,
      name,
      apiKey,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    data.openAiKeys = existing
      ? data.openAiKeys.map((item) => item.id === existing.id ? profile : item)
      : [...data.openAiKeys, profile];
    writeData(data);

    return {
      summary: createSummary(data),
      selectedId: profile.id,
    };
  }

  function saveShippingAccount(input = {}) {
    const data = readData();
    const id = String(input.id || "").trim();
    const existing = id ? data.shippingAccounts.find((profile) => profile.id === id) : null;
    if (id && !existing) throw new Error("수정할 운송장 계정을 찾을 수 없습니다.");

    const name = normalizeText(input.name, "운송장 계정 등록 이름", 80);
    const loginId = String(input.loginId || "").trim();
    const passwordProvided = typeof input.password === "string" && input.password !== "";
    const password = passwordProvided ? input.password : String(existing?.password || "");
    if (!loginId) throw new Error("운송장 계정 ID를 입력하세요.");
    if (loginId.length > 256 || /[\r\n\0]/.test(loginId)) {
      throw new Error("운송장 계정 ID 형식이 올바르지 않습니다.");
    }
    if (!password) throw new Error("운송장 계정 비밀번호를 입력하세요.");
    if (password.length > 2048 || /[\r\n\0]/.test(password)) {
      throw new Error("운송장 계정 비밀번호 형식이 올바르지 않습니다.");
    }
    assertUniqueName(data.shippingAccounts, id, name, "운송장 계정");

    const now = new Date().toISOString();
    const sameCredentials = existing?.loginId === loginId && existing?.password === password;
    const profile = {
      id: existing?.id || `shipping_${randomUUID()}`,
      name,
      loginId,
      password,
      // ID/PW가 변경되면 이전 계정으로 로그인된 브라우저 세션을 재사용하지 않는다.
      authRevision: sameCredentials && existing.authRevision ? existing.authRevision : randomUUID(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    data.shippingAccounts = existing
      ? data.shippingAccounts.map((item) => item.id === id ? profile : item)
      : [...data.shippingAccounts, profile];
    data.selectedShippingAccountId = profile.id;
    writeData(data);
    return { summary: createSummary(data), selectedId: profile.id };
  }

  function selectShippingAccount(id) {
    const profileId = String(id || "").trim();
    const data = readData();
    if (profileId && !data.shippingAccounts.some((profile) => profile.id === profileId)) {
      throw new Error("선택한 운송장 계정을 찾을 수 없습니다. 다시 선택하세요.");
    }
    data.selectedShippingAccountId = profileId;
    writeData(data);
    return createSummary(data);
  }

  function getSelectedShippingAccount() {
    const data = readData();
    if (!data.selectedShippingAccountId) return null;
    const profile = data.shippingAccounts.find((item) => item.id === data.selectedShippingAccountId);
    if (!profile) throw new Error("선택한 운송장 계정을 찾을 수 없습니다. 다시 선택하세요.");
    return { ...profile };
  }

  function deleteProfile(collectionKey, id, label) {
    const profileId = String(id || "").trim();
    const data = readData();
    const items = data[collectionKey];

    if (!items.some((profile) => profile.id === profileId)) {
      throw new Error(`삭제할 ${label}을(를) 찾을 수 없습니다.`);
    }

    data[collectionKey] = items.filter((profile) => profile.id !== profileId);
    if (collectionKey === "shippingAccounts" && data.selectedShippingAccountId === profileId) {
      data.selectedShippingAccountId = "";
    }
    writeData(data);
    return createSummary(data);
  }

  function getProfile(collectionKey, id, label) {
    const profileId = String(id || "").trim();

    if (!profileId) return null;

    const profile = readData()[collectionKey].find((item) => item.id === profileId);
    if (!profile) throw new Error(`선택한 ${label}을(를) 찾을 수 없습니다. 다시 선택하세요.`);
    return { ...profile };
  }

  return Object.freeze({
    filePath,
    getSummary: () => createSummary(),
    getProxy: (id) => getProfile("proxies", id, "프록시"),
    getProxies: () => readData().proxies.map((profile) => ({ ...profile })),
    getOpenAiKey: (id) => getProfile("openAiKeys", id, "OpenAI API 키"),
    saveProxy,
    saveOpenAiKey,
    saveShippingAccount,
    selectShippingAccount,
    getSelectedShippingAccount,
    deleteShippingAccount: (id) => deleteProfile("shippingAccounts", id, "운송장 계정"),
    deleteProxy: (id) => deleteProfile("proxies", id, "프록시"),
    deleteOpenAiKey: (id) => deleteProfile("openAiKeys", id, "OpenAI API 키"),
  });
}

module.exports = {
  createCredentialStore,
};

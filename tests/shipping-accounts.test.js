const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { createCredentialStore } = require("../electron/credential-store");
const { getShippingProfileDirectory } = require("../src/utils/shipping-login");

function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipping-account-test-"));
  t.after(() => {
    assert.equal(path.dirname(userDataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(userDataDir).startsWith("shipping-account-test-"));
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
  const key = randomBytes(32);
  // Electron 대신 테스트 전용 키로 실제 암호화된 바이트를 저장한다.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
  const options = { safeStorage, userDataDir, normalizeProxyCredentials: (value) => value };
  return { store: createCredentialStore(options), options, safeStorage, userDataDir };
}

test("운송장 계정은 암호화 저장 후 재시작해도 선택과 원본 비밀번호가 유지된다", (t) => {
  const { store, options } = fixture(t);
  const password = " synthetic-shipping-password ";
  const result = store.saveShippingAccount({ name: "KSE 운영", loginId: "test-user", password });
  assert.equal(result.summary.selectedShippingAccountId, result.selectedId);
  assert.equal(result.summary.shippingAccounts[0].hasPassword, true);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(Object.hasOwn(result.summary.shippingAccounts[0], "password"), false);
  assert.equal(fs.readFileSync(store.filePath).includes(Buffer.from(password)), false);
  const reopened = createCredentialStore(options);
  assert.equal(reopened.getSelectedShippingAccount().password, password);
  assert.equal(reopened.getSelectedShippingAccount().id, result.selectedId);
});

test("이전 v1 저장소를 열고 운송장 계정을 추가해도 기존 등록 정보가 보존된다", (t) => {
  const { store, safeStorage } = fixture(t);
  const legacy = {
    version: 1,
    proxies: [{ id: "proxy-old", name: "old", server: "http://localhost:3128", password: "proxy-test" }],
    openAiKeys: [{ id: "api-old", name: "old", apiKey: "synthetic-old-key" }],
  };
  fs.writeFileSync(store.filePath, safeStorage.encryptString(JSON.stringify(legacy)));
  assert.deepEqual(store.getSummary().shippingAccounts, []);
  assert.equal(store.getSelectedShippingAccount(), null);
  store.saveShippingAccount({ name: "KSE", loginId: "test", password: "synthetic" });
  assert.equal(store.getProxy("proxy-old").password, "proxy-test");
  assert.equal(store.getOpenAiKey("api-old").apiKey, "synthetic-old-key");
  store.saveOpenAiKey({ name: "another", apiKey: "synthetic-new-key" });
  assert.equal(store.getSelectedShippingAccount().loginId, "test");
});

test("이름만 수정하면 세션을 유지하고 ID 또는 비밀번호 변경 시 별도 세션을 사용한다", (t) => {
  const { store, userDataDir } = fixture(t);
  const saved = store.saveShippingAccount({ name: "first", loginId: "test", password: "synthetic" });
  const before = getShippingProfileDirectory(userDataDir, store.getSelectedShippingAccount());
  store.saveShippingAccount({ id: saved.selectedId, name: "renamed", loginId: "test", password: "" });
  assert.equal(store.getSelectedShippingAccount().password, "synthetic");
  assert.equal(getShippingProfileDirectory(userDataDir, store.getSelectedShippingAccount()), before);
  store.saveShippingAccount({ id: saved.selectedId, name: "renamed", loginId: "test", password: "changed" });
  const afterPassword = getShippingProfileDirectory(userDataDir, store.getSelectedShippingAccount());
  assert.notEqual(afterPassword, before);
  store.saveShippingAccount({ id: saved.selectedId, name: "renamed", loginId: "changed-user" });
  assert.notEqual(getShippingProfileDirectory(userDataDir, store.getSelectedShippingAccount()), afterPassword);
});

test("계정 선택 해제와 삭제를 저장하고 없는 계정 및 잘못된 입력을 거부한다", (t) => {
  const { store, options } = fixture(t);
  const first = store.saveShippingAccount({ name: "first", loginId: "test-1", password: "synthetic" });
  const second = store.saveShippingAccount({ name: "second", loginId: "test-2", password: "synthetic" });
  assert.throws(() => store.selectShippingAccount("missing"), /찾을 수 없습니다/);
  assert.throws(() => store.saveShippingAccount({ name: "FIRST", loginId: "new", password: "valid" }), /같은 이름/);
  assert.throws(() => store.saveShippingAccount({ name: "third", loginId: "new" }), /비밀번호/);
  assert.throws(() => store.saveShippingAccount({ name: "third", loginId: "bad\nvalue", password: "valid" }), /ID 형식/);
  assert.throws(() => store.saveShippingAccount({ name: "third", loginId: "valid", password: "bad\0value" }), /비밀번호 형식/);
  store.selectShippingAccount(first.selectedId);
  store.deleteShippingAccount(second.selectedId);
  assert.equal(store.getSelectedShippingAccount().id, first.selectedId);
  store.selectShippingAccount("");
  assert.equal(createCredentialStore(options).getSelectedShippingAccount(), null);
  store.selectShippingAccount(first.selectedId);
  assert.equal(store.deleteShippingAccount(first.selectedId).selectedShippingAccountId, "");
  assert.equal(createCredentialStore(options).getSelectedShippingAccount(), null);
});

test("암호화 저장소를 사용할 수 없으면 평문 파일로 대체하지 않는다", (t) => {
  const { store, safeStorage } = fixture(t);
  safeStorage.isEncryptionAvailable = () => false;
  assert.throws(() => store.saveShippingAccount({ name: "test", loginId: "test", password: "synthetic" }), /보안 저장소/);
  assert.equal(fs.existsSync(store.filePath), false);
});

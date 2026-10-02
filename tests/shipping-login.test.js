const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { fillShippingLogin, getShippingProfileDirectory } = require("../src/utils/shipping-login");

const account = { id: "shipping-test", loginId: "synthetic-user", password: " synthetic-password ", authRevision: "revision-1" };

function mockPage(url = "https://www.kseoms.com/login", { inputs = true, hiddenFirst = false, onFill } = {}) {
  const fills = [];
  let currentUrl = url;
  const createInput = (kind, visible = true) => ({
    isVisible: async () => visible,
    fill: async (value) => { fills.push({ kind, value }); await onFill?.(kind, value); },
  });
  const idInputs = inputs ? [...(hiddenFirst ? [createInput("hidden-id", false)] : []), createInput("id")] : [];
  const passwordInputs = inputs ? [...(hiddenFirst ? [createInput("hidden-password", false)] : []), createInput("password")] : [];
  return {
    fills,
    setUrl: (value) => { currentUrl = value; },
    url: () => currentUrl,
    locator(selector) {
      const candidates = selector === 'input[name="user_id"]' ? idInputs : passwordInputs;
      return { count: async () => candidates.length, nth: (index) => candidates[index] };
    },
  };
}

test("KSE 로그인 입력을 채우고 비밀번호 공백을 보존하며 제출하지 않는다", async () => {
  const page = mockPage(undefined, { hiddenFirst: true });
  assert.equal(await fillShippingLogin(page, account), true);
  assert.deepEqual(page.fills, [
    { kind: "id", value: account.loginId },
    { kind: "password", value: account.password },
  ]);
});

test("미등록, 로그인 폼 없음, KSE 이외 주소 또는 HTTP에서는 입력하지 않는다", async () => {
  const manualPage = mockPage();
  assert.equal(await fillShippingLogin(manualPage, null), false);
  assert.deepEqual(manualPage.fills, []);
  assert.equal(await fillShippingLogin(mockPage(undefined, { inputs: false }), account), false);
  for (const url of ["https://www.kseoms.com.example.org/login", "http://www.kseoms.com/login", "https://example.org/", "about:blank", "https://www.kseoms.com:8443/login"]) {
    const page = mockPage(url);
    assert.equal(await fillShippingLogin(page, account), false);
    assert.deepEqual(page.fills, []);
  }
  assert.equal(await fillShippingLogin(mockPage("https://kseoms.com/login"), account), true);
});

test("ID 입력 후 다른 도메인으로 이동하면 비밀번호를 입력하지 않는다", async () => {
  const page = mockPage(undefined, { onFill: () => page.setUrl("https://example.org/") });
  assert.equal(await fillShippingLogin(page, account), false);
  assert.deepEqual(page.fills, [{ kind: "id", value: account.loginId }]);
});

test("Playwright 입력 오류 메시지에 포함된 자격증명은 호출자에게 노출하지 않는다", async () => {
  const page = mockPage(undefined, { onFill: () => { throw new Error(`fill ${account.password}`); } });
  await assert.rejects(fillShippingLogin(page, account), (error) => {
    assert.match(error.message, /자동 입력에 실패/);
    assert.equal(error.message.includes(account.password), false);
    return true;
  });
});

test("수동 프로필을 유지하고 계정과 인증 버전별로 안전한 하위 프로필을 분리한다", () => {
  const base = path.resolve("synthetic-kse-profile");
  assert.equal(getShippingProfileDirectory(base, null), base);
  const selected = getShippingProfileDirectory(base, account);
  assert.equal(path.dirname(selected), base);
  assert.match(path.basename(selected), /^account-[a-f0-9]{64}$/);
  assert.equal(selected.includes(account.loginId), false);
  assert.notEqual(selected, getShippingProfileDirectory(base, { ...account, id: "other" }));
  assert.notEqual(selected, getShippingProfileDirectory(base, { ...account, authRevision: "revision-2" }));
  assert.equal(selected, getShippingProfileDirectory(base, { ...account, name: "renamed" }));
});

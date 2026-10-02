// src/utils/shipping-login.js
// 목적: 등록한 KSE 계정을 로그인 폼에 입력하고 계정별 브라우저 프로필 경로를 분리한다.

const path = require("node:path");
const { createHash } = require("node:crypto");

const KSE_ORIGINS = new Set(["https://www.kseoms.com", "https://kseoms.com"]);
const LOGIN_ID_SELECTORS = ['input[name="user_id"]'];
const PASSWORD_SELECTORS = ['input[name="password"]', 'input[type="password"]'];

function isShippingLoginOrigin(page) {
  try {
    return KSE_ORIGINS.has(new URL(page.url()).origin);
  } catch {
    return false;
  }
}

async function firstVisibleInput(page, selectors) {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return null;
}

/** KSE 로그인 화면에만 등록 정보를 입력하고 로그인 제출은 사용자에게 맡긴다. */
async function fillShippingLogin(page, account) {
  if (!account?.loginId || !account?.password || !isShippingLoginOrigin(page)) return false;
  const loginInput = await firstVisibleInput(page, LOGIN_ID_SELECTORS);
  const passwordInput = await firstVisibleInput(page, PASSWORD_SELECTORS);
  if (!loginInput || !passwordInput || !isShippingLoginOrigin(page)) return false;

  try {
    await loginInput.fill(account.loginId, { timeout: 5000 });
    if (!isShippingLoginOrigin(page)) return false;
    await passwordInput.fill(account.password, { timeout: 5000 });
    return true;
  } catch {
    // Playwright 오류에는 입력값이 포함될 수 있으므로 원문 오류를 전달하지 않는다.
    throw new Error("KSE 로그인 정보 자동 입력에 실패했습니다. 열린 브라우저에서 직접 입력해 주세요.");
  }
}

/** 계정 또는 인증 정보가 바뀌면 해당 계정의 새 세션을 사용한다. */
function getShippingProfileDirectory(baseDirectory, account) {
  if (!account) return path.resolve(baseDirectory);
  const digest = createHash("sha256")
    .update(JSON.stringify([account.id || "", account.loginId || "", account.authRevision || ""]))
    .digest("hex");
  return path.resolve(baseDirectory, `account-${digest}`);
}

module.exports = { fillShippingLogin, getShippingProfileDirectory };

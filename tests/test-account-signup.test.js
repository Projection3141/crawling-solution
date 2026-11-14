process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");
const { runTestAccountSignup } = require("../electron/test-account-signup");
const { createTestAccountStore } = require("../electron/test-account-store");

const NAME_GENERATOR = new URL("https://fanmooz.com/현대-이름생성기/").href;
const SIGNUP = "https://cheonyu.com/member/join_step012.html";
const COMPLETE = "https://cheonyu.com/member/join_step023.html?inname=fixture";
const SIGNUP_ORIGIN = new URL(SIGNUP).origin;
const POSTCODE = "https://postcode.map.kakao.com/search";
const POSTCODE_ORIGIN = new URL(POSTCODE).origin;
const POSTCODE_INITIAL = `${POSTCODE}?origin=${encodeURIComponent(SIGNUP_ORIGIN)}&mode=transmit&vt=popup`;
const FIRST_ADDRESS = "첫 번째 도로명 주소";
const SECOND_ADDRESS = "두 번째 도로명 주소";
const POSTCODE_WRAPPER = `<!doctype html><script>
  addEventListener('message', event => {
    if (event.origin !== '${POSTCODE_ORIGIN}') return;
    if (event.data?.type === 'fixture-address-selected') {
      opener.postMessage(event.data, '${SIGNUP_ORIGIN}');
      close();
    } else if (event.data?.type === 'fixture-close-postcode') {
      close();
    }
  });
</script><iframe src="${POSTCODE_INITIAL.replaceAll("&", "&amp;")}"></iframe>`;
const FORM = `<!doctype html><script>
  window.fixtureDuplicateFirst = false;
  window.fixtureBlockSubmission = false;
  function checkId() {
    const count = Number(document.querySelector('#fixtureIdCheckCount').value) + 1;
    document.querySelector('#fixtureIdCheckCount').value = String(count);
    if (window.fixtureDuplicateFirst && count === 1) {
      document.querySelector('#msgID').textContent = '이미 사용되어진 아이디입니다.';
      return;
    }
    document.querySelector('#inMid2').value = document.querySelector('#inMid').value;
    document.querySelector('#msgID').textContent = '사용할 수 있는 아이디입니다.';
  }
  function copyTel() {
    document.querySelector('#inMHP1').value = document.querySelector('#inMTEL1').value;
    document.querySelector('#inMHP2').value = document.querySelector('#inMTEL2').value;
    document.querySelector('#inMHP3').value = document.querySelector('#inMTEL3').value;
  }
  function openPostcode() {
    const popup = window.open('');
    popup.document.write(${JSON.stringify(POSTCODE_WRAPPER).replaceAll("</script>", "<\\/script>")});
    popup.document.close();
  }
  addEventListener('message', event => {
    if (event.origin !== '${SIGNUP_ORIGIN}' || event.data?.type !== 'fixture-address-selected') return;
    document.querySelector('#inMpost').value = event.data.postcode;
    document.querySelector('#inMaddr1').value = event.data.address;
  });
 </script><style>
  .ckbox label { display:inline-block; position:relative; }
  .ckbox label input { position:absolute; top:0; left:0; z-index:-1; width:1px; height:1px; opacity:.01; }
 </style><form method="post" onsubmit="return !window.fixtureBlockSubmission &&
     document.querySelector('#inMid2').value === document.querySelector('#inMid').value &&
    document.querySelector('#chkCopyTel').checked && document.querySelector('#inMHP3').value &&
    document.querySelector('#chkTerm').checked && document.querySelector('#chkPrivacy').checked">
  <input id="inMid" name="inMid" maxlength="12">
  <input id="inMid2" name="inMid2">
  <input id="fixtureIdCheckCount" name="fixtureIdCheckCount" value="0">
  <p id="msgID"></p>
  <a href="javascript:void(0)" class="chk_id ptsans" onclick="checkId()">중복확인</a>
  <input id="inMpw1" name="inMpw1" type="password">
  <input id="inMpw2" name="inMpw2" type="password">
  <input id="inMname" name="inMname" required>
  <input id="inMTEL1" name="inMTEL1" maxlength="4">
  <input id="inMTEL2" name="inMTEL2" required>
  <input id="inMTEL3" name="inMTEL3" maxlength="4">
  <input id="inMHP1" name="inMHP1">
  <input id="inMHP2" name="inMHP2">
  <input id="inMHP3" name="inMHP3">
  <span class="ckbox"><label><input id="chkCopyTel" type="checkbox" onclick="copyTel()"><em class="mbradio02"></em><em>전화번호와 동일</em></label></span>
  <input name="inMemail1" required>
  <input id="uemail_direct" name="inMemail2" style="display:none">
  <div data-id="select-area">
    <a id="uemail2" href="javascript:void(0)" data-id="select_active">직접입력</a>
    <div data-id="select_list"><a dg-data="naver.com" onclick="document.querySelector('#uemail_direct').value='naver.com'; document.querySelector('#uemail2').textContent='naver.com'">naver.com</a></div>
  </div>
  <input id="inMpost" name="inMpost" readonly>
  <input id="inMaddr1" name="inMaddr1" readonly>
  <input id="inMaddr2" name="inMaddr2">
  <a href="javascript:void(0)" class="find-addr chk_addr ptsans" onclick="openPostcode()">주소 검색</a>
  <span class="ckbox"><label><input id="chkTerm" name="chkTerm" type="checkbox" required><em class="mbradio02"></em><em>이용약관 동의</em></label></span>
  <span class="ckbox"><label><input id="chkPrivacy" name="chkPrivacy" type="checkbox" required><em class="mbradio02"></em><em>개인정보 보호정책 동의</em></label></span>
  <button id="btnJoin" type="submit" onclick="this.dataset.clicked='yes'">가입</button>
</form>`;
const NAME_FORM = `<!doctype html>
  <h4 id="random_name"></h4>
  <input type="button" value="남자 이름 생성" onclick="document.querySelector('#random_name').textContent='이름테스트'">`;

function postalForm(query, hasResults) {
    const result = hasResults
        ? `<ul class="list_post">${[FIRST_ADDRESS, SECOND_ADDRESS].map(address => `
            <li><button type="button" class="link_post" onclick="parent.postMessage({type:'fixture-address-selected',postcode:'${query}',address:'${address}'}, '${SIGNUP_ORIGIN}')">${address}</button></li>`).join("")}</ul>`
        : query ? '<div class="desc_post"><span class="emph_bold">검색결과가 없습니다.</span></div>' : "";
    return `<!doctype html><form id="searchForm" method="get" action="/search">
  <input name="region_name" value="${query}"><button class="btn_search" type="submit">검색</button>
</form>${result}`;
}

function fixtureBrowser({ closePostcodePopup = false, duplicateFirstId = false, blockSubmission = false } = {}) {
    const requests = [];
    const postalQueries = [];
    const signupBodies = [];
    const { promise: pageReady, resolve: onPage } = Promise.withResolvers();
    const browserType = {
        async launch(options) {
            assert.equal(options.headless, false, "the app opens a visible browser");
            const browser = await chromium.launch({ ...options, headless: true });
            return {
                close: () => browser.close(),
                isConnected: () => browser.isConnected(),
                async newContext() {
                    const context = await browser.newContext();
                    // Intercept every request, including the real site's URL, so the
                    // simulated user's click can never submit to an external site.
                    await context.route("**/*", async route => {
                        const request = route.request();
                        const url = request.url();
                        const method = request.method();
                        requests.push({ url, method });
                        if (url === NAME_GENERATOR && method === "GET") {
                            return route.fulfill({ contentType: "text/html; charset=utf-8", body: NAME_FORM });
                        }
                        if (new URL(url).origin + new URL(url).pathname === POSTCODE && method === "GET") {
                            const query = new URL(url).searchParams.get("region_name") || "";
                            assert.match(query, /^(?:\d{5})?$/);
                            if (query) postalQueries.push(query);
                            if (closePostcodePopup) {
                                return route.fulfill({ contentType: "text/html", body: `<script>
                                    parent.postMessage({type:'fixture-close-postcode'}, '${SIGNUP_ORIGIN}');
                                </script>` });
                            }
                            return route.fulfill({ contentType: "text/html; charset=utf-8", body: postalForm(query, postalQueries.length >= 2) });
                        }
                        if (url === SIGNUP && method === "GET") {
                            const body = FORM.replace(
                                "window.fixtureDuplicateFirst = false;",
                                `window.fixtureDuplicateFirst = ${duplicateFirstId};`,
                            ).replace("window.fixtureBlockSubmission = false;", `window.fixtureBlockSubmission = ${blockSubmission};`);
                            return route.fulfill({ contentType: "text/html; charset=utf-8", body });
                        }
                        if (url === SIGNUP && method === "POST") {
                            signupBodies.push(request.postData());
                            return route.fulfill({
                                contentType: "text/html",
                                body: '<script>location.replace("/member/join_step023.html?inname=fixture")</script>',
                            });
                        }
                        if (url === COMPLETE) {
                            return route.fulfill({ contentType: "text/html", body: "<h1>가입 완료</h1>" });
                        }
                        return route.abort();
                    });
                    return {
                        async newPage() {
                            const page = await context.newPage();
                            onPage(page);
                            return page;
                        },
                    };
                },
            };
        },
    };
    return { browserType, pageReady, requests, postalQueries, signupBodies };
}

async function preparedPage(fixture, run) {
    const page = await Promise.race([fixture.pageReady, run.then(() => {
        throw new Error("가입 양식을 열기 전에 종료했습니다.");
    })]);
    await Promise.race([page.waitForFunction(() => document.querySelector("#inMpw2")?.value &&
        document.querySelector("#inMaddr1")?.value), run.then(() => {
        throw new Error("주소 자동 입력을 끝내기 전에 종료했습니다.");
    })]);
    return page;
}

test("the headed signup checks the ID, copies required contact details, agrees to terms, and submits automatically", { timeout: 15000 }, async t => {
    const fixture = fixtureBrowser();
    const run = runTestAccountSignup([], { browserType: fixture.browserType, signal: t.signal });
    const { id, pw } = await run;
    assert.match(id, /^[a-z]{3,6}\d{1,3}$/);
    const groups = pw.match(/[a-z]+|\d+|[!@#$%]+/g);
    assert.equal(groups.join(""), pw);
    assert.equal(groups.length, 3);
    assert.equal(groups.filter(group => /^[a-z]{4,6}$/.test(group)).length, 1);
    assert.equal(groups.filter(group => /^\d{2,4}$/.test(group)).length, 1);
    assert.equal(groups.filter(group => /^[!@#$%]{2}$/.test(group)).length, 1);

    assert.equal(fixture.signupBodies.length, 1);
    const submitted = new URLSearchParams(fixture.signupBodies[0]);
    assert.equal(submitted.get("inMid2"), id);
    assert.equal(submitted.get("inMpw1"), pw);
    assert.equal(submitted.get("inMpw2"), pw);
    assert.equal(submitted.get("inMname"), "이름테스트");
    assert.equal(submitted.get("inMTEL1"), "010");
    assert.match(submitted.get("inMTEL2"), /^\d{4}$/);
    assert.match(submitted.get("inMTEL3"), /^\d{4}$/);
    assert.equal(submitted.get("inMHP1"), submitted.get("inMTEL1"));
    assert.equal(submitted.get("inMHP2"), submitted.get("inMTEL2"));
    assert.equal(submitted.get("inMHP3"), submitted.get("inMTEL3"));
    assert.equal(submitted.get("inMemail1"), id);
    assert.equal(submitted.get("inMemail2"), "naver.com");
    assert.equal(submitted.get("chkTerm"), "on");
    assert.equal(submitted.get("chkPrivacy"), "on");
    assert.equal(submitted.get("inMpost"), fixture.postalQueries[1]);
    assert.equal(submitted.get("inMaddr1"), FIRST_ADDRESS);
    assert.equal(submitted.get("fixtureIdCheckCount"), "1");
    assert.equal(fixture.requests.filter(request => request.method === "POST").length, 1);
    assert.deepEqual(fixture.requests.slice(0, 3), [
        { url: NAME_GENERATOR, method: "GET" }, { url: SIGNUP, method: "GET" },
        { url: POSTCODE_INITIAL, method: "GET" },
    ]);
    assert.equal(fixture.postalQueries.length, 2);
    assert.notEqual(fixture.postalQueries[0], fixture.postalQueries[1]);
    for (const code of fixture.postalQueries) {
        assert.match(code, /^\d{5}$/);
        assert.ok(Number(code) >= 1000 && Number(code) <= 63999, code);
    }
});

test("an already-used ID is replaced and checked again before submission", { timeout: 15000 }, async t => {
    const fixture = fixtureBrowser({ duplicateFirstId: true });
    const result = await runTestAccountSignup([], { browserType: fixture.browserType, signal: t.signal });
    const submitted = new URLSearchParams(fixture.signupBodies[0]);
    assert.equal(submitted.get("fixtureIdCheckCount"), "2");
    assert.equal(submitted.get("inMid2"), result.id);
    assert.equal(submitted.get("inMemail1"), result.id);
});

test("closing or visiting the completion URL without submitting cannot produce a saved account", { timeout: 15000 }, async t => {
    const cancelFixture = fixtureBrowser();
    const cancelController = new AbortController();
    const canceled = runTestAccountSignup([], { browserType: cancelFixture.browserType, signal: cancelController.signal });
    await cancelFixture.pageReady;
    cancelController.abort();
    assert.deepEqual(await canceled, { canceled: true });

    const visitFixture = fixtureBrowser({ blockSubmission: true });
    const visit = runTestAccountSignup([], { browserType: visitFixture.browserType, signal: t.signal });
    const visitPage = await preparedPage(visitFixture, visit);
    await visitPage.locator('#btnJoin[data-clicked="yes"]').waitFor({ timeout: 5000 });
    const rejected = assert.rejects(visit, /가입 제출 및 완료 확인/);
    await visitPage.goto(COMPLETE).catch(error => {
        if (!visitPage.isClosed()) throw error;
    });
    await rejected;
});

test("an unavailable address popup leaves the signup page open with manual lookup instructions", { timeout: 15000 }, async t => {
    const fixture = fixtureBrowser({ closePostcodePopup: true });
    const run = runTestAccountSignup([], { browserType: fixture.browserType, signal: t.signal });
    const page = await fixture.pageReady;
    try {
        await page.getByRole("status").getByText("주소를 자동으로 선택하지 못했습니다.", { exact: false }).waitFor({ timeout: 10000 });
        assert.equal(await page.locator("#inMpost").inputValue(), "");
        assert.equal(await page.locator("#inMaddr1").inputValue(), "");
        assert.ok(await page.locator("#inMid").inputValue());
        assert.ok(fixture.requests.every(request => request.method === "GET"));
    } finally {
        await page.close();
    }
    assert.deepEqual(await run, { canceled: true });
});

test("completed signups appear in registered accounts, including multiple accounts on the same Korean date", async t => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const defaults = require("../src/config").getPublicDefaults({}, "fixture-output");
    await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== "https://collector.invalid") return route.abort();
        const filename = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (!/^[\w.-]+$/.test(filename)) return route.fulfill({ status: 404 });
        await route.fulfill({ path: path.join(__dirname, "../public", filename) });
    });
    await page.clock.setFixedTime(new Date("2026-11-12T15:05:00Z"));
    await page.addInitScript(defaults => {
        let count = 0;
        window.collectorApp = {
            getBrands: async () => ({ brands: [], recent: [], used: 0, remaining: 10, limit: 10 }),
            getDefaults: async () => ({ ...defaults, app: { version: "fixture" } }),
            getState: async () => ({ runs: [], activeRuns: [], shipping: {} }),
            getCredentialProfiles: async () => ({ proxies: [], openAiKeys: [], shippingAccounts: [] }),
            getUploadApiSettings: async () => ({ uploadApiUrl: "https://fixture.invalid/" }),
            getCollectionUploadLogs: async () => ({ items: [], page: 1, totalPages: 1, totalCount: 0 }),
            onStateChanged: () => () => {},
            runTestAccountSignup: async () => ({ id: `signup${++count}`, pw: "fixture-registered-pw" }),
        };
    }, defaults);
    await page.goto("https://collector.invalid/");
    await page.locator('[data-view="settings"]').click();
    for (const loginId of ["signup1", "signup2"]) {
        await page.locator("#runTestAccountSignupButton").click();
        await page.locator("#testAccountSignupStatus").filter({ hasText: loginId }).waitFor();
    }
    await page.reload();
    await page.locator('[data-view="settings"]').click();
    await page.locator("#openAccountManagerButton").click();
    assert.deepEqual(await page.locator("#accountList .account-item strong").allTextContents(),
        ["천유_261113", "천유_261113"]);
    const select = page.locator("#accountSelect option");
    assert.deepEqual((await select.allTextContents()).slice(1),
        ["천유_261113 (signup1)", "천유_261113 (signup2)"]);
    await page.locator("#closeAccountManagerButton").click();
    await page.locator('[data-view="lifecycle-collection"]').click();
    assert.deepEqual((await page.locator("#lifecycleAccount option").allTextContents()).slice(1),
        ["천유_261113 (signup1)", "천유_261113 (signup2)"]);
    const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem("mall-collector-accounts-v1")));
    assert.deepEqual(accounts.map(({ loginId, password }) => ({ loginId, password })), [
        { loginId: "signup1", password: "fixture-registered-pw" },
        { loginId: "signup2", password: "fixture-registered-pw" },
    ]);
});

test("confirmed passwords are encrypted in JSON and legacy local accounts remain readable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mall-test-accounts-"));
    try {
        const legacy = createTestAccountStore(dir);
        const old = await legacy.add({ id: "local2", pw: "legacy-test-password" });
        const safeStorage = {
            isEncryptionAvailable: () => true,
            encryptString: text => Buffer.from(text).reverse(),
            decryptString: buffer => Buffer.from(buffer).reverse().toString(),
        };
        const store = createTestAccountStore(dir, { safeStorage });
        store.assertCanStoreRealAccount();
        const pw = "fixture-confirmed-password";
        const saved = await store.add({ id: "confirmed7", pw }, { encryptPassword: true });
        const raw = await fs.readFile(path.join(dir, "test-accounts.json"), "utf8");
        assert.equal(raw.includes(pw), false);
        const reopened = createTestAccountStore(dir, { safeStorage });
        assert.deepEqual(await reopened.list(), [old, saved]);
        assert.deepEqual(await reopened.remove(saved.key), [old]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

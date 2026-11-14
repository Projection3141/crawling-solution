const { randomInt } = require("node:crypto");
const { chromium } = require("playwright");

const SIGNUP_URL = "https://cheonyu.com/member/join_step012.html";
const SIGNUP_PATH = "/member/join_step012.html";
const COMPLETE_PATH = "/member/join_step023.html";
const NAME_GENERATOR_URL = new URL("https://fanmooz.com/현대-이름생성기/");
const POSTCODE_ORIGIN = "https://postcode.map.kakao.com";
const POSTCODE_SEARCH_URL = `${POSTCODE_ORIGIN}/search`;
const POSTCODE_ATTEMPTS = 15;
const ID_CHECK_ATTEMPTS = 5;
const ADDRESS_LOOKUP = "a.find-addr.chk_addr.ptsans";
const CHEONYU_HOSTS = ["cheonyu.com", "www.cheonyu.com"];
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%";

function randomText(characters, length) {
    return Array.from({ length }, () => characters[randomInt(characters.length)]).join("");
}

function randomId() {
    const letters = randomText(LETTERS, randomInt(3, 7));
    const digits = randomText(DIGITS, randomInt(1, 4));
    // The live form requires a lowercase first character.
    return letters + digits;
}

function randomPassword() {
    const groups = [
        randomText(LETTERS, randomInt(4, 7)),
        randomText(DIGITS, randomInt(2, 5)),
        randomText(SYMBOLS, 2),
    ];
    for (let index = groups.length - 1; index > 0; index--) {
        const other = randomInt(index + 1);
        [groups[index], groups[other]] = [groups[other], groups[index]];
    }
    return groups.join("");
}

function unusedLocalId(savedIds) {
    const taken = new Set(savedIds.map(id => id.toLowerCase()));
    for (let attempt = 0; attempt < 30; attempt++) {
        const id = randomId();
        if (!taken.has(id)) return id;
    }
    throw new Error("새 아이디를 만들지 못했습니다.");
}

function isCheonyuPath(value, pathname) {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
        CHEONYU_HOSTS.includes(url.hostname) && url.pathname === pathname;
}

function isCompleteUrl(value) {
    const url = new URL(value);
    return isCheonyuPath(url, COMPLETE_PATH) && Boolean(url.searchParams.get("inname")?.trim());
}

async function generateName(page) {
    const response = await page.goto(NAME_GENERATOR_URL.href, { waitUntil: "domcontentloaded", timeout: 15000 });
    const current = new URL(page.url());
    if (!response?.ok() || current.origin !== NAME_GENERATOR_URL.origin || current.pathname !== NAME_GENERATOR_URL.pathname) {
        throw new Error("이름 생성기를 열 수 없습니다.");
    }
    await page.locator('input[type="button"][value="남자 이름 생성"]').click({ timeout: 5000 });
    const output = page.locator("#random_name");
    await output.filter({ hasText: /^[가-힣]{2,6}$/ }).waitFor({ timeout: 5000 });
    return (await output.textContent()).trim();
}

function isPostcodeSearch(url) {
    return url.origin === POSTCODE_ORIGIN && url.pathname === "/search";
}

function nextPostcode(used) {
    let code;
    do {
        code = String(randomInt(1000, 64000)).padStart(5, "0");
    } while (used.has(code));
    used.add(code);
    return code;
}

async function postcodeFrame(popup) {
    if (isPostcodeSearch(new URL(popup.url()))) return popup.mainFrame();

    // Kakao opens a wrapper window and navigates a child frame to the search form.
    const iframe = await popup.locator(`iframe[src^="${POSTCODE_SEARCH_URL}?"]`).elementHandle({ timeout: 10000 });
    try {
        const frame = await iframe.contentFrame();
        if (!frame) throw new Error("카카오 주소 검색 화면을 찾지 못했습니다.");
        await frame.waitForURL(isPostcodeSearch, { waitUntil: "domcontentloaded", timeout: 10000 });
        return frame;
    } finally {
        await iframe.dispose().catch(() => {});
    }
}

async function selectSignupAddress(page) {
    const [popup] = await Promise.all([
        page.waitForEvent("popup", { timeout: 10000 }),
        page.locator(ADDRESS_LOOKUP).click({ timeout: 5000 }),
    ]);
    const frame = await postcodeFrame(popup);
    const field = frame.locator('#searchForm input[name="region_name"]');
    const search = frame.locator("#searchForm .btn_search");
    const firstAddress = frame.locator(
        "ul.list_post > li:first-child button.link_post:not(.link_english):not(.link_btn_map):visible",
    ).first();
    const noResults = frame.locator(".desc_post .emph_bold:visible").filter({ hasText: /^검색결과가 없습니다\.$/ }).first();
    const used = new Set();

    for (let attempt = 0; attempt < POSTCODE_ATTEMPTS; attempt++) {
        const code = nextPostcode(used);
        await field.fill(code, { timeout: 5000 });
        await Promise.all([
            frame.waitForURL(url => isPostcodeSearch(url) && url.searchParams.get("region_name") === code,
                { waitUntil: "domcontentloaded", timeout: 10000 }),
            search.click({ timeout: 5000 }),
        ]);
        await firstAddress.or(noResults).first().waitFor({ state: "visible", timeout: 8000 });
        if (await noResults.isVisible()) continue;

        await firstAddress.click({ timeout: 5000 });
        // Kakao sends the selected address back to the original Cheonyu form.
        await page.waitForFunction(() => /^\d{5}$/.test(document.getElementById("inMpost")?.value) &&
            Boolean(document.getElementById("inMaddr1")?.value.trim()), null, { timeout: 5000 });
        return;
    }
    throw new Error("검색 결과가 있는 우편번호를 찾지 못했습니다.");
}

async function checkSignupId(page, savedIds, initialId) {
    const checkedIds = [];
    let id = initialId;
    for (let attempt = 0; attempt < ID_CHECK_ATTEMPTS; attempt++) {
        await page.locator("#inMid").fill(id, { timeout: 5000 });
        if (attempt > 0) {
            await page.locator('input[name="inMemail1"]').fill(id, { timeout: 5000 });
        }
        await page.locator(".chk_id").click({ timeout: 5000 });
        await page.waitForFunction(expectedId => {
            const confirmedId = document.getElementById("inMid2")?.value;
            const message = document.getElementById("msgID")?.textContent || "";
            return confirmedId === expectedId || message.includes("이미 사용되어진 아이디입니다.");
        }, id, { timeout: 15000 });

        if (await page.locator("#inMid2").inputValue() === id) return id;
        checkedIds.push(id);
        id = unusedLocalId([...savedIds, ...checkedIds]);
    }
    throw new Error("사용할 수 있는 아이디를 확인하지 못했습니다.");
}

async function clickSignupCheckbox(page, selector) {
    const checkbox = page.locator(selector);
    if (await checkbox.isChecked()) return;

    await checkbox.locator("xpath=..").click({ timeout: 5000 });
    if (!(await checkbox.isChecked())) {
        throw new Error("필수 체크 항목을 선택하지 못했습니다.");
    }
}

async function runTestAccountSignup(savedIds, { browserType = chromium, signal } = {}) {
    if (signal?.aborted) return { canceled: true };
    let browser;
    let page;
    let phase = "이름 생성";
    const cancel = () => { void browser?.close().catch(() => {}); };
    try {
        browser = await browserType.launch({ headless: false, timeout: 15000 });
        if (signal?.aborted) return { canceled: true };
        signal?.addEventListener("abort", cancel, { once: true });
        const context = await browser.newContext();
        page = await context.newPage();
        const name = await generateName(page);

        phase = "천유 가입 페이지 열기";
        let submittedCredentials;
        let signupPosted = false;
        let completeResponse;
        await page.exposeBinding("rememberCheonyuSignupCredentials", ({ frame }, values) => {
            if (frame !== page.mainFrame() || !isCheonyuPath(frame.url(), SIGNUP_PATH)) return;
            submittedCredentials = undefined;
            const { id, pw } = values || {};
            if (typeof id === "string" && /^[a-z][a-z0-9_]{3,11}$/.test(id) &&
                typeof pw === "string" && pw.length >= 4 && pw.length <= 20) {
                submittedCredentials = { id, pw };
            }
        });
        await page.addInitScript(({ hosts, pathname }) => {
            if (window.top !== window || location.protocol !== "https:" || location.port ||
                !hosts.includes(location.hostname) || location.pathname !== pathname) return;

            // Capture the final editable credentials only on the user's registration click.
            document.addEventListener("click", event => {
                if (!event.isTrusted || !event.target?.closest?.("#btnJoin")) return;
                const id = document.getElementById("inMid")?.value;
                const pw = document.getElementById("inMpw1")?.value;
                const matchedPassword = pw === document.getElementById("inMpw2")?.value ? pw : null;
                void window.rememberCheonyuSignupCredentials({ id, pw: matchedPassword }).catch(() => {});
            }, true);
        }, { hosts: CHEONYU_HOSTS, pathname: SIGNUP_PATH });
        page.on("request", request => {
            if (request.isNavigationRequest() && isCheonyuPath(request.url(), SIGNUP_PATH) &&
                request.frame() === page.mainFrame()) {
                signupPosted = request.method() === "POST";
            }
        });
        page.on("response", response => {
            const request = response.request();
            if (request.isNavigationRequest() && isCompleteUrl(response.url()) &&
                request.frame() === page.mainFrame()) {
                completeResponse = response;
            }
        });
        const response = await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
        if (!response?.ok() || !isCheonyuPath(page.url(), SIGNUP_PATH)) {
            throw new Error("가입 페이지를 열 수 없습니다.");
        }

        phase = "생성한 정보 미리 입력";
        let id = unusedLocalId(savedIds);
        const pw = randomPassword();
        for (const [selector, value] of [
            ["#inMname", name],
            ["#inMTEL1", "010"],
            ["#inMTEL2", randomText(DIGITS, 4)],
            ["#inMTEL3", randomText(DIGITS, 4)],
            ['input[name="inMemail1"]', id],
            ["#inMid", id],
            ["#inMpw1", pw],
            ["#inMpw2", pw],
        ]) {
            await page.locator(selector).fill(value, { timeout: 5000 });
        }
        await page.locator("#uemail2").click({ timeout: 5000 });
        await page.locator('[data-id="select_list"] a[dg-data="naver.com"]').click({ timeout: 5000 });

        phase = "아이디 중복 확인";
        id = await checkSignupId(page, savedIds, id);
        phase = "전화번호와 동일 선택";
        await clickSignupCheckbox(page, "#chkCopyTel");
        phase = "이용약관 동의";
        await clickSignupCheckbox(page, "#chkTerm");
        phase = "개인정보 보호정책 동의";
        await clickSignupCheckbox(page, "#chkPrivacy");

        phase = "우편번호 검색 및 주소 선택";
        try {
            await selectSignupAddress(page);
        } catch {
            if (page.isClosed() || signal?.aborted) return { canceled: true };
            await page.locator(ADDRESS_LOOKUP).evaluate(link => {
                const status = document.createElement("p");
                status.setAttribute("role", "status");
                status.textContent = "주소를 자동으로 선택하지 못했습니다. 주소 검색에서 직접 선택해 주세요.";
                link.insertAdjacentElement("afterend", status);
            }, undefined, { timeout: 2000 }).catch(() => {});
        }

        await page.waitForFunction(() => /^\d{5}$/.test(document.getElementById("inMpost")?.value) &&
            Boolean(document.getElementById("inMaddr1")?.value.trim()), null, { timeout: 0 });

        phase = "가입 제출 및 완료 확인";
        await page.locator("#btnJoin").click({ timeout: 5000 });
        await page.waitForURL(isCompleteUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (!signupPosted || !completeResponse?.ok() || !submittedCredentials) {
            throw new Error("가입 완료와 입력한 계정을 확인할 수 없습니다.");
        }
        return submittedCredentials;
    } catch {
        // Playwright errors can contain input values in the call log.
        if (signal?.aborted || page?.isClosed() || (browser && !browser.isConnected())) {
            return { canceled: true };
        }
        throw new Error(`천유 계정 생성 중 오류가 발생했습니다 (${phase}).`);
    } finally {
        signal?.removeEventListener("abort", cancel);
        await browser?.close().catch(() => {});
    }
}

module.exports = { runTestAccountSignup };

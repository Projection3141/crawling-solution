const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const cheerio = require("cheerio");
const { getPublicDefaults, resolveRunConfig, toSafeConfig } = require("../src/config");
const { getLightweightLaunchArgs, installLightweightNetworkPolicy } = require("../src/utils/browser");

const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const account = { accountId: "fixture", accountPw: "fixture" };

function uiFunctions(names, globals = {}) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const source = appSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(source, `${name} function exists`);
    vm.runInContext(source[0], context);
  }
  return context;
}

test("브라우저 표시는 기본이고 명시적 숨김 및 기존 요청 간격은 유지된다", () => {
  const defaults = getPublicDefaults({});
  const config = resolveRunConfig(account, {});
  assert.equal(defaults.envDefaults.showBrowser, true);
  assert.equal(config.headless, false);
  assert.equal(config.requestDelayMs, 300);
  assert.equal(config.detailRequestDelayMs, 1000);
  assert.equal(config.detailConcurrency, 3);
  assert.equal(resolveRunConfig({ ...account, showBrowser: false }, {}).headless, true);
  // UI 제거와 무관하게 기존 환경 설정은 지원한다.
  assert.equal(resolveRunConfig(account, { USER_AGENT: "Fixture Agent" }).userAgent, "Fixture Agent");
});

test("프록시 교체 페이지 설정은 기본 10이며 안전한 정수로 전달된다", () => {
  assert.equal(getPublicDefaults({}).envDefaults.proxyRotationPages, 10);
  const cases = [[undefined, 10], ["", 10], ["7", 7], [2.9, 2], [0, 1], [-4, 1], [1001, 1000], ["invalid", 10]];
  for (const [input, expected] of cases) {
    const config = resolveRunConfig({ ...account, proxyRotationPages: input }, {});
    assert.equal(config.proxyRotationPages, expected);
    assert.equal(toSafeConfig(config).proxyRotationPages, expected);
  }
});

test("화면의 기본 표시·선택 문구와 프록시 입력을 제공하고 User-Agent 입력은 제거한다", () => {
  const $ = cheerio.load(html);
  assert.equal($("#mall option[value='']").text(), "쇼핑몰을 선택하세요");
  assert.equal($("#browserMode option[selected]").val(), "show");
  for (const selector of ["#browserMode", "#lifecycleBrowser"]) {
    assert.deepEqual($(`${selector} option`).map((_, option) => $(option).val()).get(), ["show", "show-no-images", "hide"]);
  }
  assert.equal($("#cheonyuUserAgent").length, 0);
  assert.equal($("details.advanced-settings #proxyRotationPages").length, 1);
  assert.equal($("#proxyRotationPages").attr("min"), "1");
  assert.match($("#detailRequestDelayMs").parent().text(), /다음 상품 상세 페이지 요청을 시작하기까지의 간격/);
  assert.match($("#detailRequestDelayMs").parent().text(), /1000ms는 1초/);
  assert.equal(appSource.includes("cheonyuUserAgent"), false);
});

test("세 브라우저 모드는 이미지 차단을 분리하고 표시 모드의 CSS를 유지한다", async () => {
  for (const [input, imagesBlocked, cssBlocked] of [
    [{ showBrowser: true, blockImages: false }, false, false],
    [{ showBrowser: true, blockImages: true }, true, false],
    [{ showBrowser: false, blockImages: false }, true, true],
  ]) {
    const config = resolveRunConfig({ ...account, ...input }, {});
    assert.equal(config.headless, !input.showBrowser);
    assert.equal(toSafeConfig(config).blockImages, imagesBlocked);
    assert.equal(getLightweightLaunchArgs(config).includes("--blink-settings=imagesEnabled=false"), imagesBlocked);
    const commands = new Map();
    const context = { pages: () => [{}], newCDPSession: async () => ({ send: async (method, params) => commands.set(method, params) }) };
    await installLightweightNetworkPolicy(context, config);
    const blocked = commands.get("Network.setBlockedURLs").urls;
    assert.equal(blocked.includes("*.jpg*"), imagesBlocked);
    assert.equal(blocked.includes("*.css*"), cssBlocked);
    assert.equal(blocked.includes("*.woff2*"), cssBlocked);
    assert.equal(blocked.includes("*.mp4*"), true);
    assert.equal(commands.get("Network.setCacheDisabled").cacheDisabled, false);
  }
});

test("수집 요청에는 천유 프록시 교체 간격만 추가되고 다른 쇼핑몰에는 보내지 않는다", () => {
  const field = (value) => ({ value });
  const elements = {
    mall: field("cheonyu"), category: field(""), collectionMode: field("general"),
    browserMode: field("show"), pageStart: field("1"), pageEnd: field("10"),
    proxyRotationPages: field("7"), cheonyuProxyProfileSelect: field("proxy-fixture"),
    openAiProfileSelect: field("key-fixture"),
  };
  const context = uiFunctions(["setNumberIfPresent", "buildPayload"], {
    elements, state: { defaults: { envDefaults: { mall: "cheonyu" } } },
    getSelectedAccount: () => null, getExecutionOptions: () => ({}), validateDetailPageRange: () => {},
  });
  const payload = context.buildPayload();
  assert.equal(payload.proxyRotationPages, 7);
  assert.equal(payload.showBrowser, true);
  elements.browserMode.value = "show-no-images";
  assert.equal(context.buildPayload().showBrowser, true);
  assert.equal(context.buildPayload().blockImages, true);
  elements.browserMode.value = "hide";
  assert.equal(context.buildPayload().showBrowser, false);
  elements.browserMode.value = "show";
  assert.equal(payload.proxyProfileId, "proxy-fixture");
  elements.mall.value = "ccdome";
  assert.equal(context.buildPayload().proxyRotationPages, undefined);
  elements.mall.value = "cheonyu";
  elements.proxyRotationPages.value = "";
  assert.equal(context.buildPayload().proxyRotationPages, undefined);
});

test("화면의 프록시 교체 간격은 main 입력 허용 목록을 통과해 실행 설정에 반영된다", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const normalizeSource = mainSource.match(/^function normalizeRunInput\([^]*?^\}/m);
  assert.ok(normalizeSource);
  const context = vm.createContext({});
  vm.runInContext(normalizeSource[0], context);
  const request = context.normalizeRunInput({ ...account, mall: "cheonyu", showBrowser: true, blockImages: true, proxyRotationPages: 7, unexpected: "discard" });
  assert.equal(resolveRunConfig(request, {}).blockImages, true);
  assert.equal(resolveRunConfig(request, {}).headless, false);
  assert.equal(request.proxyRotationPages, 7);
  assert.equal(request.unexpected, undefined);
  assert.equal(resolveRunConfig(request, {}).proxyRotationPages, 7);
});

test("실패 안내는 실제 저장 범위를 표시하고 역순·중간 누락을 완료로 과장하지 않는다", () => {
  const { getRunCheckpointMessage } = uiFunctions(["getRunCheckpointMessage"]);
  const run = {
    status: "failed",
    progress: { savedCheckpoint: { phase: "detail", pageStart: 2, pageEnd: 10, savedThroughPage: 4, savedPages: [2, 3, 4], pageOrder: "asc" } },
  };
  assert.equal(getRunCheckpointMessage(run), "2페이지부터 10페이지까지 작업 도중 실패로 4페이지까지 저장되었습니다.");
  run.progress.savedCheckpoint.savedPages = [2, 3, 4, 6];
  assert.match(getRunCheckpointMessage(run), /저장된 상세 페이지: 2~4, 6페이지/);
  run.progress.savedCheckpoint.savedPages = [10, 9, 8];
  run.progress.savedCheckpoint.pageOrder = "desc";
  run.progress.savedCheckpoint.savedThroughPage = 8;
  assert.match(getRunCheckpointMessage(run), /저장된 상세 페이지: 8~10페이지/);
  run.progress.savedCheckpoint.savedThroughPage = null;
  run.progress.savedCheckpoint.savedPages = [4];
  assert.match(getRunCheckpointMessage(run), /저장된 상세 페이지: 4페이지/);
  run.progress.savedCheckpoint.savedPages = [];
  assert.equal(getRunCheckpointMessage(run), "");
  run.status = "completed";
  assert.equal(getRunCheckpointMessage(run), "");
});

test("실패 실행 박스는 오류와 저장 범위·진단 파일 경로를 함께 텍스트로 보여준다", () => {
  class Element {
    constructor() { this.children = []; this.textContent = ""; this.dataset = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener() {}
    get childElementCount() { return this.children.length; }
    set innerHTML(_) { assert.fail("run content must use textContent"); }
  }
  const context = uiFunctions(["getRunCheckpointMessage", "getRunRepeatStopReason", "createRunCard"], {
    document: { createElement: () => new Element() },
    state: { repeatPlans: new Map(), repeatTimers: new Map() },
    RUNNING_STATUSES: new Set(["running"]), getStatusLabel: () => "실패",
    getProgressPercent: () => 0, createMetricCard: () => new Element(),
    formatPageRange: () => "2~10", displayNumber: () => "-", formatDetailProgress: () => "0", getRunElapsedText: () => "1m",
  });
  const card = context.createRunCard({ id: "fixture", status: "failed", error: "<error>", diagnosticLogPath: "C:/fixture/run.jsonl", progress: {
    message: "수집 실패", savedCheckpoint: { pageStart: 2, pageEnd: 10, savedThroughPage: 4, savedPages: [2, 3, 4] },
  } });
  const texts = card.children.map((item) => item.textContent);
  assert.ok(texts.includes("<error>"));
  assert.ok(texts.includes("2페이지부터 10페이지까지 작업 도중 실패로 4페이지까지 저장되었습니다."));
  assert.ok(texts.includes("진단 기록 경로: C:/fixture/run.jsonl (설정 폴더에서 확인)"));
  const failedLogCard = context.createRunCard({ id: "fixture", status: "failed", diagnosticLogPath: "C:/fixture/run.jsonl", diagnosticLogError: "진단 기록 파일을 저장하지 못했습니다." });
  assert.ok(failedLogCard.children.some((item) => item.textContent === "진단 기록 파일을 저장하지 못했습니다."));
  assert.ok(!failedLogCard.children.some((item) => item.textContent.startsWith("진단 기록 경로:")));
  const blockedCard = context.createRunCard({ id: "blocked", status: "failed", error: "HTTP 403", failure: {
    stopAutoRepeat: true, message: "사이트 접근 제한으로 자동 반복을 중단했습니다.",
  } });
  assert.ok(blockedCard.children.some((item) => item.className === "warning-message" && item.textContent === "사이트 접근 제한으로 자동 반복을 중단했습니다."));
});

test("상세 수집 시작 전 실패는 일반·재고 저장 범위를 상세 저장 완료로 표시하지 않는다", () => {
  const { getRunCheckpointMessage } = uiFunctions(["getRunCheckpointMessage"]);
  const run = { status: "failed", request: { collectionMode: "detail" }, progress: {
    savedCheckpoint: { phase: "general", pageStart: 1, pageEnd: 10, savedThroughPage: 10, savedPages: [1,2,3,4,5,6,7,8,9,10], pageOrder: "asc" },
  } };
  assert.match(getRunCheckpointMessage(run), /10페이지까지 저장되었습니다\. 일반·재고 수집 결과입니다\. 상세 페이지 저장은 아직 완료되지 않았습니다\./);
  run.progress.savedCheckpoint.pageOrder = "desc";
  assert.match(getRunCheckpointMessage(run), /저장된 페이지: 1~10페이지\. 일반·재고 수집 결과입니다\./);
  run.progress.savedCheckpoint.phase = "detail";
  assert.ok(!getRunCheckpointMessage(run).includes("상세 페이지 저장은 아직 완료되지 않았습니다"));
  run.progress.savedCheckpoint.phase = "general";
  run.request.collectionMode = "general";
  assert.ok(!getRunCheckpointMessage(run).includes("상세 페이지 저장은 아직 완료되지 않았습니다"));
});

test("목록 페이지 저장은 재고·상세 완료와 구분해 안내한다", () => {
  const { getRunCheckpointMessage } = uiFunctions(["getRunCheckpointMessage"]);
  const run = { status: "failed", request: { collectionMode: "detail" }, progress: {
    savedCheckpoint: { phase: "list", pageStart: 1, pageEnd: 11, savedThroughPage: 10, savedPages: [1,2,3,4,5,6,7,8,9,10], pageOrder: "asc" },
  } };
  const message = getRunCheckpointMessage(run);
  assert.match(message, /10페이지까지 저장되었습니다/);
  assert.match(message, /목록 원본 저장이며, 장바구니 재고·상세 수집은 완료되지 않았습니다/);
  assert.ok(!message.includes("일반·재고 수집 결과입니다"));
});

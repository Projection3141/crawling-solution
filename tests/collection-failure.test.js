const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const {
  classifyCollectionFailure, isTerminalStickyConnectionError, isRecoverableStickySessionError,
} = require("../src/utils/collection-failure");

const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

function createRepeatFixture() {
  const timers = new Map();
  const requests = [];
  const errors = [];
  const state = {
    repeatPlans: new Map(), repeatTimers: new Map(), repeatLaunching: new Set(),
    defaults: { envDefaults: { mall: "cheonyu" } }, applicationState: { runs: [] },
  };
  let sequence = 0;
  let now = Date.now();
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    state, console, Date: FixtureDate,
    window: {
      setTimeout(callback, delay) {
        const id = ++sequence;
        timers.set(id, async () => { timers.delete(id); now += delay; await callback(); });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      collectorApp: {
        async start(payload) { requests.push(payload); return { id: `next-${requests.length}` }; },
        async getState() { return { runs: [] }; },
      },
    },
    handleStateChanged: () => {}, renderRunList: () => {}, showError: (message) => errors.push(message),
  });
  for (const name of ["getRepeatIntervalMs", "getNextRepeatRunAt", "getRunRepeatStopReason", "clearRepeatPlan", "scheduleRepeatRuns"]) {
    const match = appSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `${name} exists`);
    vm.runInContext(match[0], context);
  }
  function addPlan(id, overrides = {}) {
    const plan = {
      basePayload: { mall: "cheonyu", executionOptions: { repeatScheduleType: "interval", repeatValue: 1, repeatUnit: "hour" } },
      consecutiveFailureCount: 0, terminalStatusHandled: false, ...overrides,
    };
    state.repeatPlans.set(id, plan);
    return plan;
  }
  return { context, state, timers, requests, errors, addPlan, now: () => now };
}

test("확정된 차단·프록시 실패는 최종 실패 후 자동 반복을 중단한다", () => {
  const cases = [
    [{ code: "SITE_ACCESS_BLOCKED" }, "site-access-blocked"],
    [{ statusCode: 403 }, "site-access-blocked"],
    [{ status: 429 }, "site-access-blocked"],
    [new Error("천유가 요청을 제한했습니다(HTTP 403)."), "site-access-blocked"],
    [{ statusCode: 407 }, "proxy-authentication"],
    [new Error("curl: (56) Received HTTP code 407 from proxy after CONNECT"), "proxy-authentication"],
    [{ code: "ERR_PROXY_AUTH_REQUESTED" }, "proxy-authentication"],
    [new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://fixture.invalid/"), "proxy-connection"],
    [{ code: "ERR_PROXY_CONNECTION_FAILED" }, "proxy-connection"],
    [{ code: "DECODO_SESSION_LOST" }, "proxy-session"],
    [{ code: "CART_CLEANUP_INCOMPLETE" }, "cart-state"],
    [new Error("CONNECT=502 HTTP=000 TOTAL=10s"), "proxy-connection"],
  ];
  for (const [error, kind] of cases) {
    const result = classifyCollectionFailure(error);
    assert.equal(result.kind, kind);
    assert.equal(result.stopAutoRepeat, true);
    assert.match(result.message, /자동 반복을 중단/);
  }
});

test("일반 서버 502·일시 오류는 프록시 CONNECT 실패로 오인하지 않는다", () => {
  for (const error of [
    { statusCode: 502, message: "HTTP 요청 실패: HTTP 502" },
    new Error("page.goto: Timeout 60000ms exceeded."),
    new Error("net::ERR_CONNECTION_RESET"),
    new Error("fixture parsing failure"),
    null,
  ]) {
    assert.equal(classifyCollectionFailure(error).stopAutoRepeat, false);
  }
});

test("세션 손실이나 터널 오류가 함께 발생해도 접근 거절과 인증 실패의 재연결을 막는다", () => {
  const failures = [
    [{ details: { statusCode: 403 } }, "site-access-blocked"],
    [{ cause: { statusCode: 429 } }, "site-access-blocked"],
    [{ details: { statusCode: 407 } }, "proxy-authentication"],
    [{ details: { reason: "PROXY_AUTH_FAILED" } }, "proxy-authentication"],
    [{ cause: { code: "PROXY_AUTH_FAILED" } }, "proxy-authentication"],
    [{ cause: { code: "PROXY_TUNNEL_UNVERIFIED" } }, "proxy-connection-unverified"],
  ];
  for (const [details, kind] of failures) {
    const error = { code: "DATAIMPULSE_SESSION_LOST", message: "ERR_TUNNEL_CONNECTION_FAILED",
      details: { reason: "SESSION_IP_CHANGED", ...details.details }, cause: details.cause };
    assert.equal(classifyCollectionFailure(error).kind, kind);
    assert.equal(classifyCollectionFailure(error).stopAutoRepeat, true);
    assert.equal(isTerminalStickyConnectionError(error), true);
    assert.equal(isRecoverableStickySessionError(error), false);
  }
  const connectionLoss = { code: "DATAIMPULSE_SESSION_LOST", details: { reason: "SESSION_IP_CHANGED" } };
  assert.equal(isTerminalStickyConnectionError(connectionLoss), false);
  assert.equal(isRecoverableStickySessionError(connectionLoss), true);
});

test("중첩 원인도 분류하고 원문 URL·인증정보를 분류 결과에 복사하지 않는다", () => {
  const secret = "sensitive-fixture-password";
  const root = new Error(`net::ERR_TUNNEL_CONNECTION_FAILED at http://user:${secret}@fixture.invalid/`);
  const wrapper = new Error("수집 실패", { cause: root });
  root.cause = wrapper;
  const result = classifyCollectionFailure(wrapper);
  assert.equal(result.stopAutoRepeat, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("fixture.invalid"), false);
});

test("IP 확인 요청 오류와 일시적인 HTTP 응답만 연결을 다시 시도한다", () => {
  const probeFailure = (reason, statusCode) => ({
    code: "DATAIMPULSE_SESSION_LOST", details: { reason, statusCode },
  });
  assert.equal(isRecoverableStickySessionError(probeFailure("PROBE_REQUEST_FAILED")), true);
  for (const statusCode of [408, 500, 503]) {
    assert.equal(isRecoverableStickySessionError(probeFailure("PROBE_HTTP_ERROR", statusCode)), true);
  }
  for (const statusCode of [400, 403, 407, 429]) {
    assert.equal(isRecoverableStickySessionError(probeFailure("PROBE_HTTP_ERROR", statusCode)), false);
  }
  assert.equal(isRecoverableStickySessionError(probeFailure("PROBE_INVALID_IP")), false);
});

test("차단 시 기존 타이머까지 제거하고 역순 재실행도 예약하지 않는다", () => {
  const fixture = createRepeatFixture();
  const plan = fixture.addPlan("blocked", { consecutiveFailureCount: 1 });
  const firstRun = { id: "blocked", status: "failed", error: "temporary fixture failure" };
  fixture.context.scheduleRepeatRuns({ runs: [firstRun] });
  assert.equal(fixture.timers.size, 1);
  const failure = classifyCollectionFailure({ code: "SITE_ACCESS_BLOCKED", statusCode: 403 });
  fixture.context.scheduleRepeatRuns({ runs: [{ ...firstRun, failure }] });
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.state.repeatTimers.size, 0);
  assert.equal(fixture.state.repeatPlans.size, 0);
  assert.equal(fixture.state.repeatLaunching.size, 0);
  assert.equal(fixture.requests.length, 0);
  // 같은 상태가 다시 전달돼도 이미 중단된 계획은 부활하지 않는다.
  fixture.context.scheduleRepeatRuns({ runs: [{ ...firstRun, failure }] });
  assert.equal(fixture.timers.size, 0);
  assert.equal(plan.consecutiveFailureCount, 2);
});

test("이전 형식의 차단·프록시 오류도 반복하지 않으며 완료·취소에는 실패 경고를 표시하지 않는다", () => {
  const fixture = createRepeatFixture();
  for (const error of ["HTTP 429", "HTTP 407", "ERR_TUNNEL_CONNECTION_FAILED", "CONNECT=502"]) {
    fixture.addPlan("legacy");
    const run = { id: "legacy", status: "failed", error };
    assert.ok(fixture.context.getRunRepeatStopReason(run));
    fixture.context.scheduleRepeatRuns({ runs: [run] });
    assert.equal(fixture.state.repeatPlans.has("legacy"), false);
  }
  for (const status of ["completed", "canceled", "running"]) {
    assert.equal(fixture.context.getRunRepeatStopReason({ status, error: "HTTP 403" }), "");
  }
  assert.equal(fixture.timers.size, 0);
});

test("완료 및 일반 오류의 기존 반복 간격·순서는 유지한다", async () => {
  const fixture = createRepeatFixture();
  const plan = fixture.addPlan("completed", { consecutiveFailureCount: 1 });
  fixture.context.scheduleRepeatRuns({ runs: [{ id: "completed", status: "completed" }] });
  assert.equal(plan.consecutiveFailureCount, 0);
  assert.equal(plan.nextPageOrder, "forward");
  assert.equal(fixture.timers.size, 1);
  await [...fixture.timers.values()][0]();
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].pageOrder, "forward");
  assert.equal(fixture.requests[0].executionOptions.repeatValue, 1);
  assert.equal(fixture.requests[0].executionOptions.repeatUnit, "hour");

  const ordinary = createRepeatFixture();
  const retry = ordinary.addPlan("temporary", { consecutiveFailureCount: 1 });
  ordinary.context.scheduleRepeatRuns({ runs: [{ id: "temporary", status: "failed", error: "HTTP 502", failure: classifyCollectionFailure({ statusCode: 502 }) }] });
  assert.equal(retry.nextPageOrder, "reverse");
  assert.equal(ordinary.timers.size, 1);
});

test("90일 반복은 타이머 한도를 넘겨도 예약일 전에 실행하지 않는다", async () => {
  const fixture = createRepeatFixture();
  const start = fixture.now();
  fixture.addPlan("longTerm", { basePayload: { mall: "cheonyu", collectionKind: "longTerm",
    executionOptions: { repeatScheduleType: "interval", repeatValue: 90, repeatUnit: "day" } } });
  fixture.state.applicationState = { runs: [{ id: "longTerm", status: "completed", startedAtMs: start }] };
  fixture.context.scheduleRepeatRuns(fixture.state.applicationState);
  for (let part = 0; part < 3; part++) {
    await [...fixture.timers.values()][0]();
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.timers.size, 1);
  }
  await [...fixture.timers.values()][0]();
  assert.equal(fixture.now(), start + 90 * 86400000);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].collectionKind, "longTerm");
});

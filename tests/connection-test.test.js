const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createConnectionTester, normalizeTestUrl } = require("../electron/connection-test");

const profile = { id: "p1", name: "프록시 1", server: "127.0.0.1:12323", username: "proxy-user", password: "proxy-secret" };

function fixture({ code = 200, error, launchError, contextError, wait, titleWait, closeWait, responseHeaders = {}, observedStatus, ...testerOptions } = {}) {
  const calls = { launch: [], context: [], goto: [], close: 0, getProxy: [] };
  const listeners = {};
  const response = { status: () => code, headers: () => responseHeaders };
  const page = {
    on(event, listener) { listeners[event] = listener; }, url: () => "https://target.example/final?token=hidden",
    mainFrame: () => "main", title: async () => { if (titleWait) await titleWait; return "Access denied"; },
    async goto(...args) {
      calls.goto.push(args);
      if (wait) await wait;
      if (observedStatus) listeners.response?.({ ...response, status: () => observedStatus, request: () => ({ isNavigationRequest: () => true }), frame: () => "main" });
      if (error) throw error;
      return response;
    },
  };
  const browserType = {
    async launch(options) {
      calls.launch.push(options);
      if (launchError) throw launchError;
      return {
        async newContext(options) {
          calls.context.push(options);
          if (contextError) throw contextError;
          return { newPage: async () => page };
        },
        async close() { calls.close += 1; if (typeof closeWait === "function") await closeWait(calls.close); else if (closeWait) await closeWait; },
      };
    },
  };
  const tester = createConnectionTester({
    browserType, env: { USER_AGENT: "Fixture Agent" },
    getProxy: (id) => {
      calls.getProxy.push(id);
      if (id !== profile.id) throw new Error("선택한 프록시를 찾을 수 없습니다.");
      return profile;
    },
    ...testerOptions,
  });
  return { tester, calls };
}

test("URL은 HTTP(S)만 허용하고 인증정보·잘못된 입력을 거절한다", () => {
  for (const value of ["", "example.com", "file:///secret", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com\n/path"]) {
    assert.throws(() => normalizeTestUrl(value));
  }
  assert.equal(normalizeTestUrl(" https://example.com/a?q=1 "), "https://example.com/a?q=1");
});

test("사이트에 관계없이 선택 프록시를 적용하고 인증정보를 결과에 노출하지 않는다", async () => {
  const { tester, calls } = fixture();
  const result = await tester.run({ url: "https://www.ccdome.co.kr/?token=hidden", proxyProfileId: "p1" });
  assert.deepEqual(calls.context[0].proxy, { server: "http://127.0.0.1:12323", username: profile.username, password: profile.password });
  assert.equal(calls.context[0].userAgent, "Fixture Agent");
  assert.equal(calls.launch[0].headless, false);
  assert.equal(calls.goto.length, 1);
  assert.equal(calls.goto[0][0], "https://www.ccdome.co.kr/?token=hidden");
  assert.deepEqual(calls.goto[0][1], { waitUntil: "domcontentloaded", timeout: 60000 });
  assert.equal(result.success, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.proxyServer, "http://127.0.0.1:12323/");
  assert.equal(result.finalUrl, "https://target.example/final");
  assert.doesNotMatch(JSON.stringify(result), /proxy-secret|proxy-user|hidden/);
  assert.equal(calls.close, 1);
});

test("직접 연결에는 환경 프록시·다른 프로필을 자동 적용하지 않는다", async () => {
  const { tester, calls } = fixture();
  const result = await tester.run({ url: "https://example.com", showBrowser: false });
  assert.equal(calls.context[0].proxy, undefined);
  assert.deepEqual(calls.getProxy, []);
  assert.equal(calls.launch[0].headless, true);
  assert.equal(result.proxyServer, "");
  assert.equal(result.browserMode, "hide");
  assert.equal(calls.launch[0].channel, undefined);
});

test("일반 Chromium 숨김 비교는 선택한 테스트에만 적용하고 기존 표시·숨김 실행은 유지한다", async () => {
  const { tester, calls } = fixture();
  const result = await tester.run({ url: "https://example.com", browserMode: "chromium-headless" });
  assert.equal(result.showBrowser, false);
  assert.equal(result.browserMode, "chromium-headless");
  assert.equal(calls.launch[0].headless, true);
  assert.equal(calls.launch[0].channel, "chromium");
  const normal = await tester.run({ url: "https://example.com", browserMode: "unexpected-mode" });
  assert.equal(normal.showBrowser, true);
  assert.equal(normal.browserMode, "show");
  assert.equal(calls.launch[1].channel, undefined);
});

test("삭제된 프록시를 고르면 직접 연결하지 않고 실행을 거절한다", async () => {
  const { tester, calls } = fixture();
  await assert.rejects(tester.run({ url: "https://example.com", proxyProfileId: "deleted" }), /찾을 수 없습니다/);
  assert.equal(calls.launch.length, 0);
});

test("HTTP 403·429·500은 네트워크 오류와 구별하고 성공으로 표시하지 않는다", async () => {
  for (const code of [403, 429, 500]) {
    const { tester, calls } = fixture({ code });
    const result = await tester.run({ url: "https://example.com" });
    assert.equal(result.success, false);
    assert.equal(result.outcome, "http-error");
    assert.equal(result.statusCode, code);
    assert.equal(calls.close, 1);
  }
});

test("터널 실패를 그대로 구분하고 재시도·프록시 교체 없이 정리한다", async () => {
  const { tester, calls } = fixture({ error: new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED proxy-user proxy-secret https://example.com/?token=hidden") });
  const result = await tester.run({ url: "https://example.com", proxyProfileId: "p1" });
  assert.equal(result.errorCode, "ERR_TUNNEL_CONNECTION_FAILED");
  assert.equal(result.statusCode, null);
  assert.equal(result.failureLayer, "proxy-tunnel");
  assert.equal(result.success, false);
  assert.doesNotMatch(result.error, /proxy-secret|proxy-user|hidden/);
  assert.equal(calls.goto.length, 1);
  assert.deepEqual(calls.getProxy, ["p1"]);
  assert.equal(calls.close, 1);
});

test("실제 응답을 받은 후의 타임아웃을 터널 실패와 구별한다", async () => {
  const error = new Error("Navigation timeout");
  error.name = "TimeoutError";
  const { tester } = fixture({ error, observedStatus: 200 });
  const result = await tester.run({ url: "https://example.com" });
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 200);
  assert.equal(result.failureLayer, "document-load-timeout");
  assert.match(result.message, /HTTP 200 응답은 받았지만/);
});

test("설치 앱용 진단 파일은 인증정보·쿠키를 빼고 결과와 허용된 응답 헤더만 저장한다", async () => {
  const files = [];
  const { tester } = fixture({
    code: 403,
    responseHeaders: { server: "fixture", "content-type": "text/html", "set-cookie": "private-cookie", authorization: "private-auth" },
    diagnosticDirectory: () => "fixture-diagnostics",
    fileSystem: { mkdir: async () => {}, writeFile: async (...args) => files.push(args) },
  });
  const result = await tester.run({ url: "https://example.com/?token=hidden", proxyProfileId: "p1" });
  assert.equal(result.failureLayer, "http-access");
  assert.equal(files.length, 1);
  assert.equal(result.diagnosticPath, files[0][0]);
  const saved = JSON.parse(files[0][1]);
  assert.equal(saved.testId, result.testId);
  assert.deepEqual(saved.responseSummary.headers, { "content-type": "text/html", server: "fixture" });
  assert.equal(saved.responseSummary.title, "Access denied");
  assert.doesNotMatch(files[0][1], /proxy-secret|proxy-user|private-cookie|private-auth|hidden/);
});

test("진단 파일 쓰기가 실패해도 접속 결과를 보존하고 다음 테스트가 가능하다", async () => {
  const { tester } = fixture({
    diagnosticDirectory: "fixture-diagnostics",
    fileSystem: { mkdir: async () => { throw new Error("disk unavailable"); } },
  });
  for (let index = 0; index < 2; index += 1) {
    const result = await tester.run({ url: "https://example.com" });
    assert.equal(result.success, true);
    assert.equal(result.diagnosticPath, undefined);
    assert.match(result.diagnosticSaveError, /disk unavailable/);
  }
});

test("오류 문서 제목 읽기가 응답하지 않아도 테스트 결과와 브라우저 정리가 완료된다", { timeout: 5000 }, async () => {
  const { tester, calls } = fixture({ code: 403, titleWait: new Promise(() => {}) });
  const result = await tester.run({ url: "https://example.com" });
  assert.equal(result.statusCode, 403);
  assert.equal(result.responseSummary.title, undefined);
  assert.equal(calls.close, 1);
});

test("종료 확인이 멈추어도 결과를 반환하되 다음 실행을 차단하고 앱 종료에서 같은 핸들을 다시 정리한다", { timeout: 5000 }, async () => {
  const { tester, calls } = fixture({ closeWait: (count) => count === 1 ? new Promise(() => {}) : Promise.resolve() });
  const result = await tester.run({ url: "https://example.com" });
  assert.equal(result.success, true);
  assert.equal(calls.close, 1);
  assert.match(result.browserCloseWarning, /종료를 확인하지 못했습니다/);
  await assert.rejects(tester.run({ url: "https://example.com" }), /이전 테스트 브라우저의 종료/);
  assert.equal(calls.launch.length, 1);
  await tester.close();
  assert.equal(calls.close, 2);
});

test("시간 제한 이후 브라우저 종료가 실제 완료되면 새 테스트가 다시 가능하다", { timeout: 5000 }, async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { tester, calls } = fixture({ closeWait: (count) => count === 1 ? wait : Promise.resolve() });
  const first = await tester.run({ url: "https://example.com" });
  assert.ok(first.browserCloseWarning);
  await assert.rejects(tester.run({ url: "https://example.com" }), /이전 테스트 브라우저의 종료/);
  release();
  await new Promise(setImmediate);
  const second = await tester.run({ url: "https://example.com" });
  assert.equal(second.success, true);
  assert.equal(second.browserCloseWarning, undefined);
  assert.equal(calls.launch.length, 2);
  assert.equal(calls.close, 2);
});

test("선택한 CONNECT 진단은 브라우저 HTTP 상태와 분리하고 직접 연결에서는 건너뛴다", async () => {
  const probes = [];
  const { tester } = fixture({
    error: new Error("net::ERR_TUNNEL_CONNECTION_FAILED"),
    probeTunnel: async (options) => { probes.push(options); return { statusCode: 502, elapsedMs: 10100, message: "Bad Gateway" }; },
  });
  const ordinary = await tester.run({ url: "https://example.com", proxyProfileId: "p1" });
  assert.equal(ordinary.tunnelProbe, undefined);
  assert.equal(probes.length, 0);
  const diagnostic = await tester.run({ url: "https://example.com", proxyProfileId: "p1", checkTunnel: true });
  assert.equal(diagnostic.statusCode, null);
  assert.equal(diagnostic.tunnelProbe.statusCode, 502);
  assert.equal(diagnostic.failureLayer, "proxy-tunnel");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].proxy.password, profile.password);
  assert.equal(probes[0].timeoutMs, 15000);
  const direct = await tester.run({ url: "https://example.com", checkTunnel: true });
  assert.equal(direct.tunnelProbe.skipped, true);
  assert.equal(probes.length, 1);
});

test("외부 IP 확인은 요청한 경우에만 동일 context의 별도 탭으로 실행하고 실패는 접속 성공을 바꾸지 않는다", async () => {
  let contextCount = 0;
  let pageCount = 0;
  let probeCount = 0;
  let probeCloseCount = 0;
  let badResponse = false;
  const tester = createConnectionTester({
    env: {}, getProxy: () => profile,
    browserType: { launch: async () => ({
      newContext: async () => {
        contextCount += 1;
        let contextPageCount = 0;
        return { newPage: async () => {
          pageCount += 1;
          if (contextPageCount++ === 0) return {
            on() {}, url: () => "https://target.example/", goto: async () => ({ status: () => 200 }),
          };
          return {
            goto: async (url, options) => { probeCount += 1; assert.match(url, /api\.ipify\.org/); assert.equal(options.timeout, 10000); return { status: () => 200 }; },
            locator: () => ({ innerText: async () => badResponse ? "not json" : '{"ip":"203.0.113.21"}' }),
            close: async () => { probeCloseCount += 1; },
          };
        } };
      }, close: async () => {},
    }) },
  });
  const normal = await tester.run({ url: "https://target.example/" });
  assert.equal(normal.egressRequested, false);
  assert.equal(pageCount, 1);
  const diagnostic = await tester.run({ url: "https://target.example/", checkEgress: true });
  assert.equal(diagnostic.egressIp, "203.0.113.21");
  assert.equal(diagnostic.success, true);
  assert.equal(contextCount, 2);
  assert.equal(pageCount, 3);
  badResponse = true;
  const failedProbe = await tester.run({ url: "https://target.example/", checkEgress: true });
  assert.equal(failedProbe.success, true);
  assert.equal(failedProbe.egressIp, "");
  assert.ok(failedProbe.egressError);
  assert.equal(probeCount, 2);
  assert.equal(probeCloseCount, 2);
});

test("브라우저 준비·세션 생성·시간 초과 오류 이후에도 다음 테스트가 가능하다", async () => {
  const timeout = new Error("Navigation timeout");
  timeout.name = "TimeoutError";
  for (const options of [{ launchError: new Error("launch failed") }, { contextError: new Error("context failed") }, { error: timeout }]) {
    const { tester, calls } = fixture(options);
    for (let i = 0; i < 2; i += 1) {
      const result = await tester.run({ url: "https://example.com" });
      assert.equal(result.success, false);
      if (options.error) assert.equal(result.errorCode, "TIMEOUT");
    }
    assert.equal(calls.launch.length, 2);
    assert.equal(calls.close, options.launchError ? 0 : 2);
  }
});

test("중복 실행을 거절하고 앱 종료 시 테스트 브라우저를 닫는다", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { tester, calls } = fixture({ wait });
  const pending = tester.run({ url: "https://example.com" });
  await assert.rejects(tester.run({ url: "https://example.com" }), /진행 중/);
  await new Promise(setImmediate);
  await tester.close();
  assert.equal(calls.close, 1);
  release();
  await pending;
  await assert.rejects(tester.run({ url: "https://example.com" }), /종료하는 중/);
});

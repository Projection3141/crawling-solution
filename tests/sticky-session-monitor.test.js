const { test } = require("node:test");
const assert = require("node:assert/strict");
const { monitorCollectionSession } = require("../src/utils/collection-proxy");
const { createCollectionDiagnostics } = require("../src/utils/collection-diagnostics");
const { needsStickyTunnelConfirmation } = require("../src/utils/collection-failure");

const IP = "192.0.2.1";
const response = (ip = IP, status = 200) => ({
  ok: () => status === 200, status: () => status,
  json: async () => ({ ip }), dispose: async () => {},
});
function fixture(sequence, options = {}) {
  let requests = 0;
  const failures = [], waits = [], probeOptions = [];
  const context = { request: { get: async (_url, options) => {
    probeOptions.push(options);
    const item = sequence[requests++];
    assert.ok(item, "unexpected IP check request");
    if (item instanceof Error) throw item;
    return typeof item === "function" ? item() : item;
  } } };
  return {
    start: () => monitorCollectionSession(context, error => failures.push(error), "dataimpulse", {
      sleep: async ms => { waits.push(ms); }, ...options,
    }),
    get requests() { return requests; }, failures, waits, probeOptions,
  };
}

test("temporary probe failures recover on the same session without exposing raw request errors", async () => {
  const lines = [];
  const logger = createCollectionDiagnostics({ directory: "unused", runId: "probe", fileSystem: {
    mkdir: async () => {}, appendFile: async (_, line) => { lines.push(JSON.parse(line)); },
  } });
  const requestError = new Error("apiRequestContext.get: ERR_HTTP2_STREAM_ERROR\nAuthorization: must-not-leak");
  const f = fixture([response(), requestError, response(IP, 503), response()]);
  await logger.run(async () => {
    const session = await f.start();
    try { await session.check(); } finally { session.stop(); }
  });
  await logger.flush();
  assert.equal(f.requests, 4);
  assert.deepEqual(f.waits, [1000, 2000]);
  assert.equal(f.failures.length, 0);
  const retries = lines.filter(x => x.event === "sticky-session-check-retry");
  assert.deepEqual(retries.map(x => x.details.reason), ["PROBE_REQUEST_FAILED", "PROBE_HTTP_ERROR"]);
  assert.equal(retries[0].details.requestErrorCode, "ERR_HTTP2_STREAM_ERROR");
  assert.equal(retries[0].details.requestErrorType, "Error");
  assert.equal(retries[0].details.probeHost, "api.ipify.org");
  assert.equal(retries[1].details.statusCode, 503);
  assert.equal(lines.at(-1).details.attempt, 3);
  assert.doesNotMatch(JSON.stringify(lines), /must-not-leak/);
  assert.ok(f.probeOptions.every(options => options.maxRedirects === 0 &&
    options.headers["Cache-Control"].includes("no-cache")));
});

test("exhausted IP checks retain a safe reason and cannot restart a failed monitor", async () => {
  const f = fixture([response(), ...Array.from({ length: 3 }, () => new Error("Timeout: Authorization secret-value"))]);
  const session = await f.start();
  try {
    let failure;
    await assert.rejects(session.check(), error => {
      failure = error;
      assert.equal(error.code, "DATAIMPULSE_SESSION_LOST");
      assert.equal(error.details.reason, "PROBE_TIMEOUT");
      assert.equal(error.details.attempt, 3);
      assert.equal(error.cause.code, "PROBE_TIMEOUT");
      assert.doesNotMatch(error.message + error.cause.message, /secret-value/);
      return true;
    });
    await assert.rejects(session.check(), error => error === failure);
    assert.equal(f.requests, 4);
    assert.equal(f.failures.length, 1);
  } finally { session.stop(); }
});

test("proxy tunnel failures from the IP probe still require CONNECT verification after sanitization", async t => {
  for (const [message, expectedCode] of [
    ["ERR_TUNNEL_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED"],
    ["Proxy connection ended before receiving CONNECT response", "PROXY_CONNECTION_CLOSED"],
  ]) await t.test(expectedCode, async () => {
    const f = fixture([response(), ...Array.from({ length: 3 }, () => new Error(`${message}\nsecret-credential`))]);
    const session = await f.start();
    try {
      await assert.rejects(session.check(), error => {
        assert.equal(error.details.reason, "PROBE_CONNECTION_FAILED");
        assert.equal(error.details.requestErrorCode, expectedCode);
        assert.equal(needsStickyTunnelConfirmation(error), true);
        assert.doesNotMatch(String(error.cause), /secret-credential/);
        return true;
      });
    } finally { session.stop(); }
  });
});

test("IP change, authentication errors, denied responses and invalid data are not retried", async t => {
  const cases = [
    [response("192.0.2.2"), "SESSION_IP_CHANGED"],
    [new Error("HTTP 407 Proxy Authentication Required"), "PROXY_AUTH_FAILED", 407],
    [new Error("ERR_TUNNEL_CONNECTION_FAILED CONNECT=403"), "PROBE_HTTP_ERROR", 403],
    [new Error("ERR_TUNNEL_CONNECTION_FAILED CONNECT=429"), "PROBE_HTTP_ERROR", 429],
    [new Error("tunneling socket could not be established, status code: 407"), "PROXY_AUTH_FAILED", 407],
    ...[403, 407, 429].map(status => [response(IP, status), "PROBE_HTTP_ERROR", status]),
    [response("not-an-ip"), "PROBE_INVALID_IP"],
    [{ ...response(), json: async () => { throw new SyntaxError("private response"); } }, "PROBE_INVALID_RESPONSE"],
  ];
  for (const [result, reason, statusCode] of cases) await t.test(`${reason} ${statusCode || ""}`.trim(), async () => {
    const f = fixture([response(), result]);
    const session = await f.start();
    try {
      await assert.rejects(session.check(), error => error.details.reason === reason &&
        error.details.attempt === 1 && error.statusCode === statusCode);
      assert.equal(f.requests, 2);
      assert.deepEqual(f.waits, []);
    } finally { session.stop(); }
  });
});

test("equivalent IP spellings keep the current session and a real early change reports its age", async t => {
  const formats = [
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1", "2001:db8::2"],
    ["::FFFF:192.0.2.1", "192.0.2.1", "192.0.2.2"],
  ];
  for (const [first, same, different] of formats) await t.test(same, async () => {
    let now = 0;
    const f = fixture([response(first), response(same), response(different)], { now: () => now });
    const session = await f.start();
    try {
      now = 4000;
      await session.check();
      now = 13000;
      assert.equal(session.needsRenewal(), false);
      await assert.rejects(session.check(), error => {
        assert.equal(error.details.reason, "SESSION_IP_CHANGED");
        assert.equal(error.details.expectedIp, same);
        assert.equal(error.details.actualIp, different);
        assert.equal(error.details.sessionElapsedMs, 13000);
        assert.equal(error.details.lastConfirmedAgoMs, 9000);
        return true;
      });
      assert.equal(f.failures.length, 1);
      assert.deepEqual(f.waits, []);
    } finally { session.stop(); }
  });
});

test("an unrelated port containing 407 does not turn a transient reset into an authentication error", async () => {
  const f = fixture([response(), new Error("ECONNRESET gateway.example:10407"), response()]);
  const session = await f.start();
  try {
    await session.check();
    assert.deepEqual(f.waits, [1000]);
    assert.equal(f.failures.length, 0);
  } finally { session.stop(); }
});

test("parallel sessions have independent baselines and concurrent checks share one pending request", async () => {
  let resolveProbe;
  const a = fixture([response(), () => new Promise(resolve => { resolveProbe = resolve; })]);
  const b = fixture([response("192.0.2.2"), response("192.0.2.2")]);
  const [first, second] = await Promise.all([a.start(), b.start()]);
  try {
    const one = first.check(), two = first.check();
    assert.equal(one, two);
    await second.check();
    resolveProbe(response());
    await Promise.all([one, two]);
    assert.equal(a.requests, 2);
    assert.equal(b.requests, 2);
    assert.equal(a.failures.length + b.failures.length, 0);
  } finally { first.stop(); second.stop(); }
});

test("expiry during retry never confirms the session or sends another request", async () => {
  let now = 0;
  const f = fixture([response(), new Error("ECONNRESET")], {
    now: () => now, sleep: async () => { now = 59 * 60000; },
  });
  const session = await f.start();
  try {
    await assert.rejects(session.check(), error => error.details.reason === "SESSION_EXPIRED");
    assert.equal(f.requests, 2);
  } finally { session.stop(); }
});

test("stopping during a retry cancels checks without triggering a collection failure", async () => {
  let session;
  const f = fixture([response(), new Error("ECONNRESET")], { sleep: async () => session.stop() });
  session = await f.start();
  await assert.rejects(session.check(), { code: "SESSION_STOPPED" });
  assert.equal(f.requests, 2);
  assert.equal(f.failures.length, 0);
});

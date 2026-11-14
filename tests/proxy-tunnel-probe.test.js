// 외부 프록시를 사용하지 않고 로컬 TCP 서버로 CONNECT 교환만 검증한다.
const assert = require("node:assert/strict");
const net = require("node:net");
const { test } = require("node:test");
const { probeProxyTunnel } = require("../electron/proxy-tunnel-probe");
const { checkStickyTunnelBeforeRecovery } = require("../src/utils/proxy-tunnel-probe");

async function fixture(t, respond, host = "127.0.0.1") {
  const sockets = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return;
      received = true;
      requests.push(buffer);
      respond(socket, buffer);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    proxy: { server: `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`, username: "fixture-user", password: "fixture-password" },
    requests,
    async assertClosed() {
      await Promise.all([...sockets].map((socket) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CONNECT 진단 소켓이 닫히지 않았습니다.")), 1000);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
      })));
      assert.equal(sockets.size, 0);
    },
  };
}

test("CONNECT 인증·목적지 authority를 보내고 분할된 200 응답 직후 소켓을 정리한다", async (t) => {
  const local = await fixture(t, (socket) => {
    socket.write("HTTP/1.");
    setTimeout(() => socket.write("1 200 Connection established\r\nX-Fixture: yes\r\n"), 5);
    setTimeout(() => socket.write("\r\n"), 10);
  });
  const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://target.example:8443/private/path?token=hidden" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.success, true);
  assert.match(local.requests[0], /^CONNECT target\.example:8443 HTTP\/1\.1\r\nHost: target\.example:8443\r\n/);
  assert.match(local.requests[0], new RegExp(`Proxy-Authorization: Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`));
  assert.doesNotMatch(local.requests[0], /private|hidden/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password|Proxy-Authorization|X-Fixture/);
  assert.ok(result.elapsedMs >= 0);
  await local.assertClosed();
});

test("CONNECT 407과 502를 원래 상태로 반환하고 응답 본문·헤더의 인증정보는 남기지 않는다", async (t) => {
  for (const code of [407, 502]) {
    const local = await fixture(t, (socket) => socket.write(`HTTP/1.1 ${code} Fixture\r\nProxy-Authenticate: secret-header\r\n\r\nprivate-body`));
    const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://target.example/" });
    assert.equal(result.statusCode, code);
    assert.equal(result.success, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-header|private-body|fixture-password/);
    await local.assertClosed();
  }
});

test("중간 100 응답 뒤의 최종 502 상태를 반환한다", async (t) => {
  const local = await fixture(t, (socket) => socket.write("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 502 Bad Gateway\r\n\r\n"));
  const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://target.example/" });
  assert.equal(result.statusCode, 502);
  await local.assertClosed();
});

test("응답이 없는 프록시는 제한 시간 후 정리하고 CONNECT 타임아웃으로 표시한다", async (t) => {
  const local = await fixture(t, () => {});
  const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://target.example/", timeoutMs: 100 });
  assert.equal(result.statusCode, null);
  assert.equal(result.errorCode, "CONNECT_TIMEOUT");
  assert.ok(result.elapsedMs >= 90 && result.elapsedMs < 2000, `elapsed=${result.elapsedMs}`);
  await local.assertClosed();
});

test("잘못된 상태 행·과도한 헤더·중간 연결 종료를 구별하고 소켓을 정리한다", async (t) => {
  for (const [data, expected, end] of [
    ["NOT HTTP\r\n\r\n", "INVALID_PROXY_RESPONSE", false],
    ["HTTP/1.1 200junk\r\n\r\n", "INVALID_PROXY_RESPONSE", false],
    ["HTTP/1.1 502 Bad Gateway\r\nX: " + "x".repeat(17000), "INVALID_PROXY_RESPONSE", false],
    ["HTTP/1.1 502 Bad Gateway\r\nX: " + "x".repeat(17000) + "\r\n\r\n", "INVALID_PROXY_RESPONSE", false],
    ["HTTP/1.1 50", "PROXY_CONNECTION_CLOSED", true],
  ]) {
    const local = await fixture(t, (socket) => end ? socket.end(data) : socket.write(data));
    const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://target.example/" });
    assert.equal(result.statusCode, null);
    assert.equal(result.errorCode, expected);
    await local.assertClosed();
  }
});

test("지원하지 않는 조합은 네트워크 접속 없이 건너뛰고 인증 없는 프록시에는 인증 헤더를 보내지 않는다", async (t) => {
  const unsupported = await probeProxyTunnel({ proxy: { server: "socks5://127.0.0.1:1" }, url: "https://target.example/" });
  assert.equal(unsupported.skipped, true);
  const plain = await probeProxyTunnel({ proxy: { server: "http://127.0.0.1:1" }, url: "http://target.example/" });
  assert.equal(plain.skipped, true);
  const local = await fixture(t, (socket) => socket.write("HTTP/1.0 200\r\n\r\n"));
  const result = await probeProxyTunnel({ proxy: { server: local.proxy.server }, url: "https://target.example/" });
  assert.equal(result.success, true);
  assert.doesNotMatch(local.requests[0], /Proxy-Authorization/);
  await local.assertClosed();
});

test("IPv6 프록시 주소의 괄호를 소켓 호스트에서 제거하고 IPv6 목적지는 CONNECT authority에 보존한다", async (t) => {
  let local;
  try { local = await fixture(t, (socket) => socket.write("HTTP/1.1 200 OK\r\n\r\n"), "::1"); }
  catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) { t.skip("IPv6 loopback unavailable"); return; }
    throw error;
  }
  const result = await probeProxyTunnel({ proxy: local.proxy, url: "https://[2001:db8::1]/" });
  assert.equal(result.success, true);
  assert.match(local.requests[0], /^CONNECT \[2001:db8::1\]:443 /);
  await local.assertClosed();
});

test("스티키 복구용 CONNECT 검사에서 403·407·429와 확인하지 못한 응답은 재연결하지 않는다", async (t) => {
  const url = "https://target.example/";
  for (const [status, code] of [[403, "SITE_ACCESS_BLOCKED"], [407, "PROXY_AUTHENTICATION_REQUIRED"],
    [429, "SITE_ACCESS_BLOCKED"], [302, "PROXY_TUNNEL_UNVERIFIED"]]) {
    const local = await fixture(t, socket => socket.write(`HTTP/1.1 ${status} Fixture\r\nX-Fixture: secret\r\n\r\n`));
    await assert.rejects(checkStickyTunnelBeforeRecovery({ proxy: local.proxy, url }), {
      code, statusCode: status, retryable: false,
    });
    await local.assertClosed();
  }
  const partial = await fixture(t, socket => socket.end("HTTP/1.1 40"));
  await assert.rejects(checkStickyTunnelBeforeRecovery({ proxy: partial.proxy, url }), { code: "PROXY_TUNNEL_UNVERIFIED" });
  await partial.assertClosed();
  await assert.rejects(checkStickyTunnelBeforeRecovery({ proxy: { server: "socks5://127.0.0.1:1" }, url }), {
    code: "PROXY_TUNNEL_UNVERIFIED",
  });
});

test("확인된 연결 가능 상태와 무응답 연결 종료의 복구 관측값에는 민감한 내용이 없다", async (t) => {
  const url = "https://target.example/";
  for (const statusCode of [200, 502, 503, 504]) {
    const observation = await checkStickyTunnelBeforeRecovery({
      url,
      probe: async () => ({ statusCode, elapsedMs: 1, message: "sensitive fixture", headers: { secret: 1 } }),
    });
    assert.deepEqual(observation, { statusCode, errorCode: "", elapsedMs: 1 });
  }
  const local = await fixture(t, socket => socket.end());
  const observation = await checkStickyTunnelBeforeRecovery({ proxy: local.proxy, url });
  assert.equal(observation.statusCode, null);
  assert.equal(observation.errorCode, "PROXY_CONNECTION_CLOSED");
  await local.assertClosed();
});

test("사용자가 취소하면 대기 중인 CONNECT 소켓을 즉시 닫는다", async (t) => {
  const { promise: connected, resolve } = Promise.withResolvers();
  const local = await fixture(t, resolve);
  const controller = new AbortController();
  const result = checkStickyTunnelBeforeRecovery({
    proxy: local.proxy, url: "https://target.example/", signal: controller.signal,
  });
  await connected;
  controller.abort();
  await assert.rejects(result, { name: "AbortError", code: "ABORT_ERR" });
  await local.assertClosed();
});

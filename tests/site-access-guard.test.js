const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { gotoWithSiteRetry, installHttpBlockGuard, isRetryableSiteError } = require("../src/utils/site-safety");
const { classifyCollectionFailure } = require("../src/utils/collection-failure");
const { collectCheonyuDetails } = require("../src/malls/cheonyu/detail");

function response(statusCode, url = "https://www.cheonyu.com/member/login.html", resourceType = "document") {
  return { status: () => statusCode, url: () => url, request: () => ({ resourceType: () => resourceType }) };
}

test("a tunnel error is returned to session recovery without accepting the previous page's DOM", async () => {
  const failure = new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED");
  let calls = 0;
  const page = {
    async goto() { calls++; throw failure; },
    locator() { assert.fail("must not inspect stale DOM after a tunnel failure"); },
  };
  await assert.rejects(gotoWithSiteRetry(page, "https://www.cheonyu.com/product/list.html?page=2", {
    maxAttempts: 4, readySelector: "#ProductCount", acceptReadySelectorAfterNavigationError: true,
    handoffProxyFailure: true,
  }), error => error === failure);
  assert.equal(calls, 1);
});

test("an observed 407 has a nonretryable proxy-auth cause and stops automatic repeats", () => {
  const context = new EventEmitter();
  const controller = new AbortController();
  const guard = installHttpBlockGuard(context, {
    hostname: "www.cheonyu.com", label: "천유", statusCodes: [403, 407, 429],
    onBlocked: (error) => controller.abort(error),
  });
  context.emit("requestfailed", { errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
  assert.equal(guard.getError(), null, "a network error alone does not prove HTTP 407");
  context.emit("response", response(407, "https://unrelated.example/"));
  context.emit("response", response(407, undefined, "image"));
  assert.equal(guard.getError(), null);
  context.emit("response", response(407));
  const error = guard.getError();
  assert.equal(error.code, "PROXY_AUTHENTICATION_REQUIRED");
  assert.equal(error.statusCode, 407);
  assert.equal(error.retryable, false);
  assert.equal(isRetryableSiteError(error), false);
  assert.equal(controller.signal.reason, error);
  const failure = classifyCollectionFailure(error);
  assert.equal(failure.kind, "proxy-authentication");
  assert.equal(failure.stopAutoRepeat, true);
  context.emit("response", response(403));
  assert.equal(guard.getError(), error, "later responses cannot overwrite the first stop cause");
  guard.dispose();
  assert.equal(context.listenerCount("response"), 0);
});

test("other callers retain the default 403/429 guard until authentication watching is explicitly enabled", () => {
  const context = new EventEmitter();
  const guard = installHttpBlockGuard(context, { hostname: "www.cheonyu.com" });
  context.emit("response", response(407));
  assert.equal(guard.getError(), null);
  context.emit("response", response(429));
  assert.equal(guard.getError().code, "SITE_ACCESS_BLOCKED");
  assert.equal(guard.getError().statusCode, 429);
  guard.dispose();
});

for (const statusCode of [403, 407, 429]) {
  test(`detail HTTP ${statusCode} stops the worker without retrying or moving to another product`, async () => {
    let navigationCount = 0;
    let closeCount = 0;
    const progress = [];
    const worker = {
      on() {},
      async goto() { navigationCount++; return { ...response(statusCode), ok: () => false }; },
      async close() { closeCount++; },
    };
    const context = { newPage: async () => worker };
    const products = ["1", "2"].map((productId) => ({ productId, productUrl: `https://www.cheonyu.com/product/view.html?id=${productId}` }));
    await assert.rejects(collectCheonyuDetails({ context: () => context }, products, {
      mall: "cheonyu", detailConcurrency: 1, detailRequestDelayMs: 0,
      detailRetryCount: 6, navigationTimeoutMs: 1000,
    }, (event) => progress.push(event)), (error) => {
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.retryable, false);
      if (statusCode === 407) {
        assert.equal(error.code, "PROXY_AUTHENTICATION_REQUIRED");
        assert.equal(classifyCollectionFailure(error).kind, "proxy-authentication");
      }
      return true;
    });
    assert.equal(navigationCount, 1);
    assert.ok(closeCount > 0);
    assert.equal(progress.filter((event) => event.stage === "blocked").length, 1);
    assert.equal(progress.some((event) => event.detailAttempt > 1), false);
  });
}

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { resolveRunConfig } = require("../src/config");

function fixture({ loseSession = false, leftoverCart = false, provider = "decodo", kind = "shortTerm",
  popupRecoveryMode = null, renewSession = true, candidateFailures = 0, failureStage = "login",
  candidateFailureReason = "SESSION_IP_CHANGED", boundaryFailureReason = "", candidateCartLeftover = false,
  failArchive = false, cancelRenewal = false, lossStage = "", lossPage = 1, losses = 1,
  lossReason = "SESSION_IP_CHANGED", reverse = false, cancelBackoff = false, lateCallback = false,
  accessStatus = 0, archiveLossAndFailure = false, initialFailureReason = "", initialFailureStage = "login",
  tunnelStatus = 502 } = {}) {
  const filename = path.resolve(__dirname, "../src/malls/cheonyu/index.js");
  const originalRequire = createRequire(filename);
  const events = [];
  const contextSettings = [];
  let lastSavedPage = 0;
  let lastClearedPage = 0;
  let currentPage = 0;
  let cartContextId = 0;
  const callbacks = new Map();
  const cartIds = new Set();
  let lossesRemaining = losses;
  const controller = new AbortController();
  const sessionError = reason => Object.assign(new Error(reason), {
    code: provider === "dataimpulse" ? "DATAIMPULSE_SESSION_LOST" : "DECODO_SESSION_LOST", details: { reason },
  });
  const reportFailure = (contextId, reason) => {
    if (reason === "TUNNEL_CONNECTION_FAILED") {
      throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED");
    }
    const error = sessionError(reason);
    callbacks.get(contextId)(error);
    return error;
  };
  const lose = (stage, context, shouldThrow = true) => {
    if (stage !== lossStage || currentPage !== lossPage || lossesRemaining <= 0) return;
    lossesRemaining--;
    events.push(`loss:${stage}:${currentPage}`);
    reportFailure(context.id, lossReason);
    if (shouldThrow) throw new Error("Target page, context or browser has been closed");
  };
  const browser = {
    async newContext(settings) {
      const id = contextSettings.push(settings);
      const context = { id, newPage: async () => {
        events.push(`tab:${id}`);
        return { context: () => context, close: async () => events.push(`close-tab:${id}`) };
      }, close: async () => events.push(`close:${id}`) };
      return context;
    },
    close: async () => events.push("browser-close"),
  };
  const mocked = {
    "../../utils/product-archive": { readProductArchive: async () => ({ products: { existing: {
      id: "100", sourceMall: "cheonyu", options: [{ id: "11", barcode: "8800000000011" }],
    } } }) },
    "../../utils/browser": { bindAbortToBrowser: originalRequire("../../utils/browser").bindAbortToBrowser, installDialogAutoAccept: () => {},
      getLightweightLaunchArgs: () => [], installLightweightNetworkPolicy: async () => ({ configurePage: async () => {} }) },
    "../../utils/network-usage": { createNetworkUsageTracker: () => ({ trackPage: async () => {},
      trackContext: async context => events.push(`network:${context.id}`), finishAndLog: async () => events.push("network-finish") }) },
    "../../utils/site-safety": { replacePage: originalRequire("../../utils/site-safety").replacePage,
      sleepWithSignal: async (ms, signal) => {
        events.push(`backoff:${ms}`);
        if (cancelBackoff) controller.abort(Object.assign(new Error("cancel fixture"), { name: "AbortError" }));
        if (signal.aborted) throw signal.reason;
      },
      installHttpBlockGuard: () => ({ dispose: () => {}, getError: () => null }) },
    "../../utils/proxy-tunnel-probe": {
      checkStickyTunnelBeforeRecovery: async ({ proxy, url, signal }) => {
        assert.equal(new URL(url).hostname.replace(/^www\./, ""), "cheonyu.com");
        assert.equal(signal.aborted, false, "the tunnel check must use the run signal, not the lost session");
        const index = contextSettings.findIndex(settings => settings.proxy === proxy);
        assert.ok(index >= 0, "verify the failed proxy, before requesting a replacement");
        events.push(`tunnel-check:${index + 1}`);
        if ([403, 407, 429].includes(tunnelStatus)) {
          throw Object.assign(new Error(`CONNECT=${tunnelStatus}`), { statusCode: tunnelStatus });
        }
        return { statusCode: tunnelStatus };
      },
    },
    "./logger": Object.fromEntries(["Error", "Warn", "Info", "Success"].map(name => [`logCheonyu${name}`, () => {}])),
    "../../utils/collection-proxy": { ...originalRequire("../../utils/collection-proxy"),
      monitorCollectionSession: async (context, onFailure, selectedProvider) => {
        assert.equal(selectedProvider, provider);
        callbacks.set(context.id, onFailure);
        let checks = 0;
        events.push(`monitor:${context.id}`);
        if (context.id === 1 && initialFailureStage === "probe" && initialFailureReason) {
          throw reportFailure(context.id, initialFailureReason);
        }
        return { stop: () => events.push(`stop:${context.id}`),
          needsRenewal: () => renewSession && context.id === 1 && lastSavedPage === 1 && lastClearedPage === 1,
          check: async () => {
            checks++;
            const failedCandidate = context.id > 1 && context.id <= candidateFailures + 1 &&
              ((failureStage === "after-login" && checks === 1) || (failureStage === "handover" && checks === 3));
            const failedBoundary = context.id === 1 && lastSavedPage === 1 && lastClearedPage === 1 && boundaryFailureReason;
            if (failedCandidate || failedBoundary) {
              throw reportFailure(context.id, failedBoundary || candidateFailureReason);
            }
            if (loseSession && currentPage === 1) {
              const error = Object.assign(new Error("세션 IP 변경"), { code: provider === "dataimpulse" ? "DATAIMPULSE_SESSION_LOST" : "DECODO_SESSION_LOST" });
              onFailure(error);
              throw error;
            }
          },
        };
      },
    },
    "./site": { resetCheonyuPopupWorkloadTracker: () => {},
      loginCheonyu: async (page, loginConfig, signal) => {
        const id = page.context().id;
        assert.equal(loginConfig.accountId, "fixture", "a new proxy session keeps the selected login");
        events.push(`login:${id}`);
        if (cancelRenewal && id > 1) {
          controller.abort(Object.assign(new Error("cancel fixture"), { name: "AbortError" }));
          throw controller.signal.reason;
        }
        const reason = id === 1 && initialFailureStage === "login" ? initialFailureReason
          : failureStage === "login" && id > 1 && id <= candidateFailures + 1 ? candidateFailureReason : "";
        if (reason === "SITE_LOGIN_FAILED") {
          callbacks.get(id)(sessionError("SESSION_IP_CHANGED"));
          throw new Error("천유닷컴 로그인 성공 확인에 실패했습니다.");
        }
        if (reason) {
          reportFailure(id, reason);
          assert.equal(signal.aborted, true);
          throw new Error("login page closed during session change");
        }
        return {};
      },
      bulkAddPages: async (page, config, _progress, _signal, options) => {
        assert.equal(options.rotatePage, null, "periodic proxy rotation must not interrupt a sticky cart");
        if (kind === "inventory") assert.equal(config.knownOptionBarcodes, undefined);
        else assert.equal(config.knownOptionBarcodes.has("100:11"), true);
        currentPage = options.startPage ?? (reverse ? 2 : 1);
        events.push(`add:${currentPage}:${page.context().id}`);
        assert.equal(options.skipProductIds.includes(String(currentPage)), false, "failed page must not remain marked collected");
        assert.equal(_signal.aborted, false, "new context must not inherit a failed session signal");
        if (lateCallback && page.context().id > 1) callbacks.get(1)(sessionError("SESSION_IP_CHANGED"));
        lose("popup", page.context());
        if (popupRecoveryMode && currentPage === 1) {
          const nextPage = await options.recoverListPage({ currentPage: page, pageNo: currentPage,
            mode: popupRecoveryMode, error: new Error("천유 1페이지 팝업 누락률 48.6%") });
          assert.notEqual(nextPage, page);
          assert.equal(nextPage.context(), page.context(), "recovery must preserve login, cart and proxy context");
          events.push(`recovered:${currentPage}:${nextPage.context().id}`);
        }
        const product = { productId: String(currentPage), page: currentPage, sourceMall: "cheonyu", productName: "상품", consumerPrice: 1200 };
        config.onCartSubmission?.([product.productId]);
        assert.equal(cartIds.has(product.productId), false, "do not replay a submitted cart before reconciliation");
        cartIds.add(product.productId);
        lose("submit", page.context());
        const popup = { productId: product.productId, optionId: "11", hasOption: true, optionText: "옵션", maxStock: 7, selectable: true, selectedForCart: true, complete: true };
        return { allProducts: [product], allTargets: [product], allPopupOptionRows: [popup], collectedProductCount: 1,
          resumePage: currentPage + (reverse ? -1 : 1), pageRange: { pageStart: 1, pageEnd: 2, detectedTotalProductCount: 2,
            collectedLastPage: currentPage, collectedPageCount: 1, resumePage: currentPage + (reverse ? -1 : 1),
            stopReason: currentPage === (reverse ? 2 : 1) ? "limit-reached" : "completed" },
          pageResults: [{ page: currentPage, bulkResult: { popupDirectProductIds: [product.productId], cartSubmittedProductIds: [product.productId] } }],
        };
      },
    },
    "./cart": { readCartHtml: async page => { cartContextId = page.context().id; return "fixture"; },
      parseCartHtml: () => leftoverCart || candidateCartLeftover && cartContextId > 1 ? [{ productId: "1" }] : [],
      clearCartAll: async (_page, context) => {
      events.push(`clear:${currentPage}:${context.id}`);
      lose("cleanup", context);
      cartIds.clear();
      lastClearedPage = currentPage;
      return { cleared: true };
    },
      reconcileCollectionCart: async (_page, context, _config, owned, { signal }) => {
        if (signal.aborted) throw signal.reason;
        if (candidateCartLeftover && context.id > 1) throw Object.assign(new Error("unknown cart item"), { code: "CART_CLEANUP_INCOMPLETE" });
        for (const id of cartIds) assert.equal(owned.has(id), true, "every recovery deletion must be journaled");
        events.push(`reconcile:${context.id}:${[...cartIds].join(",")}`);
        cartIds.clear();
      },
    },
    "./cart-stock": { ...originalRequire("./cart-stock"),
      probeCheonyuCartStock: async (_page, context) => {
        events.push(`cart:${currentPage}:${context.id}`);
        if (accessStatus) {
          callbacks.get(context.id)(sessionError("SESSION_IP_CHANGED"));
          throw Object.assign(new Error(`HTTP ${accessStatus}`), { statusCode: accessStatus });
        }
        lose("cart", context);
        lose("before-archive", context, false);
        return { inventoryItems: [{ productId: String(currentPage), sourceMall: "cheonyu", optionId: "11", hasOption: true,
          optionText: "옵션", barcode: "8800000000011", maxStock: 7 }],
          coverage: { complete: true, optionCoverageComplete: true, expectedProductIds: [String(currentPage)], actualProductIds: [String(currentPage)],
            expectedRowCount: 1, actualRowCount: 1, expectedProductCount: 1, actualProductCount: 1 }, cartHtml: "fixture" };
      },
    },
    "./detail": { collectCheonyuDetails: async () => { throw new Error("short-term must not collect public detail pages"); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, require: name => mocked[name] || originalRequire(name),
    AbortController, AbortSignal, URL, console, process, setTimeout, clearTimeout }, { filename });
  const config = resolveRunConfig({ mall: "cheonyu", collectionKind: kind, accountId: "fixture", accountPw: "fixture",
    cheonyuProxyServer: provider === "dataimpulse" ? "http://gw.dataimpulse.com:823" : "http://gate.decodo.com:7000", cheonyuProxyUsername: "user-fixture", cheonyuProxyPassword: "fixture",
    pageStart: 1, pageEnd: 2, pageOrder: reverse ? "reverse" : "forward" }, {}, "fixture");
  // Exercise the legacy adapter's session recovery independently of the new
  // inventory menu, whose scope is now always the complete selected best list.
  Object.assign(config, { pageStart: 1, pageEnd: 2, pageOrder: reverse ? "reverse" : "forward" });
  return { events, contextSettings, run: () => module.exports.run(config, {
    signal: controller.signal,
    onProgress: progress => {
      if (progress.stage === "collecting" && progress.cycleHealthProfile) {
        lose("after-cleanup", { id: contextSettings.length }, false);
      }
    },
    browserType: { launch: async () => browser },
    onCycleArchive: async ({ products, inventoryItems }) => {
      if (archiveLossAndFailure) {
        callbacks.get(contextSettings.length)(sessionError("SESSION_IP_CHANGED"));
        throw new Error("archive disk full");
      }
      if (failArchive) throw new Error("archive disk full");
      lastSavedPage = products[0].page;
      events.push(`save:${lastSavedPage}`);
      lose("archive", { id: contextSettings.length }, false);
      assert.equal(inventoryItems.length, 1, "popup/cart option rows must be merged without duplicates");
      assert.equal(inventoryItems[0].barcode, "8800000000011");
      return { saved: true };
    },
  }) };
}

test("short-term renews sticky login only after saving a complete page and clearing its cart", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.summary.collectedProductCount, 2);
  assert.equal(result.detailItems.length, 0);
  assert.equal(f.contextSettings.length, 2);
  assert.notEqual(f.contextSettings[0].proxy.username, f.contextSettings[1].proxy.username);
  assert.deepEqual(f.events.filter(event => /^(login|add|cart|save|clear):/.test(event)), [
    "login:1", "clear:0:1", "add:1:1", "cart:1:1", "save:1", "clear:1:1",
    "login:2", "add:2:2", "cart:2:2", "save:2", "clear:2:2",
  ]);
});

test("unclassified session errors still stop without replaying a populated cart", async () => {
  const f = fixture({ loseSession: true });
  await assert.rejects(f.run(), { code: "DECODO_SESSION_LOST" });
  assert.equal(f.contextSettings.length, 1);
  assert.equal(f.events.some(event => event.startsWith("save:") || event.startsWith("cart:")), false);
  assert.equal(f.events.includes("clear:1:1"), false);
});

test("short-term refuses to renew a login while the previous cart is not empty", async () => {
  const f = fixture({ leftoverCart: true });
  await assert.rejects(f.run(), { code: "CART_CLEANUP_INCOMPLETE" });
  assert.equal(f.contextSettings.length, 1);
  assert.equal(f.events.includes("save:1"), true);
  assert.equal(f.events.includes("add:2:2"), false);
});

test("inventory-only uses sticky login and renews after cart cleanup without requesting missing barcodes", async () => {
  const f = fixture({ kind: "inventory", provider: "dataimpulse" });
  await f.run();
  assert.equal(f.contextSettings.length, 2);
  assert.match(f.contextSettings[0].proxy.username, /sessttl\.60/);
  assert.ok(f.events.indexOf("login:2") > f.events.indexOf("clear:1:1"));
});

test("DataImpulse renews its 60-minute port only after saving and clearing the cart", async () => {
  const f = fixture({ provider: "dataimpulse" });
  await f.run();
  assert.equal(f.contextSettings.length, 2);
  assert.notEqual(f.contextSettings[0].proxy.server, f.contextSettings[1].proxy.server);
  for (const settings of f.contextSettings) assert.match(settings.proxy.username, /__sessttl\.60$/);
  assert.ok(f.events.indexOf("login:2") > f.events.indexOf("clear:1:1"));
  assert.ok(f.events.indexOf("clear:1:1") > f.events.indexOf("save:1"));
  for (const options of [{ loseSession: true }, { leftoverCart: true }]) {
    const failed = fixture({ provider: "dataimpulse", ...options });
    await assert.rejects(failed.run(), { code: options.loseSession ? "DATAIMPULSE_SESSION_LOST" : "CART_CLEANUP_INCOMPLETE" });
    assert.equal(failed.contextSettings.length, 1);
  }
});

test("popup recovery preserves sticky login and proxy for inventory and short-term runs", async t => {
  for (const provider of ["decodo", "dataimpulse"]) {
    for (const kind of ["shortTerm", "inventory"]) {
      for (const mode of ["popup-overload", "popup-overload-next-proxy"]) {
        await t.test(`${provider} ${kind} ${mode}`, async () => {
          const f = fixture({ provider, kind, popupRecoveryMode: mode, renewSession: false });
          const result = await f.run();
          assert.equal(result.summary.collectedProductCount, 2);
          assert.equal(f.contextSettings.length, 1);
          assert.equal(f.events.filter(event => event === "login:1").length, 1);
          assert.equal(f.events.filter(event => event === "monitor:1").length, 1);
          assert.equal(f.events.filter(event => event === "close-tab:1").length, 1);
          assert.ok(f.events.indexOf("save:1") > f.events.indexOf("recovered:1:1"));
          assert.ok(f.events.indexOf("clear:1:1") > f.events.indexOf("save:1"));
        });
      }
    }
  }
});

test("popup recovery does not retry an unclassified session failure", async () => {
  const f = fixture({ provider: "dataimpulse", kind: "inventory", loseSession: true,
    popupRecoveryMode: "popup-overload", renewSession: false });
  await assert.rejects(f.run(), { code: "DATAIMPULSE_SESSION_LOST" });
  assert.equal(f.contextSettings.length, 1);
  assert.equal(f.events.filter(event => event.startsWith("tab:")).length, 1);
  assert.equal(f.events.some(event => /^(recovered|save|cart):/.test(event)), false);
});

test("mid-page session loss rolls back temporary data and resumes without duplicates", async t => {
  for (const provider of ["decodo", "dataimpulse"]) {
    for (const kind of ["inventory", "shortTerm"]) {
      for (const lossStage of ["popup", "submit", "cart", "before-archive"]) {
        await t.test(`${provider} ${kind} ${lossStage}`, async () => {
          const f = fixture({ provider, kind, lossStage, lossPage: 2, renewSession: false });
          const result = await f.run();
          assert.equal(result.summary.collectedProductCount, 2);
          assert.equal(result.products.length, 2);
          assert.equal(result.inventoryItems.length, 2, "temporary rows must be discarded before retry");
          assert.equal(result.popupOptionItems.length, 2);
          assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1", "save:2"]);
          assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:1", "add:2:2"]);
          assert.equal(f.contextSettings.length, 2);
          assert.equal(f.events.filter(e => e === "browser-close").length, 1);
          assert.equal(f.events.filter(e => e === "network-finish").length, 1);
          assert.ok(f.events.indexOf("network-finish") > f.events.indexOf("save:2"));
          if (lossStage !== "popup") assert.ok(f.events.includes("reconcile:2:2"));
        });
      }
    }
  }
});

test("loss during a successful save or cleanup preserves the committed page, including the last page", async t => {
  for (const lossStage of ["archive", "cleanup"]) {
    for (const lossPage of [1, 2]) await t.test(`${lossStage} page ${lossPage}`, async () => {
      const f = fixture({ kind: "inventory", provider: "dataimpulse", lossStage, lossPage, renewSession: false });
      const result = await f.run();
      assert.equal(result.products.length, 2);
      assert.equal(result.inventoryItems.length, 2);
      assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1", "save:2"]);
      assert.deepEqual(f.events.filter(e => e.startsWith("add:")), lossPage === 1
        ? ["add:1:1", "add:2:2"] : ["add:1:1", "add:2:1"]);
      assert.equal(f.contextSettings.length, 2);
      assert.ok(f.events.includes(`reconcile:2:${lossPage}`));
      assert.equal(f.events.filter(e => e === "network-finish").length, 1);
    });
  }
});

test("first page and reverse-order recovery retain traversal order and ignore late retired callbacks", async t => {
  for (const reverse of [false, true]) await t.test(`reverse=${reverse}`, async () => {
    const f = fixture({ kind: "inventory", provider: "dataimpulse", reverse,
      lossStage: "submit", lossPage: reverse ? 2 : 1, renewSession: false, lateCallback: true });
    const result = await f.run();
    assert.equal(result.products.length, 2);
    assert.deepEqual(f.events.filter(e => e.startsWith("save:")), reverse ? ["save:2", "save:1"] : ["save:1", "save:2"]);
    assert.equal(f.events.filter(e => e.startsWith("add:")).length, 3);
    assert.equal(f.contextSettings.length, 2);
  });
});

test("repeated mid-page loss stops after three recoveries; backoff remains cancellable", async () => {
  const f = fixture({ provider: "dataimpulse", kind: "inventory", lossStage: "cart", losses: 10, renewSession: false });
  await assert.rejects(f.run(), { code: "DATAIMPULSE_SESSION_LOST" });
  assert.equal(f.contextSettings.length, 4);
  assert.equal(f.events.some(e => e.startsWith("save:")), false);
  assert.deepEqual(f.events.filter(e => e.startsWith("backoff:")), ["backoff:5000", "backoff:15000", "backoff:30000"]);
  assert.equal(f.events.filter(e => e === "network-finish").length, 1);
  const cancelled = fixture({ provider: "dataimpulse", lossStage: "cart", cancelBackoff: true, renewSession: false });
  await assert.rejects(cancelled.run(), { name: "AbortError" });
  assert.equal(cancelled.contextSettings.length, 1);
});

test("expiry recovers mid-page but authentication failure does not", async () => {
  const expired = fixture({ provider: "dataimpulse", lossStage: "cart", lossReason: "SESSION_EXPIRED", renewSession: false });
  assert.equal((await expired.run()).products.length, 2);
  const auth = fixture({ provider: "dataimpulse", lossStage: "cart", lossReason: "PROXY_AUTH_FAILED", renewSession: false });
  await assert.rejects(auth.run(), { code: "DATAIMPULSE_SESSION_LOST" });
  assert.equal(auth.contextSettings.length, 1);
});

test("simultaneous IP changes never mask site blocks, proxy authentication or disk failures", async t => {
  for (const accessStatus of [403, 407, 429]) await t.test(String(accessStatus), async () => {
    const f = fixture({ provider: "dataimpulse", accessStatus });
    await assert.rejects(f.run(), { statusCode: accessStatus });
    assert.equal(f.contextSettings.length, 1);
    assert.equal(f.events.some(e => e.startsWith("save:")), false);
  });
  const f = fixture({ provider: "dataimpulse", archiveLossAndFailure: true });
  await assert.rejects(f.run(), /archive disk full/);
  assert.equal(f.contextSettings.length, 1);
});

test("a session lost after final cleanup still completes with all saved data", async () => {
  const f = fixture({ kind: "inventory", provider: "dataimpulse", lossStage: "after-cleanup", lossPage: 2, renewSession: false });
  const result = await f.run();
  assert.equal(result.products.length, 2);
  assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:1"]);
  assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1", "save:2"]);
  assert.equal(f.events.filter(e => e === "network-finish").length, 1);
});

test("concurrent runs recover independently and retain their own saved pages and usage lifecycle", async () => {
  const a = fixture({ provider: "dataimpulse", kind: "inventory", lossStage: "submit", renewSession: false });
  const b = fixture({ provider: "dataimpulse", kind: "inventory", lossStage: "archive", lossPage: 2, renewSession: false });
  const results = await Promise.all([a.run(), b.run()]);
  for (const result of results) assert.equal(result.products.length, 2);
  assert.deepEqual(a.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:1:2", "add:2:2"]);
  assert.deepEqual(b.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:1"]);
  for (const f of [a, b]) {
    assert.equal(f.events.filter(e => e === "network-finish").length, 1);
    assert.equal(f.events.filter(e => e === "browser-close").length, 1);
  }
});

test("renewal failures during login, validation and handover resume the saved next page", async t => {
  for (const provider of ["decodo", "dataimpulse"]) {
    for (const failureStage of ["login", "after-login", "handover"]) {
      await t.test(`${provider} ${failureStage}`, async () => {
        const f = fixture({ provider, kind: "inventory", candidateFailures: 1, failureStage });
        const result = await f.run();
        assert.equal(result.summary.collectedProductCount, 2);
        assert.equal(f.contextSettings.length, 3);
        assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:3"]);
        assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1", "save:2"]);
        assert.ok(f.events.indexOf("login:2") > f.events.indexOf("clear:1:1"));
        assert.ok(f.events.includes("stop:2"));
        const sessions = f.contextSettings.map(c => `${c.proxy.server}|${c.proxy.username}`);
        assert.equal(new Set(sessions).size, 3);
      });
    }
  }
});

test("expired or changed sessions at a saved checkpoint renew without needing the dead session", async t => {
  for (const reason of ["SESSION_EXPIRED", "SESSION_IP_CHANGED"]) await t.test(reason, async () => {
    const f = fixture({ provider: "dataimpulse", renewSession: false, boundaryFailureReason: reason });
    await f.run();
    assert.equal(f.contextSettings.length, 2);
    assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:2"]);
  });
});

test("renewal retries are bounded across preparation and handover, with the checkpoint retained", async t => {
  for (const failureStage of ["login", "after-login", "handover"]) await t.test(failureStage, async () => {
    const f = fixture({ provider: "dataimpulse", candidateFailures: 10, failureStage });
    await assert.rejects(f.run(), { code: "DATAIMPULSE_SESSION_LOST" });
    assert.equal(f.contextSettings.length, 4, "original session plus at most three new sessions");
    assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1"]);
    assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1"]);
  });
});

test("authentication, cart leftovers, cancellation and failed saves are never retried as renewal", async t => {
  for (const [options, expected, count] of [
    [{ candidateFailures: 3, candidateFailureReason: "PROXY_AUTH_FAILED" }, { code: "DATAIMPULSE_SESSION_LOST" }, 2],
    [{ candidateCartLeftover: true }, { code: "CART_CLEANUP_INCOMPLETE" }, 2],
    [{ cancelRenewal: true }, { name: "AbortError" }, 2],
    [{ failArchive: true }, /archive disk full/, 1],
  ]) await t.test(JSON.stringify(options), async () => {
    const f = fixture({ provider: "dataimpulse", ...options });
    await assert.rejects(f.run(), expected);
    assert.equal(f.contextSettings.length, count);
    assert.equal(f.events.some(e => e.startsWith("add:2:")), false);
  });
});

test("a lost first probe or a tunnel failure on first login gets a new session before cart work", async t => {
  for (const [initialFailureStage, initialFailureReason] of [
    ["probe", "SESSION_IP_CHANGED"],
    ["login", "TUNNEL_CONNECTION_FAILED"],
  ]) await t.test(initialFailureStage, async () => {
    const f = fixture({ provider: "dataimpulse", renewSession: false, initialFailureStage, initialFailureReason });
    const result = await f.run();
    assert.equal(result.summary.collectedProductCount, 2);
    assert.notEqual(f.contextSettings[0].proxy.server, f.contextSettings[1].proxy.server);
    assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:2", "add:2:2"]);
    assert.equal(f.events.includes("clear:0:1"), false);
    assert.ok(f.events.includes("clear:0:2"));
    if (initialFailureStage === "login") assert.ok(f.events.indexOf("tunnel-check:1") < f.events.indexOf("login:2"));
  });
});

test("a verified tunnel failure reopens the same-account session at the correct saved boundary", async t => {
  for (const lossStage of ["popup", "cart", "cleanup"]) await t.test(lossStage, async () => {
    const f = fixture({ provider: "dataimpulse", renewSession: false, lossStage, lossPage: 2,
      lossReason: "TUNNEL_CONNECTION_FAILED" });
    const result = await f.run();
    assert.equal(result.summary.collectedProductCount, 2);
    assert.notEqual(f.contextSettings[0].proxy.server, f.contextSettings[1].proxy.server);
    assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1", "save:2"]);
    assert.deepEqual(f.events.filter(e => e.startsWith("add:")), lossStage === "cleanup"
      ? ["add:1:1", "add:2:1"] : ["add:1:1", "add:2:1", "add:2:2"]);
    assert.ok(f.events.indexOf("tunnel-check:1") < f.events.indexOf("login:2"));
    assert.ok(f.events.includes(`reconcile:2:${lossStage === "popup" ? "" : "2"}`));
  });
});

test("a replacement login verifies its own failed tunnel before preparing another session", async () => {
  const f = fixture({ provider: "decodo", candidateFailures: 1, candidateFailureReason: "TUNNEL_CONNECTION_FAILED" });
  await f.run();
  assert.equal(new Set(f.contextSettings.map(settings => settings.proxy.username)).size, 3);
  assert.deepEqual(f.events.filter(e => e.startsWith("tunnel-check:")), ["tunnel-check:2"]);
  assert.deepEqual(f.events.filter(e => e.startsWith("add:")), ["add:1:1", "add:2:3"]);
  assert.ok(f.events.indexOf("tunnel-check:2") < f.events.indexOf("login:3"));
});

test("denied tunnels and rejected site login never acquire another session", async t => {
  for (const tunnelStatus of [403, 407, 429]) await t.test(String(tunnelStatus), async () => {
    const f = fixture({ provider: "dataimpulse", renewSession: false, lossStage: "popup", lossPage: 2,
      lossReason: "TUNNEL_CONNECTION_FAILED", tunnelStatus });
    await assert.rejects(f.run(), { statusCode: tunnelStatus });
    assert.equal(f.contextSettings.length, 1);
    assert.deepEqual(f.events.filter(e => e.startsWith("save:")), ["save:1"]);
  });
  const f = fixture({ initialFailureReason: "SITE_LOGIN_FAILED" });
  await assert.rejects(f.run(), /천유닷컴 로그인 성공 확인에 실패했습니다/);
  assert.equal(f.contextSettings.length, 1);
  assert.equal(f.events.some(e => e.startsWith("clear:")), false);
});

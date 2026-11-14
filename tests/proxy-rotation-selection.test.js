const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createCredentialStore } = require("../electron/credential-store");
const { normalizeProxyCredentials } = require("../src/config");
const { resolveRunConfig } = require("../src/config");
const { createHash } = require("node:crypto");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-rotation-selection-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("proxy-rotation-selection-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  const store = createCredentialStore({ safeStorage, userDataDir: directory, normalizeProxyCredentials });
  return { store, directory };
}

function extractFunctions(source, names, sandbox) {
  const context = vm.createContext(sandbox);
  for (const name of names) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `${name} exists`);
    vm.runInContext(match[0], context);
  }
  return context;
}

test("new collections share provider profiles while account and static connection locks stay effective", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  for (const provider of ["decodo", "dataimpulse"]) {
    const activeRuns = new Map();
    const configs = [];
    let sequence = 0;
    const proxyInput = { cheonyuProxyProvider: provider,
      cheonyuProxyServer: provider === "decodo" ? "http://gate.decodo.com:7000" : "http://gw.dataimpulse.com:823",
      cheonyuProxyUsername: "fixture", cheonyuProxyPassword: "fixture-secret" };
    const context = extractFunctions(source, [
      "createAccountLockKey", "createCollectionAccountKey", "lockCollectionAccount",
      "findActiveRunByAccountKey", "createProxySlotLockKey", "findActiveRunByProxySlotKey", "startCollection",
    ], {
      createHash, resolveRunConfig, activeRuns, runStates: new Map(),
      collectionAccountLocks: new Map(), cartAccountLocks: new Map(), activeCartUpload: null,
      normalizeRunInput: input => input,
      resolveProxyProfileInput: () => proxyInput,
      selectedOutputRoot: "fixture-output", getDefaultOutputRoot: () => "fixture-output", process: { env: {} },
      formatAccountLabel: () => "fixture account", formatProxySlotLockLabel: () => "fixture proxy",
      createRunId: () => `run-${++sequence}`, AbortController,
      createPublicRunRequest: config => ({ collectionKind: config.collectionKind }),
      createPublicFileState: () => ({}), emitState() {}, cloneForRenderer: value => value,
      executeCollection: async (_run, config) => { configs.push(config); },
    });
    const input = { mall: "cheonyu", proxyProfileId: "shared-profile", pageStart: 1, pageEnd: 1 };
    context.startCollection({ ...input, collectionKind: "initial" });
    context.startCollection({ ...input, collectionKind: "longTerm" });
    assert.equal(activeRuns.size, 2, `${provider}: rotating public runs share a gateway`);
    context.startCollection({ ...input, collectionKind: "inventory", accountId: "member-a", accountPw: "fixture" });
    context.startCollection({ ...input, collectionKind: "shortTerm", accountId: "member-b", accountPw: "fixture" });
    assert.equal(activeRuns.size, 4, `${provider}: independent member sessions start concurrently`);
    const sessions = Array.from(activeRuns.values()).slice(2);
    assert.notEqual(sessions[0].proxySlotKey, sessions[1].proxySlotKey);
    assert.throws(() => context.startCollection({ ...input, collectionKind: "inventory", accountId: "member-a", accountPw: "fixture" }), /이미 수집/);
    assert.equal(activeRuns.size, 4);
    assert.equal(context.createProxySlotLockKey(configs[2]), context.createProxySlotLockKey({ ...configs[2] }), "the same sticky connection retains the same lock");
    assert.equal(context.createProxySlotLockKey({ mall: "cheonyu" }), "cheonyu:direct");
    const staticConfig = { mall: "cheonyu", proxy: { server: "http://127.0.0.1:8000", username: "fixture" } };
    assert.ok(context.createProxySlotLockKey(staticConfig));
    assert.equal(context.createProxySlotLockKey(staticConfig), context.createProxySlotLockKey({ ...staticConfig, proxyProfileId: "duplicate-profile" }));
    assert.ok(context.createProxySlotLockKey({ ...configs[0], collectionKind: "", anonymousCollection: false }), "legacy connections retain their lock");
  }
});

test("legacy proxy remains enabled without rewriting saved credentials", (t) => {
  const { store } = fixture(t);
  const data = JSON.stringify({ version: 1, proxies: [{ id: "old", name: "legacy", server: "http://127.0.0.1:8000", username: "fixture", password: "fixture-secret" }], openAiKeys: [] });
  fs.writeFileSync(store.filePath, data);
  assert.equal(store.getProxy("old").includeInRotation, true);
  assert.equal(store.getProxy("old").provider, "other");
  assert.equal(store.getProxies()[0].includeInRotation, true);
  assert.equal(store.getSummary().proxies[0].includeInRotation, true);
  assert.equal(fs.readFileSync(store.filePath, "utf8"), data);
});

test("rotation exclusion persists while blank-password edits retain the existing password", (t) => {
  const { store } = fixture(t);
  const saved = store.saveProxy({ name: "fixture", server: "127.0.0.1:8000", username: "fixture", password: "fixture-secret" });
  const id = saved.selectedId;
  assert.equal(saved.summary.proxies[0].includeInRotation, true);
  const disabled = store.saveProxy({ id, name: "fixture", server: "127.0.0.1:8000", username: "fixture", password: "", includeInRotation: false });
  assert.equal(disabled.summary.proxies[0].includeInRotation, false);
  assert.equal(store.getProxy(id).password, "fixture-secret");
  assert.equal(Object.hasOwn(disabled.summary.proxies[0], "password"), false);
  store.saveProxy({ id, name: "renamed", server: "127.0.0.1:8000", username: "fixture" });
  assert.equal(store.getProxy(id).includeInRotation, false, "older callers must not silently re-enable an excluded proxy");
  assert.throws(() => store.saveProxy({ id, name: "fixture", server: "127.0.0.1:8000", username: "fixture", includeInRotation: "false" }), /포함 여부/);
});

test("provider registration survives reload and resolves through main without exposing its password", t => {
  const { store } = fixture(t);
  const input = { name: "DataImpulse", provider: "dataimpulse", server: "gw.dataimpulse.com:823", username: "fixture__cr.kr", password: "secret" };
  const saved = store.saveProxy(input);
  const profile = store.getSummary().proxies[0];
  assert.equal(profile.provider, "dataimpulse");
  assert.equal(Object.hasOwn(profile, "password"), false);
  store.saveProxy({ ...input, id: saved.selectedId, password: "" });
  assert.equal(store.getProxy(saved.selectedId).password, "secret");
  assert.throws(() => store.saveProxy({ ...input, name: "mismatch", provider: "decodo" }), /Decodo/);
  assert.throws(() => store.saveProxy({ ...input, name: "invalid", provider: "invalid" }), /공급자/);
  assert.throws(() => store.saveProxy({ ...input, id: saved.selectedId, provider: "decodo", server: "gate.decodo.com:7000", password: "" }), /비밀번호/);
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const context = extractFunctions(source, ["resolveProxyProfileInput"], { ensureCredentialStore: () => store });
  const resolved = context.resolveProxyProfileInput(saved.selectedId);
  assert.equal(resolved.cheonyuProxyProvider, "dataimpulse");
  assert.equal(resolved.cheonyuProxyPassword, "secret");
});

test("legacy Decodo and DataImpulse registrations infer providers without rewriting disk", t => {
  const { store } = fixture(t);
  const data = JSON.stringify({ version: 1, proxies: [
    { id: "d", server: "http://gate.decodo.com:7000" },
    { id: "i", server: "http://gw.dataimpulse.com:823" },
  ] });
  fs.writeFileSync(store.filePath, data);
  assert.equal(store.getProxy("d").provider, "decodo");
  assert.equal(store.getProxy("i").provider, "dataimpulse");
  assert.equal(fs.readFileSync(store.filePath, "utf8"), data);
});

test("collection rotation excludes disabled profiles, preserves order, and refuses an excluded starting profile", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  const profiles = [
    { id: "1", name: "one", server: "http://127.0.0.1:8001", includeInRotation: true },
    { id: "2", name: "two", server: "http://127.0.0.1:8002", includeInRotation: false },
    { id: "3", name: "three", server: "http://127.0.0.1:8003" },
  ];
  const context = extractFunctions(source, ["resolveProxyProfileInput", "resolveProxyRotationInput"], {
    ensureCredentialStore: () => ({
      getProxy: (id) => profiles.find((profile) => profile.id === id),
      getProxies: () => profiles,
    }),
  });
  assert.deepEqual(Array.from(context.resolveProxyRotationInput("3").cheonyuProxyRotation, (profile) => profile.profileId), ["3", "1"]);
  assert.throws(() => context.resolveProxyRotationInput("2"), /제외/);
  assert.equal(context.resolveProxyProfileInput("2").cheonyuProxyProfileId, "2", "explicit test/cart access remains possible");
  assert.equal(context.resolveProxyRotationInput("").cheonyuProxyRotation, undefined);
});

test("proxy editor sends rotation inclusion without sending a blank password", async () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const elements = {
    proxyFormTitle: {}, saveProxyProfileButton: {}, proxyRegisterName: { value: "fixture", focus() {} },
    proxyRegisterServer: { value: "127.0.0.1:8000" }, proxyRegisterUsername: { value: "fixture" },
    proxyRegisterPassword: { value: "" }, proxyIncludeInRotation: { checked: true },
    proxyRegisterProvider: { value: "other" }, proxyProviderHelp: {},
    cheonyuProxyProfileSelect: { value: "fixture-id" },
  };
  let saved;
  const profile = { id: "fixture-id", name: "fixture", server: "127.0.0.1:8000", username: "fixture", includeInRotation: false };
  const context = extractFunctions(app, ["updateProxyProviderForm", "resetProxyProfileForm", "editProxyProfile", "saveProxyProfile"], {
    elements, state: { editingProxyProfileId: "" }, getProxyProfile: () => profile,
    clearError() {}, clearSuccess() {}, setManagerMessage() {}, normalizeText: (value) => value.trim(),
    applyCredentialProfiles() {}, window: { collectorApp: { async saveProxyProfile(value) { saved = value; return { summary: {} }; } } },
  });
  context.editProxyProfile("fixture-id");
  assert.equal(elements.proxyIncludeInRotation.checked, false);
  await context.saveProxyProfile();
  assert.equal(saved.includeInRotation, false);
  assert.equal(saved.provider, "other");
  assert.equal(Object.hasOwn(saved, "password"), false);
  assert.equal(elements.proxyIncludeInRotation.checked, true, "new profile defaults to included after reset");
});

test("excluding a repeat plan's starting proxy cancels that reservation without changing other plans", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const state = {
    repeatPlans: new Map([
      ["excluded-run", { basePayload: { proxyProfileId: "excluded" } }],
      ["included-run", { basePayload: { proxyProfileId: "included" } }],
    ]),
    repeatTimers: new Map([["excluded-run", 1], ["included-run", 2]]),
    repeatLaunching: new Set(),
  };
  const canceled = [];
  const context = extractFunctions(app, ["clearRepeatPlan", "applyCredentialProfiles"], {
    state, window: { clearTimeout: (id) => canceled.push(id) },
    renderProxyProfileSelects() {}, renderOpenAiProfileSelect() {}, renderProxyProfileList() {}, renderOpenAiProfileList() {},
    connectionTestView: { setProxies(profiles) { assert.equal(profiles.length, 2, "excluded proxies remain manually testable"); } },
  });
  context.applyCredentialProfiles({ proxies: [
    { id: "excluded", includeInRotation: false }, { id: "included", includeInRotation: true },
  ] });
  assert.equal(state.repeatPlans.has("excluded-run"), false);
  assert.equal(state.repeatPlans.has("included-run"), true);
  assert.deepEqual(canceled, [1]);
});

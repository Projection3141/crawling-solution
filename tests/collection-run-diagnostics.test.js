const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { classifyCollectionFailure } = require("../src/utils/collection-failure");

const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
const start = mainSource.indexOf("async function executeCollection(");
const source = mainSource.slice(start, mainSource.indexOf("/** 새 수집 작업", start));

function fixture(collect, { loggerError = null } = {}) {
  const run = { id: "fixture-run", startedAtMs: Date.now(), controller: new AbortController(), accountKey: "account", openAi: { apiKey: "test-api-secret" } };
  const runStates = new Map([[run.id, { progress: {}, files: {}, status: "running" }]]);
  const activeRuns = new Map([[run.id, run]]);
  const runResults = new Map();
  const collectionAccountLocks = new Map([[run.accountKey, {}]]);
  const events = [];
  let options;
  let wrapped = false;
  let flushed = false;
  let notified = 0;
  const sandbox = {
    path, console, Date, classifyCollectionFailure,
    environmentInfo: { userDataDir: path.resolve("fixture-user-data") },
    app: { getPath() { throw new Error("should use loaded environment user directory"); } },
    activeRuns, runStates, runResults, collectionAccountLocks,
    createCollectionDiagnostics(value) {
      options = value;
      return {
        filePath: path.join(value.directory, `${value.runId}.jsonl`),
        error: loggerError,
        async run(task) { wrapped = true; return task(); },
        record(event, details) { events.push({ event, details }); },
        async flush() { flushed = true; },
      };
    },
    runCollection: collect,
    updateRunState(id, patch) { runStates.set(id, { ...runStates.get(id), ...patch }); },
    updateRunProgress(id, progress) { const state = runStates.get(id); state.progress = { ...state.progress, ...progress }; },
    createPublicFileState(files) { return { details: { available: Boolean(files?.details) } }; },
    formatMs: String,
    getErrorMessage: (error) => error.message,
    isAbortError: (error) => error.name === "AbortError",
    productUploadScheduler: { async notifyCollectionCompleted() { notified++; } },
    emitState() {}, maybeQuitAfterWork() {}, latestCompletedRunId: "",
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    run: () => sandbox.executeCollection(run, {
      mall: "cheonyu", accountId: "test-account", accountPw: "test-password",
      proxy: { username: "proxy-user", password: "proxy-password" },
      proxyRotation: [{ proxy: { username: "other-user", password: "other-password" } }],
    }),
    state: () => runStates.get(run.id),
    inspect: () => ({ options, wrapped, flushed, notified, events, activeRuns, collectionAccountLocks, runResults }),
  };
}

test("installed-run failure preserves durable page checkpoint and diagnostic path", async () => {
  const directory = path.resolve("fixture-results");
  const checkpoint = { phase: "detail", pageStart: 1, pageEnd: 10, savedThroughPage: 3, savedPages: [1, 2, 3], outputDirectory: directory, files: { details: path.join(directory, "details.csv") } };
  const app = fixture(async (_, { onProgress }) => {
    onProgress({ savedCheckpoint: checkpoint, stage: "detail-checkpoint" });
    onProgress({ stage: "detail", currentPage: 4 });
    throw new Error("fixture page 4 failure");
  });
  await app.run();
  const state = app.state();
  const info = app.inspect();
  assert.equal(state.status, "failed");
  assert.equal(state.outputDirectory, directory);
  assert.equal(state.files.details.available, true);
  assert.equal(state.progress.savedCheckpoint.savedThroughPage, 3);
  assert.equal(state.error, "fixture page 4 failure");
  assert.equal(path.dirname(state.diagnosticLogPath), path.join(path.resolve("fixture-user-data"), "collection-diagnostics"));
  assert.equal(info.wrapped, true);
  assert.equal(info.flushed, true);
  assert.equal(info.notified, 0);
  assert.equal(info.activeRuns.size, 0);
  assert.equal(info.collectionAccountLocks.size, 0);
  assert.equal(info.events.at(-1).event, "run.failed");
  assert.ok(info.options.secrets.includes("other-password"));
  assert.ok(info.options.secrets.includes("test-api-secret"));
});

test("failure before checkpoint does not claim saved results; logging error is nonfatal", async () => {
  const app = fixture(async () => { throw new Error("login failed"); }, { loggerError: new Error("disk denied") });
  await app.run();
  assert.equal(app.state().status, "failed");
  assert.equal(app.state().outputDirectory, "");
  assert.equal(app.state().files.details.available, false);
  assert.equal(app.state().progress.savedCheckpoint, undefined);
  assert.match(app.state().diagnosticLogError, /저장하지 못/);
  assert.equal(app.inspect().activeRuns.size, 0);
});

test("a raw list checkpoint after an archived cycle preserves the completed result file on failure", async () => {
  const directory = path.resolve("fixture-mixed-checkpoints");
  const resultFile = path.join(directory, "result.json");
  const listFile = path.join(directory, "list-checkpoint.json");
  const app = fixture(async (_, { onProgress }) => {
    onProgress({ stage: "cycle-archived", savedCheckpoint: {
      phase: "general", pageStart: 1, pageEnd: 30,
      savedThroughPage: 14, savedPages: Array.from({ length: 14 }, (_, index) => index + 1),
      outputDirectory: directory, files: { result: resultFile },
    } });
    onProgress({ stage: "list-page-saved", savedCheckpoint: {
      phase: "list", dataKind: "raw-list", inventoryComplete: false, detailComplete: false,
      pageStart: 1, pageEnd: 30, savedThroughPage: 15,
      savedPages: Array.from({ length: 15 }, (_, index) => index + 1),
      outputDirectory: directory, files: { listCheckpoint: listFile },
    } });
    throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at page 16");
  });
  await app.run();
  const state = app.state();
  const savedResult = app.inspect().runResults.get("fixture-run");
  assert.equal(state.status, "failed");
  assert.equal(state.outputDirectory, directory);
  assert.equal(savedResult.directory, directory);
  assert.equal(savedResult.files.result, resultFile, "new raw-only saves must retain the earlier final result path");
  assert.equal(savedResult.files.listCheckpoint, listFile);
  assert.equal(state.progress.savedCheckpoint.phase, "list");
  assert.equal(state.progress.savedCheckpoint.savedThroughPage, 15);
  assert.equal(state.progress.savedCheckpoint.inventoryComplete, false);
  assert.equal(state.files.details.available, false, "raw list data must not advertise completed detail CSV");
  assert.equal(app.inspect().notified, 0, "partial results must not trigger a successful collection upload");
});

test("successful run retains final outputs and existing upload notification", async () => {
  const directory = path.resolve("final-results");
  const app = fixture(async () => ({ files: { inventory: path.join(directory, "inventory.csv"), details: path.join(directory, "details.csv") }, payload: { summary: {} } }));
  await app.run();
  assert.equal(app.state().status, "completed");
  assert.equal(app.state().outputDirectory, directory);
  assert.equal(app.inspect().notified, 1);
  assert.equal(app.inspect().events.at(-1).event, "run.completed");
  assert.equal(app.inspect().flushed, true);
});

test("site access and tunnel failures reach the renderer with an automatic-repeat stop reason", async () => {
  for (const error of [
    Object.assign(new Error("HTTP 403"), { code: "SITE_ACCESS_BLOCKED", statusCode: 403, retryable: false }),
    new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED"),
  ]) {
    const app = fixture(async () => { throw error; });
    await app.run();
    assert.equal(app.state().status, "failed");
    assert.equal(app.state().failure.stopAutoRepeat, true);
    assert.match(app.state().failure.message, /자동 반복을 중단/);
    assert.equal(app.inspect().events.at(-1).details.failure.stopAutoRepeat, true);
    assert.equal(app.inspect().notified, 0);
  }
});

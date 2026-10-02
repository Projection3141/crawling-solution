const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createShippingScheduler } = require("../src/shipping-scheduler");

function schedulerFixture(t, dependencies = {}) {
  const events = [];
  let finishRun;
  const scheduler = createShippingScheduler({
    profileDirectory: path.join(__dirname, "unused-kse-profile"),
    uploadProducts: async () => ({ archiveCount: 1 }),
    collectShipping: async () => ({ count: 1 }),
    getAccount: () => null,
    ...dependencies,
    onStateChanged: (state) => {
      events.push(state);
      if (state.lastFinishedAt && finishRun) {
        const resolve = finishRun;
        finishRun = null;
        resolve();
      }
    },
  });
  t.after(() => scheduler.stop());
  return {
    scheduler,
    events,
    async runFrom(trigger) {
      const completed = new Promise((resolve) => { finishRun = resolve; });
      trigger();
      await completed;
    },
  };
}

test("상품 전송이 실패해도 운송장을 수집하고 선택 계정을 전달하며 오류를 유지한다", async (t) => {
  const account = { id: "shipping-a", loginId: "fixture-login", password: "fixture-password", authRevision: "1" };
  const calls = [];
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => { calls.push("products"); throw new Error("상품 서버 오류"); },
    getAccount: async () => { calls.push("account"); return account; },
    collectShipping: async (profileDirectory, options) => {
      calls.push("shipping");
      assert.equal(profileDirectory, path.resolve(__dirname, "unused-kse-profile"));
      assert.equal(options.uploadArchive, false);
      assert.equal(options.account, account);
      return { count: 7 };
    },
  });
  await fixture.runFrom(() => fixture.scheduler.setEnabled(true));
  assert.deepEqual(calls, ["products", "account", "shipping"]);
  const state = fixture.scheduler.getState();
  assert.equal(state.running, false);
  assert.equal(state.lastRecordCount, 7);
  assert.match(state.lastError, /상품 전송: 상품 서버 오류/);
  assert.equal(state.lastSuccessAt, null);
  assert.ok(state.lastFinishedAt);
  assert.ok(state.nextRunAt);
  assert.ok(fixture.events.some((event) => event.lastError === state.lastError));
  // 마지막 후속 상태 이벤트가 오류 변수를 지우지 않는지 확인한다.
  assert.equal(fixture.scheduler.getState().lastError, state.lastError);
});

test("운송장 수집 실패는 이미 완료된 상품 전송을 되돌리지 않고 오류를 보존한다", async (t) => {
  let productCalls = 0;
  let shippingCalls = 0;
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => { productCalls += 1; return { archiveCount: 15 }; },
    collectShipping: async (profileDirectory, { account, uploadArchive }) => {
      shippingCalls += 1;
      assert.equal(account, null);
      assert.equal(uploadArchive, false);
      throw new Error("운송장 로그인 실패");
    },
  });
  await fixture.runFrom(() => fixture.scheduler.setEnabled(true));
  assert.equal(productCalls, 1);
  assert.equal(shippingCalls, 1);
  assert.match(fixture.scheduler.getState().lastError, /운송장 전송: 운송장 로그인 실패/);
  assert.equal(fixture.scheduler.getState().running, false);
});

test("계정 조회가 실패하면 운송 브라우저를 시작하지 않고 상품 전송은 유지한다", async (t) => {
  let productCalls = 0;
  let shippingCalls = 0;
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => { productCalls += 1; return {}; },
    getAccount: () => { throw new Error("선택 계정 읽기 실패"); },
    collectShipping: async () => { shippingCalls += 1; return { count: 0 }; },
  });
  await fixture.runFrom(() => fixture.scheduler.setEnabled(true));
  assert.equal(productCalls, 1);
  assert.equal(shippingCalls, 0);
  assert.match(fixture.scheduler.getState().lastError, /선택 계정 읽기 실패/);
});

test("같은 실행의 상품·운송 오류를 모두 표시하고 이후 성공 시 오류를 해제한다", async (t) => {
  let fail = true;
  const seenAccounts = [];
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => {
      if (fail) throw new Error("상품 오류");
      return { archiveCount: 3 };
    },
    getAccount: () => ({ id: fail ? "account-1" : "account-2" }),
    collectShipping: async (profileDirectory, { account }) => {
      seenAccounts.push(account.id);
      if (fail) throw new Error("운송 오류");
      return { count: 4 };
    },
  });
  await fixture.runFrom(() => fixture.scheduler.setEnabled(true));
  assert.match(fixture.scheduler.getState().lastError, /상품 전송: 상품 오류/);
  assert.match(fixture.scheduler.getState().lastError, /운송장 전송: 운송 오류/);
  fail = false;
  await fixture.scheduler.runOnce();
  const state = fixture.scheduler.getState();
  assert.equal(state.lastError, "");
  assert.equal(state.lastRecordCount, 4);
  assert.ok(state.lastSuccessAt);
  assert.deepEqual(seenAccounts, ["account-1", "account-2"]);
});

test("운송장 OFF에서는 계정 조회와 운송 수집을 호출하지 않는다", async (t) => {
  let productCalls = 0;
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => { productCalls += 1; return {}; },
    getAccount: () => { throw new Error("OFF 상태에서 계정을 읽으면 안 됩니다."); },
    collectShipping: async () => { throw new Error("OFF 상태에서 운송장을 수집하면 안 됩니다."); },
  });
  await fixture.scheduler.runOnce();
  assert.equal(productCalls, 1);
  assert.equal(fixture.scheduler.getState().lastError, "");
});

test("stop은 예약 타이머를 해제하고 명시적 다음 실행도 막는다", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let productCalls = 0;
  const fixture = schedulerFixture(t, {
    uploadProducts: async () => { productCalls += 1; return {}; },
  });
  await fixture.scheduler.runOnce();
  assert.equal(productCalls, 1);
  fixture.scheduler.stop();
  t.mock.timers.tick(60 * 60 * 1000 + 1);
  await fixture.scheduler.runOnce();
  assert.equal(productCalls, 1);
});

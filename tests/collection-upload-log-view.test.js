const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../public/collection-upload-log-view.js"), "utf8");

// 화면 코드가 사용하는 DOM 동작만 제공한다. HTML 문자열 삽입은 허용하지 않는다.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    this.ownText = "";
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map(child => child.textContent).join("");
  }
  set innerHTML(_value) {
    assert.fail("로그 데이터는 HTML 대신 textContent로 표시해야 한다.");
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.ownText = "";
    this.children = [...nodes];
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  async click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") || []) {
      await listener({ currentTarget: this });
    }
    // 클릭 핸들러의 void 비동기 조회도 모의 응답을 화면에 반영할 수 있게 한다.
    await new Promise(setImmediate);
  }
}

function fixture(api) {
  const list = new Element("div");
  const info = new Element("span");
  const previous = new Element("button");
  const next = new Element("button");
  const folder = new Element("button");
  const selectors = {
    "#collectionUploadLogList": list,
    "#collectionUploadLogPageInfo": info,
    "#collectionUploadLogPreviousButton": previous,
    "#collectionUploadLogNextButton": next,
    "#openCollectionUploadLogDirectoryButton": folder,
  };
  const document = {
    querySelector: selector => {
      assert.ok(Object.hasOwn(selectors, selector), `Unexpected selector: ${selector}`);
      return selectors[selector];
    },
    createElement: tagName => new Element(tagName),
  };
  const window = {};
  vm.runInNewContext(source, { window }, { filename: "collection-upload-log-view.js" });
  const errors = [];
  let currentApi = api;
  let apiReads = 0;
  const view = window.createCollectionUploadLogView({
    document,
    getApi: () => { apiReads += 1; return currentApi; },
    showError: message => errors.push(message),
  });
  return {
    view, list, info, previous, next, folder, errors,
    getApiReads: () => apiReads,
    setApi: value => { currentApi = value; },
  };
}

function assertElement(node, tagName, className, text) {
  assert.equal(node.tagName, tagName);
  assert.equal(node.className, className);
  assert.equal(node.textContent, text);
}

test("화면 생성·이벤트 연결은 조회하지 않고 load가 빈 목록과 첫 페이지를 표시한다", async () => {
  const calls = [];
  const f = fixture({ getCollectionUploadLogs: async page => { calls.push(page); return null; } });
  f.view.bindEvents();
  assert.equal(f.getApiReads(), 0);
  assert.deepEqual(calls, []);
  await f.view.load();
  assert.deepEqual(calls, [1]);
  assert.equal(f.list.children.length, 1);
  assertElement(f.list.children[0], "p", "upload-log-empty", "아직 저장된 수집정보 전송 로그가 없습니다.");
  assert.equal(f.info.textContent, "1 / 1 · 총 0건");
  assert.equal(f.previous.disabled, true);
  assert.equal(f.next.disabled, true);
});

test("성공·실패 카드의 구조·문구·KST 시각과 로그 문자열의 텍스트 표시를 유지한다", async () => {
  const unsafe = '<img src=x onerror="alert(1)">';
  const f = fixture({ getCollectionUploadLogs: async () => ({
    page: 1, totalPages: 1, totalCount: 3,
    items: [
      { type: "아카이브", sentAt: "2026-10-29T00:04:05.000Z", success: true,
        itemCount: 1234, status: 200, method: "GET", dateDirectory: "20261029", fileName: "090405.json",
        sampleProductIds: ["00123", "456"] },
      { type: "운송장", sentAt: "invalid-date", success: false, itemCount: null, status: null,
        dateDirectory: "20261028", fileName: "failed.json", sampleProductIds: [unsafe], error: unsafe },
      { success: false, sentAt: null, itemCount: 0, status: 503,
        dateDirectory: "20261027", fileName: "empty.json" },
    ],
  }) });
  await f.view.load();
  const [success, failure, empty] = f.list.children;
  assert.equal(f.list.children.length, 3);
  for (const card of f.list.children) {
    assert.equal(card.tagName, "article");
    assert.equal(card.className, "upload-log-item");
    assert.equal(card.children[0].tagName, "div");
    assert.equal(card.children[0].className, "upload-log-item-heading");
  }
  assertElement(success.children[0].children[0], "strong", "", "아카이브 · 2026. 10. 29. 09:04:05");
  assertElement(success.children[0].children[1], "span", "upload-log-status success", "요청 성공");
  assertElement(success.children[1], "p", "upload-log-details", "GET · 데이터 1,234개 · HTTP 200 · 20261029/090405.json");
  assertElement(success.children[2], "p", "upload-log-sample", "데이터 ID 예시: 00123, 456");
  assert.equal(success.children.length, 3);
  assertElement(failure.children[0].children[0], "strong", "", "운송장 · invalid-date");
  assertElement(failure.children[0].children[1], "span", "upload-log-status error", "요청 실패");
  assertElement(failure.children[1], "p", "upload-log-details", "POST · 데이터 확인 불가 · 응답 없음 · 20261028/failed.json");
  assertElement(failure.children[2], "p", "upload-log-sample", `데이터 ID 예시: ${unsafe}`);
  assertElement(failure.children[3], "p", "upload-log-error", unsafe);
  assert.equal(failure.children.length, 4);
  assertElement(empty.children[0].children[0], "strong", "", "수집정보 · 시각 확인 불가");
  assertElement(empty.children[1], "p", "upload-log-details", "POST · 데이터 0개 · HTTP 503 · 20261027/empty.json");
  assert.equal(empty.children.length, 2);
  assert.equal(f.info.textContent, "1 / 1 · 총 3건");
});

test("이전·다음은 응답의 현재 페이지를 기준으로 조회하고 첫·끝 페이지 버튼을 비활성화한다", async () => {
  const calls = [];
  const f = fixture({ getCollectionUploadLogs: async requestedPage => {
    calls.push(requestedPage);
    return { page: Math.min(requestedPage, 3), totalPages: 3, totalCount: 12, items: [] };
  } });
  f.view.bindEvents();
  await f.view.load(1);
  await f.previous.click();
  assert.deepEqual(calls, [1]);
  await f.next.click();
  assert.equal(f.info.textContent, "2 / 3 · 총 12건");
  assert.equal(f.previous.disabled, false);
  assert.equal(f.next.disabled, false);
  await f.view.load(999);
  assert.equal(f.info.textContent, "3 / 3 · 총 12건");
  assert.equal(f.next.disabled, true);
  await f.next.click();
  await f.previous.click();
  assert.deepEqual(calls, [1, 2, 999, 2]);
  assert.equal(f.info.textContent, "2 / 3 · 총 12건");
});

test("조회 실패는 목록의 오류 문구만 바꾸고 마지막 페이지와 이동 상태를 유지한다", async () => {
  const calls = [];
  let fail = false;
  const f = fixture({ getCollectionUploadLogs: async page => {
    calls.push(page);
    if (fail) throw new Error("fixture unavailable");
    return { page, totalPages: 3, totalCount: 12, items: [] };
  } });
  f.view.bindEvents();
  await f.view.load(2);
  fail = true;
  await f.view.load(1);
  assert.equal(f.list.textContent, "전송 로그를 불러오지 못했습니다: fixture unavailable");
  assert.equal(f.list.children.length, 0);
  assert.equal(f.info.textContent, "2 / 3 · 총 12건");
  assert.equal(f.previous.disabled, false);
  assert.equal(f.next.disabled, false);
  assert.deepEqual(f.errors, []);
  fail = false;
  await f.next.click();
  assert.deepEqual(calls, [2, 1, 3]);
  assert.equal(f.info.textContent, "3 / 3 · 총 12건");
});

test("폴더 열기는 최신 API를 호출하며 실패만 공통 오류 표시로 전달한다", async () => {
  const f = fixture(undefined);
  f.view.bindEvents();
  assert.equal(f.getApiReads(), 0);
  let opened = 0;
  f.setApi({ openCollectionUploadLogDirectory: async () => { opened += 1; } });
  await f.folder.click();
  assert.equal(opened, 1);
  assert.deepEqual(f.errors, []);
  f.setApi({ openCollectionUploadLogDirectory: async () => { throw new Error("fixture denied"); } });
  await f.folder.click();
  assert.deepEqual(f.errors, ["전송 로그 폴더를 열지 못했습니다: fixture denied"]);
  assert.equal(f.getApiReads(), 2);
});

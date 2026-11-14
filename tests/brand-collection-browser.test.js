// 외부 계정/서버에 접속하지 않고 실제 Chromium으로 다운로드와 화면 동작을 검증한다.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createBrandCollector } = require('../electron/brand-collector');
const { load } = require('cheerio');

const origin = 'https://www.cheonyu.com';
const listing = `<a href='/member/logout.html'>로그아웃</a><div class='brand-list-view'>${['가필드', '건담', '그린', '거절'].map((name, i) => `<a href='/brand/brandView.html?s3=${i + 1}'><span>${name}</span></a>`).join('')}</div>`;

test('실제 브라우저: 브랜드 함수 → iframe 다운로드 → 파일 저장, 오류 시 중단 및 이력 보존', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = []; let logins = 0; let release; let held = false;
  let denial = { body: '<script>alert("하루 10회 제한");</script>' };
  let popupLimited = false;
  const collector = createBrandCollector({ directory: root,
    login: async (page, _config, _signal, options) => {
      logins++; assert.equal(options.verificationTarget, 'brands');
      if (held) await new Promise(resolve => { release = resolve; });
      await page.route(`${origin}/**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/brand/brand.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: listing });
        if (url.pathname === '/brand/brandView.html') {
          const id = url.searchParams.get('s3');
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id='popContent'></div><iframe id='Hiddenframe'></iframe><script>
            window.fnViewPopup = function(type, params) {
              if (${popupLimited && id === '4'}) { alert('오늘 다운로드 한도를 초과했습니다.'); return; }
              document.querySelector('#popContent').innerHTML = '<div class="smartstore_popup"><a class="ns-btn-info">1.무료이미지 상품정보 Excel</a><a class="ns-btn-info">1.무료+유료이미지 상품정보 Excel</a></div>';
            };
            window.fnSmartsotreDownloadBrand = function(opt) { document.querySelector('#Hiddenframe').src = '/_Engine/sfarm.html?s3=${id}&inPonline=' + opt; };
          </script>` });
        }
        if (url.pathname === '/_Engine/sfarm.html') {
          requests.push(url.search);
          if (url.searchParams.get('s3') === '4') return route.fulfill({ contentType: 'text/html; charset=utf-8', ...denial });
          return route.fulfill({ headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': 'attachment; filename="brand.xls"' }, body: '<html><table><tr><td>브랜드 상품</td></tr></table></html>' });
        }
        return route.abort();
      });
      await page.goto(`${origin}/brand/brand.html`);
    },
  });
  t.after(() => collector.close());
  const account = { accountId: 'fixture', accountPw: 'fixture', showBrowser: false };
  const list = await collector.refresh(account); assert.equal(list.brands.length, 4);
  assert.equal(list.used, 0);
  const result = await collector.collect({ ...account, brandIds: ['1', '1', '2'], variant: 'all' });
  assert.equal(result.results.length, 2, JSON.stringify(result.results)); assert.equal(result.state.used, 2);
  for (const item of result.results) { assert.equal(item.success, true, item.error); assert.ok(fs.statSync(item.filePath).size > 0); }
  assert.ok(requests.every(query => query.endsWith('inPonline=')));
  const free = await collector.collect({ ...account, brandIds: ['1'], variant: 'free' });
  assert.equal(free.results[0].success, true); assert.ok(requests.at(-1).endsWith('inPonline=1'));
  assert.notEqual(free.results[0].filePath, result.results[0].filePath);
  const failed = await collector.collect({ ...account, brandIds: ['4', '3'], variant: 'all' });
  assert.equal(failed.results[0].success, false); assert.match(failed.results[0].error, /하루 10회/);
  assert.equal(failed.state.recent[0].siteLimited, true);
  assert.equal(failed.skipped[0].id, '3'); assert.equal(failed.state.used, 4);
  assert.equal(failed.state.brands.filter(b => b.lastCollectedAt).length, 2);
  assert.equal(requests.length, 4);
  const oldLogins = logins;
  await assert.rejects(collector.collect({ ...account, brandIds: ['unknown'] }), /목록에 없는/);
  assert.equal(logins, oldLogins);
  held = true;
  const pending = collector.refresh(account);
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(collector.refresh(account), /진행 중/);
  release(); await pending;
  assert.equal(collector.snapshot().used, 4);
  held = false;
  for (denial of [
    { body: '<p>1일 10개까지만 다운로드 가능합니다.</p>' },
    { status: 429, body: '' },
    { body: '<script>alert("로그인이 필요합니다.")</script>' },
  ]) {
    const rejected = await collector.collect({ ...account, brandIds: ['4', '3'] });
    const isLimit = !denial.body.includes('로그인');
    assert.equal(Boolean(rejected.results[0].siteLimited), isLimit);
    assert.equal(Boolean(collector.snapshot().recent[0].siteLimited), isLimit);
    assert.equal(rejected.skipped[0].id, '3');
  }
  popupLimited = true;
  const before = collector.snapshot().used;
  const popup = await collector.collect({ ...account, brandIds: ['4'] });
  assert.equal(popup.state.recent[0].siteLimited, true);
  assert.equal(popup.state.used, before);
  assert.equal(requests.length, before);
});

test('브랜드 화면: 마지막 드롭다운만 펼치고 이름 선택, 복수 수집, 성공 날짜/경로 표시', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const $ = load(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  const section = $('section[aria-label="브랜드 수집"]').toString();
  await page.setContent(`<select id='connectionTestProxy'><option value=''>직접</option></select><select id='connectionTestBrowserMode'><option value='hide'>숨김</option></select>${section}`);
  await page.addScriptTag({ path: path.join(__dirname, '../public/brand-collection-view.js') });
  await page.evaluate(() => {
    const data = { brands: [{ id: '1', name: '가필드' }, { id: '2', name: '건담', lastCollectedAt: '2026-11-01T10:00:00Z' }], recent: [], used: 0, remaining: 10, limit: 10 };
    data.recent.push({ name: '거절', status: 'failed', siteLimited: true, error: '천유 다운로드 제한 · 하루 10회 제한', startedAt: '2026-11-01T10:00:00Z', variant: 'free' });
    window.requests = [];
    const api = { getBrands: async () => data, refreshBrands: async () => data, openBrandDirectory: async () => {}, collectBrands: async input => {
      window.requests.push(input);
      const results = input.brandIds.map(id => {
        const brand = data.brands.find(b => b.id === id); brand.lastCollectedAt = '2026-11-02T10:00:00Z';
        data.recent.push({ name: brand.name, status: 'success', variant: 'all', completedAt: brand.lastCollectedAt, filePath: `C:\\fixture\\${brand.name}.xls` });
        return { brandId: id, name: brand.name, success: true };
      });
      data.used += results.length; data.remaining -= results.length;
      return { results, skipped: [], state: data };
    } };
    window.createBrandCollectionView({ document, getApi: () => api, getAccounts: () => [{ id: 'account', name: '천유 테스트', loginId: 'fixture', password: 'fixture' }] }).bindEvents();
  });
  await page.locator('#brandAccount').selectOption('account');
  assert.match(await page.locator('#brandResults h4').innerText(), /거절 · 천유 다운로드 제한/);
  await page.locator('#brandListAll').click();
  await page.locator('#brandList').getByRole('button', { name: '가필드', exact: true }).click();
  await page.locator('#brandListCollected').click();
  assert.equal(await page.locator('#brandListAll').getAttribute('aria-expanded'), 'false');
  assert.match(await page.locator('#brandList').innerText(), /마지막 수집/);
  await page.locator('#brandList').getByRole('button', { name: '건담', exact: true }).click();
  assert.equal(await page.locator('#brandNames').inputValue(), '가필드\n건담');
  const variant = page.locator('#brandCollectForm').getByLabel('상품 이미지 종류');
  assert.equal(await variant.inputValue(), 'free');
  await variant.selectOption({ label: '무료+유료' });
  await page.locator('#brandCollect').click();
  await page.waitForFunction(() => document.querySelector('#brandStatus').textContent.includes('수집 성공 2개'));
  assert.deepEqual(await page.evaluate(() => window.requests[0].brandIds), ['1', '2']);
  assert.equal(await page.evaluate(() => window.requests[0].variant), 'all');
  assert.equal(await page.locator('#brandNames').inputValue(), '');
  assert.match(await page.locator('#brandResults').innerText(), /파일 저장 완료/);
  await page.locator('#brandListPending').click();
  assert.match(await page.locator('#brandList').innerText(), /해당 브랜드가 없습니다/);
});

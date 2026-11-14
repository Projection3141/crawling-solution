process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { load } = require('cheerio');
const { createCommerceCollector } = require('../electron/commerce-collector');

const origin = 'https://www.cheonyu.com';
const list = '/commersAPI/cyproduct.html';
const login = '/commersAPI/login.html';
const credentials = { accountId: 'commerce_fixture', password: 'test-secret', count: 3 };

function productList(number, ids, next) {
  const columns = ['col-w-1', 'col-w-2', 'col-w-3', 'col-option', 'col-stock', 'col-price', 'col-discount', 'col-store-price'];
  return '<table id="productTable" class="product-list-table"><thead><tr>' +
    columns.map(name => '<th class="' + name + '"></th>').join('') + '</tr></thead><tbody>' +
    ids.map(id => '<tr><td><input type="checkbox"></td><td>' + id + '</td><td><img src="/img/' + id + '.jpg"><span>[미피]</span> 스티커 ' + id +
      '</td><td>블루</td><td>재고안정</td><td>6,000원</td><td><div>1개+ 40% 3,600원</div><div>4개+ 45% 3,300원</div></td><td><input value="5,400"><span>+10%</span></td></tr>').join('') +
    '</tbody></table><nav class="pagination-wrapper"><li class="page-item active">' + number + '</li>' +
    (next ? '<a href="?page=' + (number + 1) + '&listSize=500">›</a>' : '') + '</nav>';
}

test('커머스 전용 로그인, 페이지 이동·중복 제거·요청 개수, 저장 분리, 로그인 오류와 부분 결과', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-products-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let failSecondPage = false;
  const visited = [];
  const progress = [];
  const browserType = { async launch(options) {
    const browser = await chromium.launch(options);
    return {
      close: () => browser.close(),
      async newContext(opts) {
        const context = await browser.newContext(opts);
        let authorized = false;
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          const respond = body => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
          if (url.pathname === login) return respond('<form id="frm"><input id="username"><input type="password" id="userpassword"><button type="button" id="btLogin">로그인</button></form><script>btLogin.onclick=async()=>{const r=await fetch("/auth",{method:"POST",body:JSON.stringify([username.value,userpassword.value])}); if(r.ok) location.replace("cyproduct.html");else alert("계정 정보 확인");};</script>');
          if (url.pathname === '/auth') {
            authorized = route.request().postData() === JSON.stringify([credentials.accountId, credentials.password]);
            return route.fulfill({ status: authorized ? 200 : 401, body: '' });
          }
          assert.equal(url.pathname, list, '이미지를 포함한 별도 네트워크 요청이 발생하면 안 된다.');
          if (!authorized) return respond('<script>location.replace("/commersAPI/login.html");</script>');
          if (!url.search) return respond('로그인 성공');
          assert.equal(url.searchParams.get('listSize'), '500');
          const n = Number(url.searchParams.get('page'));
          visited.push(n);
          if (failSecondPage && n === 2) return route.fulfill({ status: 403, body: '권한 오류' });
          return respond(productList(n, n === 1 ? ['001', '002'] : ['002', '003', '004'], n === 1));
        });
        return context;
      },
    };
  } };
  const collector = createCommerceCollector({ directory: () => directory, browserType, onProgress: value => progress.push(value) });
  const first = collector.run(credentials);
  await assert.rejects(collector.run(credentials), /진행 중/);
  const result = await first;
  assert.equal(result.stopReason, 'targetReached');
  assert.deepEqual(visited, [1, 2]);
  assert.equal(progress.at(-1).collected, 2);
  const text = await fs.readFile(result.filePath, 'utf8');
  assert.ok(!text.includes(credentials.accountId) && !text.includes(credentials.password));
  const data = JSON.parse(text);
  assert.deepEqual(data.products.map(item => item.productNumber), ['001', '002', '003']);
  assert.deepEqual(data.products[0], {
    productNumber: '001', productInfo: '[미피] 스티커 001', imageUrls: [origin + '/img/001.jpg'],
    options: '블루', stock: '재고안정', consumerPrice: '6,000원',
    supplyPrice: '1개+ 40% 3,600원\n4개+ 45% 3,300원', storeSalePrice: '5,400',
  });
  assert.equal((await collector.run({ ...credentials, count: 1 })).pagesRead, 1);
  const exhausted = await collector.run({ ...credentials, count: 9 });
  assert.equal(exhausted.stopReason, 'endOfList'); assert.equal(exhausted.collected, 4);
  failSecondPage = true;
  const partial = await collector.run(credentials);
  assert.equal(partial.stopReason, 'partialError'); assert.equal(partial.collected, 2);
  assert.match(partial.detail, /2페이지.*403/);
  const files = await fs.readdir(directory);
  await assert.rejects(collector.run({ ...credentials, password: 'wrong-secret' }), /커머스 로그인에 실패/);
  assert.deepEqual(await fs.readdir(directory), files);
});

test('테스트 화면에서 입력한 커머스 계정과 개수를 전송하고 저장 결과를 표시한다', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const publicDir = path.join(__dirname, '../public');
  const $ = load(await fs.readFile(path.join(publicDir, 'index.html'), 'utf8'));
  await page.setContent($('section[aria-label="상품 정보 수집(커머스)"]').toString());
  let submitted;
  await page.exposeFunction('collectFixture', input => {
    submitted = input;
    return { collected: 7, requested: 7, pagesRead: 1, stopReason: 'targetReached', filePath: 'fixture.json' };
  });
  await page.evaluate(() => { window.collectorApp = { collectCommerce: window.collectFixture }; });
  await page.addScriptTag({ path: path.join(publicDir, 'commerce-collection-view.js') });
  await page.getByLabel('커머스 ID').fill(credentials.accountId);
  await page.getByLabel('커머스 비밀번호').fill(credentials.password);
  await page.getByLabel('수집할 상품 개수').fill('7');
  await page.getByRole('button', { name: '수집', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('commerceStatus').textContent.includes('fixture.json'));
  assert.deepEqual(submitted, { ...credentials, count: 7 });
  assert.match(await page.getByRole('status').innerText(), /수집 완료 · 요청 7개 중 7개 저장/);
  assert.equal(await page.getByLabel('커머스 비밀번호').inputValue(), '');
});

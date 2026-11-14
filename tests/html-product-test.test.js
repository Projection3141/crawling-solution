process.env.PLAYWRIGHT_BROWSERS_PATH ||= '0';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { createHtmlProductTester, productUrl, requestHtml, parseProduct, browserSample } = require('../electron/html-product-test');
const html = `<html><body><div id="productView"><div class="info_wrap"><div class="pdt_name"><span>원본 상품</span></div></div><div class="pdt-top-info"><span class="info-number">93060</span><span class="info-number">8801234567890</span></div><div class="pdt_code"><div class="pdt_code_last"><strong>1,000</strong></div></div><div id="viewContent"><img data-src="https://image1.cheonyu.com/detail.jpg"></div></div></body></html>`;
async function fixture(t, fetchHtml, sampleBrowser) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'html-product-fixture-'));
  t.after(async () => { // 생성한 테스트 디렉터리 내부 파일만 정리한다.
    for (const entry of await fs.readdir(directory)) await fs.unlink(path.join(directory, entry));
    await fs.rmdir(directory);
  });
  const baseline = { id: '93060', nameKo: '원본 상품', barcode: '8801234567890', originalPrice: 1000, descriptionImageUrls: ['https://image1.cheonyu.com/detail.jpg'], material: '종이', wholesalePrice: 500, nameJa: '翻訳', category: { depth1: '기존 분류' } };
  const file = path.join(directory, 'v1.0.0_archive.json');
  const content = JSON.stringify({ cheonyu: [baseline], ccdome: [] }); await fs.writeFile(file, content);
  return { directory, file, content, tester: createHtmlProductTester({ getProxy: () => ({ server: '127.0.0.1:12323', username: 'secret-user', password: 'secret-password' }), archiveDirectory: directory, diagnosticDirectory: directory, fetchHtml: fetchHtml || (async () => ({ html, statusCode: 200, transfer: { bodyBytes: 200, decodedBodyBytes: Buffer.byteLength(html) } })), sampleBrowser }) };
}
test('상품 URL만 허용하고 중복 ID·다른 호스트·인증·HTTP·임의 경로를 거절한다', () => {
  assert.equal(productUrl('93060').id, '93060');
  for (const url of ['https://evil.test/product/view.html?qIDX=1', 'http://www.cheonyu.com/product/view.html?qIDX=1', 'https://www.cheonyu.com/product/view.html?qIDX=1&qIDX=2', 'https://x:y@www.cheonyu.com/product/view.html?qIDX=1', 'https://www.cheonyu.com/member/login.html?qIDX=1', '0']) assert.throws(() => productUrl(url));
});
test('기존 파서로 HTML 정보를 추출하고 누락·범위 밖을 구분하며 아카이브는 수정하지 않는다', async (t) => {
  const f = await fixture(t);
  const result = await f.tester.run({ url: '93060' });
  assert.equal(result.success, true); assert.equal(result.product.nameKo, '원본 상품'); assert.equal(result.product.barcode, '8801234567890');
  assert.equal(result.comparison.find((r) => r.field === 'category').status, 'missing');
  assert.equal(result.comparison.find((r) => r.field === 'nameKo').status, 'same');
  assert.equal(result.comparison.find((r) => r.field === 'wholesalePrice').status, 'outside-scope');
  assert.equal(result.browser, undefined); assert.equal(result.productUrl, productUrl('93060').url);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.content);
  assert.doesNotMatch(JSON.stringify(result), /CIRCULAR/);
  assert.equal(JSON.parse(await fs.readFile(result.diagnosticPath)).product.nameKo, '원본 상품');
});
test('200 로그인 응답·다른 상품·403·연결 실패는 누락 비교나 브라우저 재요청으로 진행하지 않는다', async (t) => {
  for (const response of [{ statusCode: 200, html: '<input type="password">' }, { statusCode: 200, html: html.replace('93060', '93061') }, { statusCode: 403, html }, { statusCode: null, html: '', error: 'CONNECT 502' }]) {
    let called = 0; const f = await fixture(t, async () => response, async () => { called++; });
    const result = await f.tester.run({ url: '93060', compareBrowser: true });
    assert.equal(result.success, false); assert.equal(result.comparison, null); assert.equal(called, 0); assert.equal(result.browser.available, false);
  }
});
test('브라우저 비교는 명시적 선택만 실행하고 같은 프록시·상품으로 필드와 수신량을 보고한다', async (t) => {
  let called = 0;
  const f = await fixture(t, undefined, async (target, options) => {
    called++; assert.equal(target.id, '93060'); assert.equal(options.proxy.password, 'secret-password');
    const parsed = await parseProduct(html.replace('원본 상품', 'JS 상품'), target);
    return { ...parsed, receivedBytes: 900, elapsedMs: 100 };
  });
  const result = await f.tester.run({ url: '93060', proxyProfileId: 'p1', compareBrowser: true });
  assert.equal(called, 1); assert.equal(result.request.transfer.bodyBytes, 200); assert.equal(result.browser.receivedBytes, 900);
  assert.equal(result.browserComparison.find((r) => r.field === 'nameKo').status, 'different');
  assert.doesNotMatch(JSON.stringify(result), /secret-password|secret-user/);
});
test('중복 실행·앱 종료를 처리하며 요청 오류 후에도 다음 테스트를 실행할 수 있다', async (t) => {
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async () => { await wait; throw new Error('fixture request failed'); });
  const pending = f.tester.run({ url: '93060' });
  await assert.rejects(f.tester.run({ url: '93060' }), /진행 중/); release();
  assert.equal((await pending).success, false); assert.equal((await f.tester.run({ url: '93060' })).success, false);
  f.tester.close(); await assert.rejects(f.tester.run({ url: '93060' }), /종료/);
});
test('실제 curl 요청은 압축 본문 전송량을 측정하고 이미지·스크립트는 요청하지 않는다', async (t) => {
  const content = html + '<!--' + 'repeat '.repeat(2000) + '--><script src="/extra.js"></script>';
  const zipped = zlib.gzipSync(content); const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': zipped.length }); res.end(zipped); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const response = await requestHtml(`http://127.0.0.1:${server.address().port}/product`);
  assert.equal(response.statusCode, 200); assert.equal(response.html, content);
  assert.equal(response.transfer.bodyBytes, zipped.length); assert.equal(response.transfer.decodedBodyBytes, Buffer.byteLength(content));
  assert.deepEqual(requests, ['/product']); assert.ok(response.transfer.responseHeaderBytes > 0);
});
test('실제 브라우저 비교는 기존 네트워크 정책과 파서를 사용해 JS 변경과 부가 요청을 관측한다', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.setHeader('Content-Type', req.url === '/extra.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'); res.end(req.url === '/extra.js' ? `document.querySelector('.pdt_name span').textContent='JS 상품';` : html.replace('</body>', '<script src="/extra.js"></script></body>')); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const result = await browserSample({ id: '93060', url: `http://127.0.0.1:${server.address().port}/product` }, { showBrowser: false });
  assert.equal(result.available, true); assert.equal(result.product.nameKo, 'JS 상품'); assert.ok(result.receivedBytes > 0); assert.ok(requests.includes('/extra.js'));
});
test('실제 curl 프록시 인증은 표준입력으로 전달하고 CONNECT 502를 목적지 HTTP 응답과 구분한다', async (t) => {
  let connected = false;
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    connected = true;
    assert.equal(req.url, 'www.cheonyu.com:443');
    assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('fixture:pass"word\\test').toString('base64')}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve)); t.after(() => proxy.close());
  const response = await requestHtml('https://www.cheonyu.com/product/view.html?qIDX=93060', {
    proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'fixture', password: 'pass"word\\test' },
  });
  assert.equal(connected, true); assert.equal(response.statusCode, null); assert.equal(response.connectStatus, 502);
  assert.match(response.error, /502/); assert.doesNotMatch(JSON.stringify(response), /pass"word|fixture/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseBrands, createBrandStore, koreaDay, validateExcel } = require('../electron/brand-collector');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('전체 브랜드: 중복 로고/이름 링크 병합, 범위 밖 링크 제외, s3 식별', () => {
  const brands = parseBrands(`<a href='/brand/brandView.html?s3=99'>외부</a><div class='brand-list-view'>
    <div><a href='/brand/brandView.html?cateIDX=&s3=864'><img alt='logo'></a><a href='/brand/brandView.html?s3=864'><span> 가필드 </span></a></div>
    <a href='/brand/brandView.html?s3=836'>건담</a><a href='https://evil.invalid/brand/brandView.html?s3=5'>제외</a>
    <a href='/brand/brandView.html?s3=abc'>제외</a></div>`);
  assert.deepEqual(brands.map(({ id, name }) => ({ id, name })), [{ id: '864', name: '가필드' }, { id: '836', name: '건담' }]);
  assert.throws(() => parseBrands('<html>로그인하세요</html>'), /목록을 찾지/);
});

test('한도: 재시작/실패/계정 무관 10회, 한국 자정 초기화, 성공 이력 유지', t => {
  const root = directory(t); let now = new Date('2026-11-02T14:59:59Z');
  let store = createBrandStore(root, () => now);
  const brand = { id: '864', name: '가필드', url: 'https://www.cheonyu.com/brand/brandView.html?s3=864' };
  store.refresh([brand]);
  const first = store.reserve(brand, 'all'); store.finish(first.id, { status: 'success', filePath: 'fixture.xls' });
  for (let i = 0; i < 9; i++) store.reserve(brand, 'all');
  store = createBrandStore(root, () => now);
  assert.equal(store.snapshot().remaining, 0);
  assert.throws(() => store.reserve(brand, 'free'), /한도/);
  assert.equal(store.snapshot().brands[0].lastCollectedAt, now.toISOString());
  now = new Date('2026-11-02T15:00:00Z');
  assert.equal(koreaDay(now), '2026-11-03'); assert.equal(store.snapshot().remaining, 10);
  const failure = store.reserve(brand, 'all'); store.finish(failure.id, { status: 'failed', error: 'limit' });
  assert.equal(store.snapshot().remaining, 9);
  store.refresh([{ ...brand, name: '가필드 새 이름' }]);
  assert.equal(store.snapshot().brands[0].filePath, 'fixture.xls');
});

test('손상된 이력을 초기화하여 일일 제한을 우회하지 않는다', t => {
  const root = directory(t); fs.writeFileSync(path.join(root, 'brands.json'), '{');
  assert.throws(() => createBrandStore(root).snapshot(), /한도를 확인/);
});

test('파일 검증: Excel HTML 허용, 빈 파일과 로그인/차단 HTML 거절', async t => {
  const root = directory(t); const file = path.join(root, 'download.xls');
  fs.writeFileSync(file, '<html><table><tr><td>상품</td></tr></table></html>'); await validateExcel(file);
  fs.writeFileSync(file, '<table><tr><td>일일 10회 제한</td></tr></table>');
  await assert.rejects(validateExcel(file), { code: 'CHEONYU_DOWNLOAD_LIMIT' });
  for (const body of ['', '<script>alert("로그인하세요")</script>', '<table><input type="password"></table>']) {
    fs.writeFileSync(file, body); await assert.rejects(validateExcel(file), /엑셀|비어/);
  }
});

// 테스트 전용. 일반 수집·아카이브 갱신·로그인·장바구니 작업을 실행하지 않는다.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const cheerio = require('cheerio');
const { parseDetailHtml, prepareDetailImages } = require('../src/malls/cheonyu/detail');
const { createBackendProducts } = require('../src/utils/backend-product');
const { normalizeProxyCredentials } = require('../src/config');
const { getLightweightLaunchArgs, installLightweightNetworkPolicy } = require('../src/utils/browser');
const { createSanitizer } = require('../src/utils/collection-diagnostics');
const comparisonBrowsers = new Set();

async function closeComparisonBrowser(browser) {
  let timer;
  try {
    await Promise.race([
      browser.close().then(() => comparisonBrowsers.delete(browser)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('비교 브라우저 종료를 확인하지 못했습니다. 남은 창을 닫은 뒤 다시 실행하세요.')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function productUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /[\r\n\0]/.test(raw)) throw new Error('올바른 천유 상품 번호 또는 상세페이지 URL을 입력하세요.');
  const url = new URL(/^\d+$/.test(raw) ? `https://www.cheonyu.com/product/view.html?qIDX=${raw}` : raw);
  const ids = url.searchParams.getAll('qIDX');
  if (url.protocol !== 'https:' || url.hostname !== 'www.cheonyu.com' || url.port ||
      url.username || url.password || url.pathname !== '/product/view.html' ||
      ids.length !== 1 || !/^[1-9]\d{0,9}$/.test(ids[0])) {
    throw new Error('천유 상품 번호 또는 https://www.cheonyu.com/product/view.html?qIDX=상품번호 주소를 입력하세요.');
  }
  return { id: ids[0], url: `https://www.cheonyu.com/product/view.html?qIDX=${ids[0]}` };
}

// curl의 압축 해제 전 본문 전송량을 사용한다. 인증은 인자 대신 표준입력으로 전달한다.
async function requestHtml(url, { proxy, signal } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mall-html-test-'));
  const file = path.join(directory, 'response.bin');
  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const config = proxy
    ? `proxy = ${quote(proxy.server)}\nnoproxy = ""\n${proxy.username ? `proxy-user = ${quote(`${proxy.username}:${proxy.password}`)}\n` : ''}`
    : 'noproxy = "*"\n';
  try {
    const output = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
        '-q', '--config', '-', '--silent', '--show-error', '--compressed', '--max-time', '30',
        '--connect-timeout', '15', '--max-filesize', '4194304', '--output', file,
        '--write-out', '%{json}', '--header', 'Accept-Language: ko-KR',
        '--cookie', 'is_korean_mode=Y', '--url', url,
      ], { windowsHide: true, signal, stdio: ['pipe', 'pipe', 'pipe'] });
      const deadline = setTimeout(() => child.kill(), 35000);
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, 65536); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 4000); });
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
      child.stdin.end(config);
    });
    let metrics = {};
    try { metrics = JSON.parse(output.stdout); } catch { /* 실행 실패는 오류와 응답 없음으로 표시한다. */ }
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.size > 8 * 1024 * 1024) throw new Error('압축 해제 후 HTML이 8MB를 초과해 분석을 중단했습니다.');
    const buffer = stat ? await fs.readFile(file) : Buffer.alloc(0);
    const charset = String(metrics.content_type || '').match(/charset=([^;\s]+)/i)?.[1] ||
      buffer.subarray(0, 2000).toString('latin1').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(buffer); } catch { html = buffer.toString('utf8'); }
    return {
      html, statusCode: Number(metrics.http_code) || null, connectStatus: Number(metrics.http_connect) || null,
      elapsedMs: Math.round((Number(metrics.time_total) || 0) * 1000),
      transfer: {
        bodyBytes: Number(metrics.size_download) || 0, responseHeaderBytes: Number(metrics.size_header) || 0,
        decodedBodyBytes: buffer.length, measurement: 'curl: 압축된 응답 본문과 응답 헤더를 별도 집계합니다. TLS/TCP 오버헤드·프록시 업체 과금량과는 다릅니다.',
      },
      error: output.code ? output.stderr || `HTTP 요청 도구 종료 코드 ${output.code}` :
        metrics.http_code === undefined ? 'HTTP 요청 도구의 측정 정보를 읽지 못했습니다. Windows curl 업데이트를 확인하세요.' : '',
    };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
}

async function parseProduct(html, target) {
  const $ = cheerio.load(html);
  const hasProduct = $('#productView').length > 0 && $('.info_wrap .pdt_name span').text().trim().length > 0;
  if (!hasProduct) return { available: false, reason: $('input[type=password]').length ? '로그인이 필요한 응답입니다.' : '상품 상세 본문을 확인하지 못했습니다.' };
  const observedId = $('.pdt-top-info .info-number').first().text().trim();
  if (observedId && /^\d+$/.test(observedId) && observedId !== target.id) return { available: false, reason: '응답의 상품 번호가 요청한 상품과 다릅니다.' };
  const raw = parseDetailHtml(html, { productId: target.id, productUrl: target.url }, { mall: 'cheonyu', baseUrl: 'https://www.cheonyu.com', category: '-1' });
  const [product] = await createBackendProducts({ collectionMode: 'detail', detailItems: [raw] });
  return { available: true, raw, product };
}

const comparable = ['nameKo', 'barcode', 'category', 'categoryId', 'special', 'originalPrice', 'thumbnailUrl', 'imageUrls', 'descriptionImageUrls', 'specs'];
const other = ['wholesalePrice', 'stockQuantity', 'stockStatus', 'saleStatus', 'options', 'nameJa', 'nameEn', 'yenWholesalePrice', 'yenOriginalsalePrice'];
const present = (value) => value !== null && value !== undefined && value !== '' &&
  (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(present));
function compareProducts(current, baseline) {
  return [...comparable, ...other].map((field) => {
    const value = current[field];
    const before = baseline?.[field];
    const supported = comparable.includes(field);
    return { field, value: supported ? value : null, baseline: before ?? null,
      status: !supported ? 'outside-scope' : !present(value) ? (present(before) ? 'missing' : 'empty') :
        !baseline ? 'found' : JSON.stringify(value) === JSON.stringify(before) ? 'same' : 'different' };
  });
}

async function findBaseline(directory, id) {
  const files = await fs.readdir(directory).catch(() => []);
  const candidates = await Promise.all(files.filter((name) => /^v\d+\.\d+\.\d+_archive\.json$/.test(name)).map(async (name) => {
    const file = path.join(directory, name); const stat = await fs.stat(file).catch(() => null);
    return stat && stat.size <= 64 * 1024 * 1024 ? { file, mtime: stat.mtimeMs } : null;
  }));
  for (const candidate of candidates.filter(Boolean).sort((a, b) => b.mtime - a.mtime)) {
    try {
      const data = JSON.parse(await fs.readFile(candidate.file, 'utf8'));
      const rows = Array.isArray(data.cheonyu) ? data.cheonyu : Array.isArray(data) ? data.filter((p) => p.sourceMall === 'cheonyu' || /^CHEONYU-/i.test(p.sku || '')) : [];
      const product = rows.find((p) => String(p.id) === id);
      if (product) return { product, file: candidate.file, observedAt: product.updatedAt || product.createdAt || null };
    } catch { /* 손상된 파일은 다음 후보로 넘어간다. */ }
  }
  return null;
}

async function browserSample(target, { proxy, showBrowser, signal }) {
  for (const previous of comparisonBrowsers) if (!previous.isConnected()) comparisonBrowsers.delete(previous);
  if (comparisonBrowsers.size) throw new Error('이전 비교 브라우저의 종료가 확인되지 않았습니다. 남은 창을 닫은 후 다시 실행하세요.');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !showBrowser, args: getLightweightLaunchArgs({ showBrowser }), timeout: 30000 });
  comparisonBrowsers.add(browser);
  browser.once('disconnected', () => comparisonBrowsers.delete(browser));
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const started = performance.now();
  let receivedBytes = 0, partial = new Map();
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(proxy ? { proxy } : {}) });
    const policy = await installLightweightNetworkPolicy(context, { showBrowser });
    const page = await context.newPage();
    await policy.configurePage(page);
    const cdp = await context.newCDPSession(page);
    cdp.on('Network.dataReceived', (event) => partial.set(event.requestId, (partial.get(event.requestId) || 0) + Math.max(0, event.encodedDataLength || 0)));
    cdp.on('Network.loadingFinished', (event) => { receivedBytes += Math.max(0, event.encodedDataLength || 0); partial.delete(event.requestId); });
    cdp.on('Network.loadingFailed', (event) => { receivedBytes += partial.get(event.requestId) || 0; partial.delete(event.requestId); });
    await cdp.send('Network.enable');
    await context.addCookies([{ name: 'is_korean_mode', value: 'Y', url: 'https://www.cheonyu.com' }]);
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response?.status() >= 400) return { statusCode: response.status(), available: false, reason: '브라우저 비교에서 HTTP 오류를 받았습니다.' };
    await prepareDetailImages(page);
    const parsed = await parseProduct(await page.content(), target);
    return { ...parsed, statusCode: response?.status(), receivedBytes: receivedBytes + Array.from(partial.values()).reduce((a, b) => a + b, 0), elapsedMs: Math.round(performance.now() - started),
      measurement: 'CDP encodedDataLength: 해당 페이지와 부가 리소스 수신량. HTTP 직접 요청 측정과 완전히 같은 회계 기준은 아닙니다.' };
  } finally {
    signal?.removeEventListener('abort', abort);
    await closeComparisonBrowser(browser);
  }
}

function createHtmlProductTester({ getProxy, archiveDirectory, diagnosticDirectory, fetchHtml = requestHtml, sampleBrowser = browserSample }) {
  let active = null, disposed = false;
  return {
    close() {
      disposed = true; active?.abort();
      for (const browser of comparisonBrowsers) void closeComparisonBrowser(browser).catch(() => {});
    },
    async run(input = {}) {
      if (disposed) throw new Error('앱을 종료하는 중입니다.');
      if (active) throw new Error('HTML 테스트가 진행 중입니다.');
      const target = productUrl(input.url);
      const profile = input.proxyProfileId ? getProxy(String(input.proxyProfileId)) : null;
      if (input.proxyProfileId && !profile) throw new Error('선택한 프록시를 찾을 수 없습니다.');
      const proxy = profile ? normalizeProxyCredentials(profile, 'HTML 테스트 프록시') : undefined;
      if (proxy && !proxy.server.startsWith('http:')) throw new Error('이 HTML 테스트는 HTTP 프록시만 지원합니다.');
      const sanitize = createSanitizer([proxy?.username, proxy?.password]);
      const controller = new AbortController(); active = controller;
      const report = { testId: randomUUID(), startedAt: new Date().toISOString(), productId: target.id,
        productUrl: target.url, proxyName: profile?.name || '직접 연결', proxyServer: proxy?.server || '', anonymous: true };
      try {
        const baseline = await findBaseline(typeof archiveDirectory === 'function' ? archiveDirectory() : archiveDirectory, target.id);
        report.baseline = baseline ? { file: baseline.file, observedAt: baseline.observedAt } : null;
        const response = await fetchHtml(target.url, { proxy, signal: controller.signal });
        const { html, ...metadata } = response;
        report.request = metadata;
        const parsed = response.statusCode === 200 && !response.error ? await parseProduct(html, target) : { available: false, reason: response.error || `HTTP ${response.statusCode || '응답 없음'}` };
        report.success = parsed.available;
        report.reason = parsed.reason || '상품 HTML 분석을 완료했습니다. 로그인·재고 확인·번역은 수행하지 않았습니다.';
        report.product = parsed.product || null;
        report.raw = parsed.raw || null;
        report.comparison = parsed.available ? compareProducts(parsed.product, baseline?.product) : null;
        if (input.compareBrowser === true && parsed.available) {
          try {
            report.browser = await sampleBrowser(target, { proxy, showBrowser: input.showBrowser === true, signal: controller.signal });
            if (report.browser.available) report.browserComparison = compareProducts(parsed.product, report.browser.product);
          } catch (error) { report.browser = { available: false, reason: String(error.message || error) }; }
        } else if (input.compareBrowser === true) report.browser = { available: false, reason: '정상 상품 HTML을 받지 못해 추가 브라우저 요청을 생략했습니다.' };
        report.trafficNote = '기존 아카이브에는 상품별 전송량이 없습니다. 브라우저 비교를 선택하고 양쪽에서 정상 상품을 받아야 전송량을 비교할 수 있습니다. TLS/TCP 오버헤드·로그인 트래픽·업체 과금량은 별도입니다.';
      } catch (error) { report.success = false; report.reason = String(error.message || error); }
      finally { active = null; }
      const safe = sanitize(JSON.parse(JSON.stringify(report)));
      // 일반 진단의 URL 쿼리 제거와 별개로 허용된 상품 식별자만 복원한다.
      safe.productUrl = target.url;
      try {
        const directory = typeof diagnosticDirectory === 'function' ? diagnosticDirectory() : diagnosticDirectory;
        await fs.mkdir(directory, { recursive: true });
        safe.diagnosticPath = path.join(directory, `html-${report.testId}.json`);
        await fs.writeFile(safe.diagnosticPath, JSON.stringify(safe, null, 2), { flag: 'wx' });
      } catch { safe.diagnosticSaveError = 'HTML 테스트 진단 파일을 저장하지 못했습니다.'; }
      return safe;
    },
  };
}

module.exports = { createHtmlProductTester, productUrl, requestHtml, parseProduct, compareProducts, findBaseline, browserSample };

// 천유 브랜드 목록과 엑셀 수집 이력. 일일 한도는 계정/연결과 무관하게 앱 전체에 적용한다.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { load } = require('cheerio');
const { chromium } = require('playwright');
const { resolveRunConfig, normalizeProxyCredentials } = require('../src/config');
const { loginCheonyu } = require('../src/malls/cheonyu/site');
const { getLightweightLaunchArgs, installLightweightNetworkPolicy } = require('../src/utils/browser');

const DAILY_LIMIT = 10;
const BASE_URL = 'https://www.cheonyu.com';
const SITE_LIMIT = 'CHEONYU_DOWNLOAD_LIMIT';
const koreaDay = (date = new Date()) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const usedOnDay = (data, day) => data.attempts.filter(a => a.day === day && a.counted !== false).length;

function parseBrands(html) {
  const $ = load(html);
  const brands = new Map();
  $('.brand-list-view a[href]').each((_index, element) => {
    const link = $(element);
    let url;
    try { url = new URL(link.attr('href'), BASE_URL); } catch { return; }
    const id = url.searchParams.get('s3');
    if (!['cheonyu.com', 'www.cheonyu.com'].includes(url.hostname) ||
        url.pathname !== '/brand/brandView.html' || !/^\d+$/.test(id || '')) return;
    const name = link.text().replace(/\s+/g, ' ').trim() || link.find('img').attr('alt')?.trim();
    if (!name) return;
    // 같은 브랜드의 로고와 이름 링크가 각각 존재한다.
    const previous = brands.get(id);
    if (!previous || link.find('span').length) brands.set(id, { id, name, url: `${BASE_URL}/brand/brandView.html?cateIDX=&s3=${id}` });
  });
  if (!brands.size) throw new Error('브랜드 목록을 찾지 못했습니다. 로그인 상태 또는 천유 페이지 구조를 확인하세요.');
  return [...brands.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function createBrandStore(directory, now = () => new Date()) {
  const root = () => path.resolve(typeof directory === 'function' ? directory() : directory);
  const file = () => path.join(root(), 'brands.json');
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.brands) || !Array.isArray(data.attempts) ||
          data.attempts.some(a => !a || typeof a.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day) ||
            !['pending', 'success', 'failed'].includes(a.status))) throw new Error();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, brands: [], attempts: [], refreshedAt: null };
      throw new Error('브랜드 이력 파일을 읽을 수 없어 일일 한도를 확인할 수 없습니다.');
    }
  }
  function write(data) {
    fs.mkdirSync(root(), { recursive: true });
    const temp = `${file()}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file()); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  function snapshot() {
    const data = read();
    const day = koreaDay(now());
    const used = usedOnDay(data, day);
    const latest = new Map();
    for (const attempt of data.attempts) if (attempt.status === 'success') latest.set(attempt.brandId, attempt);
    const brands = data.brands.map(brand => {
      const collected = latest.get(brand.id);
      return { ...brand, lastCollectedAt: collected?.completedAt || null, filePath: collected?.filePath || null };
    });
    return { brands, refreshedAt: data.refreshedAt, day, used, remaining: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT,
      directory: path.join(root(), 'files'), recent: data.attempts.slice(-30).reverse() };
  }
  return {
    snapshot,
    refresh(brands) { const data = read(); data.brands = brands; data.refreshedAt = now().toISOString(); write(data); return snapshot(); },
    reserve(brand, variant) {
      const data = read(); const day = koreaDay(now());
      if (usedOnDay(data, day) >= DAILY_LIMIT) throw new Error('오늘의 브랜드 다운로드 한도 10회를 모두 사용했습니다.');
      const attempt = { id: randomUUID(), brandId: brand.id, name: brand.name, variant, day, startedAt: now().toISOString(), status: 'pending' };
      // 요청 전에 기록한다. 종료/실패/계정 변경 후에도 서버 사용량을 과소계산하지 않는다.
      data.attempts.push(attempt); write(data); return attempt;
    },
    logPopupLimit(brand, variant, fields) {
      const data = read(); const at = now();
      data.attempts.push({ id: randomUUID(), brandId: brand.id, name: brand.name, variant,
        day: koreaDay(at), startedAt: at.toISOString(), completedAt: at.toISOString(), counted: false, ...fields });
      write(data);
    },
    finish(id, fields) {
      const data = read(); const attempt = data.attempts.find(a => a.id === id);
      if (!attempt) throw new Error('브랜드 다운로드 이력을 찾지 못했습니다.');
      Object.assign(attempt, fields, { completedAt: now().toISOString() }); write(data);
    },
  };
}

function limitError(reason) {
  const error = new Error(`천유 다운로드 제한 · ${reason}`);
  error.code = SITE_LIMIT;
  return error;
}

function findLimitNotice(message) {
  const notice = message.replace(/\s+/g, ' ').trim();
  const scope = /다운로드|다운\s*횟수|하루|일일|오늘|금일|1\s*일|일\s*최대|횟수/i;
  const exhausted = /한도|제한|초과|소진|모두\s*사용|더\s*이상|\d+\s*(?:개|회|건|번)\s*(?:까지만?|이하|씩만|만\s*가능)/;
  if ((scope.test(notice) && exhausted.test(notice)) || /too many requests|download (?:quota|limit) exceeded/i.test(notice)) {
    return limitError(notice.slice(0, 300));
  }
  return null;
}

// 일반 상품 엑셀과 팝업 안내문에는 한도 설명이 있을 수 있다. 거절 응답만 판독한다.
function limitInBody(body) {
  let source = body.toString('utf8');
  if (source.includes('\uFFFD')) source = new TextDecoder('euc-kr').decode(body);
  const $ = load(source);
  if ($('.smartstore_popup a.ns-btn-info').length || $('td, th').toArray().some(cell => $(cell).text().trim() === '판매자 상품코드')) return null;
  for (const match of source.matchAll(/\balert\s*\(\s*(['"])(.*?)\1\s*\)/gis)) {
    const error = findLimitNotice(match[2]);
    if (error) return error;
  }
  $('script, style').remove();
  return findLimitNotice($('body').text());
}

function isBrandDownloadResponse(request) {
  for (let current = request; current; current = current.redirectedFrom()) {
    const url = new URL(current.url());
    if (['www.cheonyu.com', 'cheonyu.com'].includes(url.hostname) &&
        ['/_Engine/sfarm.html', '/_Include/pop/pop_smartstore_brand.html'].includes(url.pathname)) return true;
  }
  return false;
}

async function withSiteNotices(page, operation) {
  let rejectNotice;
  const notice = new Promise((_, reject) => { rejectNotice = reject; });
  const onDialog = dialog => {
    const message = dialog.message();
    void dialog.dismiss().catch(() => {});
    rejectNotice(findLimitNotice(message) || new Error(`천유 안내: ${message}`));
  };
  const onResponse = async response => {
    if (!isBrandDownloadResponse(response.request())) return;
    if (response.status() === 429) return rejectNotice(limitError('HTTP 429 · 천유가 요청 횟수를 제한했습니다.'));
    const headers = response.headers();
    if (!/text\/(html|plain)/i.test(headers['content-type']) || /attachment/i.test(headers['content-disposition'])) return;
    try {
      const error = limitInBody(await response.body());
      if (error) rejectNotice(error);
    } catch { /* 본문 판독 실패만으로 다운로드 제한을 단정하지 않는다. */ }
  };
  page.on('dialog', onDialog); page.on('response', onResponse);
  try { return await Promise.race([notice, operation()]); }
  finally { page.off('dialog', onDialog); page.off('response', onResponse); }
}

async function validateExcel(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.size) throw new Error('다운로드한 파일이 비어 있습니다.');
    const buffer = Buffer.alloc(Math.min(stat.size, 65536));
    await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8');
    const zip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]));
    const ole = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    if (!zip && !ole) {
      const limit = limitInBody(buffer);
      if (limit) throw limit;
    }
    // 사이트가 HTML table 형식의 .xls를 제공하는 경우도 허용한다.
    const sheet = /<table[\s>]/i.test(text) || /urn:schemas-microsoft-com:office:spreadsheet/i.test(text);
    if ((!zip && !ole && !sheet) || /<input[^>]+type\s*=\s*["']?password/i.test(text)) {
      throw new Error('정상 엑셀 파일이 아닙니다. 로그인 또는 다운로드 제한 응답일 수 있습니다.');
    }
  } finally { await handle.close(); }
}

async function prepareBrandDownload(page, brand, variant) {
  const response = await page.goto(brand.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (response && response.status() >= 400) throw new Error(`브랜드 페이지 접속 실패 (HTTP ${response.status()})`);
  await page.waitForFunction(() => typeof window.fnViewPopup === 'function' && typeof window.fnSmartsotreDownloadBrand === 'function', null, { timeout: 15000 });
  await page.evaluate(() => { document.querySelector('#popContent')?.replaceChildren(); });
  await page.evaluate(id => window.fnViewPopup('pop_smartstore_brand', `s3=${id}`), brand.id);
  const button = page.locator('.smartstore_popup a.ns-btn-info').filter({ hasText: variant === 'free' ? /^1\.무료이미지 상품정보 Excel$/ : /무료\+유료이미지 상품정보 Excel/ }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  // 사이트에서 확인한 함수만 실행한다. 다운로드 요청은 한 번만 하고 자동 재시도하지 않는다.
  return () => page.evaluate(opt => window.fnSmartsotreDownloadBrand(opt), variant === 'free' ? '1' : '');
}

async function receiveDownload(page, trigger, timeoutMs = 120000) {
  let timer; let onDownload;
  const received = new Promise((resolve, reject) => {
    onDownload = resolve;
    page.on('download', onDownload);
    timer = setTimeout(() => reject(new Error('엑셀 다운로드 대기 시간이 초과되었습니다. 사용 횟수는 유지됩니다.')), timeoutMs);
  });
  try {
    const [download] = await withSiteNotices(page, () => Promise.all([received, trigger()]));
    return download;
  } finally {
    clearTimeout(timer); page.off('download', onDownload);
  }
}

function createBrandCollector({ directory, getProxy = () => null, browserType = chromium, login = loginCheonyu,
  now = () => new Date(), prepareDownload = prepareBrandDownload, downloadTimeoutMs = 120000 } = {}) {
  const store = createBrandStore(directory, now);
  let active = false; let browser = null;
  async function withSession(input, operation) {
    if (active) throw new Error('브랜드 작업이 진행 중입니다. 완료 후 다시 실행하세요.');
    active = true;
    try {
      if (!String(input.accountId || '').trim() || !input.accountPw) throw new Error('등록한 천유 로그인 계정을 선택하세요.');
      const proxy = input.proxyProfileId ? getProxy(input.proxyProfileId) : null;
      if (input.proxyProfileId && !proxy) throw new Error('선택한 프록시를 찾을 수 없습니다.');
      const config = resolveRunConfig({ mall: 'cheonyu', category: '-1', accountId: input.accountId, accountPw: input.accountPw,
        showBrowser: input.showBrowser === true }, {});
      browser = await browserType.launch({ headless: config.headless, args: getLightweightLaunchArgs({ showBrowser: config.showBrowser }) });
      const context = await browser.newContext({ acceptDownloads: true, viewport: config.viewport, userAgent: config.userAgent,
        ...(proxy ? { proxy: normalizeProxyCredentials(proxy, '브랜드 수집 프록시') } : {}) });
      await installLightweightNetworkPolicy(context, { showBrowser: config.showBrowser });
      const page = await context.newPage();
      // 로그인/팝업 안내는 대기 중인 작업을 멈추지 않도록 닫는다.
      page.on('dialog', dialog => { if (page.listenerCount('dialog') === 1) void dialog.dismiss().catch(() => {}); });
      await login(page, config, undefined, { verificationTarget: 'brands' });
      return await operation(page);
    } finally {
      try { if (browser) await browser.close(); }
      finally { browser = null; active = false; }
    }
  }
  return {
    snapshot: () => store.snapshot(),
    refresh: (input = {}) => withSession(input, async page => store.refresh(parseBrands(await page.content()))),
    async collect(input = {}) {
      if (!Array.isArray(input.brandIds)) throw new Error('수집할 브랜드를 선택하세요.');
      const ids = [...new Set(input.brandIds.map(String))];
      const snapshot = store.snapshot();
      if (!ids.length) throw new Error('수집할 브랜드를 선택하세요.');
      if (ids.length > snapshot.remaining) throw new Error(`오늘은 ${snapshot.remaining}개까지 수집할 수 있습니다. 선택한 브랜드 수를 줄여주세요.`);
      const targets = ids.map(id => snapshot.brands.find(brand => brand.id === id));
      if (targets.some(brand => !brand)) throw new Error('목록에 없는 브랜드가 있습니다. 브랜드 목록을 다시 불러오세요.');
      if (!['all', 'free'].includes(input.variant || 'free')) throw new Error('엑셀 종류를 확인하세요.');
      const variant = input.variant || 'free';
      return withSession(input, async page => {
        const results = [];
        for (const brand of targets) {
          let attempt; let temporary;
          try {
            const trigger = await withSiteNotices(page, () => prepareDownload(page, brand, variant));
            attempt = store.reserve(brand, variant);
            const download = await receiveDownload(page, trigger, downloadTimeoutMs);
            const extension = path.extname(download.suggestedFilename()).toLowerCase();
            const excelExtension = ['.xls', '.xlsx'].includes(extension);
            const root = store.snapshot().directory;
            await fs.promises.mkdir(root, { recursive: true });
            const name = brand.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70);
            const filename = `${attempt.day}_${brand.id}_${name}_${variant}_${attempt.id}${excelExtension ? extension : ''}`;
            const filePath = path.join(root, filename);
            temporary = `${filePath}.partial`;
            let saveTimer;
            try {
              await Promise.race([
                download.saveAs(temporary),
                new Promise((_, reject) => {
                  saveTimer = setTimeout(() => {
                    void download.cancel().catch(() => {});
                    reject(new Error('엑셀 파일 저장 시간이 초과되었습니다. 사용 횟수는 유지됩니다.'));
                  }, downloadTimeoutMs);
                }),
              ]);
            } finally { clearTimeout(saveTimer); }
            await validateExcel(temporary);
            if (!excelExtension) throw new Error('다운로드 응답이 Excel 파일(.xls/.xlsx)이 아닙니다.');
            await fs.promises.rename(temporary, filePath);
            temporary = null;
            store.finish(attempt.id, { status: 'success', filePath });
            results.push({ brandId: brand.id, name: brand.name, success: true, filePath });
          } catch (error) {
            if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => {});
            const failure = { status: 'failed', error: error.message };
            if (error.code === SITE_LIMIT) failure.siteLimited = true;
            if (attempt) store.finish(attempt.id, failure);
            else if (failure.siteLimited) store.logPopupLimit(brand, variant, failure);
            results.push({ brandId: brand.id, name: brand.name, success: false, ...failure });
            // 제한/세션 만료/파일 오류 뒤에 다음 브랜드 요청을 추가하지 않는다.
            break;
          }
        }
        return { results, skipped: targets.slice(results.length).map(({ id, name }) => ({ id, name })), state: store.snapshot() };
      });
    },
    close: async () => { if (browser) await browser.close(); },
  };
}

module.exports = { DAILY_LIMIT, koreaDay, parseBrands, createBrandStore, validateExcel, prepareBrandDownload, receiveDownload, createBrandCollector };

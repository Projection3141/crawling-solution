const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');

const ORIGIN = 'https://www.cheonyu.com';
const PRODUCT_PATH = '/commersAPI/cyproduct.html';
const LOGIN_PATH = '/commersAPI/login.html';
const pageUrl = number => ORIGIN + PRODUCT_PATH + '?page=' + number + '&listSize=500';

async function login(page, accountId, password) {
  // 상품 URL은 비로그인 상태에서 스크립트로 커머스 전용 로그인 폼으로 이동한다.
  await page.goto(pageUrl(1), { waitUntil: 'commit' });
  await page.waitForURL(ORIGIN + LOGIN_PATH + '*', { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname !== LOGIN_PATH) throw new Error('천유 커머스 로그인 페이지를 확인할 수 없습니다.');
  let rejectLogin;
  const denied = new Promise((_, reject) => { rejectLogin = reject; });
  const onDialog = dialog => {
    void dialog.dismiss().catch(() => {});
    rejectLogin(new Error('커머스 로그인에 실패했습니다. 계정 정보와 커머스센터 접근 권한을 확인하세요.'));
  };
  page.on('dialog', onDialog);
  try {
    await page.locator('#frm #username').fill(accountId);
    await page.locator('#frm #userpassword').fill(password);
    await Promise.race([denied, Promise.all([
      page.waitForURL(url => url.origin === ORIGIN && url.pathname === PRODUCT_PATH, { waitUntil: 'domcontentloaded' }),
      page.locator('#btLogin').click(),
    ])]);
  } catch {
    // Playwright 입력 오류에 비밀번호가 들어갈 수 있어 로그인 단계의 원문을 노출하지 않는다.
    throw new Error('커머스 로그인에 실패했습니다. 계정 정보와 커머스센터 접근 권한을 확인하세요.');
  } finally { page.off('dialog', onDialog); }
}

// Playwright가 실제 DOM에서 실행한다. input.value와 이미지 주소만 읽고 표 안의 버튼은 조작하지 않는다.
function readTable(table) {
  const headers = Array.from(table.tHead?.rows[0]?.cells || []);
  function column(css, title) {
    let index = headers.findIndex(cell => cell.classList.contains(css));
    if (index < 0) index = headers.findIndex(cell => title.test(cell.textContent.replace(/\s/g, '')));
    if (index < 0) throw new Error('상품 표에 필요한 열이 없습니다 (' + css + ').');
    return index;
  }
  const columns = {
    productNumber: column('col-w-2', /상품번호|제품번호|상품코드/),
    productInfo: column('col-w-3', /제품정보|상품정보|상품명/),
    options: column('col-option', /옵션/),
    stock: column('col-stock', /재고/),
    consumerPrice: column('col-price', /소비자가/),
    supplyPrice: column('col-discount', /공급가/),
    storeSalePrice: column('col-store-price', /스토어판매가/),
  };
  function cellText(cell) {
    return cell.innerText.trim().replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, '\n');
  }
  const products = [];
  for (const row of table.tBodies[0].rows) {
    if (row.cells.length === 1 && row.cells[0].colSpan > 1 &&
        /없습니다|없음|존재하지 않/.test(row.innerText)) continue;
    const product = {};
    for (const [key, index] of Object.entries(columns)) {
      const cell = row.cells[index];
      if (!cell) throw new Error('상품 행의 열 구성이 바뀌었습니다.');
      product[key] = cellText(cell);
      if (key === 'options' && !product[key]) {
        product[key] = Array.from(cell.querySelectorAll('select option, input:not([type=hidden])'),
          field => field.tagName === 'OPTION' ? field.textContent.trim() : field.value).filter(Boolean).join('\n');
      }
      if (key === 'productInfo') {
        product.imageUrls = [];
        for (const img of cell.querySelectorAll('img')) {
          const src = img.dataset.src || img.dataset.original || img.getAttribute('src');
          if (!src) continue;
          let url;
          try { url = new URL(src, document.baseURI); } catch { continue; }
          if (['http:', 'https:'].includes(url.protocol) && !product.imageUrls.includes(url.href)) product.imageUrls.push(url.href);
        }
      }
      if (key === 'storeSalePrice') {
        const input = cell.querySelector('input:not([type=hidden])');
        if (input) product[key] = input.value.trim();
      }
    }
    if (!product.productNumber || !product.productInfo) throw new Error('상품 번호 또는 제품 정보를 읽지 못했습니다.');
    products.push(product);
  }
  const pager = document.querySelector('.pagination-wrapper');
  const active = pager?.querySelector('.page-item.active');
  const current = active?.textContent.trim().match(/^\d+/);
  const nextPages = [];
  for (const link of pager?.querySelectorAll('a[href]') || []) {
    if (link.closest('.disabled, [aria-disabled="true"]')) continue;
    const url = new URL(link.href);
    if (url.origin === location.origin && url.pathname === location.pathname) nextPages.push(Number(url.searchParams.get('page')));
    if (/^\d+$/.test(link.textContent.trim())) nextPages.push(Number(link.textContent.trim()));
  }
  return { products, current: current ? Number(current[0]) : null, nextPages };
}

async function readPage(page, number) {
  const response = await page.goto(pageUrl(number), { waitUntil: 'domcontentloaded' });
  if (!response || response.status() >= 400) throw new Error('상품 목록 요청 실패 (HTTP ' + (response?.status() ?? '응답 없음') + ').');
  const content = page.locator('#productTable.product-list-table > tbody, #frm #userpassword').first();
  await content.waitFor({ state: 'attached' });
  if (new URL(page.url()).pathname !== PRODUCT_PATH || await page.locator('#frm #userpassword').count()) {
    throw new Error('커머스 로그인 세션이 만료되었습니다.');
  }
  const result = await page.locator('#productTable.product-list-table').evaluate(readTable);
  if (result.current !== null && result.current !== number) throw new Error('요청한 페이지와 표시된 페이지가 다릅니다.');
  return result;
}

function createCommerceCollector({ directory, browserType = chromium, onProgress = () => {} }) {
  let running = false;
  let browser;
  async function run({ accountId, password, count } = {}) {
    if (running) throw new Error('커머스 상품 수집이 진행 중입니다.');
    if (typeof accountId !== 'string' || !accountId.trim() || typeof password !== 'string' || !password) {
      throw new Error('천유 커머스 ID와 비밀번호를 입력하세요.');
    }
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('수집 개수는 1 이상의 정수로 입력하세요.');

    running = true;
    const products = new Map();
    let pagesRead = 0;
    let stopReason = 'endOfList';
    let detail = '';
    try {
      browser = await browserType.launch({ headless: true });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.fallback());
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      await login(page, accountId.trim(), password);
      for (let number = 1; products.size < count; number++) {
        onProgress({ page: number, collected: products.size, requested: count });
        try {
          const result = await readPage(page, number);
          const hasNextPage = result.nextPages.some(p => p > number);
          if (hasNextPage && !result.products.length) throw new Error('다음 페이지가 있지만 현재 상품 행을 읽지 못했습니다.');
          const previousSize = products.size;
          for (const item of result.products) {
            if (!products.has(item.productNumber)) products.set(item.productNumber, item);
            if (products.size === count) break;
          }
          if (result.products.length && products.size === previousSize) throw new Error('새 상품 없이 같은 목록이 반복되었습니다.');
          pagesRead++;
          if (products.size === count) { stopReason = 'targetReached'; break; }
          if (!hasNextPage) break;
        } catch (error) {
          if (!products.size) throw error;
          stopReason = 'partialError';
          detail = number + '페이지 수집 중단 · ' + error.message;
          break;
        }
      }
      const collectedAt = new Date().toISOString();
      const root = directory();
      await fs.mkdir(root, { recursive: true });
      const filePath = path.join(root, collectedAt.replace(/[:.]/g, '-') + '-' + randomUUID() + '.json');
      const summary = { collectedAt, requested: count, collected: products.size, pagesRead, stopReason, detail };
      const temp = filePath + '.partial';
      try {
        await fs.writeFile(temp, JSON.stringify({ source: 'cheonyu-commerce', ...summary, products: [...products.values()] }, null, 2), { flag: 'wx' });
        await fs.rename(temp, filePath);
      } finally { await fs.rm(temp, { force: true }); }
      return { ...summary, filePath };
    } finally {
      try { if (browser) await browser.close(); }
      finally { browser = null; running = false; }
    }
  }
  return { run, close: async () => { if (browser) await browser.close(); } };
}

module.exports = { createCommerceCollector };

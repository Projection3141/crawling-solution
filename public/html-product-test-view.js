(() => {
  window.createHtmlProductTestView = function ({ document, getApi }) {
    const query = (id) => document.querySelector(`#${id}`);
    const form = query('productHtmlTestForm');
    if (!form) return { bindEvents() {} };
    let running = false;
    const bytes = (value) => Number.isFinite(value) ? `${value.toLocaleString('ko-KR')} B (${(value / 1024).toFixed(2)} KiB)` : '측정 불가';
    const labels = { same: '같음', different: '값 다름 (관측 시점 차이 가능)', missing: '기존 값 있으나 누락', empty: '양쪽 미확인', found: '직접 요청에서 확인', 'outside-scope': '단일 상세 HTML 범위 밖' };
    function text(parent, content, tag = 'p') { const node = document.createElement(tag); node.textContent = content; parent.append(node); return node; }
    function render(result) {
      const card = document.createElement('article'); card.className = 'run-card html-product-test-result';
      text(card, `${result.success ? 'HTML 분석 완료' : 'HTML 분석 불가'} · 상품 ${result.productId} · ${result.proxyName}`, 'h3');
      text(card, result.reason);
      text(card, `HTTP ${result.request?.statusCode ?? '응답 없음'} · CONNECT ${result.request?.connectStatus ?? '해당 없음'} · ${((result.request?.elapsedMs || 0) / 1000).toFixed(2)}초`);
      text(card, `직접 요청 본문 전송량: ${bytes(result.request?.transfer?.bodyBytes)} · 응답 헤더: ${bytes(result.request?.transfer?.responseHeaderBytes)} · 압축 해제 후 HTML: ${bytes(result.request?.transfer?.decodedBodyBytes)}`);
      text(card, result.baseline ? `기존 비교 파일: ${result.baseline.file} · 저장 시각: ${result.baseline.observedAt || '미확인'}` : '같은 상품의 기존 아카이브가 없어 기존 결과와의 일치 여부를 판단할 수 없습니다.');
      if (result.browser) text(card, result.browser.available ? `브라우저 수신량 (HTML·부가 리소스): ${bytes(result.browser.receivedBytes)} · ${((result.browser.elapsedMs || 0) / 1000).toFixed(2)}초` : `브라우저 비교 불가: ${result.browser.reason}`);
      text(card, result.trafficNote || '전송량은 프록시 업체 과금량과 다를 수 있습니다.');
      function table(rows, caption) {
        if (!rows) return;
        text(card, caption, 'h4');
        const wrapper = document.createElement('div'); wrapper.style.overflowX = 'auto';
        const node = document.createElement('table'); const head = document.createElement('tr');
        for (const label of ['항목', '비교 결과', '직접 HTML 값', '비교 대상 값']) text(head, label, 'th');
        node.append(head);
        for (const row of rows) {
          const tr = document.createElement('tr');
          for (const value of [row.field, labels[row.status] || row.status, row.value, row.baseline]) {
            const td = text(tr, typeof value === 'string' ? value : JSON.stringify(value), 'td'); td.style.maxWidth = '300px'; td.style.overflowWrap = 'anywhere';
          }
          node.append(tr);
        }
        wrapper.append(node); card.append(wrapper);
      }
      table(result.comparison, '기존 저장 결과와 비교'); table(result.browserComparison, '동일 시점 브라우저 상세 분석과 비교');
      if (result.raw) {
        const details = document.createElement('details'); text(details, 'HTML에서 추출한 전체 원본 정보', 'summary');
        text(details, JSON.stringify(result.raw, null, 2), 'pre').style.whiteSpace = 'pre-wrap'; card.append(details);
      }
      text(card, result.diagnosticSaveError || `진단 파일: ${result.diagnosticPath || '없음'}`);
      const results = query('productHtmlTestResults'); results.prepend(card); while (results.children.length > 5) results.lastElementChild.remove();
    }
    async function submit(event) {
      event.preventDefault(); if (running) return;
      const status = query('productHtmlTestStatus');
      if (query('connectionTestButton').disabled) { status.textContent = '진행 중인 접속 테스트가 끝난 후 실행하세요.'; return; }
      running = true;
      const controls = ['productHtmlTestButton', 'productHtmlTestUrl', 'productHtmlCompareBrowser', 'connectionTestButton', 'connectionTestProxy', 'connectionTestBrowserMode'].map(query);
      controls.forEach((node) => { node.disabled = true; });
      status.textContent = '브라우저 없이 HTML을 한 번 요청하고 기존 아카이브와 비교합니다…';
      try {
        const result = await getApi().testProductHtml({ url: query('productHtmlTestUrl').value.trim(), proxyProfileId: query('connectionTestProxy').value,
          compareBrowser: query('productHtmlCompareBrowser').checked, showBrowser: query('connectionTestBrowserMode').value === 'show' });
        render(result); status.textContent = result.success ? 'HTML 요청과 분석을 완료했습니다.' : '정상 상품 HTML을 받지 못했습니다. 결과를 확인하세요.';
      } catch (error) { status.textContent = `HTML 테스트 실패: ${error.message}`; }
      finally { running = false; controls.forEach((node) => { node.disabled = false; }); }
    }
    return { bindEvents() { form.addEventListener('submit', submit); } };
  };
})();

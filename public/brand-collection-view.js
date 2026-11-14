(() => {
  window.createBrandCollectionView = function ({ document, getApi, getAccounts }) {
    const q = id => document.getElementById(id);
    let state = { brands: [], recent: [], remaining: 10, used: 0, limit: 10 };
    let activeList = null; let running = false;
    const toggles = { all: q('brandListAll'), collected: q('brandListCollected'), pending: q('brandListPending') };
    const status = message => { q('brandStatus').textContent = message; };
    const date = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    function text(parent, value, tag = 'p') {
      const node = document.createElement(tag); node.textContent = value; parent.append(node); return node;
    }
    function setAccounts() {
      const select = q('brandAccount'); const previous = select.value;
      select.replaceChildren(); const empty = text(select, '천유 계정 선택', 'option'); empty.value = '';
      for (const account of getAccounts()) { const option = text(select, `${account.name} (${account.loginId})`, 'option'); option.value = account.id; }
      if (getAccounts().some(account => account.id === previous)) select.value = previous;
    }
    function names() { return [...new Set(q('brandNames').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean))]; }
    function renderLists() {
      const groups = { all: state.brands, collected: state.brands.filter(b => b.lastCollectedAt), pending: state.brands.filter(b => !b.lastCollectedAt) };
      for (const [key, button] of Object.entries(toggles)) {
        button.querySelector('span').textContent = `(${groups[key].length})`;
        button.setAttribute('aria-expanded', String(key === activeList));
      }
      const list = q('brandList'); list.replaceChildren(); list.hidden = !activeList;
      if (!activeList) return;
      if (!groups[activeList].length) text(list, state.brands.length ? '해당 브랜드가 없습니다.' : '브랜드 목록을 먼저 불러오세요.');
      for (const brand of groups[activeList]) {
        const row = document.createElement('div'); row.className = 'brand-list-row';
        const button = text(row, brand.name, 'button'); button.type = 'button'; button.className = 'secondary-button'; button.disabled = running;
        button.addEventListener('click', () => {
          const selected = names(); if (!selected.includes(brand.name)) selected.push(brand.name);
          q('brandNames').value = selected.join('\n'); q('brandNames').focus();
        });
        if (activeList === 'collected') { const time = text(row, `마지막 수집: ${date(brand.lastCollectedAt)}`, 'time'); time.dateTime = brand.lastCollectedAt; }
        list.append(row);
      }
    }
    function render() {
      q('brandQuota').textContent = `앱 기준 오늘 ${state.used}/${state.limit}회 사용 · ${state.remaining}회 남음 (한국 시간)${state.refreshedAt ? ` · 목록 갱신: ${date(state.refreshedAt)}` : ''}`;
      renderLists();
      const results = q('brandResults'); results.replaceChildren();
      for (const result of state.recent || []) {
        const card = document.createElement('article'); card.className = 'run-card';
        const label = result.siteLimited ? '천유 다운로드 제한' : result.status === 'success' ? '수집 성공' : result.status === 'failed' ? '수집 실패' : '완료 미확인';
        text(card, `${result.name} · ${label} · ${result.variant === 'free' ? '무료이미지' : '무료+유료이미지'}`, 'h4');
        text(card, date(result.completedAt || result.startedAt));
        text(card, result.status === 'success' ? `파일 저장 완료: ${result.filePath}` : result.error || '이전 다운로드의 완료가 확인되지 않았습니다. 일일 사용 횟수에는 포함됩니다.');
        if (result.siteLimited) text(card, '다른 곳에서 다운로드했다면 앱 사용 횟수가 10회 미만이어도 천유에서 제한될 수 있습니다.');
        results.append(card);
      }
    }
    function payload() {
      const account = getAccounts().find(item => item.id === q('brandAccount').value);
      if (!account) throw new Error('등록한 천유 계정을 선택하세요.');
      return { accountId: account.loginId, accountPw: account.password, proxyProfileId: q('connectionTestProxy').value,
        showBrowser: q('connectionTestBrowserMode').value === 'show', variant: q('brandVariant').value };
    }
    async function execute(operation) {
      if (running) return;
      running = true;
      const controls = ['brandRefresh', 'brandCollect', 'brandAccount', 'brandVariant', 'brandNames'].map(q);
      controls.forEach(node => { node.disabled = true; }); renderLists();
      try { await operation(); }
      catch (error) { status(`브랜드 작업 실패: ${error.message}`); }
      finally {
        try { state = await getApi().getBrands(); render(); } catch (error) { status(`이력 확인 실패: ${error.message}`); }
        running = false; controls.forEach(node => { node.disabled = false; }); renderLists();
      }
    }
    return { setAccounts, bindEvents() {
      for (const [key, button] of Object.entries(toggles)) button.addEventListener('click', () => { activeList = activeList === key ? null : key; renderLists(); });
      q('brandRefresh').addEventListener('click', () => execute(async () => {
        const input = payload(); status('천유 로그인 후 전체 브랜드 목록을 불러옵니다…');
        state = await getApi().refreshBrands(input); if (!activeList) activeList = 'all'; render(); status(`브랜드 ${state.brands.length}개를 불러왔습니다.`);
      }));
      q('brandCollectForm').addEventListener('submit', event => {
        event.preventDefault(); void execute(async () => {
          const input = payload(); const selected = names();
          // 앱을 자정 이후에도 열어둔 경우 현재 날짜의 한도를 다시 읽는다.
          state = await getApi().getBrands(); render();
          if (!selected.length) throw new Error('수집할 브랜드 이름을 입력하세요.');
          const brandIds = selected.map(name => {
            const matches = state.brands.filter(brand => brand.name === name);
            if (matches.length !== 1) throw new Error(`브랜드 이름을 확인하세요: ${name}`);
            return matches[0].id;
          });
          if (brandIds.length > state.remaining) throw new Error(`오늘 남은 횟수는 ${state.remaining}회입니다. 선택한 브랜드 수를 줄여주세요.`);
          status(`${brandIds.length}개 브랜드 수집 중… 파일 다운로드와 저장이 완료될 때까지 기다려주세요.`);
          const result = await getApi().collectBrands({ ...input, brandIds }); state = result.state; render();
          const success = result.results.filter(item => item.success);
          q('brandNames').value = selected.filter(name => !success.some(item => item.name === name)).join('\n');
          const failure = result.results.find(item => !item.success);
          status(`수집 성공 ${success.length}개 · 실패 ${result.results.length - success.length}개 · 미실행 ${result.skipped.length}개${failure ? ` — ${failure.name}: ${failure.error}` : ' · 엑셀 파일 저장 완료'}`);
        });
      });
      q('brandOpenDirectory').addEventListener('click', async () => { try { await getApi().openBrandDirectory(); } catch (error) { status(error.message); } });
      setAccounts();
      void getApi().getBrands().then(value => { state = value; render(); }).catch(error => status(`브랜드 이력 확인 실패: ${error.message}`));
    } };
  };
})();

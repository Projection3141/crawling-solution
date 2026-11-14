(() => {
  const form = document.getElementById('commerceForm');
  const account = document.getElementById('commerceId');
  const password = document.getElementById('commercePassword');
  const count = document.getElementById('commerceCount');
  const button = document.getElementById('commerceCollect');
  const status = document.getElementById('commerceStatus');
  const api = window.collectorApp;
  api?.onCommerceProgress?.(({ page, collected, requested }) => {
    status.textContent = page + '페이지 조회 중 · ' + requested + '개 중 ' + collected + '개 수집';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const input = { accountId: account.value.trim(), password: password.value, count: count.valueAsNumber };
    const controls = [account, password, count, button];
    controls.forEach(control => { control.disabled = true; });
    status.textContent = '천유 커머스센터에 로그인 중…';
    try {
      const result = await api.collectCommerce(input);
      const label = { targetReached: '수집 완료', endOfList: '목록 끝', partialError: '일부 저장' }[result.stopReason];
      status.textContent = label + ' · 요청 ' + result.requested + '개 중 ' + result.collected + '개 저장 (' + result.pagesRead + '페이지) · ' +
        (result.detail ? result.detail + ' · ' : '') + result.filePath;
    } catch (error) { status.textContent = '커머스 수집 실패 · ' + error.message; }
    finally { password.value = ''; controls.forEach(control => { control.disabled = false; }); }
  });
  document.getElementById('commerceOpenFolder').addEventListener('click', async () => {
    try { await api.openCommerceDirectory(); } catch (error) { status.textContent = error.message; }
  });
})();

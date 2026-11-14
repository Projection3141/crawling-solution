// 접속 테스트의 입력·결과 화면. 수집 화면의 선택과 실행 상태는 변경하지 않는다.
(() => {
  window.createConnectionTestView = function createConnectionTestView({ document, getApi }) {
    const form = document.querySelector("#connectionTestForm");
    const url = document.querySelector("#connectionTestUrl");
    const proxy = document.querySelector("#connectionTestProxy");
    const browserMode = document.querySelector("#connectionTestBrowserMode");
    const checkEgress = document.querySelector("#connectionTestCheckEgress");
    const checkTunnel = document.querySelector("#connectionTestCheckTunnel");
    const button = document.querySelector("#connectionTestButton");
    const status = document.querySelector("#connectionTestStatus");
    const results = document.querySelector("#connectionTestResults");
    let running = false;
    const htmlView = window.createHtmlProductTestView?.({ document, getApi });

    function setProxies(profiles) {
      const selected = proxy.value;
      proxy.replaceChildren();
      for (const profile of [{ id: "", name: "프록시 사용 안 함 (내 IP)" }, ...profiles]) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.server ? `${profile.name} · ${profile.server}` : profile.name;
        proxy.append(option);
      }
      proxy.value = profiles.some((profile) => profile.id === selected) ? selected : "";
    }

    function addResult(result) {
      const card = document.createElement("article");
      card.className = "run-card connection-test-result";
      const header = document.createElement("div");
      header.className = "status-header";
      const title = document.createElement("h3");
      title.textContent = result.proxyName;
      const badge = document.createElement("span");
      badge.className = `status-badge ${result.success ? "completed" : "failed"}`;
      badge.textContent = result.success ? "접속 성공" : "접속 실패";
      header.append(title, badge);
      card.append(header);
      const lines = [
        `시각: ${new Date(result.startedAt).toLocaleString("ko-KR")}`,
        `요청 URL: ${result.requestedUrl}`,
        `사용 프록시: ${result.proxyServer || "사용 안 함 (내 IP)"}`,
        ...(result.browserMode ? [`브라우저 방식: ${{ show: "표시", hide: "숨김", "chromium-headless": "숨김 (일반 Chromium)" }[result.browserMode] || result.browserMode}`] : []),
        `HTTP 응답: ${result.statusCode ?? "없음"} · 소요 시간: ${(result.elapsedMs / 1000).toFixed(1)}초`,
        ...(result.failureLayer && result.failureLayer !== "none" ? [`실패 구간: ${{
          "proxy-auth": "프록시 인증", "proxy-tunnel": "프록시 HTTPS 터널", "proxy-connection": "프록시 연결",
          "http-access": "HTTP 접근 거부", "http": "HTTP 응답", "navigation-timeout": "응답 또는 문서 로딩 대기",
          "document-load-timeout": "응답 이후 문서 로딩", "browser": "브라우저 준비", "network": "네트워크 연결",
        }[result.failureLayer] || result.failureLayer}`] : []),
        ...(result.egressIp ? [`동일 세션에서 확인한 외부 IP: ${result.egressIp}`] : []),
        ...(result.egressError ? [`외부 IP 확인 실패 (접속 결과와 별개): ${result.egressError}`] : []),
        ...(result.tunnelProbe ? [result.tunnelProbe.skipped
          ? result.tunnelProbe.message
          : `별도 CONNECT 진단: ${result.tunnelProbe.statusCode ?? "응답 없음"}${Number.isFinite(result.tunnelProbe.elapsedMs) ? ` · ${(result.tunnelProbe.elapsedMs / 1000).toFixed(1)}초` : ""} · ${result.tunnelProbe.message || result.tunnelProbe.errorCode || ""}`] : []),
        ...(result.finalUrl && result.finalUrl !== "about:blank" ? [`최종 URL: ${result.finalUrl}`] : []),
        result.message,
        ...(result.errorCode ? [`오류 코드: ${result.errorCode}`] : []),
        ...(result.error ? [result.error] : []),
        ...(result.responseSummary?.title ? [`오류 문서 제목: ${result.responseSummary.title}`] : []),
        ...(result.diagnosticPath ? [`진단 파일: ${result.diagnosticPath}`] : []),
        ...(result.diagnosticSaveError ? [`진단 파일을 저장하지 못했습니다: ${result.diagnosticSaveError}`] : []),
        ...(result.browserCloseWarning ? [result.browserCloseWarning] : []),
      ];
      for (const line of lines) {
        const text = document.createElement("p");
        text.textContent = line;
        card.append(text);
      }
      results.prepend(card);
      while (results.children.length > 10) results.lastElementChild.remove();
    }

    async function submit(event) {
      event.preventDefault();
      if (running) return;
      running = true;
      const controls = [url, proxy, browserMode, checkEgress, checkTunnel, button].filter(Boolean);
      for (const control of controls) control.disabled = true;
      button.textContent = "접속 확인 중…";
      status.textContent = checkEgress?.checked || checkTunnel?.checked
        ? "브라우저 준비 후 접속과 선택한 추가 진단을 확인합니다. 추가 진단은 최대 25초가 걸릴 수 있습니다."
        : "브라우저 준비 후 최대 60초 동안 접속을 확인합니다.";
      try {
        const result = await getApi().testConnection({
          url: url.value.trim(), proxyProfileId: proxy.value,
          showBrowser: browserMode.value === "show",
          browserMode: browserMode.value,
          checkEgress: checkEgress?.checked === true,
          checkTunnel: checkTunnel?.checked === true,
        });
        addResult(result);
        status.textContent = result.success ? "접속 테스트를 완료했습니다." : "접속에 실패했습니다. 아래 결과를 확인하세요.";
      } catch (error) {
        status.textContent = `테스트를 실행하지 못했습니다: ${error.message}`;
      } finally {
        running = false;
        for (const control of controls) control.disabled = false;
        button.textContent = "접속 테스트";
      }
    }

    return { setProxies, bindEvents: () => { form.addEventListener("submit", submit); htmlView?.bindEvents(); } };
  };
})();

(function () {
  window.createLifecycleCollectionView = function ({ document, getState, start, chooseOutput, getOutputDirectory }) {
    const element = name => document.getElementById(`lifecycle${name}`);
    const form = element("Form");
    const descriptions = {
      inventory: "로그인 필요 · 메인 페이지에서 선택한 베스트 목록에 들어가 상품·옵션별 재고를 팝업으로 확인합니다.",
      newProducts: "이번 달·지난달 신상품의 목록과 상세를 비로그인으로 읽습니다. 새 옵션 상품의 바코드는 선택한 계정으로 장바구니에서 확인합니다.",
      changes: "로그인 필요 · 품절 상태를 반영하거나 최근 재입고 상품의 팝업 재고를 확인합니다.",
    };
    let submitting = false;
    function updateMode() {
      const kind = element("Kind").value;
      const loginRequired = kind !== "newProducts";
      element("KindHelp").textContent = descriptions[kind];
      element("Best").disabled = kind !== "inventory";
      element("BestField").hidden = kind !== "inventory";
      element("Change").disabled = kind !== "changes";
      element("ChangeField").hidden = kind !== "changes";
      const soldOut = element("Change").value === "soldOut";
      const restockDays = element("Change").value === "restock90" ? 90 : 30;
      element("ChangeHelp").textContent = soldOut
        ? "전체 상품 목록의 품절 표시를 확인해 아카이브의 판매 상태만 품절로 바꿉니다."
        : "마이페이지 → 인기 재입고상품에서 최신 재입고순으로 확인합니다. 성공한 실행의 날짜·상품번호를 저장합니다.";
      element("Scope").textContent = kind === "inventory" ? "선택한 베스트 목록 전체"
        : kind === "newProducts" ? "전체 카테고리 · 이번 달과 지난달의 모든 페이지 (한국 시간 기준)"
        : soldOut ? "전체 상품 · 품절 표시가 있는 상품" : `최근 ${restockDays}일 · 최신 재입고순 · 최초 전체 / 이후 새 재입고`;
      element("OpenAi").disabled = loginRequired;
      element("Delay").disabled = loginRequired;
      element("RepeatDays").disabled = element("RunMode").value !== "repeat";
      element("Submit").disabled = submitting;
    }
    function options(select, items, placeholder, label = item => item.name) {
      const selected = select.value;
      select.replaceChildren();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = placeholder;
      select.append(blank);
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = label(item);
        select.append(option);
      }
      if (items.some(item => item.id === selected)) select.value = selected;
    }
    function refresh() {
      const state = getState();
      options(element("Proxy"), state.credentialProfiles.proxies.filter(profile => {
        if (profile.provider) return ["decodo", "dataimpulse"].includes(profile.provider);
        try { return ["gate.decodo.com", "gw.dataimpulse.com"].includes(new URL(profile.server).hostname); } catch { return false; }
      }), "Decodo / DataImpulse 프록시 선택");
      const accounts = state.accounts.filter(account => !account.mall || account.mall === "cheonyu");
      options(element("Account"), accounts, "공통 .env 계정 사용", account =>
        accounts.some(item => item.id !== account.id && item.name === account.name)
          ? `${account.name} (${account.loginId})`
          : account.name);
      options(element("OpenAi"), state.credentialProfiles.openAiKeys, "한국어 원문 수집");
      element("Output").value = getOutputDirectory();
      updateMode();
    }
    function integer(name, minimum) {
      const value = Number(element(name).value);
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error("수집 범위와 주기는 올바른 정수로 입력하세요.");
      return value;
    }
    function payload() {
      const kind = element("Kind").value;
      const input = { mall: "cheonyu", collectionKind: kind,
        collectionMode: kind === "newProducts" ? "detail" : "general",
        category: "ALL", proxyProfileId: element("Proxy").value,
        pageStart: 1, pageEnd: 0,
        detailRequestDelayMs: kind === "newProducts" ? integer("Delay", 0) : 0,
        showBrowser: element("Browser").value !== "hide",
        blockImages: element("Browser").value === "show-no-images",
        executionOptions: { runMode: element("RunMode").value, repeatScheduleType: "interval",
          repeatValue: integer("RepeatDays", 1), repeatUnit: "day" },
      };
      if (kind === "inventory") input.inventoryBest = element("Best").value;
      if (kind === "changes") input.changeType = element("Change").value;
      if (!input.proxyProfileId) throw new Error("Decodo 또는 DataImpulse 프록시를 등록하고 선택하세요.");
      if (input.pageEnd && input.pageEnd < input.pageStart) throw new Error("종료 페이지는 시작 페이지 이상이어야 합니다.");
      const account = getState().accounts.find(item => item.id === element("Account").value);
      if (account) Object.assign(input, { accountId: account.loginId, accountPw: account.password,
        accountName: account.name, localCredentialId: account.id });
      if (kind === "newProducts" && element("OpenAi").value) input.openAiProfileId = element("OpenAi").value;
      return input;
    }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      submitting = true;
      updateMode();
      element("Message").textContent = "수집을 준비하고 있습니다.";
      try {
        await start(payload());
        element("Message").textContent = "실행 현황에 수집 작업을 추가했습니다.";
      } catch (error) { element("Message").textContent = error.message; }
      finally { submitting = false; updateMode(); }
    });
    element("Kind").addEventListener("change", () => {
      element("Message").textContent = "";
      updateMode();
    });
    element("RunMode").addEventListener("change", updateMode);
    element("Change").addEventListener("change", updateMode);
    element("ChooseOutput").addEventListener("click", async () => {
      await chooseOutput();
      element("Output").value = getOutputDirectory();
    });
    updateMode();
    return { refresh };
  };
})();

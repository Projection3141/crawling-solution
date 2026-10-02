(() => {
  let mountedPanel = null;

  /** 운송장 로그인 계정은 main process의 암호화 저장소에서 관리한다. */
  async function mountShippingAccounts() {
    const panel = document.querySelector("#shippingAccountsPanel");
    if (!panel || mountedPanel === panel) return;
    mountedPanel = panel;

    const heading = document.createElement("h3");
    heading.textContent = "운송장 KSE 계정";
    const help = document.createElement("p");
    help.className = "env-hint";
    help.textContent = "선택한 계정의 ID/PW를 운송장 로그인 페이지에 자동 입력합니다. 로그인 버튼은 브라우저에서 눌러주세요.";

    function field(labelText, control, helpText = "") {
      const label = document.createElement("label");
      label.className = "field";
      const title = document.createElement("span");
      title.textContent = labelText;
      label.append(title, control);
      if (helpText) {
        const note = document.createElement("small");
        note.textContent = helpText;
        label.append(note);
      }
      return label;
    }

    function button(id, text, className = "secondary-button") {
      const element = document.createElement("button");
      element.id = id;
      element.type = "button";
      element.className = className;
      element.textContent = text;
      return element;
    }

    function input(id, type, maxLength) {
      const element = document.createElement("input");
      element.id = id;
      element.name = id;
      element.type = type;
      element.maxLength = maxLength;
      element.autocomplete = type === "password" ? "new-password" : "off";
      return element;
    }

    const select = document.createElement("select");
    select.id = "shippingAccountSelect";
    const selection = field("자동 입력 계정", select, "계정을 변경하면 다음 운송정보 수집부터 적용됩니다. 미선택 시 직접 로그인합니다.");
    const form = document.createElement("form");
    form.className = "collector-form";
    const grid = document.createElement("div");
    grid.className = "form-grid";
    const name = input("shippingAccountName", "text", 80);
    const loginId = input("shippingAccountLoginId", "text", 256);
    const password = input("shippingAccountPassword", "password", 2048);
    name.required = true;
    loginId.required = true;
    grid.append(
      field("등록 이름", name),
      field("KSE ID", loginId),
      field("비밀번호", password, "수정 시 비워 두면 기존 비밀번호를 유지합니다. Windows 보안 저장소로 암호화해 저장합니다."),
    );
    const actions = document.createElement("div");
    actions.className = "form-actions";
    const saveButton = button("saveShippingAccountButton", "등록하고 사용", "primary-button");
    saveButton.type = "submit";
    const newButton = button("newShippingAccountButton", "새 계정 등록");
    const deleteButton = button("deleteShippingAccountButton", "선택 계정 삭제", "danger-button");
    actions.append(saveButton, newButton, deleteButton);
    form.append(grid, actions);
    const status = document.createElement("p");
    status.id = "shippingAccountStatus";
    status.className = "form-note";
    status.setAttribute("aria-live", "polite");
    panel.replaceChildren(heading, help, selection, form, status);

    let profiles = [];
    let selectedId = "";
    let editingId = "";
    let busy = false;
    const controls = [select, name, loginId, password, saveButton, newButton, deleteButton];

    function setBusy(value) {
      busy = value;
      for (const control of controls) control.disabled = busy;
      deleteButton.disabled = busy || !editingId;
    }

    function editProfile(profile) {
      editingId = profile?.id || "";
      name.value = profile?.name || "";
      loginId.value = profile?.loginId || "";
      password.value = "";
      password.required = !editingId;
      password.placeholder = editingId ? "변경할 때만 입력" : "KSE 비밀번호";
      saveButton.textContent = editingId ? "수정하고 사용" : "등록하고 사용";
      deleteButton.disabled = busy || !editingId;
    }

    function applySummary(summary) {
      profiles = Array.isArray(summary?.shippingAccounts) ? summary.shippingAccounts : [];
      selectedId = summary?.selectedShippingAccountId || "";
      select.replaceChildren();
      const manual = document.createElement("option");
      manual.value = "";
      manual.textContent = "직접 로그인 (자동 입력 안 함)";
      select.append(manual);
      for (const profile of profiles) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = `${profile.name} (${profile.loginId})`;
        select.append(option);
      }
      select.value = selectedId;
      editProfile(profiles.find((profile) => profile.id === selectedId));
    }

    async function perform(action) {
      if (busy) return;
      setBusy(true);
      status.textContent = "저장 중…";
      try {
        await action();
      } catch (error) {
        select.value = selectedId;
        status.textContent = error?.message || "운송장 계정을 저장하지 못했습니다.";
      } finally {
        setBusy(false);
      }
    }

    select.addEventListener("change", () => {
      const nextId = select.value;
      void perform(async () => {
        applySummary(await window.collectorApp.selectShippingAccount(nextId));
        status.textContent = selectedId
          ? "자동 입력 계정을 선택했습니다. 다음 운송정보 수집부터 적용됩니다."
          : "직접 로그인으로 변경했습니다.";
      });
    });

    newButton.addEventListener("click", () => {
      editProfile(null);
      status.textContent = "새 계정을 입력해 등록하세요. 등록하면 자동 입력 계정으로 선택됩니다.";
      name.focus();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void perform(async () => {
        const result = await window.collectorApp.saveShippingAccount({
          id: editingId,
          name: name.value,
          loginId: loginId.value,
          password: password.value,
        });
        applySummary(result.summary);
        status.textContent = "운송장 계정을 저장했습니다. 다음 운송정보 수집부터 자동 입력됩니다.";
      });
    });

    deleteButton.addEventListener("click", () => {
      if (!editingId) return;
      const profile = profiles.find((item) => item.id === editingId);
      if (!window.confirm(`"${profile?.name || "선택한 계정"}" 운송장 계정을 삭제하시겠습니까?`)) return;
      void perform(async () => {
        applySummary(await window.collectorApp.deleteShippingAccount(editingId));
        status.textContent = "운송장 계정을 삭제했습니다.";
      });
    });

    setBusy(true);
    status.textContent = "운송장 계정을 불러오는 중…";
    try {
      applySummary(await window.collectorApp.getCredentialProfiles());
      status.textContent = selectedId ? "등록 계정 자동 입력을 사용합니다." : "등록된 계정을 선택하거나 직접 로그인하세요.";
    } catch (error) {
      status.textContent = error?.message || "운송장 계정을 불러오지 못했습니다.";
      editProfile(null);
    } finally {
      setBusy(false);
    }
  }

  window.mountShippingAccounts = mountShippingAccounts;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { void mountShippingAccounts(); }, { once: true });
  } else {
    void mountShippingAccounts();
  }
})();

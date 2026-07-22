const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  getDefaults: "collector:get-defaults",
  getState: "collector:get-state",
  start: "collector:start",
  cancel: "collector:cancel",
  chooseOutputDirectory: "collector:choose-output-directory",
  saveResultFile: "collector:save-result-file",
  openResultDirectory: "collector:open-result-directory",
  showResultFile: "collector:show-result-file",
  openSettingsDirectory: "collector:open-settings-directory",
  stateChanged: "collector:state-changed",
});

/** main process의 표준 응답을 값 또는 Error로 변환한다. */
async function invoke(channel, payload) {
  const response = await ipcRenderer.invoke(channel, payload);

  if (!response?.ok) {
    throw new Error(response?.error || "Electron IPC 요청이 실패했습니다.");
  }

  return response.data;
}

/**
 * Renderer에는 필요한 수집 API만 제한적으로 공개한다.
 * ipcRenderer 자체나 Electron 전체 API는 노출하지 않는다.
 */
contextBridge.exposeInMainWorld(
  "collectorApp",
  Object.freeze({
    getDefaults: () => invoke(CHANNELS.getDefaults),
    getState: () => invoke(CHANNELS.getState),
    start: (input) => invoke(CHANNELS.start, input),
    cancel: () => invoke(CHANNELS.cancel),
    chooseOutputDirectory: () => invoke(CHANNELS.chooseOutputDirectory),
    saveResultFile: (fileType) =>
      invoke(CHANNELS.saveResultFile, { fileType }),
    openResultDirectory: () => invoke(CHANNELS.openResultDirectory),
    showResultFile: (fileType) =>
      invoke(CHANNELS.showResultFile, { fileType }),
    openSettingsDirectory: () => invoke(CHANNELS.openSettingsDirectory),

    /**
     * 상태 이벤트의 Electron event 객체는 Renderer에 전달하지 않는다.
     * 반환된 함수를 호출하면 listener를 해제할 수 있다.
     */
    onStateChanged: (callback) => {
      if (typeof callback !== "function") {
        throw new TypeError("상태 callback은 함수여야 합니다.");
      }

      const listener = (_event, state) => callback(state);

      ipcRenderer.on(CHANNELS.stateChanged, listener);

      return () => {
        ipcRenderer.removeListener(CHANNELS.stateChanged, listener);
      };
    },
  }),
);
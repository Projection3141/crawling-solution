const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  getDefaults: "collector:get-defaults",
  getState: "collector:get-state",
  start: "collector:start",
  cancel: "collector:cancel",
  uploadCartItems: "collector:upload-cart-items",
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

/** Renderer에는 필요한 API만 제한적으로 공개한다. */
contextBridge.exposeInMainWorld(
  "collectorApp",
  Object.freeze({
    getDefaults: () => invoke(CHANNELS.getDefaults),
    getState: () => invoke(CHANNELS.getState),
    start: (input) => invoke(CHANNELS.start, input),
    cancel: (runId) =>
      invoke(CHANNELS.cancel, {
        runId,
      }),
    uploadCartItems: (input) => invoke(CHANNELS.uploadCartItems, input),
    chooseOutputDirectory: () => invoke(CHANNELS.chooseOutputDirectory),
    saveResultFile: (fileType, runId = "") =>
      invoke(CHANNELS.saveResultFile, {
        fileType,
        runId,
      }),
    openResultDirectory: (runId = "") =>
      invoke(CHANNELS.openResultDirectory, {
        runId,
      }),
    showResultFile: (fileType, runId = "") =>
      invoke(CHANNELS.showResultFile, {
        fileType,
        runId,
      }),
    openSettingsDirectory: () => invoke(CHANNELS.openSettingsDirectory),

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

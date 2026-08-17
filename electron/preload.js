// electron/preload.js

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = Object.freeze({
  getDefaults: "collector:get-defaults",
  getState: "collector:get-state",
  start: "collector:start",
  cancel: "collector:cancel",
  deleteRun: "collector:delete-run",
  uploadCartItems: "collector:upload-cart-items",
  setShippingEnabled: "collector:set-shipping-enabled",
  chooseOutputDirectory: "collector:choose-output-directory",
  saveResultFile: "collector:save-result-file",
  openResultDirectory: "collector:open-result-directory",
  showResultFile: "collector:show-result-file",
  openSettingsDirectory: "collector:open-settings-directory",
  getCredentialProfiles: "collector:get-credential-profiles",
  saveProxyProfile: "collector:save-proxy-profile",
  deleteProxyProfile: "collector:delete-proxy-profile",
  saveOpenAiProfile: "collector:save-openai-profile",
  deleteOpenAiProfile: "collector:delete-openai-profile",
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
    deleteRun: (runId) =>
      invoke(CHANNELS.deleteRun, {
        runId,
      }),
    uploadCartItems: (input) => invoke(CHANNELS.uploadCartItems, input),
    setShippingEnabled: (enabled) =>
      invoke(CHANNELS.setShippingEnabled, {
        enabled: enabled === true,
      }),
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
    getCredentialProfiles: () => invoke(CHANNELS.getCredentialProfiles),
    saveProxyProfile: (profile) =>
      invoke(CHANNELS.saveProxyProfile, profile),
    deleteProxyProfile: (id) =>
      invoke(CHANNELS.deleteProxyProfile, { id }),
    saveOpenAiProfile: (profile) =>
      invoke(CHANNELS.saveOpenAiProfile, profile),
    deleteOpenAiProfile: (id) =>
      invoke(CHANNELS.deleteOpenAiProfile, { id }),

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

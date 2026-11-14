// 서버 API 설정의 파일 읽기·저장을 Electron 실행 환경과 분리한다.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ensureDir, isFile } = require("../src/utils/files");
const {
    DEFAULT_UPLOAD_API_URL,
    getUploadApiSettings,
    normalizeUploadApiSettings,
    setUploadApiSettings,
} = require("../src/utils/upload-api-settings");

const UPLOAD_API_SETTINGS_FILE_NAME = "upload-api-settings.json";

function createUploadApiSettingsResult(uploadApiUrl, source) {
    return {
        ...getUploadApiSettings(),
        uploadApiUrl,
        defaultUploadApiUrl: DEFAULT_UPLOAD_API_URL,
        isDefault: uploadApiUrl === DEFAULT_UPLOAD_API_URL,
        source,
    };
}

/** 경로와 환경변수는 앱 초기화 후의 값을 매 호출마다 읽는다. */
function createUploadApiSettingsStore({
    getUserDataDir,
    getEnvironmentUrl = () => process.env.UPLOAD_API_URL,
}) {
    function getUploadApiSettingsPath() {
        return path.join(getUserDataDir(), UPLOAD_API_SETTINGS_FILE_NAME);
    }

    function loadUploadApiSettings() {
        const settingsPath = getUploadApiSettingsPath();
        let storedUrl = "";
        let storedSettings = {};

        try {
            if (isFile(settingsPath)) {
                const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
                storedSettings = stored && typeof stored === "object" ? stored : {};
                storedUrl = String(stored?.uploadApiUrl || "").trim();
            }
        } catch (error) {
            console.warn(
                `[UPLOAD API] 저장 설정을 읽지 못해 기본값을 사용합니다: ` +
                    `${error?.message || error}`,
            );
        }

        const environmentUrl = String(getEnvironmentUrl() || "").trim();
        let source = storedUrl
            ? "user"
            : environmentUrl
                ? "environment"
                : "default";
        let uploadApiUrl;

        try {
            uploadApiUrl = setUploadApiSettings({
                ...storedSettings,
                uploadApiUrl: storedUrl || environmentUrl || DEFAULT_UPLOAD_API_URL,
            }).uploadApiUrl;
        } catch (error) {
            console.warn(
                `[UPLOAD API] 저장된 URL이 올바르지 않아 기본값으로 복원합니다: ` +
                    `${error?.message || error}`,
            );
            source = "default";
            uploadApiUrl = setUploadApiSettings({ uploadApiUrl: DEFAULT_UPLOAD_API_URL }).uploadApiUrl;
        }

        return createUploadApiSettingsResult(uploadApiUrl, source);
    }

    async function saveUploadApiSettings(payload) {
        const requestedUrl = String(payload?.uploadApiUrl || "").trim();
        const settings = normalizeUploadApiSettings({ ...getUploadApiSettings(), ...payload, uploadApiUrl: requestedUrl });
        const { uploadApiUrl } = settings;
        const settingsPath = getUploadApiSettingsPath();

        ensureDir(path.dirname(settingsPath));
        const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
            await fs.promises.rename(temporaryPath, settingsPath);
        } finally {
            await fs.promises.rm(temporaryPath, { force: true });
        }
        setUploadApiSettings(settings);

        console.log(`[UPLOAD API] URL 설정 저장: ${uploadApiUrl}`);
        return createUploadApiSettingsResult(
            uploadApiUrl,
            requestedUrl ? "user" : "default",
        );
    }

    return { loadUploadApiSettings, saveUploadApiSettings };
}

module.exports = { createUploadApiSettingsStore };

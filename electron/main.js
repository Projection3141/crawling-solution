// electron/main.js

process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    net,
    protocol,
    safeStorage,
    session,
    shell,
} = require("electron");

const {
    formatMs,
    getErrorMessage,
    isAbortError,
} = require("../src/utils/common");
const { ensureDir, isFile } = require("../src/utils/files");
const {
    getPublicDefaults,
    normalizeProxyCredentials,
    resolveOpenAiConfig,
    resolveOutputDir,
    resolveRunConfig,
} = require("../src/config");
const {
    runCartUpload,
} = require("../src/cart-uploader");
const { runCollection } = require("../src/crawler");
const { setResultUploadLogRoot } = require("../src/utils/result-uploader");
const collectionUploadLogFs = require("node:fs/promises");
const {
    createWonToYenRateScheduler,
} = require("../translate/convert");
const {
    createShippingScheduler,
} = require("../src/shipping-scheduler");
const { loadEnvironment } = require("./environment");
const { createCredentialStore } = require("./credential-store");
const {
    DEFAULT_UPLOAD_API_URL,
    getUploadApiUrl,
    normalizeUploadApiUrl,
    setUploadApiUrl,
} = require("../src/utils/upload-api-settings");

const APP_SCHEME = "mall-collector";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const APP_URL = `${APP_ORIGIN}/index.html`;
const UPLOAD_API_SETTINGS_FILE_NAME = "upload-api-settings.json";
const RENDERER_DIR = path.resolve(__dirname, "..", "public");

const CHANNELS = Object.freeze({
    getDefaults: "collector:get-defaults",
    getState: "collector:get-state",
    start: "collector:start",
    cancel: "collector:cancel",
    deleteRun: "collector:delete-run",
    uploadCartItems:
        "collector:upload-cart-items",
    setShippingEnabled:
        "collector:set-shipping-enabled",
    chooseOutputDirectory: "collector:choose-output-directory",
    saveResultFile: "collector:save-result-file",
    openResultDirectory: "collector:open-result-directory",
    showResultFile: "collector:show-result-file",
    openSettingsDirectory: "collector:open-settings-directory",
    getCredentialProfiles: "collector:get-credential-profiles",
    getUploadApiSettings: "collector:get-upload-api-settings",
    saveUploadApiSettings: "collector:save-upload-api-settings",
    getCollectionUploadLogs: "collector:get-collection-upload-logs",
    openCollectionUploadLogDirectory: "collector:open-collection-upload-log-directory",
    saveProxyProfile: "collector:save-proxy-profile",
    deleteProxyProfile: "collector:delete-proxy-profile",
    saveOpenAiProfile: "collector:save-openai-profile",
    deleteOpenAiProfile: "collector:delete-openai-profile",
    stateChanged: "collector:state-changed",
});

const RESULT_FILE_TYPES = Object.freeze({
    inventory: {
        label: "재고 CSV",
        defaultName: "inventory.csv",
    },
    summary: {
        label: "상품 요약 CSV",
        defaultName: "summary.csv",
    },
    products: {
        label: "전체 상품 CSV",
        defaultName: "products.csv",
    },
    details: {
        label: "상세 CSV",
        defaultName: "details.csv",
    },
});

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            codeCache: true,
        },
    },
]);

let mainWindow = null;
let environmentInfo = null;
let selectedOutputRoot = "";
let closePromptOpen = false;
let quitAfterRun = false;
let allowImmediateQuit = false;
let shippingScheduler = null;
let wonToYenRateScheduler = null;
let credentialStore = null;

function getUploadApiSettingsPath() {
    return path.join(
        environmentInfo?.userDataDir || app.getPath("userData"),
        UPLOAD_API_SETTINGS_FILE_NAME,
    );
}

function createUploadApiSettingsResult(uploadApiUrl, source) {
    return {
        uploadApiUrl,
        defaultUploadApiUrl: DEFAULT_UPLOAD_API_URL,
        isDefault: uploadApiUrl === DEFAULT_UPLOAD_API_URL,
        source,
    };
}

const COLLECTION_UPLOAD_LOG_DIRECTORY_NAME = "collection-upload-logs";
let collectionUploadLogRoot = "";

function getCollectionUploadLogRoot() {
    if (collectionUploadLogRoot) return collectionUploadLogRoot;

    const baseDirectory = app.isPackaged
        ? app.getPath("userData")
        : path.join(app.getPath("home"), "MallCollector");

    return path.join(
        baseDirectory,
        COLLECTION_UPLOAD_LOG_DIRECTORY_NAME,
    );
}

function loadUploadApiSettings() {
    const settingsPath = getUploadApiSettingsPath();
    let storedUrl = "";

    try {
        if (isFile(settingsPath)) {
            const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
            storedUrl = String(stored?.uploadApiUrl || "").trim();
        }
    } catch (error) {
        console.warn(
            `[UPLOAD API] 저장 설정을 읽지 못해 기본값을 사용합니다: ` +
                `${error?.message || error}`,
        );
    }

    const environmentUrl = String(process.env.UPLOAD_API_URL || "").trim();
    let source = storedUrl
        ? "user"
        : environmentUrl
            ? "environment"
            : "default";
    let uploadApiUrl;

    try {
        uploadApiUrl = setUploadApiUrl(
            storedUrl || environmentUrl || DEFAULT_UPLOAD_API_URL,
        );
    } catch (error) {
        console.warn(
            `[UPLOAD API] 저장된 URL이 올바르지 않아 기본값으로 복원합니다: ` +
                `${error?.message || error}`,
        );
        source = "default";
        uploadApiUrl = setUploadApiUrl(DEFAULT_UPLOAD_API_URL);
    }

    return createUploadApiSettingsResult(uploadApiUrl, source);
}

async function saveUploadApiSettings(payload) {
    const requestedUrl = String(payload?.uploadApiUrl || "").trim();
    const uploadApiUrl = normalizeUploadApiUrl(
        requestedUrl || DEFAULT_UPLOAD_API_URL,
    );
    const settingsPath = getUploadApiSettingsPath();

    ensureDir(path.dirname(settingsPath));
    await fs.promises.writeFile(
        settingsPath,
        `${JSON.stringify({ uploadApiUrl }, null, 2)}\n`,
        "utf8",
    );
    setUploadApiUrl(uploadApiUrl);

    console.log(`[UPLOAD API] URL 설정 저장: ${uploadApiUrl}`);
    return createUploadApiSettingsResult(
        uploadApiUrl,
        requestedUrl ? "user" : "default",
    );
}

/**
 * 여러 수집 작업을 동시에 실행하기 위한 상태 저장소.
 *
 * activeRuns: 현재 실행 중인 작업
 * runStates: Renderer에 표시할 전체 실행 이력
 * runResults: 실행별 결과 파일 경로
 */
const activeRuns = new Map();
const runStates = new Map();
const runResults = new Map();

/**
 * 장바구니 작업 중인 계정만 수집 시작을 제한한다.
 *
 * Map을 사용해 잠금 여부뿐 아니라 화면에 표시할 계정 정보도 함께 보관한다.
 * key 형식은 계정 ID를 우선 사용하고, ID가 없을 때만 로컬 계정 식별자를 사용한다.
 */
const cartAccountLocks = new Map();
/**
 * 수집 작업에서 동일 사이트·계정 동시 실행을 제한한다.
 */
const collectionAccountLocks = new Map();

let activeCartUpload = null;
let latestCompletedRunId = "";

/** 결과 파일의 공개 가능 상태만 생성한다. */
function createPublicFileState(files = null) {
    return Object.fromEntries(
        Object.entries(RESULT_FILE_TYPES).map(([key, metadata]) => [
            key,
            {
                key,
                label: metadata.label,
                name: metadata.defaultName,
                available: Boolean(files?.[key] && isFile(files[key])),
            },
        ]),
    );
}

/** 객체를 IPC structured clone에 안전한 순수 데이터로 복제한다. */
function cloneForRenderer(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 전체 실행 상태를 Renderer 전용 객체로 변환한다. */
function createPublicApplicationState() {
    const runs = Array.from(runStates.values()).sort(
        (a, b) => Number(b.startedAtMs || 0) - Number(a.startedAtMs || 0),
    );

    return {
        runs,
        activeRunCount: activeRuns.size,
        latestCompletedRunId,
        outputDirectory: selectedOutputRoot,
        cart: {
            running: Boolean(activeCartUpload),
            startedAtMs: activeCartUpload?.startedAtMs || null,
            lockedAccountCount: cartAccountLocks.size,
        },
        shipping: shippingScheduler?.getState() || {
            enabled: false,
            running: false,
            intervalMs: 60 * 60 * 1000,
            lastStartedAt: null,
            lastFinishedAt: null,
            lastSuccessAt: null,
            lastRecordCount: 0,
            lastError: "",
            nextRunAt: null,
        },
    };
}

/** 현재 전체 상태를 Renderer에 전송한다. */
function emitState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    mainWindow.webContents.send(
        CHANNELS.stateChanged,
        cloneForRenderer(createPublicApplicationState()),
    );
}

/** 특정 실행 상태 일부를 갱신하고 Renderer에 전달한다. */
function updateRunState(runId, patch) {
    const current = runStates.get(runId);

    if (!current) return;

    runStates.set(runId, {
        ...current,
        ...patch,
    });

    emitState();
}

/** 특정 실행의 진행 상태를 갱신한다. */
function updateRunProgress(runId, progress) {
    const current = runStates.get(runId);

    if (!current) return;

    const elapsedMs =
        Number(progress?.elapsedMs) ||
        (current.startedAtMs ? Date.now() - current.startedAtMs : 0);

    updateRunState(runId, {
        progress: {
            ...current.progress,
            ...progress,
            elapsedMs,
            elapsedText: progress?.elapsedText || formatMs(elapsedMs),
        },
    });
}

/** 사이트와 계정으로 동시 실행 충돌 검사에 사용할 key를 만든다. */
function createAccountLockKey(site, localCredentialId, accountId) {
    const normalizedSite = String(site || "").trim().toLowerCase();
    const credentialId = String(localCredentialId || "").trim();
    const loginId = String(accountId || "").trim();

    if (!normalizedSite) return "";

    /**
     * 같은 로그인 계정을 로컬 계정 목록에 중복 저장해도 같은 계정으로 판정해야 한다.
     * 따라서 localCredentialId보다 실제 로그인 ID를 우선한다.
     */
    if (loginId) return `${normalizedSite}:login:${loginId}`;
    if (credentialId) return `${normalizedSite}:credential:${credentialId}`;

    return `${normalizedSite}:env`;
}

/** 쇼핑몰 key를 사용자에게 표시할 한글 이름으로 바꾼다. */
function getMallLabel(site) {
    return site === "cheonyu"
        ? "천유닷컴"
        : site === "ccdome"
            ? "과자생각"
            : String(site || "쇼핑몰");
}

/** 충돌 안내에 사용할 계정 이름을 만든다. */
function formatAccountLabel(site, accountName, accountId) {
    const mallLabel = getMallLabel(site);
    const name = String(accountName || "").trim();
    const loginId = String(accountId || "").trim();

    if (name && loginId) {
        return `${mallLabel} 계정 '${name}' (ID: ${loginId})`;
    }

    if (name) return `${mallLabel} 계정 '${name}'`;
    if (loginId) return `${mallLabel} 계정 (ID: ${loginId})`;

    return `${mallLabel} 계정`;
}

/** 장바구니 계정 잠금을 등록하고 안내용 계정 정보도 저장한다. */
function lockCartAccount(accountKey, site, account) {
    if (!accountKey) return;

    cartAccountLocks.set(accountKey, {
        site,
        accountName: String(account?.accountName || ""),
        accountId: String(account?.accountId || ""),
    });
}

/** 수집 계정 잠금을 등록한다. */
function lockCollectionAccount(accountKey, site, account) {
    if (!accountKey) return;

    collectionAccountLocks.set(accountKey, {
        site,
        accountName: String(account?.accountName || ""),
        accountId: String(account?.accountId || ""),
        startedAtMs: Date.now(),
    });
}

/** 같은 계정을 사용 중인 수집 작업을 찾는다. */
function findActiveRunByAccountKey(accountKey) {
    if (!accountKey) return null;

    return (
        Array.from(activeRuns.values()).find(
            (run) => run.accountKey === accountKey,
        ) || null
    );
}

/** 동일 천유 프록시 연결의 동시 실행을 막기 위한 key를 만든다. */
function createProxySlotLockKey(config) {
    if (config?.mall !== "cheonyu") return "";

    if (!config?.proxy) {
        return "cheonyu:direct";
    }

    const fingerprint = createHash("sha256")
        .update(String(config.proxy.server || ""))
        .update("\0")
        .update(String(config.proxy.username || ""))
        .digest("hex")
        .slice(0, 16);

    return `cheonyu:proxy:profile:${fingerprint}`;
}

/** 천유 네트워크 잠금 key를 사용자용 이름으로 바꾼다. */
function formatProxySlotLockLabel(proxySlotKey) {
    if (proxySlotKey === "cheonyu:direct") return "천유 직접 연결";
    if (String(proxySlotKey || "").startsWith("cheonyu:proxy:profile:")) {
        return "천유 등록 프록시";
    }

    return "천유 프록시";
}

/** 같은 천유 프록시 연결을 사용 중인 수집 작업을 찾는다. */
function findActiveRunByProxySlotKey(proxySlotKey) {
    if (!proxySlotKey) return null;

    return (
        Array.from(activeRuns.values()).find(
            (run) => run.proxySlotKey === proxySlotKey,
        ) || null
    );
}

/** 종료 대기 중이며 모든 작업이 끝났으면 앱을 종료한다. */
function maybeQuitAfterWork() {
    if (!quitAfterRun) return;
    if (activeRuns.size > 0 || activeCartUpload) return;

    allowImmediateQuit = true;
    app.quit();
}

/** IPC 요청이 로컬 Renderer 창에서 발생했는지 확인한다. */
function assertTrustedSender(event) {
    const senderUrl =
        event.senderFrame?.url ||
        event.sender?.getURL?.() ||
        "";

    if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        !senderUrl.startsWith(`${APP_ORIGIN}/`)
    ) {
        throw new Error("허용되지 않은 Electron IPC 요청입니다.");
    }
}

function summarizeCollectionUploadLog(log, dateDirectory, fileName) {
    const products = Array.isArray(log?.request?.data)
        ? log.request.data
        : [];
    const sampleProductIds = products
        .map(
            (product) =>
                product?.productId ?? product?.product_id ?? product?.id,
        )
        .filter(
            (value) =>
                value !== undefined &&
                value !== null &&
                String(value).trim(),
        )
        .slice(0, 5)
        .map(String);

    return {
        dateDirectory,
        fileName,
        sentAt: log?.sentAt || null,
        success: log?.success === true,
        type: log?.type || log?.request?.type || "수집정보",
        itemCount: Number.isFinite(log?.itemCount)
            ? log.itemCount
            : products.length,
        uploadApiUrl: log?.uploadApiUrl || "",
        status: log?.response?.status ?? null,
        error: log?.error || "",
        sampleProductIds,
    };
}

async function listCollectionUploadLogs(payload = {}) {
    const root = getCollectionUploadLogRoot();
    const pageSize = 5;
    const requestedPage = Math.max(
        1,
        Number.parseInt(payload?.page, 10) || 1,
    );
    await collectionUploadLogFs.mkdir(root, { recursive: true });

    const dateDirectories = (
        await collectionUploadLogFs.readdir(root, { withFileTypes: true })
    )
        .filter(
            (entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a));
    const files = [];

    for (const dateDirectory of dateDirectories) {
        const directory = path.join(root, dateDirectory);
        const names = (
            await collectionUploadLogFs.readdir(directory, {
                withFileTypes: true,
            })
        )
            .filter(
                (entry) =>
                    entry.isFile() &&
                    entry.name.toLowerCase().endsWith(".json"),
            )
            .map((entry) => entry.name)
            .sort((a, b) => b.localeCompare(a));
        names.forEach((fileName) =>
            files.push({ dateDirectory, fileName }),
        );
    }

    const totalCount = files.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const selectedFiles = files.slice(
        (page - 1) * pageSize,
        page * pageSize,
    );
    const items = await Promise.all(
        selectedFiles.map(async ({ dateDirectory, fileName }) => {
            try {
                const content = await collectionUploadLogFs.readFile(
                    path.join(root, dateDirectory, fileName),
                    "utf8",
                );
                return summarizeCollectionUploadLog(
                    JSON.parse(content),
                    dateDirectory,
                    fileName,
                );
            } catch (error) {
                return {
                    dateDirectory,
                    fileName,
                    sentAt: null,
                    success: false,
                    type: "로그 읽기 실패",
                    itemCount: null,
                    uploadApiUrl: "",
                    status: null,
                    error: error?.message || String(error),
                    sampleProductIds: [],
                };
            }
        }),
    );

    return { page, pageSize, totalCount, totalPages, items, root };
}

/** IPC 오류를 직렬화 가능한 표준 응답으로 변환한다. */
function registerIpcHandler(channel, handler) {
    ipcMain.handle(channel, async (event, payload) => {
        try {
            assertTrustedSender(event);

            return {
                ok: true,
                data: await handler(payload),
            };
        } catch (error) {
            return {
                ok: false,
                error: getErrorMessage(error),
            };
        }
    });
}

/** 실행 ID를 사람이 구분하기 쉬운 문자열로 만든다. */
function createRunId() {
    const time = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "");

    return `${time}-${randomUUID().slice(0, 8)}`;
}

/** 실행 입력에서 허용할 필드만 새 객체로 복사한다. */
function normalizeRunInput(input) {
    const source = input && typeof input === "object" ? input : {};

    const allowedKeys = [
        "mall",
        "category",

        "accountId",
        "accountPw",
        "accountName",
        "localCredentialId",

        "showBrowser",

        "collectionMode",
        "executionOptions",

        "pageStart",
        "pageEnd",
        "maxPerPage",

        "detailTargetMode",
        "detailRequestDelayMs",
        "proxyProfileId",
        "cheonyuUserAgent",
        "openAiProfileId",

        "cartQty",
        "clearCartBefore",
        "clearCartAfter",
        "lowStockThreshold",
        "requestDelayMs",
        "navigationTimeoutMs",
    ];

    return Object.fromEntries(
        allowedKeys
            .filter((key) => Object.hasOwn(source, key))
            .map((key) => [key, source[key]]),
    );
}

function ensureCredentialStore() {
    if (!credentialStore) {
        throw new Error("프록시/API 키 저장소가 초기화되지 않았습니다.");
    }

    return credentialStore;
}

/** 프로필 ID를 main process 내부에서만 실제 프록시 인증정보로 변환한다. */
function resolveProxyProfileInput(profileId) {
    const normalizedId = String(profileId || "").trim();
    if (!normalizedId) return {};

    const profile = ensureCredentialStore().getProxy(normalizedId);

    return {
        cheonyuProxyProfileId: profile.id,
        cheonyuProxyProfileName: profile.name,
        cheonyuProxyServer: profile.server,
        cheonyuProxyUsername: profile.username,
        cheonyuProxyPassword: profile.password,
    };
}

/** 선택 프로필부터 등록 순서대로 순환할 천유 프록시 목록을 만든다. */
function resolveProxyRotationInput(profileId) {
    const selected = resolveProxyProfileInput(profileId);

    if (!selected.cheonyuProxyProfileId) return selected;

    const profiles = ensureCredentialStore().getProxies();
    const startIndex = profiles.findIndex(
        (profile) => profile.id === selected.cheonyuProxyProfileId,
    );

    if (startIndex < 0) return selected;

    const orderedProfiles = [
        ...profiles.slice(startIndex),
        ...profiles.slice(0, startIndex),
    ];

    return {
        ...selected,
        cheonyuProxyRotation: orderedProfiles.map((profile) => ({
            profileId: profile.id,
            profileName: profile.name,
            server: profile.server,
            username: profile.username,
            password: profile.password,
        })),
    };
}

/** 선택된 API 키 프로필을 main process 내부 OpenAI 설정으로 고정한다. */
function resolveOpenAiProfile(profileId) {
    const normalizedId = String(profileId || "").trim();

    if (!normalizedId) {
        throw new Error("OpenAI API 키를 선택하세요.");
    }

    const profile = ensureCredentialStore().getOpenAiKey(normalizedId);

    return {
        profileId: profile.id,
        profileName: profile.name,
        config: Object.freeze(
            resolveOpenAiConfig({
                openaiApiKey: profile.apiKey,
            }),
        ),
    };
}


/** 수집 설정에서 장바구니 계정 잠금용 key를 만든다. */
function createCollectionAccountKey(config, safeInput) {
    return createAccountLockKey(
        config.mall,
        safeInput.localCredentialId,
        config.accountId,
    );
}

/** Renderer에 노출할 실행 요청 요약을 만든다. */
function createPublicRunRequest(config, safeInput) {
    return {
        mall: config.mall,
        collectionMode:
            safeInput.collectionMode === "detail" ? "detail" : "general",
        detailTargetMode:
            safeInput.collectionMode === "detail"
                ? config.detailTargetMode === "pending"
                    ? "pending"
                    : "all"
                : null,
        accountName:
            String(safeInput.accountName || "").trim() ||
            (safeInput.localCredentialId ? "등록 계정" : ".env 계정"),
        localCredentialId: String(safeInput.localCredentialId || ""),
        proxyEnabled: Boolean(config.proxy),
        proxySource: config.proxySource || "none",
        proxyProfileName: config.proxyProfileName || "",
        executionOptions: safeInput.executionOptions || {
            runMode: "once",
        },
    };
}

const SUPPORTED_CART_SITES = new Set(["cheonyu", "ccdome"]);

/** 일괄 요청에 포함된 상품 한 건을 검증한다. */
function normalizeCartItem(item, index = 0) {
    const source = item && typeof item === "object" ? item : {};
    const site = String(source.site || "").trim();
    const productId = String(source.productId || "").trim();
    const optionId = String(source.optionId ?? "").trim();
    const quantity = Math.trunc(Number(source.quantity));

    if (!SUPPORTED_CART_SITES.has(site)) {
        throw new Error(`${index + 1}번째 상품의 site가 올바르지 않습니다.`);
    }

    if (!/^\d+$/.test(productId)) {
        throw new Error(`${index + 1}번째 상품 ID가 올바르지 않습니다.`);
    }

    if (site === "cheonyu" && !/^\d+$/.test(optionId)) {
        throw new Error(`${index + 1}번째 천유 옵션 ID가 올바르지 않습니다.`);
    }

    if (site === "ccdome" && optionId) {
        throw new Error(`${index + 1}번째 과자생각 상품의 optionId는 비워야 합니다.`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
        throw new Error(`${index + 1}번째 수량은 1 이상의 정수여야 합니다.`);
    }

    return {
        productId,
        optionId,
        quantity,
        site,
    };
}

/** 같은 사이트·상품·옵션 요청이 중복되면 수량을 합친다. */
function mergeDuplicateCartItems(items) {
    const map = new Map();

    for (const item of items) {
        const key = `${item.site}:${item.productId}:${item.optionId}`;
        const previous = map.get(key);

        if (previous) {
            previous.quantity += item.quantity;
        } else {
            map.set(key, { ...item });
        }
    }

    return Array.from(map.values());
}

/** 상품 목록을 사이트별 배열로 분리한다. */
function splitCartItemsBySite(items) {
    const result = {
        cheonyu: [],
        ccdome: [],
    };

    for (const item of items) {
        result[item.site].push(item);
    }

    return result;
}

/** 사이트별 로컬 로그인 계정을 검증한다. */
function getCartAccount(accounts, site) {
    const source = accounts?.[site];
    const accountId = String(source?.accountId || "").trim();
    const accountPw = String(source?.accountPw || "");

    if (!accountId || !accountPw) {
        throw new Error(`${site} 장바구니 계정이 선택되지 않았습니다.`);
    }

    return {
        accountId,
        accountPw,
        accountName: String(source?.accountName || ""),
        localCredentialId: String(source?.localCredentialId || ""),
    };
}

/** uploader 응답에서 상품 배열을 추출하고 각 항목을 검증한다. */
function extractUploaderCartItems(responseData) {
    const candidate = Array.isArray(responseData)
        ? responseData
        : Array.isArray(responseData?.data)
            ? responseData.data
            : Array.isArray(responseData?.items)
                ? responseData.items
                : Array.isArray(responseData?.data?.items)
                    ? responseData.data.items
                    : null;

    if (!candidate) {
        throw new Error("Uploader 응답이 상품 배열 형식이 아닙니다.");
    }

    if (candidate.length < 1) {
        throw new Error("Uploader에서 받은 장바구니 상품이 없습니다.");
    }

    return candidate.map((item, index) => normalizeCartItem(item, index));
}

/** uploader API를 한 번 호출해 전체 장바구니 상품 배열을 가져온다. */
async function fetchUploaderCartItems(signal) {
    const url = new URL(getUploadApiUrl());

    console.log("[CART UPLOADER GET]", url.toString());

    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    signal?.addEventListener("abort", abortFromParent, {
        once: true,
    });

    try {
        const response = await net.fetch(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json, text/plain, */*",
            },
            redirect: "follow",
            signal: controller.signal,
        });
        const responseText = await response.text();
        let responseData = responseText;

        try {
            responseData = responseText ? JSON.parse(responseText) : null;
        } catch {
            throw new Error("Uploader 응답이 올바른 JSON 형식이 아닙니다.");
        }

        if (!response.ok) {
            const serverMessage =
                responseData && typeof responseData === "object"
                    ? responseData?.message || responseData?.error
                    : responseData;

            throw new Error(
                serverMessage || `Uploader 요청 실패: HTTP ${response.status}`,
            );
        }

        const items = extractUploaderCartItems(responseData);

        console.log("[CART UPLOADER RESPONSE]", items);

        return {
            items,
            status: response.status,
            response: responseData,
        };
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("Uploader 요청이 취소되었거나 시간이 초과되었습니다.");
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abortFromParent);
    }
}

/** 장바구니용 공통 실행 설정을 생성한다. */
function createCartRunConfig(site, account, input, proxyProfileInput = {}) {
    return resolveRunConfig(
        {
            mall: site,
            category: site === "cheonyu" ? "-1" : "017",
            accountId: account.accountId,
            accountPw: account.accountPw,
            accountName: account.accountName,
            localCredentialId: account.localCredentialId,
            ...(site === "cheonyu" ? proxyProfileInput : {}),
            cheonyuUserAgent: input?.cheonyuUserAgent,
            showBrowser: input?.showBrowser === true,
            pageStart: 1,
            pageEnd: 0,
            clearCartBefore: false,
            clearCartAfter: false,
            outDir: selectedOutputRoot,
        },
        process.env,
        getDefaultOutputRoot(),
    );
}

/** GET 응답 배열을 사이트별로 분리해 실제 장바구니에 담는다. */
async function uploadCartItems(input) {
    if (activeCartUpload) {
        throw new Error("이미 다른 장바구니 담기 작업이 실행 중입니다.");
    }

    const controller = new AbortController();
    const lockedAccountKeys = new Set();
    const lockedProxySlotKeys = new Set();
    const preselectedAccounts = {};
    const preselectedAccountKeys = {};
    const preselectedConfigs = {};
    const proxyProfileInput = resolveProxyProfileInput(input?.proxyProfileId);

    /**
     * 1) 화면에서 선택된 계정을 먼저 정규화한다.
     *
     * 이 단계에서는 아직 잠금을 걸지 않는다. 여러 사이트 계정 중 하나라도
     * 이미 수집에 사용 중이면 중간에 생성된 잠금이 남지 않도록 하기 위함이다.
     */
    for (const site of ["cheonyu", "ccdome"]) {
        const source = input?.accounts?.[site];
        const accountId = String(source?.accountId || "").trim();
        const accountPw = String(source?.accountPw || "");

        if (!accountId || !accountPw) continue;

        const account = {
            accountId,
            accountPw,
            accountName: String(source?.accountName || ""),
            localCredentialId: String(source?.localCredentialId || ""),
        };
        const accountKey = createAccountLockKey(
            site,
            account.localCredentialId,
            account.accountId,
        );

        preselectedAccounts[site] = account;
        preselectedAccountKeys[site] = accountKey;

        const config = createCartRunConfig(site, account, input, proxyProfileInput);
        const proxySlotKey = createProxySlotLockKey(config);

        preselectedConfigs[site] = config;
        if (proxySlotKey) lockedProxySlotKeys.add(proxySlotKey);
    }

    for (const proxySlotKey of lockedProxySlotKeys) {
        const conflictingRun = findActiveRunByProxySlotKey(proxySlotKey);

        if (!conflictingRun) continue;

        throw new Error(
            `${formatProxySlotLockLabel(proxySlotKey)}에서 이미 수집 작업이 진행 중입니다. ` +
            "같은 IP의 요청이 겹치지 않도록 기존 작업이 끝난 후 다시 실행하세요.",
        );
    }

    /**
     * 2) Uploader GET 요청 전에 같은 계정의 수집 작업을 검사한다.
     *
     * 이전에는 Uploader 응답을 받은 뒤 충돌을 검사했기 때문에, 수집 중에
     * 장바구니 담기를 누르면 계정 충돌 문구보다 Uploader 응답 오류가 먼저
     * 표시될 수 있었다. 이제 동시 실행 시도를 즉시 차단한다.
     */
    for (const site of ["cheonyu", "ccdome"]) {
        const account = preselectedAccounts[site];
        const accountKey = preselectedAccountKeys[site];

        if (!account || !accountKey) continue;

        const conflictingRun = findActiveRunByAccountKey(accountKey);

        if (!conflictingRun) continue;

        const runState = runStates.get(conflictingRun.id);
        const modeLabel =
            runState?.request?.collectionMode === "detail"
                ? "상세 수집"
                : "일반 수집";
        const accountLabel = formatAccountLabel(
            site,
            account.accountName,
            account.accountId,
        );

        throw new Error(
            `${accountLabel}으로 현재 ${modeLabel}이 진행 중입니다. ` +
            `같은 계정으로 수집과 장바구니 담기를 동시에 실행할 수 없어 ` +
            `장바구니 담기에 실패했습니다. ` +
            `해당 수집이 끝난 후 다시 시도하거나 다른 계정을 선택하세요.`,
        );
    }

    /**
     * 3) 충돌이 없으면 선택된 계정을 즉시 잠근다.
     * Uploader GET 대기 중에도 같은 계정으로 새 수집을 시작할 수 없다.
     */
    for (const site of ["cheonyu", "ccdome"]) {
        const account = preselectedAccounts[site];
        const accountKey = preselectedAccountKeys[site];

        if (!account || !accountKey) continue;

        lockedAccountKeys.add(accountKey);
        lockCartAccount(accountKey, site, account);
    }

    activeCartUpload = {
        controller,
        startedAtMs: Date.now(),
        accountKeys: lockedAccountKeys,
        proxySlotKeys: lockedProxySlotKeys,
    };
    emitState();

    try {
        const fetched = await fetchUploaderCartItems(controller.signal);
        const normalizedItems = fetched.items;
        const grouped = splitCartItemsBySite(normalizedItems);
        const accounts = {};

        /**
         * 실제 Uploader 응답에 포함되지 않은 사이트 계정은 더 이상 잠글 필요가 없다.
         */
        for (const site of ["cheonyu", "ccdome"]) {
            if (grouped[site].length > 0) continue;

            const account = preselectedAccounts[site];
            if (!account) continue;

            const unusedKey = createAccountLockKey(
                site,
                account.localCredentialId,
                account.accountId,
            );

            lockedAccountKeys.delete(unusedKey);
            cartAccountLocks.delete(unusedKey);

            const unusedProxySlotKey = createProxySlotLockKey(
                preselectedConfigs[site],
            );
            if (unusedProxySlotKey) {
                lockedProxySlotKeys.delete(unusedProxySlotKey);
            }
        }
        emitState();

        /**
         * 응답에 실제로 포함된 사이트의 계정을 검증한다.
         * 같은 계정으로 수집 중이면 장바구니 담기를 시작하지 않는다.
         */
        for (const site of ["cheonyu", "ccdome"]) {
            if (grouped[site].length < 1) continue;

            const account = preselectedAccounts[site] ||
                getCartAccount(input?.accounts, site);
            const accountKey = createAccountLockKey(
                site,
                account.localCredentialId,
                account.accountId,
            );
            const conflictingRun = findActiveRunByAccountKey(accountKey);

            if (conflictingRun) {
                const runState = runStates.get(conflictingRun.id);
                const modeLabel =
                    runState?.request?.collectionMode === "detail"
                        ? "상세 수집"
                        : "일반 수집";
                const accountLabel = formatAccountLabel(
                    site,
                    account.accountName,
                    account.accountId,
                );

                throw new Error(
                    `${accountLabel}으로 현재 ${modeLabel}이 진행 중입니다. ` +
                    `같은 계정으로 수집과 장바구니 담기를 동시에 실행할 수 없어 ` +
                    `장바구니 담기에 실패했습니다. ` +
                    `해당 수집이 끝난 후 다시 시도하거나 다른 계정을 선택하세요.`,
                );
            }

            accounts[site] = account;
            lockedAccountKeys.add(accountKey);
            lockCartAccount(accountKey, site, account);

            const config =
                preselectedConfigs[site] ||
                createCartRunConfig(site, account, input, proxyProfileInput);
            const proxySlotKey = createProxySlotLockKey(config);

            preselectedConfigs[site] = config;
            if (proxySlotKey) lockedProxySlotKeys.add(proxySlotKey);
        }
        emitState();

        const results = {};

        for (const site of ["cheonyu", "ccdome"]) {
            const siteItems = grouped[site];

            if (siteItems.length < 1) continue;

            const account = accounts[site];
            const config = preselectedConfigs[site];

            const cartItems = mergeDuplicateCartItems(siteItems);
            const cartResult = await runCartUpload(config, cartItems, {
                signal: controller.signal,
                onProgress: (progress) => {
                    console.log(`[CART ${site}]`, progress.message);
                },
            });

            results[site] = {
                ...cartResult,
                requestCount: siteItems.length,
            };
        }

        return {
            success: true,
            requestCount: normalizedItems.length,
            items: normalizedItems,
            uploader: {
                status: fetched.status,
            },
            results,
        };
    } finally {
        for (const key of lockedAccountKeys) {
            cartAccountLocks.delete(key);
        }

        activeCartUpload = null;
        emitState();
        maybeQuitAfterWork();
    }
}

/** Playwright 수집을 백그라운드 Promise로 실행한다. */
async function executeCollection(run, config) {
    try {
        const result = await runCollection(config, {
            runId: run.id,
            signal: run.controller.signal,
            openAi: run.openAi,
            onProgress: (progress) => {
                if (!activeRuns.has(run.id)) return;
                updateRunProgress(run.id, progress);
            },
        });

        const resultDirectory = path.dirname(result.files.inventory);
        const finishedAtMs = Date.now();
        const excludedProductCount = Math.max(
            0,
            Number(result.payload.summary?.excludedProductCount) || 0,
        );

        runResults.set(run.id, {
            files: result.files,
            directory: resultDirectory,
        });
        latestCompletedRunId = run.id;

        const current = runStates.get(run.id);

        updateRunState(run.id, {
            status: "completed",
            finishedAtMs,
            summary: result.payload.summary,
            outputDirectory: resultDirectory,
            files: createPublicFileState(result.files),
            error: "",
            progress: {
                ...current?.progress,
                stage: "completed",
                message: excludedProductCount > 0
                    ? `수집과 파일 저장이 완료되었습니다. 상품 체크박스 또는 ` +
                      `수량 입력 비활성화로 장바구니 재고 수집에서 ` +
                      `${excludedProductCount}개 상품을 제외했습니다.`
                    : "수집과 파일 저장이 완료되었습니다.",
                elapsedMs: finishedAtMs - run.startedAtMs,
                elapsedText: formatMs(finishedAtMs - run.startedAtMs),
            },
        });
    } catch (error) {
        const canceled =
            run.controller.signal.aborted ||
            isAbortError(error);
        const finishedAtMs = Date.now();
        const current = runStates.get(run.id);

        updateRunState(run.id, {
            status: canceled ? "canceled" : "failed",
            finishedAtMs,
            summary: null,
            files: createPublicFileState(),
            outputDirectory: "",
            error: canceled ? "" : getErrorMessage(error),
            progress: {
                ...current?.progress,
                stage: canceled ? "canceled" : "failed",
                message: canceled
                    ? "사용자 요청으로 수집을 취소했습니다."
                    : "수집 작업이 실패했습니다.",
                elapsedMs: finishedAtMs - run.startedAtMs,
                elapsedText: formatMs(finishedAtMs - run.startedAtMs),
            },
        });
    } finally {
        collectionAccountLocks.delete(run.accountKey);
        activeRuns.delete(run.id);
        emitState();
        maybeQuitAfterWork();
    }
}

/** 새 수집 작업을 시작하고 즉시 해당 실행 상태를 반환한다. */
function startCollection(input) {
    const safeInput = normalizeRunInput(input);
    const mall = String(safeInput.mall || "cheonyu").trim().toLowerCase();
    const proxyProfileInput = mall === "cheonyu"
        ? resolveProxyRotationInput(safeInput.proxyProfileId)
        : {};
    const openAiProfile = resolveOpenAiProfile(safeInput.openAiProfileId);
    const openAi = openAiProfile.config;
    const config = resolveRunConfig(
        {
            ...safeInput,
            ...proxyProfileInput,
            outDir: selectedOutputRoot,
        },
        process.env,
        getDefaultOutputRoot(),
    );
    const accountKey = createCollectionAccountKey(config, safeInput);
    const proxySlotKey = createProxySlotLockKey(config);

    if (cartAccountLocks.has(accountKey)) {
        const lockInfo = cartAccountLocks.get(accountKey) || {};
        const accountLabel = formatAccountLabel(
            config.mall,
            safeInput.accountName || lockInfo.accountName,
            config.accountId || lockInfo.accountId,
        );
        const modeLabel =
            safeInput.collectionMode === "detail" ? "상세 수집" : "일반 수집";

        throw new Error(
            `${accountLabel}으로 현재 장바구니 담기 작업이 진행 중입니다. ` +
            `같은 계정으로 장바구니 담기와 ${modeLabel}을 동시에 실행할 수 없어 ` +
            `${modeLabel} 시작에 실패했습니다. ` +
            `장바구니 작업이 끝난 후 다시 시도하거나 다른 계정을 선택하세요.`,
        );
    }

    const conflictingAccountRun = findActiveRunByAccountKey(accountKey);

    if (conflictingAccountRun) {
        const accountLabel = formatAccountLabel(
            config.mall,
            safeInput.accountName,
            config.accountId,
        );

        throw new Error(
            `${accountLabel} 계정으로 이미 수집 작업이 진행 중입니다. ` +
            "같은 계정의 장바구니를 공유하므로 다른 프록시에서도 동시에 실행할 수 없습니다.",
        );
    }

    if (collectionAccountLocks.has(accountKey)) {
        const lockInfo = collectionAccountLocks.get(accountKey) || {};
        const accountLabel = formatAccountLabel(
            config.mall,
            safeInput.accountName || lockInfo.accountName,
            config.accountId || lockInfo.accountId,
        );
        const modeLabel =
            safeInput.collectionMode === "detail" ? "상세 수집" : "일반 수집";

        throw new Error(
            `${accountLabel} 계정으로 이미 수집 작업이 진행 중입니다. ` +
            `같은 계정으로 수집을 동시에 실행할 수 없어 ` +
            `${modeLabel} 시작에 실패했습니다. ` +
            `현재 작업이 끝난 후 다시 시도하세요.`,
        );
    }

    const conflictingProxyRun = findActiveRunByProxySlotKey(proxySlotKey);

    if (conflictingProxyRun) {
        throw new Error(
            `${formatProxySlotLockLabel(proxySlotKey)}에서 이미 수집 작업이 진행 중입니다. ` +
            "같은 IP의 요청이 겹치지 않도록 기존 작업이 끝난 후 다시 실행하세요.",
        );
    }

    if (proxySlotKey && activeCartUpload?.proxySlotKeys?.has(proxySlotKey)) {
        throw new Error(
            `${formatProxySlotLockLabel(proxySlotKey)}에서 장바구니 작업이 진행 중입니다. ` +
            "같은 IP의 요청이 겹치지 않도록 기존 작업이 끝난 후 다시 실행하세요.",
        );
    }

    const id = createRunId();
    const controller = new AbortController();
    const startedAtMs = Date.now();
    const run = {
        id,
        controller,
        startedAtMs,
        accountKey,
        proxySlotKey,
        openAi,
    };
    const runState = {
        id,
        status: "running",
        startedAtMs,
        finishedAtMs: null,
        request: createPublicRunRequest(config, safeInput),
        progress: {
            stage: "queued",
            message: "수집 작업을 준비하고 있습니다.",
            elapsedMs: 0,
            elapsedText: "0ms",
        },
        summary: null,
        outputDirectory: "",
        files: createPublicFileState(),
        error: "",
    };

    lockCollectionAccount(accountKey, config.mall, {
        accountName: safeInput.accountName,
        accountId: config.accountId,
    });

    activeRuns.set(id, run);
    runStates.set(id, runState);
    emitState();

    void executeCollection(run, config);

    return cloneForRenderer(runState);
}

/** 실행 ID에 해당하는 수집 작업만 취소한다. */
function cancelCollection(payload) {
    const requestedRunId = String(
        typeof payload === "string" ? payload : payload?.runId || "",
    ).trim();
    const fallbackRun =
        Array.from(activeRuns.values()).sort(
            (a, b) => b.startedAtMs - a.startedAtMs,
        )[0] || null;
    const run = activeRuns.get(requestedRunId) || fallbackRun;

    if (!run) {
        return cloneForRenderer(createPublicApplicationState());
    }

    const current = runStates.get(run.id);

    updateRunState(run.id, {
        status: "canceling",
        progress: {
            ...current?.progress,
            stage: "canceling",
            message: "브라우저를 종료하고 수집을 취소하고 있습니다.",
        },
    });

    run.controller.abort();

    return cloneForRenderer(createPublicApplicationState());
}

/** 삭제 후 남은 완료 실행 중 가장 최근 실행 ID를 다시 계산한다. */
function refreshLatestCompletedRunId() {
    latestCompletedRunId =
        Array.from(runStates.values())
            .filter(
                (runState) =>
                    runState.status === "completed" &&
                    runResults.has(runState.id),
            )
            .sort(
                (a, b) =>
                    Number(b.finishedAtMs || b.startedAtMs || 0) -
                    Number(a.finishedAtMs || a.startedAtMs || 0),
            )[0]?.id || "";
}

/**
 * 완료·실패·취소된 실행을 실행 목록에서 제거한다.
 *
 * 결과 디렉터리와 실제 파일은 삭제하지 않는다.
 * Renderer가 더 이상 해당 실행을 표시하거나 저장 버튼으로 접근하지 않도록
 * 메모리 상태와 결과 경로 참조만 정리한다.
 */
function deleteRunFromList(payload) {
    const runId = String(
        typeof payload === "string" ? payload : payload?.runId || "",
    ).trim();

    if (!runId) {
        throw new Error("삭제할 실행 ID가 없습니다.");
    }

    if (activeRuns.has(runId)) {
        throw new Error(
            "실행 중인 작업은 목록에서 삭제할 수 없습니다. 먼저 실행을 취소하세요.",
        );
    }

    const runState = runStates.get(runId);

    if (!runState) {
        return cloneForRenderer(createPublicApplicationState());
    }

    if (["queued", "running", "canceling"].includes(runState.status)) {
        throw new Error(
            "실행 중인 작업은 목록에서 삭제할 수 없습니다. 먼저 실행을 취소하세요.",
        );
    }

    runStates.delete(runId);
    runResults.delete(runId);

    if (latestCompletedRunId === runId) {
        refreshLatestCompletedRunId();
    }

    emitState();

    return cloneForRenderer(createPublicApplicationState());
}

/**
 * Electron 특수 폴더를 순서대로 조회합니다.
 *
 * Windows의 문서 폴더가 삭제되거나 OneDrive 리디렉션,
 * 레지스트리 설정 문제 등으로 조회되지 않을 수 있으므로
 * 하나의 app.getPath() 실패가 앱 전체 실행을 막지 않게 합니다.
 */
function getAvailableSystemPath(pathNames) {
    for (const pathName of pathNames) {
        try {
            const systemPath = app.getPath(pathName);

            if (systemPath) {
                return systemPath;
            }
        } catch (error) {
            console.warn(
                `[PATH] '${pathName}' 경로를 가져오지 못했습니다:`,
                error.message,
            );
        }
    }

    /**
     * Electron 특수 폴더를 모두 가져오지 못했을 때의 최종 fallback입니다.
     */
    return (
        process.env.USERPROFILE ||
        process.env.HOME ||
        os.homedir() ||
        process.cwd()
    );
}

/**
 * 결과 파일 기본 저장 폴더를 반환합니다.
 *
 * Windows에서 Documents 특수 폴더 조회가 실패하는 환경을 고려해
 * 사용자 홈 폴더를 우선 사용합니다.
 */
function getDefaultOutputRoot() {
    const baseDirectory =
        process.env.USERPROFILE ||
        process.env.HOME ||
        os.homedir() ||
        getAvailableSystemPath([
            "downloads",
            "userData",
        ]);

    return path.resolve(
        baseDirectory,
        "MallCollector",
    );
}

/** CSV 개별 저장 대화상자의 기본 폴더를 반환합니다. */
function getDefaultDownloadRoot() {
    return getAvailableSystemPath([
        "downloads",
        "documents",
        "home",
        "userData",
    ]);
}

/** 실행별 결과 파일 유형을 검증하고 실제 경로를 반환한다. */
function getResultFile(fileType, runId = "") {
    if (!RESULT_FILE_TYPES[fileType]) {
        throw new Error(`지원하지 않는 결과 파일입니다: ${fileType}`);
    }

    const targetRunId =
        String(runId || "").trim() ||
        latestCompletedRunId;
    const resultInfo = runResults.get(targetRunId);
    const filePath = resultInfo?.files?.[fileType];

    if (!filePath || !isFile(filePath)) {
        throw new Error("해당 실행에서 저장할 결과 파일이 없습니다.");
    }

    return {
        runId: targetRunId,
        filePath,
        metadata: RESULT_FILE_TYPES[fileType],
    };
}

/** 실행별 결과 CSV를 사용자가 선택한 경로로 복사한다. */
async function saveResultFile(payload) {
    const { filePath, metadata } = getResultFile(
        payload?.fileType,
        payload?.runId,
    );

    const result = await dialog.showSaveDialog(mainWindow, {
        title: `${metadata.label} 저장`,
        defaultPath: path.resolve(
            getDefaultDownloadRoot(),
            metadata.defaultName,
        ),
        buttonLabel: "저장",
        filters: [
            {
                name: "CSV",
                extensions: ["csv"],
            },
        ],
    });

    if (result.canceled || !result.filePath) {
        return {
            canceled: true,
        };
    }

    if (path.resolve(result.filePath) !== path.resolve(filePath)) {
        await fs.promises.copyFile(filePath, result.filePath);
    }

    return {
        canceled: false,
        saved: true,
        fileName: path.basename(result.filePath),
    };
}

/** 로컬 Renderer 파일만 제공하는 custom protocol을 등록한다. */
function registerRendererProtocol() {
    protocol.handle(APP_SCHEME, (request) => {
        const requestUrl = new URL(request.url);
        const requestedPath =
            decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") ||
            "index.html";
        const resolvedPath = path.resolve(RENDERER_DIR, requestedPath);
        const relativePath = path.relative(RENDERER_DIR, resolvedPath);

        if (
            relativePath.startsWith("..") ||
            path.isAbsolute(relativePath)
        ) {
            return new Response("Not Found", {
                status: 404,
            });
        }

        return net.fetch(
            pathToFileURL(resolvedPath).toString(),
        );
    });
}

/** 앱에 필요한 IPC 채널을 한 번 등록한다. */
function registerIpcHandlers() {
    registerIpcHandler(CHANNELS.getDefaults, () => ({
        ...getPublicDefaults(
            process.env,
            selectedOutputRoot,
        ),
        app: {
            name: app.getName(),
            version: app.getVersion(),
            isPackaged: app.isPackaged,
        },
        outputDirectory: selectedOutputRoot,
        settingsDirectory: environmentInfo.userDataDir,
        userEnvPath: environmentInfo.userEnvPath,
        loadedEnvFiles: environmentInfo.loadedPaths,
    }));

    registerIpcHandler(CHANNELS.getState, () =>
        cloneForRenderer(createPublicApplicationState()),
    );

    registerIpcHandler(CHANNELS.getCredentialProfiles, () =>
        ensureCredentialStore().getSummary(),
    );

    registerIpcHandler(CHANNELS.getUploadApiSettings, () =>
        loadUploadApiSettings(),
    );

    registerIpcHandler(CHANNELS.saveUploadApiSettings, (payload) =>
        saveUploadApiSettings(payload),
    );

    registerIpcHandler(CHANNELS.getCollectionUploadLogs, (payload) =>
        listCollectionUploadLogs(payload),
    );

    registerIpcHandler(
        CHANNELS.openCollectionUploadLogDirectory,
        async () => {
            const directory = getCollectionUploadLogRoot();
            await collectionUploadLogFs.mkdir(directory, {
                recursive: true,
            });
            const errorMessage = await shell.openPath(directory);

            if (errorMessage) throw new Error(errorMessage);

            return { directory };
        },
    );

    registerIpcHandler(CHANNELS.saveProxyProfile, (payload) =>
        ensureCredentialStore().saveProxy(payload),
    );

    registerIpcHandler(CHANNELS.deleteProxyProfile, (payload) =>
        ensureCredentialStore().deleteProxy(payload?.id),
    );

    registerIpcHandler(CHANNELS.saveOpenAiProfile, (payload) =>
        ensureCredentialStore().saveOpenAiKey(payload),
    );

    registerIpcHandler(CHANNELS.deleteOpenAiProfile, (payload) =>
        ensureCredentialStore().deleteOpenAiKey(payload?.id),
    );

    registerIpcHandler(CHANNELS.start, (input) =>
        startCollection(input),
    );

    registerIpcHandler(CHANNELS.cancel, (payload) =>
        cancelCollection(payload),
    );

    registerIpcHandler(CHANNELS.deleteRun, (payload) =>
        deleteRunFromList(payload),
    );

    registerIpcHandler(
        CHANNELS.uploadCartItems,
        uploadCartItems,
    );

    registerIpcHandler(
        CHANNELS.setShippingEnabled,
        async (payload) => {
            if (!shippingScheduler) {
                throw new Error("운송정보 전송기가 초기화되지 않았습니다.");
            }

            if (typeof payload?.collectionUploadEnabled === "boolean") {
                return shippingScheduler.setCollectionUploadEnabled(
                    payload.collectionUploadEnabled,
                );
            }

            return shippingScheduler.setEnabled(
                payload?.enabled === true,
            );
        },
    );

    registerIpcHandler(
        CHANNELS.chooseOutputDirectory,
        async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: "수집 결과 저장 폴더 선택",
                defaultPath: selectedOutputRoot,
                buttonLabel: "이 폴더 사용",
                properties: [
                    "openDirectory",
                    "createDirectory",
                ],
            });

            if (!result.canceled && result.filePaths[0]) {
                selectedOutputRoot = path.resolve(
                    result.filePaths[0],
                );

                ensureDir(selectedOutputRoot);
            }

            return {
                canceled: result.canceled,
                outputDirectory: selectedOutputRoot,
            };
        },
    );

    registerIpcHandler(
        CHANNELS.saveResultFile,
        saveResultFile,
    );

    registerIpcHandler(
        CHANNELS.openResultDirectory,
        async (payload) => {
            const runId =
                String(payload?.runId || "").trim() ||
                latestCompletedRunId;
            const directory = runResults.get(runId)?.directory;

            if (!directory) {
                throw new Error("열 수 있는 결과 폴더가 없습니다.");
            }

            const error = await shell.openPath(directory);

            if (error) {
                throw new Error(error);
            }

            return {
                opened: true,
                runId,
            };
        },
    );

    registerIpcHandler(
        CHANNELS.showResultFile,
        (payload) => {
            const { filePath } = getResultFile(
                payload?.fileType,
                payload?.runId,
            );

            shell.showItemInFolder(filePath);

            return {
                opened: true,
            };
        },
    );

    registerIpcHandler(
        CHANNELS.openSettingsDirectory,
        async () => {
            ensureDir(environmentInfo.userDataDir);

            const error = await shell.openPath(
                environmentInfo.userDataDir,
            );

            if (error) {
                throw new Error(error);
            }

            return {
                opened: true,
            };
        },
    );
}

/** Electron 보안 기본값과 navigation 제한을 적용한다. */
function hardenSessionAndWindow(window) {
    session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => {
            callback(false);
        },
    );

    session.defaultSession.setPermissionCheckHandler(
        () => false,
    );

    window.webContents.setWindowOpenHandler(() => ({
        action: "deny",
    }));

    window.webContents.on(
        "will-navigate",
        (event, targetUrl) => {
            if (!targetUrl.startsWith(`${APP_ORIGIN}/`)) {
                event.preventDefault();
            }
        },
    );
}

/** 메인 BrowserWindow를 생성한다. */
function createMainWindow() {
    mainWindow = new BrowserWindow({
        title: "쇼핑몰 상품 수집기",
        width: 1440,
        height: 1080,
        minWidth: 920,
        minHeight: 720,
        show: false,
        backgroundColor: "#f4f6fa",
        icon: path.resolve(
            __dirname,
            "..",
            "public",
            "assets",
            "icon.ico",
        ),
        webPreferences: {
            preload: path.resolve(
                __dirname,
                "preload.js",
            ),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools:
                process.env.ELECTRON_DEVTOOLS === "true" ||
                !app.isPackaged,
        },
    });

    const fakeChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    mainWindow.webContents.setUserAgent(fakeChromeUA);
    console.log("현재 설정된 웹 브라우저 명찰:", mainWindow.webContents.getUserAgent());

    hardenSessionAndWindow(mainWindow);

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.on("close", (event) => {
        if (
            (activeRuns.size === 0 && !activeCartUpload) ||
            allowImmediateQuit
        ) {
            return;
        }

        /** prompt가 열려 있는 동안 반복 close 요청도 계속 차단한다. */
        event.preventDefault();

        if (closePromptOpen) {
            return;
        }

        closePromptOpen = true;

        void dialog
            .showMessageBox(mainWindow, {
                type: "warning",
                title: "수집 작업 실행 중",
                message: "수집을 취소하고 앱을 종료하시겠습니까?",
                detail:
                    "현재 Playwright 브라우저를 정상 종료한 뒤 앱을 닫습니다.",
                buttons: [
                    "수집 취소 후 종료",
                    "계속 사용",
                ],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            })
            .then(({ response }) => {
                if (response === 0) {
                    quitAfterRun = true;

                    for (const run of activeRuns.values()) {
                        run.controller.abort();
                    }

                    activeCartUpload?.controller?.abort();
                    maybeQuitAfterWork();
                }
            })
            .finally(() => {
                closePromptOpen = false;
            });
    });

    void mainWindow.loadURL(APP_URL);
}

/** Electron 앱을 초기화한다. */
async function bootstrap() {
    app.setAppUserModelId(
        "com.squirrel.MallCollector.MallCollector",
    );

    Menu.setApplicationMenu(null);

    collectionUploadLogRoot = getCollectionUploadLogRoot();
    await collectionUploadLogFs.mkdir(collectionUploadLogRoot, {
        recursive: true,
    });
    setResultUploadLogRoot(collectionUploadLogRoot);

    environmentInfo = loadEnvironment(app);
    loadUploadApiSettings();

    credentialStore = createCredentialStore({
        safeStorage,
        userDataDir: environmentInfo.userDataDir,
        normalizeProxyCredentials,
    });

    selectedOutputRoot = resolveOutputDir(
        {},
        process.env,
        getDefaultOutputRoot(),
    );

    ensureDir(selectedOutputRoot);

    shippingScheduler =
        createShippingScheduler({
            /**
             * KSE 로그인 세션을 앱 사용자 데이터 폴더에 저장합니다.
             */
            profileDirectory: path.join(
                environmentInfo.userDataDir,
                "kse-profile",
            ),

            onStateChanged: () => {
                emitState();
            },
        });

    wonToYenRateScheduler =
        createWonToYenRateScheduler();

    registerRendererProtocol();
    registerIpcHandlers();
    createMainWindow();

    shippingScheduler.start();
    wonToYenRateScheduler.start();
}

const isSquirrelStartup = require(
    "electron-squirrel-startup",
);

if (isSquirrelStartup) {
    app.quit();
} else {
    const hasSingleInstanceLock =
        app.requestSingleInstanceLock();

    if (!hasSingleInstanceLock) {
        app.quit();
    } else {
        app.on("second-instance", () => {
            if (!mainWindow) return;

            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }

            mainWindow.show();
            mainWindow.focus();
        });

        app
            .whenReady()
            .then(bootstrap)
            .catch((error) => {
                console.error("[BOOTSTRAP FATAL]", error);

                dialog.showErrorBox(
                    "Mall Collector 실행 오류",
                    [
                        "앱 초기화 중 오류가 발생했습니다.",
                        "",
                        error.message,
                        "",
                        "문서 또는 다운로드 폴더 설정을 확인해 주세요.",
                    ].join("\n"),
                );

                app.quit();
            });

        app.on("activate", () => {
            if (!mainWindow) {
                createMainWindow();
            }
        });

        app.on("before-quit", () => {
            shippingScheduler?.stop();
            wonToYenRateScheduler?.stop();
        });

        app.on("window-all-closed", () => {
            if (process.platform !== "darwin") {
                app.quit();
            }
        });
    }
}

process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    net,
    protocol,
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
    resolveOutputDir,
    resolveRunConfig,
} = require("../src/config");
const { runCollection } = require("../src/crawler");
const { loadEnvironment } = require("./environment");

const APP_SCHEME = "mall-collector";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const APP_URL = `${APP_ORIGIN}/index.html`;
const RENDERER_DIR = path.resolve(__dirname, "..", "public");

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
let activeRun = null;
let lastResultFiles = null;
let lastResultDirectory = "";
let closePromptOpen = false;
let quitAfterRun = false;
let allowImmediateQuit = false;

let appState = createIdleState();

/** Renderer에 전달 가능한 초기 상태를 생성한다. */
function createIdleState() {
    return {
        id: null,
        status: "idle",
        startedAtMs: null,
        finishedAtMs: null,
        progress: {
            stage: "idle",
            message: "수집 설정을 입력한 뒤 시작하세요.",
            elapsedMs: 0,
            elapsedText: "0ms",
        },
        summary: null,
        outputDirectory: "",
        files: createPublicFileState(),
        error: "",
    };
}

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

/** 현재 상태를 Renderer에 전송한다. */
function emitState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    mainWindow.webContents.send(
        CHANNELS.stateChanged,
        cloneForRenderer(appState),
    );
}

/** 상태 일부를 갱신하고 즉시 Renderer에 전달한다. */
function updateState(patch) {
    appState = {
        ...appState,
        ...patch,
    };

    emitState();
}

/** 실행 시간을 보완해 진행 상태를 갱신한다. */
function updateProgress(progress) {
    const elapsedMs =
        Number(progress?.elapsedMs) ||
        (appState.startedAtMs ? Date.now() - appState.startedAtMs : 0);

    updateState({
        progress: {
            ...appState.progress,
            ...progress,
            elapsedMs,
            elapsedText: progress?.elapsedText || formatMs(elapsedMs),
        },
    });
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
        "showBrowser",
        "pageStart",
        "pageEnd",
        "pageSize",
    ];

    return Object.fromEntries(
        allowedKeys
            .filter((key) => Object.hasOwn(source, key))
            .map((key) => [key, source[key]]),
    );
}

/** Playwright 수집을 백그라운드 Promise로 실행한다. */
async function executeCollection(run, config) {
    try {
        const result = await runCollection(config, {
            runId: run.id,
            signal: run.controller.signal,
            onProgress: (progress) => {
                if (activeRun?.id !== run.id) return;
                updateProgress(progress);
            },
        });

        lastResultFiles = result.files;
        lastResultDirectory = path.dirname(result.files.inventory);

        const finishedAtMs = Date.now();

        updateState({
            status: "completed",
            finishedAtMs,
            summary: result.payload.summary,
            outputDirectory: lastResultDirectory,
            files: createPublicFileState(result.files),
            error: "",
            progress: {
                ...appState.progress,
                stage: "completed",
                message: "수집과 파일 저장이 완료되었습니다.",
                elapsedMs: finishedAtMs - run.startedAtMs,
                elapsedText: formatMs(finishedAtMs - run.startedAtMs),
            },
        });
    } catch (error) {
        const canceled =
            run.controller.signal.aborted ||
            isAbortError(error);

        const finishedAtMs = Date.now();

        updateState({
            status: canceled ? "canceled" : "failed",
            finishedAtMs,
            summary: null,
            files: createPublicFileState(),
            outputDirectory: "",
            error: canceled ? "" : getErrorMessage(error),
            progress: {
                ...appState.progress,
                stage: canceled ? "canceled" : "failed",
                message: canceled
                    ? "사용자 요청으로 수집을 취소했습니다."
                    : "수집 작업이 실패했습니다.",
                elapsedMs: finishedAtMs - run.startedAtMs,
                elapsedText: formatMs(finishedAtMs - run.startedAtMs),
            },
        });
    } finally {
        if (activeRun?.id === run.id) {
            activeRun = null;
        }

        if (quitAfterRun) {
            allowImmediateQuit = true;
            app.quit();
        }
    }
}

/** 새 수집 작업을 시작하고 즉시 초기 상태를 반환한다. */
function startCollection(input) {
    if (activeRun) {
        throw new Error("이미 수집 작업이 실행 중입니다.");
    }

    const safeInput = normalizeRunInput(input);
    const config = resolveRunConfig(
        {
            ...safeInput,
            outDir: selectedOutputRoot,
        },
        process.env,
        getDefaultOutputRoot(),
    );

    const id = createRunId();
    const controller = new AbortController();
    const startedAtMs = Date.now();

    activeRun = {
        id,
        controller,
        startedAtMs,
    };

    lastResultFiles = null;
    lastResultDirectory = "";

    appState = {
        id,
        status: "running",
        startedAtMs,
        finishedAtMs: null,
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

    emitState();

    void executeCollection(activeRun, config);

    return cloneForRenderer(appState);
}

/** 실행 중인 작업에 취소 신호를 보낸다. */
function cancelCollection() {
    if (!activeRun) {
        return cloneForRenderer(appState);
    }

    updateState({
        status: "canceling",
        progress: {
            ...appState.progress,
            stage: "canceling",
            message: "브라우저를 종료하고 수집을 취소하고 있습니다.",
        },
    });

    activeRun.controller.abort();

    return cloneForRenderer(appState);
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

/** 결과 파일 유형을 검증하고 실제 경로를 반환한다. */
function getResultFile(fileType) {
    if (!RESULT_FILE_TYPES[fileType]) {
        throw new Error(`지원하지 않는 결과 파일입니다: ${fileType}`);
    }

    const filePath = lastResultFiles?.[fileType];

    if (!filePath || !isFile(filePath)) {
        throw new Error("저장할 결과 파일이 없습니다.");
    }

    return {
        filePath,
        metadata: RESULT_FILE_TYPES[fileType],
    };
}

/** 결과 CSV를 사용자가 선택한 경로로 복사한다. */
async function saveResultFile(payload) {
    const { filePath, metadata } = getResultFile(payload?.fileType);

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
        cloneForRenderer(appState),
    );

    registerIpcHandler(CHANNELS.start, (input) =>
        startCollection(input),
    );

    registerIpcHandler(CHANNELS.cancel, () =>
        cancelCollection(),
    );

    registerIpcHandler(
        CHANNELS.chooseOutputDirectory,
        async () => {
            if (activeRun) {
                throw new Error("수집 중에는 출력 폴더를 변경할 수 없습니다.");
            }

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
        async () => {
            if (!lastResultDirectory) {
                throw new Error("열 수 있는 결과 폴더가 없습니다.");
            }

            const error = await shell.openPath(
                lastResultDirectory,
            );

            if (error) {
                throw new Error(error);
            }

            return {
                opened: true,
            };
        },
    );

    registerIpcHandler(
        CHANNELS.showResultFile,
        (payload) => {
            const { filePath } = getResultFile(
                payload?.fileType,
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
        width: 1240,
        height: 900,
        minWidth: 920,
        minHeight: 720,
        show: false,
        backgroundColor: "#f4f6fa",
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

    hardenSessionAndWindow(mainWindow);

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.on("close", (event) => {
        if (!activeRun || allowImmediateQuit) {
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
                    cancelCollection();
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

    environmentInfo = loadEnvironment(app);

    selectedOutputRoot = resolveOutputDir(
        {},
        process.env,
        getDefaultOutputRoot(),
    );

    ensureDir(selectedOutputRoot);

    registerRendererProtocol();
    registerIpcHandlers();
    createMainWindow();
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

        app.on("window-all-closed", () => {
            if (process.platform !== "darwin") {
                app.quit();
            }
        });
    }
}
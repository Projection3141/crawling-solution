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
const {
  runCartUpload,
} = require("../src/cart-uploader");
const { runCollection } = require("../src/crawler");
const { loadEnvironment } = require("./environment");

const APP_SCHEME = "mall-collector";
const APP_ORIGIN = `${APP_SCHEME}://app`;
const APP_URL = `${APP_ORIGIN}/index.html`;
const CART_UPLOAD_API_URL =
    "https://www.web3.io.kr/joahstore/crawling/uploader";
const RENDERER_DIR = path.resolve(__dirname, "..", "public");

const CHANNELS = Object.freeze({
    getDefaults: "collector:get-defaults",
    getState: "collector:get-state",
    start: "collector:start",
    cancel: "collector:cancel",
    uploadCartItems:
        "collector:upload-cart-items",
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
 * key 형식: site:localCredentialId 또는 site:accountId
 */
const cartAccountLocks = new Set();
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
    const normalizedSite = String(site || "").trim();
    const credentialId = String(localCredentialId || "").trim();
    const loginId = String(accountId || "").trim();

    if (!normalizedSite) return "";
    if (credentialId) return `${normalizedSite}:credential:${credentialId}`;
    if (loginId) return `${normalizedSite}:login:${loginId}`;

    return `${normalizedSite}:env`;
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

        "detailMaxProducts",
        "detailRequestDelayMs",

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
        accountName:
            String(safeInput.accountName || "").trim() ||
            (safeInput.localCredentialId ? "등록 계정" : ".env 계정"),
        localCredentialId: String(safeInput.localCredentialId || ""),
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
    const url = new URL(CART_UPLOAD_API_URL);

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

/** GET 응답 배열을 사이트별로 분리해 실제 장바구니에 담는다. */
async function uploadCartItems(input) {
    if (activeCartUpload) {
        throw new Error("이미 장바구니 작업이 실행 중입니다.");
    }

    const controller = new AbortController();
    const lockedAccountKeys = new Set();

    /**
     * GET 응답을 받기 전에는 어느 사이트 계정이 실제로 필요한지 알 수 없다.
     * 따라서 이 시점에는 두 번째 장바구니 실행만 막고 계정 잠금은 하지 않는다.
     */
    activeCartUpload = {
        controller,
        startedAtMs: Date.now(),
        accountKeys: lockedAccountKeys,
    };
    emitState();

    try {
        const fetched = await fetchUploaderCartItems(controller.signal);
        const normalizedItems = fetched.items;
        const grouped = splitCartItemsBySite(normalizedItems);
        const accounts = {};

        /**
         * 응답에 실제로 포함된 사이트의 계정만 검증하고 잠근다.
         * 같은 계정으로 이미 수집 중이면 장바구니 작업을 시작하지 않는다.
         */
        for (const site of ["cheonyu", "ccdome"]) {
            if (grouped[site].length < 1) continue;

            const account = getCartAccount(input?.accounts, site);
            const accountKey = createAccountLockKey(
                site,
                account.localCredentialId,
                account.accountId,
            );
            const conflictingRun = findActiveRunByAccountKey(accountKey);

            if (conflictingRun) {
                const runState = runStates.get(conflictingRun.id);

                throw new Error(
                    `${site} 장바구니 계정은 현재 ` +
                    `${runState?.request?.collectionMode === "detail" ? "상세" : "일반"} ` +
                    `수집에서 사용 중입니다.`,
                );
            }

            accounts[site] = account;
            lockedAccountKeys.add(accountKey);
        }

        for (const key of lockedAccountKeys) {
            cartAccountLocks.add(key);
        }
        emitState();

        const results = {};

        for (const site of ["cheonyu", "ccdome"]) {
            const siteItems = grouped[site];

            if (siteItems.length < 1) continue;

            const account = accounts[site];
            const config = resolveRunConfig(
                {
                    mall: site,
                    category: site === "cheonyu" ? "-1" : "017",
                    accountId: account.accountId,
                    accountPw: account.accountPw,
                    accountName: account.accountName,
                    localCredentialId: account.localCredentialId,
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
            onProgress: (progress) => {
                if (!activeRuns.has(run.id)) return;
                updateRunProgress(run.id, progress);
            },
        });

        const resultDirectory = path.dirname(result.files.inventory);
        const finishedAtMs = Date.now();

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
        activeRuns.delete(run.id);
        emitState();
        maybeQuitAfterWork();
    }
}

/** 새 수집 작업을 시작하고 즉시 해당 실행 상태를 반환한다. */
function startCollection(input) {
    const safeInput = normalizeRunInput(input);
    const config = resolveRunConfig(
        {
            ...safeInput,
            outDir: selectedOutputRoot,
        },
        process.env,
        getDefaultOutputRoot(),
    );
    const accountKey = createCollectionAccountKey(config, safeInput);

    if (cartAccountLocks.has(accountKey)) {
        throw new Error(
            "선택한 계정은 현재 장바구니 담기 작업에서 사용 중입니다. 다른 계정을 선택하세요.",
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

    registerIpcHandler(CHANNELS.start, (input) =>
        startCollection(input),
    );

    registerIpcHandler(CHANNELS.cancel, (payload) =>
        cancelCollection(payload),
    );

    registerIpcHandler(
        CHANNELS.uploadCartItems,
        uploadCartItems,
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
        width: 1240,
        height: 900,
        minWidth: 920,
        minHeight: 720,
        show: false,
        backgroundColor: "#f4f6fa",
        icon: path.resolve(
            __dirname,
            "..",
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
// 전송 로그를 화면용으로 요약하고 지정한 로그 폴더를 페이지 단위로 조회한다.

const collectionUploadLogFs = require("node:fs/promises");
const path = require("node:path");

function summarizeCollectionUploadLog(log, dateDirectory, fileName) {
    const type = log?.type || log?.request?.type || "수집정보";
    const products = Array.isArray(log?.request)
        ? log.request
        : Array.isArray(log?.request?.data)
        ? log.request.data
        : type === "아카이브" && log?.request?.data &&
            typeof log.request.data === "object"
        ? Object.values(log.request.data).filter(Array.isArray).flat()
        : [];
    const sampleProductIds = Array.isArray(log?.sampleIds) ? log.sampleIds : products
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
        type,
        itemCount: Number.isFinite(log?.itemCount)
            ? log.itemCount
            : products.length,
        uploadApiUrl: log?.uploadApiUrl || "",
        status: log?.response?.status ?? null,
        error: log?.error || "",
        method: log?.method || "POST",
        archiveRef: log?.archiveRef || "",
        sampleProductIds,
    };
}

async function listCollectionUploadLogs(root, payload = {}) {
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

module.exports = { summarizeCollectionUploadLog, listCollectionUploadLogs };

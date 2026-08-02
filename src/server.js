// src/server.js

require("dotenv").config({ quiet: true });

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  getPublicDefaults,
  resolveRunConfig,
  resolveServerConfig,
  toSafeConfig,
} = require("./config");
const { runCollection } = require("./crawler");
const { formatMs, getErrorMessage } = require("./utils/common");
const { isFile } = require("./utils/files");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const jobs = new Map();
let activeJobId = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 공통 API 응답 헤더를 설정한다. */
function setCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/** JSON 응답을 전송한다. */
function sendJson(response, statusCode, value) {
  setCommonHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/** 오류 응답을 일관된 형식으로 전송한다. */
function sendError(response, statusCode, message, extra = {}) {
  sendJson(response, statusCode, {
    ok: false,
    error: message,
    ...extra,
  });
}

/** JSON request body를 최대 1MB까지 읽는다. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf-8");
    request.on("data", (chunk) => {
      body += chunk;

      if (Buffer.byteLength(body, "utf-8") > 1024 * 1024) {
        reject(new Error("요청 본문이 너무 큽니다."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 요청 형식이 올바르지 않습니다."));
      }
    });
    request.on("error", reject);
  });
}

/** 내부 job 객체를 비밀번호가 없는 상태 API 응답으로 변환한다. */
function serializeJob(job) {
  const liveElapsedMs =
    job.status === "running" && job.startedAtMs
      ? Date.now() - job.startedAtMs
      : job.progress.elapsedMs || job.summary?.elapsedMs || 0;

  return {
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      config: job.safeConfig,
      progress: {
        ...job.progress,
        elapsedMs: liveElapsedMs,
        elapsedText: formatMs(liveElapsedMs),
      },
      summary: job.summary,
      error: job.error,
      downloads:
        job.status === "completed"
          ? {
              inventory: `/api/jobs/${job.id}/files/inventory`,
              summary: `/api/jobs/${job.id}/files/summary`,
              products: `/api/jobs/${job.id}/files/products`,
              details: job.files?.details
                ? `/api/jobs/${job.id}/files/details`
                : null,
            }
          : null,
    },
  };
}

/** progress patch를 현재 job 상태에 병합한다. */
function updateJobProgress(job, patch) {
  job.progress = {
    ...job.progress,
    ...patch,
    pageRange: patch.pageRange
      ? { ...patch.pageRange }
      : job.progress.pageRange,
  };
}

/** 실제 크롤러를 실행하고 job 상태를 갱신한다. */
async function executeJob(job, config) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.startedAtMs = Date.now();
  updateJobProgress(job, {
    stage: "starting",
    message: "수집 작업을 시작합니다.",
  });

  try {
    const result = await runCollection(config, {
      runId: job.id,
      onProgress: (patch) => updateJobProgress(job, patch),
    });

    job.summary = result.payload.summary;
    job.files = result.files;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    updateJobProgress(job, {
      stage: "completed",
      message: "수집 및 파일 저장이 완료되었습니다.",
      elapsedMs: job.summary.elapsedMs,
      elapsedText: job.summary.elapsedText,
    });
  } catch (error) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = getErrorMessage(error);
    updateJobProgress(job, {
      stage: "failed",
      message: job.error,
      elapsedMs: Date.now() - job.startedAtMs,
    });
    console.error(`[JOB ${job.id}]`, error);
  } finally {
    if (activeJobId === job.id) activeJobId = null;
  }
}

/** 새 job을 만들고 실행을 예약한다. */
function createJob(input) {
  if (activeJobId) {
    const activeJob = jobs.get(activeJobId);

    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      const error = new Error("이미 실행 중인 수집 작업이 있습니다.");
      error.statusCode = 409;
      error.activeJobId = activeJobId;
      throw error;
    }
  }

  const config = resolveRunConfig(input);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job = {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    startedAtMs: null,
    finishedAt: null,
    safeConfig: toSafeConfig(config),
    progress: {
      stage: "queued",
      message: "실행 대기 중입니다.",
      currentPage: null,
      pageRange: null,
      detectedTotalProductCount: null,
      collectedProductCount: 0,
      targetProductCount: 0,
      productSummaryCount: 0,
      soldOutProductCount: 0,
      elapsedMs: 0,
      elapsedText: "0ms",
    },
    summary: null,
    files: null,
    error: null,
  };

  jobs.set(id, job);
  activeJobId = id;

  /** HTTP 응답을 먼저 반환할 수 있도록 다음 event loop에서 실행한다. */
  setImmediate(() => executeJob(job, config));

  return job;
}

/** public 정적 파일을 안전하게 전송한다. */
function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    sendError(response, 403, "허용되지 않은 경로입니다.");
    return;
  }

  if (!isFile(filePath)) {
    sendError(response, 404, "파일을 찾지 못했습니다.");
    return;
  }

  setCommonHeaders(response);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(response);
}

/** 실행 결과 CSV를 다운로드한다. */
function serveJobFile(job, fileKey, response) {
  const allowed = {
    inventory: "inventory.csv",
    summary: "summary.csv",
    products: "products.csv",
    details: "details.csv",
  };
  const filePath = job.files?.[fileKey];

  if (!allowed[fileKey] || !filePath || !isFile(filePath)) {
    sendError(response, 404, "다운로드 파일을 찾지 못했습니다.");
    return;
  }

  setCommonHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${allowed[fileKey]}"`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(response);
}

/** API와 public 페이지 요청을 처리한다. */
async function requestHandler(request, response) {
  setCommonHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      activeJobId,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/defaults") {
    sendJson(response, 200, {
      ok: true,
      ...getPublicDefaults(),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs") {
    try {
      const input = await readJsonBody(request);
      const job = createJob(input);
      sendJson(response, 202, serializeJob(job));
    } catch (error) {
      sendError(
        response,
        error.statusCode || 400,
        getErrorMessage(error),
        error.activeJobId ? { activeJobId: error.activeJobId } : {},
      );
    }
    return;
  }

  const statusMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);

  if (request.method === "GET" && statusMatch) {
    const job = jobs.get(statusMatch[1]);

    if (!job) {
      sendError(response, 404, "수집 작업을 찾지 못했습니다.");
      return;
    }

    sendJson(response, 200, serializeJob(job));
    return;
  }

  const fileMatch = pathname.match(
    /^\/api\/jobs\/([^/]+)\/files\/(inventory|summary|products|details)$/,
  );

  if (request.method === "GET" && fileMatch) {
    const job = jobs.get(fileMatch[1]);

    if (!job) {
      sendError(response, 404, "수집 작업을 찾지 못했습니다.");
      return;
    }

    serveJobFile(job, fileMatch[2], response);
    return;
  }

  if (request.method === "GET" && !pathname.startsWith("/api/")) {
    serveStatic(pathname, response);
    return;
  }

  sendError(response, 404, "요청 경로를 찾지 못했습니다.");
}

/** 로컬 public 서버를 시작한다. */
function startServer() {
  const { host, port } = resolveServerConfig();
  const server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      console.error("[SERVER]", error);

      if (!response.headersSent) {
        sendError(response, 500, getErrorMessage(error));
      } else {
        response.end();
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`Mall Collector UI: http://${host}:${port}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createJob,
  requestHandler,
  serializeJob,
  startServer,
};
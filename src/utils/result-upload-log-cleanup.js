// 서버 요청·전송 로그 중 저장 후 7일이 지난 파일을 정리한다.
const fs = require("node:fs/promises");
const path = require("node:path");

const RESULT_UPLOAD_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RESULT_UPLOAD_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const LOG_FILE_NAME = /^\d{6}-\d{3}(?:-\d+)?\.json$/i;

/** 큰 파일이나 손상된 JSON도 본문을 읽지 않고 최종 수정 시각으로 정리한다. */
async function cleanupResultUploadLogs(logRoot, { now = Date.now() } = {}) {
  if (!String(logRoot || "").trim()) return 0;
  const cutoff = Number(now) - RESULT_UPLOAD_LOG_RETENTION_MS;
  if (!Number.isFinite(cutoff)) return 0;

  const root = path.resolve(logRoot);
  let deletedCount = 0;
  const warn = (target, error) => {
    if (error?.code !== "ENOENT") {
      console.warn("[RESULT REQUEST] 오래된 전송 로그 정리 실패", target, error?.message || error);
    }
  };
  let directories;
  try {
    directories = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    warn(root, error);
    return deletedCount;
  }

  for (const entry of directories) {
    // 날짜 폴더 외의 파일과 링크·junction은 따라가지 않는다.
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{8}$/.test(entry.name)) continue;
    const directory = path.resolve(root, entry.name);
    if (path.dirname(directory) !== root) continue;

    let files;
    try {
      files = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      warn(directory, error);
      continue;
    }

    let deletedFromDirectory = 0;
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !LOG_FILE_NAME.test(file.name)) continue;
      const logPath = path.resolve(directory, file.name);
      if (path.dirname(logPath) !== directory) continue;

      try {
        const stat = await fs.lstat(logPath);
        if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
        await fs.unlink(logPath);
        deletedCount += 1;
        deletedFromDirectory += 1;
      } catch (error) {
        // 한 파일의 권한·잠금 오류로 다른 로그 정리나 앱 시작을 막지 않는다.
        warn(logPath, error);
      }
    }

    if (deletedFromDirectory > 0) {
      try {
        // 다른 파일이 남아 있다면 보존한다. 재귀 삭제는 사용하지 않는다.
        await fs.rmdir(directory);
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") warn(directory, error);
      }
    }
  }

  return deletedCount;
}

module.exports = {
  cleanupResultUploadLogs,
  RESULT_UPLOAD_LOG_RETENTION_MS,
  RESULT_UPLOAD_LOG_CLEANUP_INTERVAL_MS,
};

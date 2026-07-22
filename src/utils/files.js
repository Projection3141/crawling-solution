const fs = require("node:fs");
const path = require("node:path");

/** 디렉토리가 없으면 재귀적으로 생성한다. */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** UTF-8 텍스트 파일을 저장한다. */
function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(content ?? ""), "utf-8");
}

/** 객체를 보기 좋은 JSON 파일로 저장한다. */
function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

/** CSV 필드를 큰따옴표로 감싸고 수식 시작 문자를 안전하게 중화한다. */
function csvEscape(value) {
  const raw = value == null ? "" : String(value);
  const safe =
    typeof value === "string" && /^[=+\-@\t\r]/.test(raw)
      ? `'${raw}`
      : raw;

  return `"${safe.replace(/"/g, '""')}"`;
}

/** 객체 배열을 지정한 헤더 순서로 CSV에 저장한다. */
function saveCsv(filePath, headers, rows) {
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((key) => csvEscape(row[key])).join(","),
    ),
  ];

  /** Excel에서 한글 CSV를 바로 열 수 있도록 UTF-8 BOM을 추가한다. */
  writeText(filePath, `\uFEFF${lines.join("\n")}`);
}

/** 실행별 출력 디렉토리와 공통 파일 경로를 생성한다. */
function createRunFiles(baseOutDir, mall, runId) {
  const runDir = path.resolve(baseOutDir, mall, runId);

  ensureDir(runDir);

  return {
    runDir,
    resultJson: path.resolve(runDir, "result.json"),
    inventoryCsv: path.resolve(runDir, "inventory.csv"),
    summaryCsv: path.resolve(runDir, "summary.csv"),
    productsCsv: path.resolve(runDir, "products.csv"),
  };
}

/** 경로가 실제 파일인지 확인한다. */
function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  createRunFiles,
  csvEscape,
  ensureDir,
  isFile,
  saveCsv,
  writeJson,
  writeText,
};
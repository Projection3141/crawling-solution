const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const TARGETS = [
  "electron",
  "public",
  "scripts",
  "src",
  "translate",
  "forge.config.js",
];

/** 지정 경로 아래 JavaScript 파일을 재귀적으로 찾는다. */
function collectJavaScriptFiles(targetPath) {
  const absolutePath = path.resolve(ROOT_DIR, targetPath);

  if (!fs.existsSync(absolutePath)) return [];

  const stat = fs.statSync(absolutePath);

  if (stat.isFile()) {
    return absolutePath.endsWith(".js") ? [absolutePath] : [];
  }

  return fs.readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.resolve(absolutePath, entry.name);

    if (entry.isDirectory()) {
      return collectJavaScriptFiles(path.relative(ROOT_DIR, childPath));
    }

    return childPath.endsWith(".js") ? [childPath] : [];
  });
}

/** 모든 JavaScript 파일을 Node.js 구문 검사기로 검증한다. */
function main() {
  const files = TARGETS.flatMap(collectJavaScriptFiles).sort();
  let failed = false;

  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      encoding: "utf-8",
    });

    const relativePath = path.relative(ROOT_DIR, filePath);

    if (result.status === 0) {
      console.log(`[CHECK] OK   ${relativePath}`);
      continue;
    }

    failed = true;
    console.error(`[CHECK] FAIL ${relativePath}`);
    console.error(result.stderr || result.stdout);
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(`[CHECK] ${files.length}개 JavaScript 파일 통과`);
}

main();

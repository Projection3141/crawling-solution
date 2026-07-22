const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

/**
 * 설치 앱과 개발 환경의 공통 .env 후보 경로를 반환한다.
 *
 * 우선순위:
 * 1. 운영체제에서 이미 설정된 process.env
 * 2. 사용자 설정 폴더의 .env
 * 3. 개발 프로젝트 루트의 .env
 */
function getEnvironmentPaths(electronApp) {
  const userDataDir = electronApp.getPath("userData");

  return {
    userDataDir,
    userEnvPath: path.resolve(userDataDir, ".env"),
    userExamplePath: path.resolve(userDataDir, ".env.example"),
    projectEnvPath: path.resolve(__dirname, "..", ".env"),
    projectExamplePath: path.resolve(__dirname, "..", ".env.example"),
  };
}

/** 사용자 설정 폴더에 참고용 .env.example을 복사한다. */
function ensureUserEnvironmentExample(paths) {
  fs.mkdirSync(paths.userDataDir, { recursive: true });

  if (
    !fs.existsSync(paths.userExamplePath) &&
    fs.existsSync(paths.projectExamplePath)
  ) {
    fs.copyFileSync(paths.projectExamplePath, paths.userExamplePath);
  }
}

/** 실제 존재하는 .env 파일을 우선순위대로 로드한다. */
function loadEnvironment(electronApp) {
  const paths = getEnvironmentPaths(electronApp);
  const loadedPaths = [];

  ensureUserEnvironmentExample(paths);

  const candidates = [
    paths.userEnvPath,
    ...(electronApp.isPackaged ? [] : [paths.projectEnvPath]),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;

    dotenv.config({
      path: filePath,
      override: false,
      quiet: true,
    });

    loadedPaths.push(filePath);
  }

  return {
    ...paths,
    loadedPaths,
  };
}

module.exports = {
  getEnvironmentPaths,
  loadEnvironment,
};
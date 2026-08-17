const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

/**
 * 설치 앱과 개발 환경의 공통 .env 후보 경로를 반환한다.
 *
 * 우선순위:
 * 1. 운영체제에서 이미 설정된 process.env
 * 2. 사용자 설정 폴더의 .env
 * 3. 프로젝트 또는 설치 앱의 .env
 */
function getEnvironmentPaths(electronApp) {
  const userDataDir = electronApp.getPath("userData");

  return {
    userDataDir,
    userEnvPath: path.resolve(userDataDir, ".env"),
    projectEnvPath: path.resolve(__dirname, "..", ".env"),
  };
}

/** 실제 존재하는 .env 파일을 우선순위대로 로드한다. */
function loadEnvironment(electronApp) {
  const paths = getEnvironmentPaths(electronApp);
  const loadedPaths = [];

  fs.mkdirSync(paths.userDataDir, { recursive: true });

  const candidates = [
    paths.userEnvPath,
    paths.projectEnvPath,
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

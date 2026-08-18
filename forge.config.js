const fs = require("node:fs");
const path = require("node:path");
const { version } = require("./package.json");

const iconBase = path.resolve(__dirname, "assets", "icon");
const windowsIcon = `${iconBase}.ico`;

/**
 * Electron Forge 패키징 설정이다.
 *
 * Playwright Chromium은 실제 실행 파일이므로 초기 버전에서는 ASAR를 사용하지 않는다.
 * 이후 ASAR를 적용하려면 playwright-core/.local-browsers를 반드시 unpack해야 한다.
 */
module.exports = {
  packagerConfig: {
    asar: false,
    executableName: "MallCollector",
    icon: path.resolve(
      __dirname,
      "public",
      "assets",
      "icon.ico",
    ),
    ignore: [
      /[\\/]\.env$/,
      /[\\/]\.git([\\/]|$)/,
      /[\\/]\.github([\\/]|$)/,
      /[\\/]docs([\\/]|$)/,
      /[\\/]out([\\/]|$)/,
      /[\\/]release([\\/]|$)/,
      /[\\/]scripts([\\/]|$)/,
    ],
    win32metadata: {
      CompanyName: "Your Company",
      FileDescription: "Mall Collector",
      ProductName: "Mall Collector",
      InternalName: "MallCollector",
      OriginalFilename: "MallCollector.exe",
    },
  },

  rebuildConfig: {},

  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "MallCollector",
        authors: "Your Name",
        description:
          "천유닷컴과 과자생각 상품·재고를 로컬에서 수집하는 데스크톱 앱",
        setupExe: `MallCollectorSetup-${version}.exe`,
        noMsi: true,
        setupIcon: path.resolve(
          __dirname,
          "public",
          "assets",
          "icon.ico",
        ),
      },
    },
  ],
};
#!/usr/bin/env node

/** Playwright Chromium을 프로젝트 내부 번들 경로에서 찾도록 고정한다. */
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";

require("dotenv").config({ quiet: true });

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveRunConfig } = require("./config");
const { runCollection } = require("./crawler");

/** 공통 .env 설정을 이용해 Electron 없이도 CLI 수집을 실행한다. */
async function main() {
  const mall = process.argv[2] || undefined;
  const config = resolveRunConfig(
    mall ? { mall } : {},
    process.env,
    path.resolve(process.cwd(), "out"),
  );

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const result = await runCollection(config, {
    runId,
    onProgress: (progress) => {
      const page = progress.currentPage
        ? ` | page ${progress.currentPage}`
        : "";

      console.log(
        `[${progress.stage || "progress"}] ` +
          `${progress.message || ""}${page}`,
      );
    },
  });

  console.log(JSON.stringify(result.payload.summary, null, 2));
  console.log("inventory:", result.files.inventory);
  console.log("summary  :", result.files.summary);
  console.log("products :", result.files.products);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[FATAL]", error);
    process.exitCode = 1;
  });
}
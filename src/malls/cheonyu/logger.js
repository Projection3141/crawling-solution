// 천유 수집 단계에서 사용하는 로그 형식과 출력 경로를 공유한다.

const CHEONYU_LOG_COLORS = {
  reset: "\x1b[0m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  success: "\x1b[32m",
  info: "\x1b[90m",
};
const CHEONYU_LOG_LABELS = {
  error: "[ERROR]",
  warn: "[WARN]",
  success: "[SUCCESS]",
  info: "[INFO]",
};
const CHEONYU_LOG_ENABLED_COLOR = process.stdout?.isTTY;

function logCheonyu(level, message, details) {
  const color = CHEONYU_LOG_ENABLED_COLOR ? CHEONYU_LOG_COLORS[level] : "";
  const reset = CHEONYU_LOG_ENABLED_COLOR ? CHEONYU_LOG_COLORS.reset : "";
  const label = CHEONYU_LOG_LABELS[level] || "[INFO]";
  const line = `${color}${label} ${message}${reset}`;

  if (details !== undefined) {
    if (level === "error" && console.error) {
      console.error(line, details);
      return;
    }

    console.log(line, details);
    return;
  }

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

const logCheonyuError = (message, details) => logCheonyu("error", message, details);
const logCheonyuWarn = (message, details) => logCheonyu("warn", message, details);
const logCheonyuSuccess = (message, details) => logCheonyu("success", message, details);
const logCheonyuInfo = (message, details) => logCheonyu("info", message, details);

module.exports = {
  logCheonyuError,
  logCheonyuWarn,
  logCheonyuSuccess,
  logCheonyuInfo,
};

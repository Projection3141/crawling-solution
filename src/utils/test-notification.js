// src/utils/test-notification.js
// 목적: 사용자의 수동 테스트 이벤트를 서버로 전송하고 중복 실행을 막는다.

const { randomUUID } = require("node:crypto");
const { postResultJson } = require("./result-uploader");

let sending = false;

/** 사용자가 버튼을 눌렀을 때만 작은 테스트 이벤트를 전송한다. */
async function sendTestNotification({ appVersion = "" } = {}) {
  if (sending) throw new Error("테스트 알림을 전송 중입니다.");
  sending = true;
  try {
    const requestId = randomUUID();
    const sentAt = new Date().toISOString();
    return await postResultJson("테스트", {
      event: "connection-test",
      requestId,
      sentAt,
      appVersion: String(appVersion),
      message: "Mall Collector 수동 테스트 알림",
    }, { requestId, sentAt });
  } finally {
    sending = false;
  }
}

module.exports = { sendTestNotification };

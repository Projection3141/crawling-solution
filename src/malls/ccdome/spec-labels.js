// src/malls/ccdome/spec-labels.js
// 목적: 과자생각 상품 상세 스펙의 한국어 항목명을 고정 일본어 라벨로 변환한다.

/** 과자생각 상세 스펙의 고정 일본어 라벨. */
const SPEC_LABELS_JA = Object.freeze({
  소비기한: "消費期限",
  낱개가: "単品価格",
  박스구성: "ボックス構成",
  모델명: "型番",
  배송비: "送料",
  총상품금액: "合計商品金額",
});

function getCcdomeSpecLabelJa(label, fallback = label) {
  const key = String(label ?? "").replace(/\s+/g, "").replace(/[:：]$/, "");
  return SPEC_LABELS_JA[key] || fallback;
}

module.exports = { getCcdomeSpecLabelJa };

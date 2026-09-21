// 批次准入模块
// 建批前逐项校验：隔离中、有风险却无有效除害凭证、非待修状态均拒绝（409）。
// 仅做校验、不改动任何状态；调用方须在全部通过后再建批。

const quarantine = require("./quarantine");
const treatment = require("./treatment");

function fail(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function assertBatchAdmission(db, damageIds, nowMs = Date.now()) {
  const rejected = [];

  damageIds.forEach((id) => {
    const damage = db.damages.find((item) => item.id === id);
    if (!damage) return; // 不存在的项由路由层以 400 处理

    if (quarantine.isQuarantined(damage)) {
      rejected.push(`${id} 处于虫害隔离状态，须放行后才能入批`);
      return;
    }
    if (quarantine.hasRisk(damage) && !treatment.hasValidCertificate(db, id, nowMs)) {
      rejected.push(`${id} 存在${damage.riskCategory}风险且无有效除害凭证（观察期未结束），禁止入批`);
      return;
    }
    if (damage.status !== "pending") {
      rejected.push(`${id} 当前状态为 ${damage.status}，仅待修缺损可入批`);
    }
  });

  if (rejected.length) {
    fail(`批次准入失败：${rejected.join("；")}`);
  }
}

module.exports = { assertBatchAdmission };

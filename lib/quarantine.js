// 隔离判定模块：识别虫害/霉变/污染风险，决定缺损是否必须进入隔离
const { httpError } = require("./http");

const RISK_CATEGORIES = {
  insect: "虫蛀",
  mold: "霉斑",
  contamination: "污染"
};

const RISK_ALIASES = {
  insect: "insect",
  虫蛀: "insect",
  虫: "insect",
  虫害: "insect",
  蛀: "insect",
  mold: "mold",
  霉斑: "mold",
  霉: "mold",
  霉变: "mold",
  contamination: "contamination",
  污染: "contamination",
  污染物: "contamination"
};

// 风险字段缺失或为 null/空：旧缺损按安全处理
function hasRisk(damage) {
  return Boolean(normalizeRiskCategory(damage.riskCategory));
}

function normalizeRiskCategory(value) {
  if (value === undefined || value === null || value === "") return null;
  const key = RISK_ALIASES[String(value).trim()];
  return key || null;
}

function riskLabel(damage) {
  const key = normalizeRiskCategory(damage.riskCategory);
  return key ? RISK_CATEGORIES[key] : null;
}

// 将缺损标记为某类风险并立即隔离
function markQuarantined(damage, rawCategory, now = new Date()) {
  const category = normalizeRiskCategory(rawCategory);
  if (!category) {
    throw httpError(400, `riskCategory必须是：${Object.values(RISK_CATEGORIES).join("、")}`);
  }
  damage.riskCategory = category;
  damage.status = "quarantined";
  damage.quarantinedAt = now.toISOString();
  damage.releasedAt = null;
  damage.lastTreatmentId = null;
  return damage;
}

module.exports = {
  RISK_CATEGORIES,
  normalizeRiskCategory,
  hasRisk,
  riskLabel,
  markQuarantined
};

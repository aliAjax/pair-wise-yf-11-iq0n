// 隔离判定模块
// 缺损被标记为虫蛀、霉斑、污染三类风险后进入隔离（quarantined）。
// 旧缺损若缺少风险字段，按安全处理（riskCategory 为 null，不隔离）。

const RISK_CATEGORIES = ["虫蛀", "霉斑", "污染"];

// 除显式 riskCategory 外，缺损类型文本中出现以下关键字时同样视为风险标记
const RISK_KEYWORDS = [
  { category: "虫蛀", words: ["虫蛀", "蛀虫", "蛀孔", "蛀"] },
  { category: "霉斑", words: ["霉斑", "霉变", "发霉", "霉菌", "霉"] },
  { category: "污染", words: ["污染"] }
];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isValidRiskCategory(value) {
  return RISK_CATEGORIES.includes(value);
}

// 从写请求中识别风险类别：显式 riskCategory 优先，其次按 type 关键字识别
function detectRiskCategory(body) {
  if (body.riskCategory !== undefined && body.riskCategory !== null && body.riskCategory !== "") {
    if (!isValidRiskCategory(body.riskCategory)) {
      fail(400, `风险类型不合法，仅支持：${RISK_CATEGORIES.join("、")}`);
    }
    return body.riskCategory;
  }
  if (typeof body.type === "string" && body.type.trim()) {
    const hit = RISK_KEYWORDS.find((item) => item.words.some((word) => body.type.includes(word)));
    return hit ? hit.category : null;
  }
  return null;
}

function hasRisk(damage) {
  return isValidRiskCategory(damage.riskCategory);
}

function isQuarantined(damage) {
  return damage.status === "quarantined";
}

// 将缺损置为隔离状态；首次隔离时间保留，不覆盖
function markQuarantined(damage, category, now) {
  if (!isValidRiskCategory(category)) fail(400, `风险类型不合法，仅支持：${RISK_CATEGORIES.join("、")}`);
  damage.riskCategory = category;
  damage.status = "quarantined";
  damage.quarantinedAt = damage.quarantinedAt || now;
  damage.releasedAt = null;
  return damage;
}

// 旧数据归一化：缺少风险字段时按安全处理，保留原状态；返回是否发生变更
function normalizeDamage(damage) {
  let changed = false;
  if (damage.riskCategory === undefined) {
    damage.riskCategory = null;
    changed = true;
  }
  if (damage.quarantinedAt === undefined) {
    damage.quarantinedAt = null;
    changed = true;
  }
  if (damage.releasedAt === undefined) {
    damage.releasedAt = null;
    changed = true;
  }
  return changed;
}

module.exports = {
  RISK_CATEGORIES,
  detectRiskCategory,
  hasRisk,
  isQuarantined,
  markQuarantined,
  normalizeDamage
};

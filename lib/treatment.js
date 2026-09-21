// 除害记录模块
// 隔离中的缺损须登记除害凭证：药剂、温度、湿度、观察截止时间。
// 观察截止时间到达后凭证才有效，凭有效凭证方可放行。

const quarantine = require("./quarantine");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) fail(404, "缺损项不存在");
  return damage;
}

function listTreatments(db, damageId) {
  findDamage(db, damageId);
  return db.treatments
    .filter((item) => item.damageId === damageId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function requireString(body, field, label) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    fail(400, `缺少字段：${label}`);
  }
  return value.trim();
}

// 温湿度必须给出明确数值（摄氏度 / 相对湿度百分比）
function requireMeasure(body, field, label, unit) {
  const value = body[field];
  const num = Number(value);
  if (value === undefined || value === null || value === "" || Number.isNaN(num)) {
    fail(400, `缺少字段：${label}，须为${unit}`);
  }
  return num;
}

// 新增一条除害记录
function addTreatment(db, damageId, body, makeId, now) {
  const damage = findDamage(db, damageId);
  if (!quarantine.isQuarantined(damage)) {
    fail(409, "缺损未处于隔离状态，无需登记除害记录");
  }

  const chemical = requireString(body, "chemical", "药剂");
  const temperature = requireMeasure(body, "temperature", "温度", "摄氏度数值");
  const humidity = requireMeasure(body, "humidity", "湿度", "相对湿度百分比数值");

  const observeUntilRaw = requireString(body, "observeUntil", "观察截止时间");
  const observeUntilMs = Date.parse(observeUntilRaw);
  if (Number.isNaN(observeUntilMs)) fail(400, "观察截止时间必须是合法时间");
  const observeUntil = new Date(observeUntilMs).toISOString();
  if (observeUntilMs <= Date.parse(now)) {
    fail(400, "观察截止时间必须晚于当前时间");
  }

  const treatment = {
    id: makeId("treatment"),
    damageId,
    chemical,
    temperature,
    humidity,
    observeUntil,
    note: typeof body.note === "string" ? body.note : "",
    createdAt: now
  };
  db.treatments.push(treatment);
  return treatment;
}

// 取最近一条除害记录
function latestTreatment(db, damageId) {
  return listTreatments(db, damageId).slice(-1)[0] || null;
}

// 是否存在观察期已结束的有效除害凭证
function hasValidCertificate(db, damageId, nowMs) {
  const latest = latestTreatment(db, damageId);
  return Boolean(latest) && Date.parse(latest.observeUntil) <= nowMs;
}

// 放行：隔离中且观察期已到方可放行，放行后恢复待修
function release(db, damageId, now) {
  const damage = findDamage(db, damageId);
  if (!quarantine.isQuarantined(damage)) {
    fail(409, "缺损未处于隔离状态，不能放行");
  }
  const latest = latestTreatment(db, damageId);
  if (!latest) {
    fail(409, "缺少有效除害凭证，无法放行");
  }
  const nowMs = Date.parse(now);
  const untilMs = Date.parse(latest.observeUntil);
  if (untilMs > nowMs) {
    fail(409, `观察期未到（截止时间 ${latest.observeUntil}），不能提前放行`);
  }
  damage.status = "pending";
  damage.releasedAt = now;
  return { damage, treatment: latest };
}

module.exports = {
  listTreatments,
  addTreatment,
  latestTreatment,
  hasValidCertificate,
  release
};

// 除害记录模块：登记药剂/温湿度/观察截止时间，管理观察期与放行
const { makeId, httpError } = require("./http");
const { hasRisk } = require("./quarantine");

function pickChemical(body) {
  return body.chemical ?? body.pesticide ?? body.reagent;
}

function pickTemperature(body) {
  return body.temperature ?? body.temp;
}

function pickHumidity(body) {
  return body.humidity ?? body.humidityPercent;
}

function pickObserveUntil(body) {
  return body.observeUntil ?? body.observeDeadline ?? body.observationEndsAt ?? body.deadline;
}

function assertTreatmentFields(body) {
  const chemical = pickChemical(body);
  const temperature = pickTemperature(body);
  const humidity = pickHumidity(body);
  const observeUntil = pickObserveUntil(body);
  const missing = [];
  if (chemical === undefined || chemical === "") missing.push("chemical(药剂)");
  if (temperature === undefined || temperature === "") missing.push("temperature(温度)");
  if (humidity === undefined || humidity === "") missing.push("humidity(湿度)");
  if (observeUntil === undefined || observeUntil === "") missing.push("observeUntil(观察截止时间)");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join("、")}`);
  if (Number.isNaN(new Date(observeUntil).getTime())) {
    throw httpError(400, "observeUntil必须是合法时间");
  }
  return {
    chemical: String(chemical),
    temperature: String(temperature),
    humidity: String(humidity),
    observeUntil: new Date(observeUntil).toISOString()
  };
}

// 观察期是否已到：当前时间到达观察截止时间方可放行
function observationDue(treatment, now = new Date()) {
  return new Date(treatment.observeUntil).getTime() <= now.getTime();
}

// 一份有效除害凭证：已放行且观察期已到
function isReleasedCertificate(treatment, now = new Date()) {
  return Boolean(treatment) && treatment.status === "released" && observationDue(treatment, now);
}

// 取缺损最新一份有效放行凭证（无风险缺损不需要）。
// 重新隔离后，旧凭证（放行时间早于本次隔离时间）自动失效。
function findValidCertificate(db, damage, now = new Date()) {
  if (!hasRisk(damage)) return null;
  const quarantinedAt = damage.quarantinedAt ? new Date(damage.quarantinedAt).getTime() : 0;
  return (
    db.treatments
      .filter(
        (item) =>
          item.damageId === damage.id &&
          item.status === "released" &&
          item.releasedAt &&
          new Date(item.releasedAt).getTime() >= quarantinedAt
      )
      .sort((a, b) => new Date(b.observeUntil) - new Date(a.observeUntil))[0] || null
  );
}

function createTreatment(db, damage, body, now = new Date()) {
  if (damage.status !== "quarantined") {
    throw httpError(409, "缺损未处于隔离状态，不能登记除害记录");
  }
  const fields = assertTreatmentFields(body);
  const treatment = {
    id: makeId("treatment"),
    damageId: damage.id,
    chemical: fields.chemical,
    temperature: fields.temperature,
    humidity: fields.humidity,
    observeUntil: fields.observeUntil,
    note: body.note || "",
    status: "observing",
    createdAt: now.toISOString(),
    releasedAt: null
  };
  db.treatments.push(treatment);
  damage.lastTreatmentId = treatment.id;
  return treatment;
}

function release(db, treatmentId, now = new Date()) {
  const treatment = db.treatments.find((item) => item.id === treatmentId);
  if (!treatment) throw httpError(404, "除害记录不存在");
  const damage = db.damages.find((item) => item.id === treatment.damageId);
  if (!damage) throw httpError(404, "缺损项不存在");

  // 观察期未到，提前放行一律拒绝，批次与缺损状态不变
  if (!observationDue(treatment, now)) {
    throw httpError(409, `观察期未到，截止时间为 ${treatment.observeUntil}，暂不能放行`, {
      code: "OBSERVATION_NOT_DUE",
      observeUntil: treatment.observeUntil
    });
  }

  if (treatment.status !== "released") {
    treatment.status = "released";
    treatment.releasedAt = now.toISOString();
  }

  // 放行后恢复待修，风险标记保留备查，可再次入批；
  // 重复放行（已在修补批次中）保持幂等，不改动缺损状态
  if (damage.status === "quarantined") {
    damage.status = "pending";
    damage.releasedAt = treatment.releasedAt;
    damage.lastTreatmentId = treatment.id;
  }
  return { treatment, damage };
}

module.exports = {
  assertTreatmentFields,
  observationDue,
  isReleasedCertificate,
  findValidCertificate,
  createTreatment,
  release
};

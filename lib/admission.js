// 批次准入模块：建批前的准入校验，隔离或缺有效除害凭证一律拒绝
const { makeId, httpError } = require("./http");
const { hasRisk, riskLabel } = require("./quarantine");
const { findValidCertificate, observationDue } = require("./treatment");

// 返回所有不准入的缺损及原因；空数组表示全部准入
function checkAdmission(db, damageIds, now = new Date()) {
  if (!Array.isArray(damageIds) || damageIds.length === 0) {
    throw httpError(400, "damageIds必须是非空数组");
  }
  const missing = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
  if (missing.length) throw httpError(400, `缺损项不存在：${missing.join(", ")}`);

  const blocked = [];
  for (const id of damageIds) {
    const damage = db.damages.find((item) => item.id === id);

    if (damage.status === "repaired") {
      blocked.push({ damageId: id, reason: "缺损已修复完成" });
      continue;
    }
    if (damage.batchId) {
      blocked.push({ damageId: id, reason: `缺损已在批次 ${damage.batchId} 中`, batchId: damage.batchId });
      continue;
    }
    if (damage.status === "quarantined" || hasRisk(damage)) {
      const certificate = findValidCertificate(db, damage, now);
      if (!certificate) {
        blocked.push({
          damageId: id,
          reason: `存在${riskLabel(damage) || "生物危害"}风险，缺少有效除害放行凭证`,
          riskCategory: damage.riskCategory,
          quarantined: damage.status === "quarantined"
        });
      } else if (!observationDue(certificate, now)) {
        blocked.push({
          damageId: id,
          reason: `除害观察期未到（截止 ${certificate.observeUntil}）`,
          treatmentId: certificate.id
        });
      }
    }
  }
  return blocked;
}

function assertAdmittable(db, damageIds, now = new Date()) {
  const blocked = checkAdmission(db, damageIds, now);
  if (blocked.length) {
    throw httpError(409, "存在未通过准入的缺损项，不能建批", {
      code: "BATCH_ADMISSION_BLOCKED",
      blocked
    });
  }
}

// 校验通过后建批并把缺损转入修补中
function createBatch(db, body, now = new Date()) {
  const damageIds = body.damageIds;
  assertAdmittable(db, damageIds, now);
  const batch = {
    id: makeId("batch"),
    name: body.name,
    status: "open",
    damageIds: [...damageIds],
    note: body.note || "",
    createdAt: now.toISOString(),
    completedAt: null
  };
  db.batches.push(batch);
  for (const damage of db.damages) {
    if (damageIds.includes(damage.id)) {
      damage.batchId = batch.id;
      damage.status = "in_repair";
    }
  }
  return batch;
}

module.exports = { checkAdmission, assertAdmittable, createBatch };

const http = require("http");
const { readDb, writeDb } = require("./lib/store");
const { send, parseBody, required, httpError } = require("./lib/http");
const { normalizeRiskCategory, markQuarantined, RISK_CATEGORIES } = require("./lib/quarantine");
const { createTreatment, release } = require("./lib/treatment");
const { createBatch } = require("./lib/admission");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "POST /damages/:id/quarantine",
  "GET /damages/:id/treatments",
  "POST /damages/:id/treatments",
  "POST /treatments/:id/release",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw httpError(404, "拓片不存在");
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw httpError(404, "缺损项不存在");
  return damage;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();
  const now = new Date();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", riskCategories: RISK_CATEGORIES, routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length,
        quarantinedDamages: damages.filter((item) => item.status === "quarantined").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeIdSafe("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: now.toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const riskCategory = normalizeRiskCategory(body.riskCategory);
    if (body.riskCategory !== undefined && !riskCategory) {
      throw httpError(400, `riskCategory必须是：${Object.values(RISK_CATEGORIES).join("、")}`);
    }
    const damage = {
      id: makeIdSafe("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: riskCategory ? "quarantined" : "pending",
      repairNote: "",
      batchId: null,
      riskCategory,
      quarantinedAt: riskCategory ? now.toISOString() : null,
      releasedAt: null,
      lastTreatmentId: null,
      createdAt: now.toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter(
      (item) => (!status || item.status === status) && (!type || item.type === type)
    );
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = findDamage(db, damagePatchMatch[1]);
    const body = await parseBody(req);

    // 隔离中只能走除害/放行闭环，禁止直接改状态绕过
    if (damage.status === "quarantined" && body.status && body.status !== "quarantined") {
      throw httpError(409, "缺损处于虫害隔离中，请先完成除害并放行");
    }

    // 标记虫蛀、霉斑或污染：立即进入隔离
    if (body.riskCategory !== undefined) {
      const category = normalizeRiskCategory(body.riskCategory);
      if (!category) throw httpError(400, `riskCategory必须是：${Object.values(RISK_CATEGORIES).join("、")}`);
      markQuarantined(damage, body.riskCategory, now);
    }

    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      repairNote: body.repairNote ?? damage.repairNote
    });
    if (damage.status !== "quarantined") {
      damage.status = body.status ?? damage.status;
    }
    damage.repairedAt = damage.status === "repaired" ? now.toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  // 隔离判定：将缺损标记为虫蛀/霉斑/污染并隔离
  const quarantineMatch = pathname.match(/^\/damages\/([^/]+)\/quarantine$/);
  if (quarantineMatch && req.method === "POST") {
    const damage = findDamage(db, quarantineMatch[1]);
    const body = await parseBody(req);
    required(body, ["riskCategory"]);
    markQuarantined(damage, body.riskCategory, now);
    if (body.note !== undefined) damage.quarantineNote = body.note;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  // 除害记录：登记药剂、温湿度和观察截止时间
  const damageTreatmentsMatch = pathname.match(/^\/damages\/([^/]+)\/treatments$/);
  if (damageTreatmentsMatch && req.method === "GET") {
    const damage = findDamage(db, damageTreatmentsMatch[1]);
    return send(res, 200, { data: db.treatments.filter((item) => item.damageId === damage.id) });
  }
  if (damageTreatmentsMatch && req.method === "POST") {
    const damage = findDamage(db, damageTreatmentsMatch[1]);
    const body = await parseBody(req);
    const treatment = createTreatment(db, damage, body, now);
    await writeDb(db);
    return send(res, 201, { data: treatment });
  }

  // 放行：观察期未到返回409，放行后缺损恢复待修
  const releaseMatch = pathname.match(/^\/treatments\/([^/]+)\/release$/);
  if (releaseMatch && req.method === "POST") {
    const result = release(db, releaseMatch[1], now);
    await writeDb(db);
    return send(res, 200, { data: result.treatment, damage: result.damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    // 准入不通过直接抛409：批次与缺损状态不变（写库在抛错之后）
    const batch = createBatch(db, body, now);
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = now.toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = now.toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function makeIdSafe(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误", code: error.code, blocked: error.blocked })
  );
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});

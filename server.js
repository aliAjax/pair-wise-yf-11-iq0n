const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const quarantine = require("./lib/quarantine");
const treatment = require("./lib/treatment");
const { assertBatchAdmission } = require("./lib/batchGate");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      riskCategory: null,
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      quarantinedAt: null,
      releasedAt: null,
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      riskCategory: null,
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      quarantinedAt: null,
      releasedAt: null,
      repairedAt: null
    }
  ],
  batches: [],
  treatments: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /damages/:id/treatments",
  "POST /damages/:id/treatments",
  "POST /damages/:id/release",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!Array.isArray(db.treatments)) db.treatments = [];
  // 旧缺损缺少风险字段时按安全处理，归一化后落盘保留
  let changed = false;
  (db.damages || []).forEach((damage) => {
    if (quarantine.normalizeDamage(damage)) changed = true;
  });
  if (changed) await writeDb(db);
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, "请求体必须是合法JSON");
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw fail(400, `缺少字段：${missing.join(", ")}`);
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw fail(404, "拓片不存在");
  return rubbing;
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
  const now = new Date().toISOString();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
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
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: now
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
    const riskCategory = quarantine.detectRiskCategory(body);
    const quarantined = Boolean(riskCategory);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      // 标记虫蛀、霉斑、污染后直接进入隔离
      status: quarantined ? "quarantined" : "pending",
      riskCategory,
      repairNote: "",
      batchId: null,
      createdAt: now,
      quarantinedAt: quarantined ? now : null,
      releasedAt: null,
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damageTreatmentsMatch = pathname.match(/^\/damages\/([^/]+)\/treatments$/);
  if (damageTreatmentsMatch && req.method === "GET") {
    const data = treatment.listTreatments(db, damageTreatmentsMatch[1]);
    return send(res, 200, { data });
  }

  if (damageTreatmentsMatch && req.method === "POST") {
    const body = await parseBody(req);
    const record = treatment.addTreatment(db, damageTreatmentsMatch[1], body, makeId, now);
    await writeDb(db);
    return send(res, 201, { data: record });
  }

  const releaseMatch = pathname.match(/^\/damages\/([^/]+)\/release$/);
  if (releaseMatch && req.method === "POST") {
    const { damage, treatment: cert } = treatment.release(db, releaseMatch[1], now);
    await writeDb(db);
    return send(res, 200, { data: damage, releasedBy: cert });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    const originalType = damage.type;

    // 隔离闭环：隔离中的缺损只能走除害放行，禁止直接改状态或清除风险标记
    if (quarantine.isQuarantined(damage)) {
      if (body.status !== undefined && body.status !== "quarantined") {
        throw fail(409, "缺损处于隔离状态，须完成除害并放行后才能变更状态");
      }
      if (body.riskCategory !== undefined && body.riskCategory !== damage.riskCategory) {
        throw fail(409, "缺损处于隔离状态，不可变更风险标记");
      }
    }

    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });

    // 补标记虫蛀、霉斑、污染：进入隔离
    // type 原样回传不算新标记，避免编辑旧缺损时被关键字误隔离；显式 riskCategory 始终生效
    const riskInput = body.type !== undefined && body.type === originalType ? { ...body, type: undefined } : body;
    const riskCategory = quarantine.detectRiskCategory(riskInput);
    if (riskCategory && !quarantine.isQuarantined(damage)) {
      quarantine.markQuarantined(damage, riskCategory, now);
    }

    damage.repairedAt = damage.status === "repaired" ? damage.repairedAt || now : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    // 批次准入：隔离中、风险无有效除害凭证、非待修一律拒绝
    try {
      assertBatchAdmission(db, body.damageIds, Date.parse(now));
    } catch (error) {
      return send(res, error.status || 409, { error: error.message });
    }

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: now,
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
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
    batch.completedAt = now;
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = now;
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});

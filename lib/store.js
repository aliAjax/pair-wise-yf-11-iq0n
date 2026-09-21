const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

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
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
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
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: [],
  treatments: []
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 旧数据缺少风险字段时按安全处理：回填后状态落盘保留
function migrate(data) {
  let changed = false;
  if (!Array.isArray(data.treatments)) {
    data.treatments = [];
    changed = true;
  }
  for (const damage of data.damages || []) {
    if (!Object.prototype.hasOwnProperty.call(damage, "riskCategory")) {
      damage.riskCategory = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(damage, "quarantinedAt")) {
      damage.quarantinedAt = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(damage, "releasedAt")) {
      damage.releasedAt = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(damage, "lastTreatmentId")) {
      damage.lastTreatmentId = null;
      changed = true;
    }
  }
  return changed;
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(data)) {
    await writeFile(DB_FILE, JSON.stringify(data, null, 2));
  }
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { DB_FILE, readDb, writeDb };

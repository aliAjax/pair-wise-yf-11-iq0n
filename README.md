# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次与除害记录。

## 启动

```bash
PORT=3020 node server.js
```

## 模块划分

- `lib/quarantine.js` — **隔离判定**：识别虫蛀 / 霉斑 / 污染风险，缺损标记后立即进入隔离（`quarantined`）。
- `lib/treatment.js` — **除害记录**：登记药剂、温度、湿度、观察截止时间；观察期到点后放行，缺损恢复待修。
- `lib/admission.js` — **批次准入**：建批前统一校验，隔离中或缺少有效除害放行凭证的缺损一律拒绝。
- `lib/store.js` / `lib/http.js` — 持久化（含旧数据安全迁移）与 HTTP 工具。

## 接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`（建缺损时可带 `riskCategory`，带风险直接隔离）
- `GET /damages?status=&type=`
- `PATCH /damages/:id`（支持补标 `riskCategory`；隔离中禁止直接改状态绕过闭环）
- `POST /damages/:id/quarantine` — 标记 `riskCategory`（`insect`/`mold`/`contamination` 或中文 虫蛀/霉斑/污染）进入隔离
- `GET /damages/:id/treatments` / `POST /damages/:id/treatments` — 除害记录
- `POST /treatments/:id/release` — 观察期满放行
- `GET /batches` / `POST /batches` / `GET /batches/:id` / `POST /batches/:id/complete`

## 虫害隔离与放行闭环规则

1. **标记即隔离**：缺损标记虫蛀、霉斑或污染后，状态变为 `quarantined`，不能直接建批或改状态。
2. **无凭证拒入批**：隔离中的缺损没有有效除害放行凭证时，`POST /batches` 返回 `409`，批次不创建、任何缺损状态不变（响应 `blocked` 数组给出逐项原因）。
3. **除害记录四要素**：`chemical`（药剂，兼容 `pesticide`/`reagent`）、`temperature`（温度，兼容 `temp`）、`humidity`（湿度）、`observeUntil`（观察截止时间，兼容 `observeDeadline`/`deadline`），缺一返回 `400`。
4. **观察期未满禁放行**：当前时间早于观察截止时间时，`POST /treatments/:id/release` 返回 `409`；观察期内同样不能建批。
5. **放行恢复待修**：观察期到点放行后，缺损状态恢复 `pending`（风险标记保留备查），即可正常入批。
6. **重新隔离旧凭证失效**：放行后若再次被标记风险重新隔离，旧放行凭证（放行时间早于本次隔离时间）不再有效。
7. **旧数据按安全处理**：缺少风险字段的历史缺损迁移为 `riskCategory: null`（不隔离、可直接建批），迁移结果立即落盘保留。

## 闭环示例

```bash
# 1. 发现虫蛀，隔离
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/quarantine \
  -H 'Content-Type: application/json' -d '{"riskCategory":"虫蛀"}'

# 2. 直接建批 -> 409（缺有效除害凭证）
curl -X POST http://127.0.0.1:3020/batches -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'

# 3. 登记除害（药剂、温湿度、观察截止时间）
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/treatments \
  -H 'Content-Type: application/json' \
  -d '{"chemical":"环氧乙烷熏蒸","temperature":"25℃","humidity":"55%RH","observeUntil":"2026-09-28T00:00:00Z"}'

# 4. 观察期未到放行 -> 409；到期后放行 -> 200，缺损回到 pending
curl -X POST http://127.0.0.1:3020/treatments/<treatmentId>/release

# 5. 放行后建批成功
curl -X POST http://127.0.0.1:3020/batches -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'
```

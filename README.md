# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、除害记录和修补批次。

业务拆分为三个独立模块（`lib/`）：

- `quarantine.js` 隔离判定：缺损标记 **虫蛀 / 霉斑 / 污染** 后进入隔离（`quarantined`）
- `treatment.js` 除害记录：登记药剂、温度、湿度、观察截止时间，并负责放行判定
- `batchGate.js` 批次准入：建批前统一校验，不合规返回 409 且不改动任何状态

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `GET /damages/:id/treatments`：查看除害记录
- `POST /damages/:id/treatments`：登记除害记录
- `POST /damages/:id/release`：观察期满后放行，恢复待修
- `GET /batches` / `POST /batches` / `GET /batches/:id` / `POST /batches/:id/complete`

## 虫害隔离与放行闭环

1. 标记风险即隔离：新建缺损时传 `riskCategory`（`虫蛀`/`霉斑`/`污染`），
   或 `type` 文本含虫蛀、霉斑、污染关键字；也可用 `PATCH /damages/:id` 补标记。
   命中后状态变为 `quarantined`。
2. 隔离中登记除害记录，须写清 `chemical`（药剂）、`temperature`（温度℃）、
   `humidity`（湿度%）、`observeUntil`（观察截止时间，须晚于当前时间）。
3. 观察期未到时调用放行返回 **409**；到期后 `POST /damages/:id/release`
   放行，状态恢复 `pending`。
4. `POST /batches` 建批时准入校验：
   - 隔离中 → 409（须先放行）
   - 有风险但无有效除害凭证（无记录或观察期未结束）→ 409
   - 非待修状态 → 409
   - 任一缺损不合规则整批拒绝，批次与缺损状态均不变
5. 旧缺损缺少风险字段时按安全处理（`riskCategory: null`），服务启动读取后
   归一化并落盘保留，原状态不变。

隔离中的缺损禁止通过 PATCH 直接改状态或清除风险标记（返回 409）。

## 闭环示例

```bash
# 1. 标记虫蛀（也可在创建缺损时直接标记）
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_1 \
  -H 'Content-Type: application/json' \
  -d '{"riskCategory":"虫蛀"}'

# 2. 无有效除害凭证时建批 -> 409
curl -i -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'

# 3. 登记除害（观察期 7 天）
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/treatments \
  -H 'Content-Type: application/json' \
  -d '{"chemical":"环氧乙烷熏蒸","temperature":22,"humidity":55,"observeUntil":"2026-09-28T00:00:00Z"}'

# 4. 观察期未到放行 -> 409；到期后放行 -> 恢复 pending
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/release

# 5. 放行后正常入批
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```

# 加油站班次核销台

按班次核销油枪读数、现金、电子支付与银行到账回执。解决"只记总额、设备读数和回执对不上只能翻纸单"的问题。

## 启动

```bash
npm install
npm run dev      # 同时启动 API（:3001，数据落 data/gas-shift-db.json）与前端（:5173）
# 或分开：npm run server / npx vite
```

- 构建：`npm run build`（前端 dist/ + 服务端 dist-api/），`npm start` 跑生产服务端
- 测试：`npm test`（领域纯逻辑单测 + API 端到端 + 多窗口真实前端 store 端到端，需先 `npm run server` 才跑 e2e）
- 页面提供"重置演示数据"按钮；也可 `curl -X POST http://localhost:3001/api/state/reset`

## 核销规则（业务底线）

1. **当班收入只认油枪泵码**：应收 = Σ(交班泵码−接班泵码)×单价。
2. **未匹配回执/电子支付不核销**：进入"待核"，保留为对账差异（应收−已核销实收），**绝不拉高当班收入**。
3. 银行回执按 **终端号 + 回执号** 合并：重复上报幂等丢弃；同号但金额不一致标记"金额不符"，不自动核销。
4. 待核回执到达时，自动按 终端号+金额 配对未确认班次的电子支付；也可在班次页人工挂班。

## 确认后只追加冲正，原确认依据保留

班次一旦确认，`confirmedBasis` 快照（泵码、已核销收款、应收/实收/差异）永久冻结，泵码和收款不可整单改写。此后：

- **跨班退款**：往原班追加 `cross_shift_refund` 冲正，应收/实收各冲减；
- **晚到回执**：追加 `late_receipt` 冲正，只增实收、冲减差异，不动原应收；
- **泵码更新**：追加 `pump_adjust` 冲正，按新旧泵码差额 × 单价调应收，实收不变。

页面按班次呈现油枪、收款、回执、差异和完整**冲正链**；视图 = 原确认依据 + 冲正链重算（未确认部分仍按实时泵码/收款算）。

## 离线优先与并发安全

- 顶栏可切"断网"：编辑即时存为本地草稿，保存/回执/确认/冲正进 **FIFO 待发队列**；关掉浏览器再打开，草稿、队列、终端号、上次查看的班次都还在，可接着处理。
- 网络恢复后队列自动重放，回执按回执号幂等合并。
- 服务端对每个班次用 **version 乐观锁**：两个窗口同时保存，后到的旧版本被 409 拒绝，**不会覆盖已生效结果**，而是在前端生成**冲突草稿**——可"放弃旧版本"或"以旧内容基于最新版本重做（rebase）"。
- 前端对并发响应做单调序号守卫，迟到的旧 GET 响应不会覆盖新写结果。
- 跨窗口通过 BroadcastChannel / storage 事件互相同步。

## 结构

```
shared/          前后端共用：领域类型 types.ts + 纯核销逻辑 domain.ts（含单测）
server/          零依赖 Node HTTP 服务：JSON 原子落盘、乐观锁、自动核销、冲正
  index.ts         API 路由
  store.ts         持久化（tmp+rename）
  seed.ts          演示数据（已确认晚班+跨班退款 / 进行中早班 / 晚到与孤儿回执）
src/
  store.ts         Pinia：在线/队列/草稿/冲突/单调守卫
  lib/api.ts       API 客户端（409→ApiConflict，4xx→ApiReject 不入队）
  components/      班次列表、班次详情（油枪/收款/待核回执/冲正链）、回执上报、冲突面板
scripts/         构建与端到端测试（esbuild 随 vite 安装，无额外运行时依赖）
```

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全站状态（同时触发一次自动核销） |
| POST | `/api/receipts` | 回执上报，终端号+回执号幂等合并 |
| POST | `/api/receipts/link` | 人工挂班；已确认班→晚到回执冲正 |
| PUT | `/api/shifts/:id/commit` | 提交工作稿（body 带 version，泵码整单、收款按 clientId 合并） |
| POST | `/api/shifts/:id/confirm` | 确认班次，固化快照 |
| POST | `/api/shifts/:id/corrections/cross-shift-refund` | 跨班退款冲正 |
| POST | `/api/shifts/:id/corrections/pump-adjust` | 泵码更新冲正 |

所有写操作基于版本号；版本不匹配返回 `409 VERSION_CONFLICT` 并附服务端当前班次快照。

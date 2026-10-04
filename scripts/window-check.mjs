// 多窗口（worker realm）端到端：真实前端 store + 真实 API
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER = process.env.WORKER_BUNDLE || fileURLToPath(new URL("../dist-api/worker.mjs", import.meta.url));
let failed = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}
let seq = 0;
function openWindow(label, initial = {}) {
  const w = new Worker(WORKER);
  let resolveReady;
  const ready = new Promise((res) => (resolveReady = res));
  const pending = new Map();
  w.on("message", (msg) => {
    if (msg.id === "ready") {
      // worker 已注册消息监听，现在发初始数据
      w.postMessage({ initial });
      return;
    }
    if (msg.id === "started") {
      resolveReady();
      return;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      msg.ok ? r.resolve(msg.val) : r.reject(new Error(msg.val));
    }
  });
  w.on("error", (e) => console.error(`[worker:${label}]`, e.message));
  const rpc = (cmd, payload) =>
    new Promise((resolve, reject) => {
      const id = `m${++seq}`;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, cmd, ...payload });
    });
  return {
    label,
    w,
    ready,
    call: (method, ...args) => rpc("call", { method, args }),
    eval: (body) => rpc("eval", { body }),
    expr: (body) => rpc("expr", { body }),
    dump: () => rpc("dump", {}),
    terminate: () => w.terminate(),
  };
}
async function startWindow(label, initial) {
  const w = openWindow(label, initial);
  await Promise.race([
    w.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error("worker timeout")), 10000)),
  ]);
  return w;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MORNING = "S-1004-MORNING";
const EVENING = "S-1003-EVENING";

await fetch("http://localhost:3001/api/state/reset", { method: "POST" });

// ---------- 场景 1：两个窗口同时保存，后到旧版本 → 冲突草稿，不覆盖，可重做 ----------
{
  const A = await startWindow("A", { "gas-shift:terminal": "T01" });
  const B = await startWindow("B", { "gas-shift:terminal": "T02" });
  await A.call("refresh");
  await B.call("refresh");

  for (const [w, meter] of [[A, 56950], [B, 56999]]) {
    await w.eval(`
      const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
      const pumps = JSON.parse(JSON.stringify(sh.pumps));
      pumps[1].endMeter = ${meter};
      store.saveDraft(sh.id, sh.version, pumps, sh.payments);
    `);
  }

  const aOk = await A.eval(`
    const id = ${JSON.stringify(MORNING)};
    return store.commitDraft(id, store.getDraft(id));
  `);
  check("窗口A 先保存成功", aOk === true);

  const bOk = await B.eval(`
    const id = ${JSON.stringify(MORNING)};
    return store.commitDraft(id, store.getDraft(id));
  `);
  check("窗口B 后到旧版本被拒绝（不覆盖生效结果）", bOk === false);

  const bc = await B.eval(`
    const c = store.conflicts[0];
    return { n: store.conflicts.length, kind: c.kind, oldBase: c.clientPayload.version,
      serverV: c.serverSnapshot.version, winningMeter: c.serverSnapshot.pumps[1].endMeter };
  `);
  check("窗口B 生成冲突草稿（旧 v0 vs 生效 v1）",
    bc.n === 1 && bc.kind === "commit" && bc.oldBase === 0 && bc.serverV === 1, JSON.stringify(bc));
  check("冲突快照保留 A 生效结果（56950，未被 56999 覆盖）", bc.winningMeter === 56950);

  await B.eval(`store.resolveConflictRebase(store.conflicts[0].id); true;`);
  const rebased = await B.eval(`
    const d = store.getDraft(${JSON.stringify(MORNING)});
    return { base: d.baseVersion, meter: d.pumps[1].endMeter };
  `);
  check("冲突 rebase：基线换 v1、旧内容 56999 保留", rebased.base === 1 && rebased.meter === 56999, JSON.stringify(rebased));

  const bRetry = await B.eval(`
    const id = ${JSON.stringify(MORNING)};
    return store.commitDraft(id, store.getDraft(id));
  `);
  check("窗口B 基于新版本重做成功", bRetry === true);

  await A.call("refresh");
  const aSees = await A.expr(`store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)}).pumps[1].endMeter`);
  check("窗口A 看到 B 重做后的生效结果 v2(56999)", aSees === 56999, String(aSees));

  await A.terminate();
  await B.terminate();
}

// ---------- 场景 2：断网留草稿/队列 → 关掉重开仍在 → 联网自动合并 ----------
{
  await fetch("http://localhost:3001/api/state/reset", { method: "POST" });
  const A = await startWindow("A-offline", { "gas-shift:terminal": "T01" });
  await A.call("refresh");

  await A.eval(`
    store.setOnline(false);
    const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
    const pumps = JSON.parse(JSON.stringify(sh.pumps));
    pumps[0].endMeter = 130488;
    store.saveDraft(sh.id, sh.version, pumps, sh.payments);
  `);
  const q = await A.eval(`
    const id = ${JSON.stringify(MORNING)};
    const ok = await store.commitDraft(id, store.getDraft(id));
    return { ok, queue: store.queue.length, hasDraft: !!store.getDraft(id), online: store.online };
  `);
  check("断网保存：留草稿 + 待发队列，不上报", q.ok === false && q.queue === 1 && q.hasDraft === true && q.online === false, JSON.stringify(q));

  // 关掉（保留 localStorage），用导出的存储内容重开
  const dump = await A.dump();
  await A.terminate();
  const A2 = await startWindow("A-reopen", dump);
  const restored = await A2.eval(`
    return { online: store.online, queue: store.queue.length,
      meter: store.getDraft(${JSON.stringify(MORNING)})?.pumps[0].endMeter,
      terminal: store.terminalNo };
  `);
  check("关掉再打开：离线态/队列/草稿/终端号都在",
    restored.online === false && restored.queue === 1 && restored.meter === 130488 && restored.terminal === "T01",
    JSON.stringify(restored));

  await A2.call("setOnline", true);
  // setOnline(true) 内部触发 refresh + flushQueue
  for (let i = 0; i < 30; i++) {
    const ql = await A2.expr(`store.queue.length`);
    if (ql === 0) break;
    await sleep(200);
  }
  await sleep(300);
  const synced = await A2.eval(`
    const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
    return { v: sh.version, meter: sh.pumps[0].endMeter, draftCleared: !store.getDraft(sh.id) };
  `);
  check("联网后自动上报：泵码 130488 生效 v1，草稿清除",
    synced.v === 1 && synced.meter === 130488 && synced.draftCleared, JSON.stringify(synced));

  await A2.terminate();
}

// ---------- 场景 3：未匹配回执不抬收入；晚到回执只追加冲正，确认依据保留 ----------
{
  await fetch("http://localhost:3001/api/state/reset", { method: "POST" });
  const A = await startWindow("A-rcpt", { "gas-shift:terminal": "T01" });
  await A.call("refresh");

  const before = await A.expr(`store.view(${JSON.stringify(MORNING)})`);
  check("进行中早班：应收只认泵码 12195，未匹配电子 4200 在差异里",
    before.income === 12195 && before.electronicUnmatched === 4200 && before.collected === 3740 && before.diff === 8455,
    JSON.stringify({ i: before.income, c: before.collected, d: before.diff }));

  await A.eval(`
    store.dispatch({
      type: "receipt", label: "R3200", endpoint: "/api/receipts",
      payload: { receipts: [{ id: "loc-R3200", terminalNo: "T02", receiptNo: "R3200", amount: 4200,
        txTime: new Date().toISOString(), arrivedAt: new Date().toISOString() }] },
    });
  `);
  await sleep(400);
  const after = await A.expr(`store.view(${JSON.stringify(MORNING)})`);
  check("R3200 到达自动核销：实收 +4200=7940，应收仍 12195（不被拉高）",
    after.collected === 7940 && after.electronicMatched === 4200 && after.income === 12195,
    JSON.stringify({ c: after.collected, i: after.income }));

  await A.eval(`
    store.dispatch({ type: "confirm", label: "确认早班", shiftId: ${JSON.stringify(MORNING)},
      endpoint: "/api/shifts/m/confirm", payload: { version: 0 } });
  `);
  await sleep(400);
  const confirmed = await A.eval(`
    const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
    return { status: sh.status, bi: sh.confirmedBasis?.income, bc: sh.confirmedBasis?.collected };
  `);
  check("确认：固化依据 应收12195/实收7940",
    confirmed.status === "confirmed" && confirmed.bi === 12195 && confirmed.bc === 7940, JSON.stringify(confirmed));

  // 晚到回执 R3001(T01,300) 挂到已确认班 → 冲正
  await A.eval(`
    store.dispatch({ type: "linkReceipt", label: "晚到回执R3001", endpoint: "/api/receipts/link",
      payload: { terminalNo: "T01", receiptNo: "R3001", shiftId: ${JSON.stringify(MORNING)},
        version: 1, clientId: "T01-LR-3001" } });
  `);
  await sleep(400);
  const late = await A.eval(`
    const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
    const v = store.view(sh.id);
    const x = sh.correctionChain.find(c => c.type === "late_receipt");
    return { has: !!x, dCol: x?.collectedDelta, dInc: x?.incomeDelta,
      basis: sh.confirmedBasis.collected, income: v.income, collected: v.collected, diff: v.diff };
  `);
  check("晚到回执：冲正 +300 实收、0 应收，原依据 7940 保留",
    late.has && late.dCol === 300 && late.dInc === 0 && late.basis === 7940, JSON.stringify(late));
  check("重算：应收 12195、实收 8240、差异缩小到 3955",
    late.income === 12195 && late.collected === 8240 && late.diff === 3955, JSON.stringify(late));

  // 跨班退款冲正
  await A.eval(`
    store.dispatch({ type: "correction", label: "跨班退款-200", shiftId: ${JSON.stringify(MORNING)},
      endpoint: "x", payload: { kind: "refund", version: 2, amount: 200,
        reason: "客户次日退款", originShiftId: ${JSON.stringify(EVENING)}, clientId: "T01-RF-200" } });
  `);
  await sleep(400);
  const chain = await A.eval(`
    const sh = store.state.shifts.find(x => x.id === ${JSON.stringify(MORNING)});
    const v = store.view(sh.id);
    return { types: sh.correctionChain.map(c => c.type), income: v.income, collected: v.collected, basis: sh.confirmedBasis.income };
  `);
  check("跨班退款只追加：链=[晚到回执,退款]，应收/实收各 -200，原确认收入依据不变",
    chain.types[0] === "late_receipt" && chain.types[1] === "cross_shift_refund"
      && chain.income === 11995 && chain.collected === 8040 && chain.basis === 12195, JSON.stringify(chain));

  // 已确认班次再保存 → 冲突草稿（不覆盖）
  await A.eval(`
    store.saveDraft(${JSON.stringify(MORNING)}, 99, [], []);
    store.commitDraft(${JSON.stringify(MORNING)}, store.getDraft(${JSON.stringify(MORNING)}));
  `);
  await sleep(300);
  const cf = await A.expr(`store.conflicts.length`);
  check("已确认班次整单保存被拦为冲突草稿", cf >= 1, String(cf));

  await A.terminate();
}

console.log(failed === 0 ? "\n多窗口端到端全部通过 🎉" : `\n${failed} 项失败`);
process.exit(failed ? 1 : 0);

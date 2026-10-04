import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BankReceipt, Correction, Payment, PumpReading, ServerState, Shift } from "../shared/types.ts";
import {
  autoMatch,
  buildConfirmBasis,
  mergePayments,
  mergeReceipts,
  round2,
  uid,
} from "../shared/domain.ts";
import { getState, persist, reseed } from "./store.ts";

const PORT = Number(process.env.PORT || 3001);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) rejectBody(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (e) {
        rejectBody(e);
      }
    });
    req.on("error", rejectBody);
  });
}

function findShift(s: ServerState, id: string): Shift | undefined {
  return s.shifts.find((x) => x.id === id);
}

/**
 * 全站自动核销：待核回执与各未确认班次的未匹配电子支付
 * 按 终端号+金额 配对；确认后的班次不动，晚到回执走冲正。
 */
function autoMatchAll(s: ServerState): void {
  let receipts = s.receipts.map((r) => ({ ...r }));
  for (const shift of s.shifts) {
    if (shift.status !== "open") continue;
    const out = autoMatch(shift.payments, receipts);
    shift.payments = out.payments;
    for (const r of out.receipts) {
      if (r.status === "linked" && !r.shiftId && r.linkedPaymentId) {
        if (shift.payments.some((p) => p.id === r.linkedPaymentId)) r.shiftId = shift.id;
      }
    }
    receipts = out.receipts;
  }
  s.receipts = receipts;
}

function conflict(res: ServerResponse, shift: Shift, detail: string): void {
  json(res, 409, {
    error: "VERSION_CONFLICT",
    message: detail,
    shiftId: shift.id,
    serverShift: shift,
    serverVersion: shift.version,
  });
}

function publicState(s: ServerState) {
  return { ...s, serverTime: new Date().toISOString() };
}

function appendCorrection(shift: Shift, corr: Omit<Correction, "id" | "createdAt">): void {
  shift.correctionChain.push({
    ...corr,
    id: uid("X"),
    createdAt: new Date().toISOString(),
  });
  shift.version += 1;
  shift.updatedAt = new Date().toISOString();
}

async function routes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const s = getState();

  if (req.method === "GET" && path === "/api/state") {
    autoMatchAll(s);
    persist();
    json(res, 200, publicState(s));
    return;
  }

  if (req.method === "POST" && path === "/api/state/reset") {
    json(res, 200, reseed());
    return;
  }

  if (req.method === "POST" && path === "/api/shifts") {
    const b = await readBody(req);
    const shift: Shift = {
      id: typeof b.id === "string" ? b.id : uid("S"),
      stationId: s.station.id,
      name: String(b.name ?? "新班次"),
      startTime: String(b.startTime ?? new Date().toISOString()),
      endTime: b.endTime ? String(b.endTime) : undefined,
      status: "open",
      version: 0,
      pumps: Array.isArray(b.pumps) ? (b.pumps as PumpReading[]) : [],
      payments: Array.isArray(b.payments) ? (b.payments as Payment[]) : [],
      correctionChain: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    s.shifts.unshift(shift);
    autoMatchAll(s);
    persist();
    json(res, 200, publicState(s));
    return;
  }

  // 班次工作稿提交：泵码整单覆盖（基于版本），收款按 clientId 幂等合并
  if (req.method === "PUT" && /^\/api\/shifts\/[^/]+\/commit$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const shift = findShift(s, id);
    if (!shift) return json(res, 404, { error: "NOT_FOUND" });
    const b = await readBody(req);
    if (shift.status === "confirmed") return conflict(res, shift, "班次已确认生效，不能覆盖，只能追加冲正");
    if (shift.version !== Number(b.version)) return conflict(res, shift, "数据已被另一终端更新，请先合并新版本");
    if (Array.isArray(b.pumps)) shift.pumps = b.pumps as PumpReading[];
    if (Array.isArray(b.payments)) shift.payments = mergePayments(shift.payments, b.payments as Payment[]);
    shift.version += 1;
    shift.updatedAt = new Date().toISOString();
    autoMatchAll(s);
    persist();
    json(res, 200, publicState(s));
    return;
  }

  // 确认班次：固化确认依据，此后泵码/收款不可改
  if (req.method === "POST" && /^\/api\/shifts\/[^/]+\/confirm$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const shift = findShift(s, id);
    if (!shift) return json(res, 404, { error: "NOT_FOUND" });
    const b = await readBody(req);
    if (shift.status === "confirmed") return conflict(res, shift, "班次已确认，不能重复确认");
    if (shift.version !== Number(b.version)) return conflict(res, shift, "确认依据已过期，请基于新版本重新确认");
    shift.status = "confirmed";
    shift.endTime = b.endTime ?? new Date().toISOString();
    shift.confirmedBasis = buildConfirmBasis(shift, new Date().toISOString());
    shift.version += 1;
    shift.updatedAt = new Date().toISOString();
    persist();
    json(res, 200, publicState(s));
    return;
  }

  // 跨班退款冲正：退款冲减原班应收与实收，原确认依据保留
  if (req.method === "POST" && /^\/api\/shifts\/[^/]+\/corrections\/cross-shift-refund$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const shift = findShift(s, id);
    if (!shift) return json(res, 404, { error: "NOT_FOUND" });
    const b = await readBody(req);
    if (shift.status !== "confirmed") return json(res, 400, { error: "BAD_REQUEST", message: "只有已确认班次才需要冲正，未确认班次请直接改泵码/收款" });
    if (shift.version !== Number(b.version)) return conflict(res, shift, "冲正期间班次已有新冲正，请刷新后追加");
    const amount = Math.abs(Number(b.amount));
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: "BAD_REQUEST", message: "金额无效" });
    appendCorrection(shift, {
      clientId: String(b.clientId ?? uid("X")),
      type: "cross_shift_refund",
      reason: String(b.reason ?? "跨班退款"),
      terminalNo: String(b.terminalNo ?? s.station.terminals[0]),
      incomeDelta: round2(-amount),
      collectedDelta: round2(-amount),
      originShiftId: b.originShiftId ? String(b.originShiftId) : undefined,
    });
    persist();
    json(res, 200, publicState(s));
    return;
  }

  // 泵码更新冲正：确认后泵码一更新，只追加差额
  if (req.method === "POST" && /^\/api\/shifts\/[^/]+\/corrections\/pump-adjust$/.test(path)) {
    const id = decodeURIComponent(path.split("/")[3]);
    const shift = findShift(s, id);
    if (!shift) return json(res, 404, { error: "NOT_FOUND" });
    const b = await readBody(req);
    if (shift.status !== "confirmed") return json(res, 400, { error: "BAD_REQUEST", message: "未确认班次直接改泵码即可" });
    if (shift.version !== Number(b.version)) return conflict(res, shift, "冲正期间班次已有新冲正，请刷新后追加");
    const price = Number(b.price);
    const oldMeter = Number(b.oldMeter);
    const newMeter = Number(b.newMeter);
    if (![price, oldMeter, newMeter].every(Number.isFinite)) return json(res, 400, { error: "BAD_REQUEST", message: "泵码参数无效" });
    const volumeDelta = round2(newMeter - oldMeter);
    appendCorrection(shift, {
      clientId: String(b.clientId ?? uid("X")),
      type: "pump_adjust",
      reason: String(b.reason ?? "确认后泵码更新"),
      terminalNo: String(b.terminalNo ?? s.station.terminals[0]),
      incomeDelta: round2(volumeDelta * price),
      collectedDelta: 0,
      volumeDelta,
      pumpNo: b.pumpNo ? String(b.pumpNo) : undefined,
      oldMeter,
      newMeter,
    });
    persist();
    json(res, 200, publicState(s));
    return;
  }

  // 银行回执上报（断网恢复后按 终端号+回执号 合并，重复幂等）
  if (req.method === "POST" && path === "/api/receipts") {
    const b = await readBody(req);
    const incoming: BankReceipt[] = (Array.isArray(b.receipts) ? b.receipts : [b])
      .filter((r: any) => r && r.terminalNo && r.receiptNo && Number.isFinite(Number(r.amount)))
      .map((r: any): BankReceipt => ({
        id: String(r.id ?? uid("B")),
        terminalNo: String(r.terminalNo),
        receiptNo: String(r.receiptNo),
        amount: round2(Number(r.amount)),
        txTime: String(r.txTime ?? new Date().toISOString()),
        arrivedAt: String(r.arrivedAt ?? new Date().toISOString()),
        status: "pending",
      }));
    const out = mergeReceipts(s.receipts, incoming);
    s.receipts = out.merged;
    autoMatchAll(s);
    persist();
    json(res, 200, { ...publicState(s), merged: incoming.length, duplicates: out.duplicates, mismatchKeys: out.mismatches.map((m) => `${m.terminalNo}#${m.receiptNo}`) });
    return;
  }

  // 人工核账：待核回执挂到班次（未确认→核销电子支付；已确认→晚到回执冲正）
  if (req.method === "POST" && path === "/api/receipts/link") {
    const b = await readBody(req);
    const receipt = s.receipts.find((r) => r.terminalNo === String(b.terminalNo) && r.receiptNo === String(b.receiptNo));
    if (!receipt) return json(res, 404, { error: "NOT_FOUND", message: "回执不存在" });
    const shift = findShift(s, String(b.shiftId));
    if (!shift) return json(res, 404, { error: "NOT_FOUND", message: "班次不存在" });
    if (shift.version !== Number(b.version)) return conflict(res, shift, "班次版本已变，请刷新后核销");

    if (shift.status === "open") {
      const pay = shift.payments
        .filter((p) => p.method === "electronic" && !p.receiptNo && p.terminalNo === receipt.terminalNo)
        .sort((a, z) => Math.abs(a.amount - receipt.amount) - Math.abs(z.amount - receipt.amount))[0];
      if (!pay) return json(res, 400, { error: "NO_MATCH", message: "该班没有同终端的未匹配电子支付" });
      pay.receiptNo = receipt.receiptNo;
      receipt.status = "linked";
      receipt.linkedPaymentId = pay.id;
      receipt.shiftId = shift.id;
      receipt.amountMismatch = Math.abs(pay.amount - receipt.amount) > 0.001;
      shift.version += 1;
      shift.updatedAt = new Date().toISOString();
    } else {
      appendCorrection(shift, {
        clientId: String(b.clientId ?? uid("X")),
        type: "late_receipt",
        reason: String(b.reason ?? `晚到回执 ${receipt.receiptNo} 人工核销`),
        terminalNo: String(b.terminalNo ?? s.station.terminals[0]),
        incomeDelta: 0,
        collectedDelta: round2(receipt.amount),
        receiptSnapshot: { terminalNo: receipt.terminalNo, receiptNo: receipt.receiptNo, amount: receipt.amount },
      });
      receipt.status = "linked";
      receipt.shiftId = shift.id;
    }
    persist();
    json(res, 200, publicState(s));
    return;
  }

  json(res, 404, { error: "NOT_FOUND", path });
}

const server = createServer((req, res) => {
  routes(req, res).catch((err: Error) => {
    json(res, 500, { error: "INTERNAL", message: err.message });
  });
});

server.listen(PORT, () => {
  console.log(`[gas-shift] API listening on http://localhost:${PORT}`);
});

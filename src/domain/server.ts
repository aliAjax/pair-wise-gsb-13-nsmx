import {
  reconcile,
  pumpAmount,
  totalPumpAmount,
} from "./recon";
import type {
  AppliedOp,
  BankReceipt,
  Correction,
  Payment,
  ServerOp,
  ServerState,
  Shift,
  UnassignedReceipt,
} from "./types";
import { ConflictError, receiptKey } from "./types";

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function findShift(state: ServerState, id: string): Shift {
  const s = state.shifts.find((x) => x.id === id);
  if (!s) throw new Error(`班次不存在: ${id}`);
  return s;
}

function checkVersion(shift: Shift, baseVersion: number): void {
  if (shift.version !== baseVersion) {
    throw new ConflictError(shift.id, baseVersion, shift.version);
  }
}

function bump(shift: Shift, clientId: string, opId: string, at: number): void {
  shift.versionOwner.push({ clientId, opId, at });
  shift.version += 1;
}

/** 某班次当前可用于匹配的全部银行回执：各班的已匹配/挂起 + 全局同步池按流水反查 */
/**
 * 应用一条服务端操作（纯函数）。乐观锁冲突抛 ConflictError，不修改入参。
 * clientId 用于记录每个版本由哪个设备生效（离线重放时区分本机链与他人窗口）。
 */
export function applyOp(
  input: ServerState,
  op: ServerOp,
  now: number = Date.now(),
  clientId = "server"
): AppliedOp {
  if (input.appliedOpKeys.includes(op.opId)) {
    // 幂等：重复操作直接返回原状态
    return {
      state: input,
      bumpedShiftIds: [],
      lateRouted: [],
      unassigned: [],
      duplicated: [],
    };
  }

  const state: ServerState = {
    ...input,
    revision: input.revision + 1,
    shifts: clone(input.shifts),
    unassigned: clone(input.unassigned),
    seenReceiptKeys: [...input.seenReceiptKeys],
    appliedOpKeys: [...input.appliedOpKeys, op.opId].slice(-500),
  };

  const result: AppliedOp = {
    state,
    bumpedShiftIds: [],
    lateRouted: [],
    unassigned: [],
    duplicated: [],
  };

  if (op.kind === "syncReceipts") {
    applySyncReceipts(state, op, result, now, clientId);
  } else if (op.kind === "saveShift") {
    const shift = findShift(state, op.shiftId);
    checkVersion(shift, op.baseVersion);
    if (shift.status !== "open") throw new Error("已确认班次不能整体覆盖保存，请走冲正");
    shift.pumps = clone(op.pumps);
    shift.cashTotal = op.cashTotal;
    shift.payments = clone(op.payments);
    bump(shift, clientId, op.opId, now);
    result.bumpedShiftIds = [shift.id];
  } else if (op.kind === "confirmShift") {
    const shift = findShift(state, op.shiftId);
    checkVersion(shift, op.baseVersion);
    if (shift.status !== "open") throw new Error("班次已确认");
    const receipts = receiptsForOpenShift(state, shift);
    const recon = reconcile(shift.pumps, shift.cashTotal, shift.payments, receipts);
    shift.snapshot = {
      confirmedAt: now,
      confirmedBy: op.confirmedBy,
      version: shift.version,
      pumpTotals: clone(shift.pumps),
      cashTotal: shift.cashTotal,
      payments: clone(shift.payments),
      matchedReceipts: clone(recon.matchedReceipts),
      income: clone(recon.summary),
      pending: clone(recon.summary),
      pumpTotalAmount: totalPumpAmount(shift.pumps),
    };
    // 已确认匹配的回执退出待核池（冻结进快照）；未匹配回执继续留在池里保留差异
    const matchedKeys = new Set(
      recon.matchedReceipts.map((r) => receiptKey(r.terminalId, r.receiptNo))
    );
    state.unassigned = state.unassigned.filter(
      (r) => !matchedKeys.has(receiptKey(r.terminalId, r.receiptNo))
    );
    shift.status = "confirmed";
    bump(shift, clientId, op.opId, now);
    result.bumpedShiftIds = [shift.id];
  } else if (op.kind === "addRefund") {
    const shift = findShift(state, op.shiftId);
    checkVersion(shift, op.baseVersion);
    applyRefund(shift, op, now);
    bump(shift, clientId, op.opId, now);
    result.bumpedShiftIds = [shift.id];
  } else if (op.kind === "adjustPump") {
    const shift = findShift(state, op.shiftId);
    checkVersion(shift, op.baseVersion);
    applyPumpAdjust(shift, op, now);
    bump(shift, clientId, op.opId, now);
    result.bumpedShiftIds = [shift.id];
  }

  return result;
}

/** 银行回执同步：按 终端号+回执号 幂等，并路由到 开放班 / 已确认班(晚到冲正) / 待核池 */
function applySyncReceipts(
  state: ServerState,
  op: { opId: string; receipts: BankReceipt[] },
  result: AppliedOp,
  now: number,
  clientId: string
): void {
  const knownKeys = new Set(state.seenReceiptKeys);
  // 待核池与历史匹配也兜底参与判重
  state.unassigned.forEach((r) => knownKeys.add(receiptKey(r.terminalId, r.receiptNo)));
  for (const s of state.shifts) {
    s.snapshot?.matchedReceipts.forEach((r) =>
      knownKeys.add(receiptKey(r.terminalId, r.receiptNo))
    );
  }

  for (const receipt of op.receipts) {
    const key = receiptKey(receipt.terminalId, receipt.receiptNo);
    if (knownKeys.has(key)) {
      result.duplicated.push(key);
      continue;
    }

    // 已确认班快照里存在同 key 支付流水，且确认时未匹配 → 晚到回执冲正：
    // 补收入、冲减待核差异，原始确认依据不变。
    let routed = false;
    for (const shift of state.shifts) {
      if (shift.status !== "confirmed" || !shift.snapshot) continue;
      const pay = shift.snapshot.payments.find(
        (p) => receiptKey(p.terminalId, p.receiptNo) === key
      );
      if (!pay) continue;

      const wasMatched = shift.snapshot.matchedReceipts.some(
        (r) => receiptKey(r.terminalId, r.receiptNo) === key
      );
      if (wasMatched) {
        result.duplicated.push(key);
        routed = true;
        break;
      }
      const alreadyRouted = shift.corrections.some(
        (c) =>
          c.type === "late_receipt" &&
          c.paymentId === pay.id
      );
      if (alreadyRouted) {
        result.duplicated.push(key);
        routed = true;
        break;
      }

      shift.corrections.push({
        id: uid("cor"),
        type: "late_receipt",
        reason: `回执晚到：终端 ${receipt.terminalId} 回执号 ${receipt.receiptNo}`,
        createdAt: now,
        incomeDelta: pay.amount,
        pendingDelta: -pay.amount,
        pumpDelta: 0,
        paymentId: pay.id,
        bankReceiptId: receipt.id,
        lateReceipt: clone(receipt),
      });
      bump(shift, clientId, op.opId, now);
      result.bumpedShiftIds.push(shift.id);
      result.lateRouted.push({ shiftId: shift.id, receipt });
      knownKeys.add(key);
      state.seenReceiptKeys.push(key);
      routed = true;
      break;
    }

    if (!routed) {
      // 开放班能实时匹配、或无人认领，都进入待核池；开放班视图从池里按 key 取。
      // 无人认领的回执保留差异，不计任何班次收入。
      state.unassigned.push(clone(receipt));
      knownKeys.add(key);
      state.seenReceiptKeys.push(key);
      result.unassigned.push(receipt);
    }
  }
}

function applyRefund(
  shift: Shift,
  op: {
    paymentId: string;
    bankReceiptId?: string;
    refundedInShiftId: string;
    reason: string;
  },
  now: number
): void {
  if (shift.status === "open") {
    // 未确认：直接在原数据上标记重算（不冻结、不留冲正）
    const pay = shift.payments.find((p) => p.id === op.paymentId);
    if (!pay) throw new Error("支付流水不存在");
    if (pay.refundedInShiftId) throw new Error("该流水已登记退款");
    pay.refundedInShiftId = op.refundedInShiftId;
    return;
  }

  if (!shift.snapshot) throw new Error("已确认班次缺少快照");
  const pay = shift.snapshot.payments.find((p) => p.id === op.paymentId);
  if (!pay) throw new Error("支付流水不存在");
  if (
    shift.corrections.some(
      (c) => c.type === "cross_shift_refund" && c.paymentId === op.paymentId
    )
  ) {
    throw new Error("该流水已登记跨班退款");
  }

  // 该支付确认时是否已计入收入（已匹配），还是仍挂在待核
  const matchedAtConfirm = shift.snapshot.matchedReceipts.some(
    (r) => receiptKey(r.terminalId, r.receiptNo) === receiptKey(pay.terminalId, pay.receiptNo)
  );
  // 晚到回执是否已把它从挂起转为收入
  const late = shift.corrections.find(
    (c) => c.type === "late_receipt" && c.paymentId === op.paymentId
  );
  const countedInIncome = matchedAtConfirm || Boolean(late);

  const correction: Correction = {
    id: uid("cor"),
    type: "cross_shift_refund",
    reason: op.reason || `跨班退款：在 ${op.refundedInShiftId} 退原班交易`,
    createdAt: now,
    incomeDelta: countedInIncome ? -pay.amount : 0,
    pendingDelta: countedInIncome ? 0 : -pay.amount,
    pumpDelta: 0,
    paymentId: op.paymentId,
    bankReceiptId: op.bankReceiptId,
    refundedInShiftId: op.refundedInShiftId,
  };
  shift.corrections.push(correction);
}

function applyPumpAdjust(
  shift: Shift,
  op: { pumpId: string; toEndReading: number; reason: string },
  now: number
): void {
  if (!shift.snapshot) throw new Error("泵码调整只能追加到已确认班次");
  const pump = shift.snapshot.pumpTotals.find((p) => p.id === op.pumpId);
  if (!pump) throw new Error("油枪读数不存在");

  // 冲正链上最近一次调整后的终码（或冻结终码）
  const prevAdjust = [...shift.corrections]
    .reverse()
    .find((c) => c.type === "pump_adjust" && c.pumpId === op.pumpId);
  const fromEnd = prevAdjust?.toEndReading ?? pump.endReading;
  const delta =
    pumpAmount({ ...pump, endReading: op.toEndReading }) -
    pumpAmount({ ...pump, endReading: fromEnd });

  shift.corrections.push({
    id: uid("cor"),
    type: "pump_adjust",
    reason: op.reason || `泵码更新：${pump.pumpNo} 号枪终码修正`,
    createdAt: now,
    incomeDelta: 0,
    pendingDelta: 0,
    pumpDelta: delta,
    pumpId: op.pumpId,
    fromEndReading: fromEnd,
    toEndReading: op.toEndReading,
  });
}

/** 未确认班次可用的匹配回执（来自全局池，按本班流水过滤） */
export function receiptsForOpenShift(
  state: ServerState,
  shift: Shift
): BankReceipt[] {
  const keys = new Set(
    shift.payments
      .filter((p: Payment) => !p.refundedInShiftId)
      .map((p) => receiptKey(p.terminalId, p.receiptNo))
  );
  return state.unassigned.filter((r) =>
    keys.has(receiptKey(r.terminalId, r.receiptNo))
  );
}

export type { UnassignedReceipt };

// 班次核销纯逻辑 —— 前端与服务端共用，不碰 IO
import type {
  BankReceipt,
  ConfirmBasis,
  Correction,
  Payment,
  PumpReading,
  Shift,
  ShiftView,
} from "./types.ts";

export const CENT = 100; // 金额按分汇总，避免浮点误差

export const c = (yuan: number): number => Math.round(yuan * CENT);
export const y = (cents: number): number => cents / CENT;

export function pumpVolume(p: PumpReading): number {
  return Math.max(0, p.endMeter - p.startMeter);
}

export function pumpAmountCents(p: PumpReading): number {
  return c(pumpVolume(p) * p.price);
}

export function isElectronicMatched(p: Payment): boolean {
  return p.method === "electronic" && !!p.receiptNo;
}

/**
 * 回执自动核销：同终端号、同金额的未匹配电子支付与待核回执配对（最早优先）。
 * 纯函数：返回新数组，不修改入参。
 */
export function autoMatch(
  payments: Payment[],
  receipts: BankReceipt[],
): { payments: Payment[]; receipts: BankReceipt[] } {
  const ps = payments.map((p) => ({ ...p }));
  const rs = receipts.map((r) => ({ ...r }));
  const unpaid = ps
    .filter((p) => p.method === "electronic" && !p.receiptNo)
    .sort((a, b) => a.paidAt.localeCompare(b.paidAt));

  for (const r of rs) {
    if (r.status === "linked") continue;
    if (r.amountMismatch) continue;
    const idx = unpaid.findIndex((p) => p.terminalNo === r.terminalNo && c(p.amount) === c(r.amount));
    if (idx >= 0) {
      const p = unpaid[idx];
      p.receiptNo = r.receiptNo;
      r.status = "linked";
      r.linkedPaymentId = p.id;
      r.shiftId = undefined; // 关联到具体班次时由调用方回填
      unpaid.splice(idx, 1);
    }
  }
  return { payments: ps, receipts: rs };
}

/** 按 终端号+回执号 合并：重复上报幂等丢弃，同号金额不一致标记差异、不核销 */
export function mergeReceipts(
  existing: BankReceipt[],
  incoming: BankReceipt[],
): { merged: BankReceipt[]; duplicates: number; mismatches: BankReceipt[] } {
  const map = new Map<string, BankReceipt>();
  for (const r of existing) map.set(`${r.terminalNo}#${r.receiptNo}`, { ...r });
  let duplicates = 0;
  const mismatches: BankReceipt[] = [];
  for (const r of incoming) {
    const key = `${r.terminalNo}#${r.receiptNo}`;
    const old = map.get(key);
    if (!old) {
      map.set(key, { ...r });
    } else if (c(old.amount) === c(r.amount)) {
      duplicates += 1; // 断网重连后的重复上报：幂等
    } else {
      old.amountMismatch = true;
      duplicates += 1;
      mismatches.push({ ...old });
    }
  }
  return { merged: [...map.values()], duplicates, mismatches };
}

/** 按 clientId（终端号-本地流水）幂等合并收款 */
export function mergePayments(existing: Payment[], incoming: Payment[]): Payment[] {
  const map = new Map<string, Payment>();
  for (const p of existing) map.set(p.clientId, { ...p });
  for (const p of incoming) {
    if (!map.has(p.clientId)) map.set(p.clientId, { ...p });
  }
  return [...map.values()];
}

/** 按 clientId 幂等合并冲正 */
export function mergeCorrections(existing: Correction[], incoming: Correction[]): Correction[] {
  const map = new Map<string, Correction>();
  for (const x of existing) map.set(x.clientId, { ...x });
  for (const x of incoming) if (!map.has(x.clientId)) map.set(x.clientId, { ...x });
  return [...map.values()];
}

export interface Totals {
  volume: number;
  pumpAmount: number;
  cash: number;
  electronicMatched: number;
  electronicUnmatched: number;
  income: number;
  collected: number;
  diff: number;
}

function totalsFromOpen(pumps: PumpReading[], payments: Payment[]): Totals {
  const volume = pumps.reduce((s, p) => s + pumpVolume(p), 0);
  const pumpAmt = y(pumps.reduce((s, p) => s + pumpAmountCents(p), 0));
  const cash = y(payments.filter((p) => p.method === "cash").reduce((s, p) => s + c(p.amount), 0));
  const electronicMatched = y(
    payments.filter(isElectronicMatched).reduce((s, p) => s + c(p.amount), 0),
  );
  const electronicUnmatched = y(
    payments.filter((p) => p.method === "electronic" && !p.receiptNo).reduce((s, p) => s + c(p.amount), 0),
  );
  const income = pumpAmt; // 应收只认泵码，待核回执不算收入
  const collected = cash + electronicMatched;
  return {
    volume: round2(volume),
    pumpAmount: round2(pumpAmt),
    cash: round2(cash),
    electronicMatched: round2(electronicMatched),
    electronicUnmatched: round2(electronicUnmatched),
    income: round2(income),
    collected: round2(collected),
    diff: round2(income - collected),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 计算班次核销视图：已确认 = 原确认依据 + 冲正链；未确认 = 实时泵码/收款 */
export function computeView(shift: Shift): ShiftView {
  if (shift.status === "confirmed" && shift.confirmedBasis) {
    const b = shift.confirmedBasis;
    const corrections = [...shift.correctionChain].sort((a, z) => a.createdAt.localeCompare(z.createdAt));
    const incomeDelta = y(corrections.reduce((s, x) => s + c(x.incomeDelta), 0));
    const collectedDelta = y(corrections.reduce((s, x) => s + c(x.collectedDelta), 0));
    const volumeDelta = corrections.reduce((s, x) => s + (x.volumeDelta ?? 0), 0);
    const lateReceiptMatched = y(
      corrections
        .filter((x) => x.type === "late_receipt")
        .reduce((s, x) => s + c(x.collectedDelta), 0),
    );
    const income = round2(b.income + incomeDelta);
    const collected = round2(b.collected + collectedDelta);
    return {
      shiftId: shift.id,
      status: "confirmed",
      volume: round2(b.volume + volumeDelta),
      pumpAmount: round2(income - corrections
        .filter((x) => x.type !== "pump_adjust")
        .reduce((s, x) => s + x.incomeDelta, 0)),
      cash: b.cash,
      electronicMatched: round2(b.electronicMatched + lateReceiptMatched),
      electronicUnmatched: round2(Math.max(0, b.electronicUnmatched - lateReceiptMatched)),
      correctionIncome: round2(incomeDelta),
      correctionCollected: round2(collectedDelta),
      income,
      collected,
      diff: round2(income - collected),
      corrections,
    };
  }
  const t = totalsFromOpen(shift.pumps, shift.payments);
  return {
    shiftId: shift.id,
    status: "open",
    volume: t.volume,
    pumpAmount: t.pumpAmount,
    cash: t.cash,
    electronicMatched: t.electronicMatched,
    electronicUnmatched: t.electronicUnmatched,
    correctionIncome: 0,
    correctionCollected: 0,
    income: t.income,
    collected: t.collected,
    diff: t.diff,
    corrections: [],
  };
}

/** 确认时刻固化确认依据（只存当时事实，后续不可改） */
export function buildConfirmBasis(shift: Shift, confirmedAt: string): ConfirmBasis {
  const t = totalsFromOpen(shift.pumps, shift.payments);
  return {
    confirmedAt,
    version: shift.version,
    volume: t.volume,
    pumpAmount: t.pumpAmount,
    cash: t.cash,
    electronicMatched: t.electronicMatched,
    electronicUnmatched: t.electronicUnmatched,
    income: t.income,
    collected: t.collected,
    diff: t.diff,
    pumps: shift.pumps.map((p) => ({ ...p })),
    matchedPayments: shift.payments
      .filter((p) => p.method === "cash" || isElectronicMatched(p))
      .map((p) => ({
        id: p.id,
        method: p.method,
        amount: p.amount,
        terminalNo: p.terminalNo,
        receiptNo: p.receiptNo,
      })),
  };
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

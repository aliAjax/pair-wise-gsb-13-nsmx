import type {
  BankReceipt,
  ConfirmSnapshot,
  Correction,
  Payment,
  PumpReading,
  ReconSummary,
  Shift,
  ShiftRecon,
} from "./types";
import { receiptKey } from "./types";

/** 泵码发油量（升，×100 整数） */
export function pumpLiters(p: PumpReading): number {
  return Math.max(0, p.endReading - p.startReading);
}

/** 单枪油款（分，按 ×100 的升 × 分/升 后除以 100，四舍五入到分） */
export function pumpAmount(p: PumpReading): number {
  return Math.round((pumpLiters(p) * p.pricePerL) / 100);
}

export function totalPumpAmount(pumps: PumpReading[]): number {
  return pumps.reduce((sum, p) => sum + pumpAmount(p), 0);
}

export function totalLiters(pumps: PumpReading[]): number {
  return pumps.reduce((sum, p) => sum + pumpLiters(p), 0);
}

/**
 * 核销核心：把电子支付按「终端号 + 回执号」与银行回执配对。
 *
 * 口径：
 * - 已匹配电子支付 → 计入当班收入
 * - 有支付流水但无银行回执 → 进入待核（pendingPayments），不计收入、保留差异
 * - 有银行回执但无支付流水 → 挂账（extraReceipts），不计收入、保留差异
 */
export function reconcile(
  pumps: PumpReading[],
  cashTotal: number,
  payments: Payment[],
  receipts: BankReceipt[]
): ShiftRecon {
  const receiptMap = new Map<string, BankReceipt>();
  for (const r of receipts) {
    receiptMap.set(receiptKey(r.terminalId, r.receiptNo), r);
  }

  const matchedPayments: Payment[] = [];
  const pendingPayments: Payment[] = [];
  const matchedReceipts: BankReceipt[] = [];
  const matchedKeys = new Set<string>();

  // 已登记跨班退款的流水不再参与本班核销（确认后退款走冲正，不会落到这里）
  const activePayments = payments.filter((p) => !p.refundedInShiftId);

  for (const pay of activePayments) {
    const key = receiptKey(pay.terminalId, pay.receiptNo);
    const receipt = receiptMap.get(key);
    if (receipt) {
      matchedPayments.push(pay);
      matchedReceipts.push(receipt);
      matchedKeys.add(key);
    } else {
      pendingPayments.push(pay);
    }
  }
  const extraReceipts = receipts.filter(
    (r) => !matchedKeys.has(receiptKey(r.terminalId, r.receiptNo))
  );

  const pump = totalPumpAmount(pumps);
  const electronicMatched = matchedPayments.reduce((s, p) => s + p.amount, 0);
  const electronicPending = pendingPayments.reduce((s, p) => s + p.amount, 0);
  const receiptsUnmatched = extraReceipts.reduce((s, r) => s + r.amount, 0);

  // 待核差异：电子支付侧挂起金额 + 银行回执侧挂账金额（分别保留，不轧差掩盖问题）
  const pendingDiff = electronicPending + receiptsUnmatched;
  // 交叉差异：泵码油款 vs 实际收款（仅已匹配部分与现金参与；未匹配的不算实收）
  const incomeTotal = cashTotal + electronicMatched;
  const crossDiff = pump - incomeTotal;

  return {
    summary: {
      pumpAmount: pump,
      cash: cashTotal,
      electronicMatched,
      electronicPending,
      incomeTotal,
      receiptsUnmatched,
      pendingDiff,
      crossDiff,
    },
    matchedPayments,
    pendingPayments,
    matchedReceipts,
    extraReceipts,
  };
}

/**
 * 班次在「当前时刻」的有效核销视图。
 * 已确认班次：原始依据取快照冻结值，冲正链只追加；未确认部分用当前可匹配的回执重算。
 */
export function effectiveReceipts(shift: Shift, lateReceipts: BankReceipt[]): BankReceipt[] {
  // 确认后才到达的回执由冲正携带；确认前已匹配的在快照里
  if (shift.status === "confirmed" && shift.snapshot) {
    const fromCorrections = shift.corrections
      .filter((c) => c.type === "late_receipt" && c.bankReceiptId)
      .map((c) => lateReceipts.find((r) => r.id === c.bankReceiptId))
      .filter((r): r is BankReceipt => Boolean(r));
    return [...shift.snapshot.matchedReceipts, ...fromCorrections];
  }
  return lateReceipts;
}

/**
 * 班次全量视图：
 * - 收入 = 确认时冻结收入 + 冲正链净额（晚到回执补收入、跨班退款冲减）
 * - 待核差异 = 确认时冻结待核 + 冲正对差异的影响（晚到回执从挂起转收入、退款冲掉挂起）
 * - 泵码油款 = 冻结泵码油款 + 泵码调整差额
 * 原始确认依据永不改写。
 */
export interface ShiftView {
  base: ShiftRecon; // 未确认：实时核销；已确认：快照口径核销
  current: ReconSummary; // 叠加冲正后的当前口径
  confirmed: ConfirmSnapshot | undefined;
  corrections: Correction[];
  /** 冲正链已核销/处理的支付 id（晚到回执补齐、跨班退款） */
  resolvedPaymentIds: string[];
  /** 冲正链已并入的银行回执 id（晚到回执） */
  resolvedReceiptIds: string[];
  /** 已通过跨班退款冲正处理的支付 id */
  refundedPaymentIds: string[];
}

export function viewShift(shift: Shift, bankReceipts: BankReceipt[] = []): ShiftView {
  let base: ShiftRecon;

  if (shift.status === "confirmed" && shift.snapshot) {
    base = reconcile(
      shift.snapshot.pumpTotals,
      shift.snapshot.cashTotal,
      shift.snapshot.payments,
      shift.snapshot.matchedReceipts
    );
  } else {
    base = reconcile(shift.pumps, shift.cashTotal, shift.payments, bankReceipts);
  }

  const incomeCorrection = shift.corrections.reduce((s, c) => s + c.incomeDelta, 0);
  const pendingCorrection = shift.corrections.reduce((s, c) => s + c.pendingDelta, 0);
  const pumpCorrection = shift.corrections.reduce((s, c) => s + c.pumpDelta, 0);
  const incomeTotal = base.summary.incomeTotal + incomeCorrection;
  const pumpAmountNow = base.summary.pumpAmount + pumpCorrection;
  // 晚到回执 / 挂起流水退款都会改变「电子无回执待核」；银行挂账部分不受冲正影响
  const electronicPendingNow = Math.max(
    0,
    base.summary.electronicPending + pendingCorrection
  );

  const current: ReconSummary = {
    ...base.summary,
    pumpAmount: pumpAmountNow,
    electronicMatched: base.summary.electronicMatched + incomeCorrection,
    electronicPending: electronicPendingNow,
    incomeTotal,
    pendingDiff: Math.max(0, electronicPendingNow + base.summary.receiptsUnmatched),
    crossDiff: pumpAmountNow - incomeTotal,
  };

  return {
    base,
    current,
    confirmed: shift.snapshot,
    corrections: shift.corrections,
    resolvedPaymentIds: shift.corrections
      .filter((c) => c.paymentId)
      .map((c) => c.paymentId as string),
    resolvedReceiptIds: shift.corrections
      .filter((c) => c.bankReceiptId)
      .map((c) => c.bankReceiptId as string),
    /** 已通过跨班退款冲正处理的支付 id */
    refundedPaymentIds: shift.corrections
      .filter((c) => c.type === "cross_shift_refund" && c.paymentId)
      .map((c) => c.paymentId as string),
  };
}

/** 冲正链按时间排序（供页面展示链路） */
export function correctionChain(shift: Shift): Correction[] {
  return [...shift.corrections].sort((a, b) => a.createdAt - b.createdAt);
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}¥${(abs / 100).toFixed(2)}`;
}

export function formatLiters(units: number): string {
  return `${(units / 100).toFixed(2)} L`;
}

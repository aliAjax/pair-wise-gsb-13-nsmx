import { describe, expect, it } from "vitest";
import { reconcile, viewShift } from "../src/domain/recon";
import { applyOp } from "../src/domain/server";
import { createSeedState, demoLateReceipts } from "../src/domain/seed";
import type {
  BankReceipt,
  Payment,
  PumpReading,
  ServerState,
  Shift,
} from "../src/domain/types";
import { ConflictError } from "../src/domain/types";

const pump = (
  id: string,
  pumpNo: string,
  startReading: number,
  endReading: number,
  pricePerL = 785
): PumpReading => ({ id, pumpNo, grade: "92#", startReading, endReading, pricePerL });

const pay = (
  id: string,
  terminalId: string,
  receiptNo: string,
  amount: number
): Payment => ({
  id,
  terminalId,
  receiptNo,
  amount,
  method: "微信",
  paidAt: 0,
});

const rcp = (
  id: string,
  terminalId: string,
  receiptNo: string,
  amount: number
): BankReceipt => ({ id, terminalId, receiptNo, amount, arrivedAt: 0 });

function openShift(over: Partial<Shift> = {}): Shift {
  return {
    id: "s1",
    name: "早班",
    station: "测试站",
    date: "2026-10-04",
    window: "06-14",
    status: "open",
    version: 1,
    versionOwner: [{ clientId: "seed", opId: "seed", at: 0 }],
    pumps: [pump("p1", "1", 100000, 200000, 785)], // 1000L * 7.85 = 7850.00
    cashTotal: 300000,
    payments: [
      pay("m1", "T1", "R1", 200000),
      pay("m2", "T1", "R2", 285000), // 无回执
    ],
    corrections: [],
    createdAt: 0,
    ...over,
  };
}

describe("reconcile 核销口径", () => {
  it("未匹配支付进待核，不拉高当班收入；银行多出的回执挂账", () => {
    const r = reconcile(
      [pump("p1", "1", 100000, 200000)],
      300000,
      [pay("m1", "T1", "R1", 200000), pay("m2", "T1", "R2", 285000)],
      [rcp("b1", "T1", "R1", 200000), rcp("b2", "T9", "RX", 99000)]
    );
    // 收入只算现金 + 已匹配电子 = 3000 + 2000 = 5000，泵码 7850
    expect(r.summary.incomeTotal).toBe(500000);
    expect(r.summary.electronicPending).toBe(285000);
    expect(r.summary.receiptsUnmatched).toBe(99000);
    expect(r.summary.pendingDiff).toBe(285000 + 99000);
    expect(r.summary.crossDiff).toBe(785000 - 500000);
    expect(r.matchedPayments.map((p) => p.id)).toEqual(["m1"]);
    expect(r.pendingPayments.map((p) => p.id)).toEqual(["m2"]);
    expect(r.extraReceipts.map((x) => x.id)).toEqual(["b2"]);
  });

  it("已登记跨班退款的未确认流水直接从重算中剔除", () => {
    const shift = openShift({
      payments: [
        pay("m1", "T1", "R1", 200000),
        { ...pay("m2", "T1", "R2", 285000), refundedInShiftId: "s2" },
      ],
    });
    const r = reconcile(shift.pumps, shift.cashTotal, shift.payments, [
      rcp("b1", "T1", "R1", 200000),
    ]);
    expect(r.matchedPayments.map((p) => p.id)).toEqual(["m1"]);
    expect(r.pendingPayments).toHaveLength(0);
  });
});

describe("确认 + 晚到回执", () => {
  it("确认冻结依据；晚到回执只追加冲正、补收入冲差异、不改原快照", () => {
    let state: ServerState = createSeedState();
    const before = JSON.stringify(
      state.shifts.find((s) => s.status === "confirmed")!.snapshot
    );

    const late = demoLateReceipts();
    const applied = applyOp(
      state,
      { kind: "syncReceipts", opId: "op-late", receipts: late },
      1000,
      "bank-sync"
    );
    state = applied.state;
    expect(applied.lateRouted).toHaveLength(1);

    const confirmed = state.shifts.find((s) => s.status === "confirmed")!;
    expect(confirmed.version).toBe(3);
    const corr = confirmed.corrections.find((c) => c.type === "late_receipt")!;
    expect(corr.incomeDelta).toBe(15000);
    expect(corr.pendingDelta).toBe(-15000);

    // 原确认依据保留
    expect(JSON.stringify(confirmed.snapshot)).toBe(before);

    const view = viewShift(confirmed, []);
    expect(view.current.incomeTotal).toBe(
      view.confirmed!.income.incomeTotal + 15000
    );
    expect(view.current.pendingDiff).toBe(0);
  });
});

describe("已确认班次跨班退款", () => {
  it("退的是已计入收入的流水 → 冲减收入；退的是挂起流水 → 只冲待核", () => {
    let state: ServerState = createSeedState();
    const confirmed = state.shifts.find((s) => s.status === "confirmed")!;

    // 退一笔确认时已匹配（计入收入）
    const matchedPay = confirmed.snapshot!.payments[0];
    state = applyOp(
      state,
      {
        kind: "addRefund",
        opId: "op-ref1",
        shiftId: confirmed.id,
        baseVersion: confirmed.version,
        paymentId: matchedPay.id,
        refundedInShiftId: "next-shift",
        reason: "客户次日退款",
      },
      2000,
      "dev1"
    ).state;
    let s2 = state.shifts.find((x) => x.id === confirmed.id)!;
    const refundCorr = s2.corrections.find((x) => x.type === "cross_shift_refund")!;
    expect(refundCorr.incomeDelta).toBe(-matchedPay.amount);
    expect(refundCorr.pendingDelta).toBe(0);
    let view = viewShift(s2, []);
    expect(view.current.incomeTotal).toBe(
      view.confirmed!.income.incomeTotal - matchedPay.amount
    );
    expect(view.current.pendingDiff).toBe(view.confirmed!.pending.pendingDiff);
  });

  it("退确认时仍挂起（无回执）的流水 → 不动收入，只冲减待核差异", () => {
    let state: ServerState = createSeedState();
    const confirmed = state.shifts.find((s) => s.status === "confirmed")!;
    // 第三笔是确认时无回执的挂起支付
    const pendingPay = confirmed.snapshot!.payments[2];
    state = applyOp(
      state,
      {
        kind: "addRefund",
        opId: "op-ref2",
        shiftId: confirmed.id,
        baseVersion: confirmed.version,
        paymentId: pendingPay.id,
        refundedInShiftId: "next-shift",
        reason: "无回执交易次日退款",
      },
      2000,
      "dev1"
    ).state;
    const s2 = state.shifts.find((x) => x.id === confirmed.id)!;
    const corr = s2.corrections.find((x) => x.type === "cross_shift_refund")!;
    expect(corr.incomeDelta).toBe(0);
    expect(corr.pendingDelta).toBe(-pendingPay.amount);
    const view = viewShift(s2, []);
    expect(view.current.incomeTotal).toBe(view.confirmed!.income.incomeTotal);
    expect(view.current.electronicPending).toBe(0);
    expect(view.current.pendingDiff).toBe(0);
  });

  it("晚到回执先补收入、之后退款 → 冲减收入且不留挂起", () => {
    let state: ServerState = createSeedState();
    const confirmed = state.shifts.find((s) => s.status === "confirmed")!;
    const pendingPay = confirmed.snapshot!.payments[2];

    state = applyOp(
      state,
      { kind: "syncReceipts", opId: "op-late", receipts: demoLateReceipts() },
      1000,
      "bank"
    ).state;
    let s2 = state.shifts.find((x) => x.id === confirmed.id)!;
    const afterLate = viewShift(s2, []);
    expect(afterLate.current.incomeTotal).toBe(
      afterLate.confirmed!.income.incomeTotal + pendingPay.amount
    );

    state = applyOp(
      state,
      {
        kind: "addRefund",
        opId: "op-ref3",
        shiftId: confirmed.id,
        baseVersion: s2.version,
        paymentId: pendingPay.id,
        refundedInShiftId: "next-shift",
        reason: "晚到入账后退款",
      },
      2000,
      "dev1"
    ).state;
    s2 = state.shifts.find((x) => x.id === confirmed.id)!;
    const view = viewShift(s2, []);
    expect(view.current.incomeTotal).toBe(view.confirmed!.income.incomeTotal);
    expect(view.current.pendingDiff).toBe(0);
  });
});

describe("泵码更新", () => {
  it("只改变泵码口径与交叉差异，不动现金/电子收入，且保留原终码", () => {
    let state: ServerState = createSeedState();
    const confirmed = state.shifts.find((s) => s.status === "confirmed")!;
    const pump0 = confirmed.snapshot!.pumpTotals[0];
    const newEnd = pump0.endReading + 5000; // +50L * 8.42 = +421.00
    state = applyOp(
      state,
      {
        kind: "adjustPump",
        opId: "op-pump",
        shiftId: confirmed.id,
        baseVersion: confirmed.version,
        pumpId: pump0.id,
        toEndReading: newEnd,
        reason: "泵码回传修正",
      },
      3000,
      "dev1"
    ).state;
    const s2 = state.shifts.find((x) => x.id === confirmed.id)!;
    const corr = s2.corrections.find((c) => c.type === "pump_adjust")!;
    expect(corr.pumpDelta).toBe(42100);
    expect(corr.incomeDelta).toBe(0);
    expect(corr.fromEndReading).toBe(pump0.endReading);
    // 原确认依据终码未变
    expect(s2.snapshot!.pumpTotals[0].endReading).toBe(pump0.endReading);
    const view = viewShift(s2, []);
    expect(view.current.pumpAmount - view.confirmed!.income.pumpAmount).toBe(42100);
    expect(view.current.incomeTotal).toBe(view.confirmed!.income.incomeTotal);
  });
});

describe("乐观锁并发", () => {
  it("两个窗口基于同一版本保存，后到的旧版本抛冲突，不能覆盖已生效结果", () => {
    let state: ServerState = createSeedState();
    const open = state.shifts.find((s) => s.status === "open")!;

    // 窗口 A 先保存生效
    state = applyOp(
      state,
      {
        kind: "saveShift",
        opId: "a1",
        shiftId: open.id,
        baseVersion: open.version,
        pumps: open.pumps,
        cashTotal: 999900,
        payments: open.payments,
      },
      100,
      "winA"
    ).state;
    const afterA = state.shifts.find((s) => s.id === open.id)!;
    expect(afterA.cashTotal).toBe(999900);
    expect(afterA.version).toBe(open.version + 1);

    // 窗口 B 仍用旧版本保存
    expect(() =>
      applyOp(state, {
        kind: "saveShift",
        opId: "b1",
        shiftId: open.id,
        baseVersion: open.version,
        pumps: open.pumps,
        cashTotal: 11100,
        payments: open.payments,
      })
    ).toThrow(ConflictError);

    // A 的结果保持不变
    const afterB = state.shifts.find((s) => s.id === open.id)!;
    expect(afterB.cashTotal).toBe(999900);
  });

  it("操作幂等：相同 opId 不重复生效", () => {
    const state0 = createSeedState();
    const open = state0.shifts.find((s) => s.status === "open")!;
    const op = {
      kind: "saveShift",
      opId: "same",
      shiftId: open.id,
      baseVersion: open.version,
      pumps: open.pumps,
      cashTotal: 12300,
      payments: open.payments,
    } as const;
    const s1 = applyOp(state0, op).state;
    const s2 = applyOp(s1, op).state;
    expect(s2).toBe(s1);
  });
});

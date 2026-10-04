import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoMatch,
  buildConfirmBasis,
  computeView,
  mergeReceipts,
} from "./domain.ts";
import type { BankReceipt, Payment, PumpReading, Shift } from "./types.ts";

const pumps: PumpReading[] = [
  { pumpNo: "P1", product: "92#", price: 7.62, startMeter: 1000, endMeter: 2000 },
  { pumpNo: "P2", product: "95#", price: 8.1, startMeter: 0, endMeter: 1000 },
];
// 泵码应收 = 1000*7.62 + 1000*8.1 = 15720
const payments: Payment[] = [
  { id: "p1", clientId: "T01-1", method: "cash", amount: 7000, paidAt: "2026-10-04T10:00:00Z" },
  { id: "p2", clientId: "T01-2", method: "electronic", amount: 5000, terminalNo: "T01", receiptNo: "R1", paidAt: "2026-10-04T11:00:00Z" },
  { id: "p3", clientId: "T01-3", method: "electronic", amount: 3000, terminalNo: "T01", paidAt: "2026-10-04T12:00:00Z" },
];

function baseShift(): Shift {
  return {
    id: "S1",
    stationId: "ST",
    name: "测试班",
    startTime: "2026-10-04T06:00:00Z",
    status: "open",
    version: 0,
    pumps: pumps.map((p) => ({ ...p })),
    payments: payments.map((p) => ({ ...p })),
    correctionChain: [],
    createdAt: "",
    updatedAt: "",
  };
}

test("未确认班次：未匹配回执不进收入，差异保留为应收-已核销实收", () => {
  const v = computeView(baseShift());
  assert.equal(v.income, 15720);
  assert.equal(v.collected, 12000); // 现金 7000 + 已核销电子 5000
  assert.equal(v.electronicUnmatched, 3000);
  assert.equal(v.diff, 3720);
});

test("自动核销：终端号+金额匹配回执，金额不符不核销", () => {
  const receipts: BankReceipt[] = [
    { id: "r1", terminalNo: "T01", receiptNo: "R3", amount: 3000, txTime: "", arrivedAt: "", status: "pending" },
    { id: "r2", terminalNo: "T01", receiptNo: "R4", amount: 999, txTime: "", arrivedAt: "", status: "pending" },
  ];
  const out = autoMatch(payments, receipts);
  assert.equal(out.receipts.find((r) => r.receiptNo === "R3")?.status, "linked");
  assert.equal(out.receipts.find((r) => r.receiptNo === "R4")?.status, "pending");
  assert.equal(out.payments.find((p) => p.id === "p3")?.receiptNo, "R3");
});

test("回执合并：重复上报幂等丢弃；同号不同额标记金额不符", () => {
  const existing: BankReceipt[] = [
    { id: "r1", terminalNo: "T01", receiptNo: "R9", amount: 100, txTime: "", arrivedAt: "", status: "pending" },
  ];
  const out = mergeReceipts(existing, [
    { id: "r1b", terminalNo: "T01", receiptNo: "R9", amount: 100, txTime: "", arrivedAt: "", status: "pending" },
    { id: "r2", terminalNo: "T01", receiptNo: "R10", amount: 200, txTime: "", arrivedAt: "", status: "pending" },
    { id: "r3", terminalNo: "T01", receiptNo: "R9", amount: 110, txTime: "", arrivedAt: "", status: "pending" },
  ]);
  assert.equal(out.merged.length, 2);
  assert.equal(out.duplicates, 2);
  assert.equal(out.merged.find((r) => r.receiptNo === "R9")?.amountMismatch, true);
});

test("确认后：快照冻结；晚到回执只增加实收、冲减差异，不动原收入", () => {
  const sh = baseShift();
  sh.status = "confirmed";
  sh.confirmedBasis = buildConfirmBasis(sh, "2026-10-04T14:00:00Z");
  sh.correctionChain.push({
    id: "x1",
    clientId: "T01-c1",
    type: "late_receipt",
    createdAt: "2026-10-05T08:00:00Z",
    reason: "晚到回执",
    terminalNo: "T01",
    incomeDelta: 0,
    collectedDelta: 3000,
    receiptSnapshot: { terminalNo: "T01", receiptNo: "R3", amount: 3000 },
  });
  const v = computeView(sh);
  assert.equal(v.income, 15720);
  assert.equal(v.collected, 15000);
  assert.equal(v.diff, 720);
  assert.equal(sh.confirmedBasis?.collected, 12000); // 原确认依据不变
});

test("跨班退款：只追加冲正，应收与实收同时冲减，原依据保留", () => {
  const sh = baseShift();
  sh.status = "confirmed";
  sh.confirmedBasis = buildConfirmBasis(sh, "2026-10-04T14:00:00Z");
  sh.correctionChain.push({
    id: "x2",
    clientId: "T02-c2",
    type: "cross_shift_refund",
    createdAt: "2026-10-05T08:30:00Z",
    reason: "次日退款",
    terminalNo: "T02",
    incomeDelta: -260,
    collectedDelta: -260,
  });
  const v = computeView(sh);
  assert.equal(v.income, 15460);
  assert.equal(v.collected, 11740);
  assert.equal(v.diff, 3720); // 差异随收支同向移动，保留
  assert.equal(sh.confirmedBasis?.income, 15720);
});

test("泵码更新：只按新旧泵码差额追加冲正，实收不动", () => {
  const sh = baseShift();
  sh.status = "confirmed";
  sh.confirmedBasis = buildConfirmBasis(sh, "2026-10-04T14:00:00Z");
  sh.correctionChain.push({
    id: "x3",
    clientId: "T01-c3",
    type: "pump_adjust",
    createdAt: "2026-10-05T09:00:00Z",
    reason: "校泵发现少记 10L",
    terminalNo: "T01",
    incomeDelta: 76.2,
    collectedDelta: 0,
    volumeDelta: 10,
    pumpNo: "P1",
    oldMeter: 2000,
    newMeter: 2010,
  });
  const v = computeView(sh);
  assert.equal(v.income, 15796.2);
  assert.equal(v.collected, 12000);
  assert.equal(v.diff, 3796.2);
});

import type { BankReceipt, Shift, Station } from "../shared/types.ts";

// 演示数据：覆盖 已确认班次+冲正链、进行中班次、晚到回执、待核孤儿回执
export function buildSeed(nowIso: string): { station: Station; shifts: Shift[]; receipts: BankReceipt[] } {
  const station: Station = {
    id: "ST001",
    name: "城东01加油站",
    terminals: ["T01", "T02"],
  };

  const evening: Shift = {
    id: "S-1003-EVENING",
    stationId: "ST001",
    name: "10-03 晚班",
    startTime: "2026-10-03T14:00:00+08:00",
    endTime: "2026-10-03T22:00:00+08:00",
    status: "confirmed",
    version: 2,
    createdAt: "2026-10-03T14:00:00+08:00",
    updatedAt: "2026-10-04T08:55:00+08:00",
    pumps: [
      { pumpNo: "P1", product: "92#", price: 7.62, startMeter: 128400, endMeter: 129650 },
      { pumpNo: "P2", product: "95#", price: 8.1, startMeter: 98200, endMeter: 99100 },
    ],
    payments: [
      { id: "T01-1001", clientId: "T01-1001", method: "cash", amount: 7000, paidAt: "2026-10-03T18:00:00+08:00" },
      { id: "T02-1002", clientId: "T02-1002", method: "cash", amount: 4515, paidAt: "2026-10-03T21:40:00+08:00" },
      { id: "T01-1003", clientId: "T01-1003", method: "electronic", amount: 3500, terminalNo: "T01", receiptNo: "R2001", paidAt: "2026-10-03T17:20:00+08:00" },
      { id: "T02-1004", clientId: "T02-1004", method: "electronic", amount: 1500, terminalNo: "T02", receiptNo: "R2002", paidAt: "2026-10-03T19:05:00+08:00" },
      // 确认时银行回执未到：进差异、不核销
      { id: "T01-1005", clientId: "T01-1005", method: "electronic", amount: 300, terminalNo: "T01", paidAt: "2026-10-03T20:14:00+08:00", note: "确认时回执未到" },
    ],
    correctionChain: [
      {
        id: "X-0001",
        clientId: "T02-2001",
        type: "cross_shift_refund",
        createdAt: "2026-10-04T08:30:00+08:00",
        reason: "10-03 晚班加注的92#客户次日早班回站退款",
        terminalNo: "T02",
        incomeDelta: -260,
        collectedDelta: -260,
        originShiftId: "S-1004-MORNING",
      },
    ],
    confirmedBasis: {
      confirmedAt: "2026-10-03T22:20:00+08:00",
      version: 1,
      volume: 2150,
      pumpAmount: 16815,
      cash: 11515,
      electronicMatched: 5000,
      electronicUnmatched: 300,
      income: 16815,
      collected: 16515,
      diff: 300,
      pumps: [
        { pumpNo: "P1", product: "92#", price: 7.62, startMeter: 128400, endMeter: 129650 },
        { pumpNo: "P2", product: "95#", price: 8.1, startMeter: 98200, endMeter: 99100 },
      ],
      matchedPayments: [
        { id: "T01-1001", method: "cash", amount: 7000 },
        { id: "T02-1002", method: "cash", amount: 4515 },
        { id: "T01-1003", method: "electronic", amount: 3500, terminalNo: "T01", receiptNo: "R2001" },
        { id: "T02-1004", method: "electronic", amount: 1500, terminalNo: "T02", receiptNo: "R2002" },
      ],
    },
  };

  const morning: Shift = {
    id: "S-1004-MORNING",
    stationId: "ST001",
    name: "10-04 早班",
    startTime: "2026-10-04T06:00:00+08:00",
    status: "open",
    version: 0,
    createdAt: "2026-10-04T06:00:00+08:00",
    updatedAt: "2026-10-04T08:50:00+08:00",
    pumps: [
      { pumpNo: "P1", product: "92#", price: 7.62, startMeter: 129650, endMeter: 130400 },
      { pumpNo: "P3", product: "0#", price: 7.2, startMeter: 56000, endMeter: 56900 },
    ],
    payments: [
      { id: "T02-2002", clientId: "T02-2002", method: "cash", amount: 4000, paidAt: "2026-10-04T07:30:00+08:00" },
      // 早班柜面垫付晚班退款：现金流出，冲正挂在原班
      { id: "T02-2003", clientId: "T02-2003", method: "cash", amount: -260, paidAt: "2026-10-04T08:30:00+08:00", note: "跨班退款，见 S-1003-EVENING 冲正 X-0001" },
      // 回执还在路上
      { id: "T02-2004", clientId: "T02-2004", method: "electronic", amount: 4200, terminalNo: "T02", paidAt: "2026-10-04T08:10:00+08:00", note: "等待银行回执" },
    ],
    correctionChain: [],
  };

  const receipts: BankReceipt[] = [
    {
      id: "B-3001",
      terminalNo: "T01",
      receiptNo: "R3001",
      amount: 300,
      txTime: "2026-10-03T20:14:00+08:00",
      arrivedAt: "2026-10-04T08:42:00+08:00",
      status: "pending",
    },
    {
      id: "B-3100",
      terminalNo: "T02",
      receiptNo: "R3100",
      amount: 500,
      txTime: "2026-10-04T08:40:00+08:00",
      arrivedAt: "2026-10-04T08:48:00+08:00",
      status: "pending",
    },
  ];

  void nowIso;
  return { station, shifts: [evening, morning], receipts };
}

import type { BankReceipt, ServerState, Shift } from "./types";

let idc = 0;
function id(p: string): string {
  idc += 1;
  return `${p}${idc}`;
}

const P92 = 785; // 92# 单价 7.85 元/升
const P95 = 842; // 8.42
const P98 = 931; // 9.31
const D0 = 768; // 0# 柴油 7.68

function shift(
  idv: string,
  partial: Partial<Shift> & Pick<Shift, "name" | "station" | "date" | "window" | "status" | "pumps" | "cashTotal" | "payments">
): Shift {
  const version = partial.version ?? 1;
  const base: Shift = {
    id: idv,
    name: partial.name,
    station: partial.station,
    date: partial.date,
    window: partial.window,
    status: partial.status,
    version,
    versionOwner:
      partial.versionOwner ??
      Array.from({ length: version }, () => ({
        clientId: "seed",
        opId: "seed",
        at: Date.now(),
      })),
    pumps: partial.pumps,
    cashTotal: partial.cashTotal,
    payments: partial.payments,
    corrections: [],
    snapshot: partial.snapshot,
    createdAt: Date.now(),
  };
  return base;
}

// —— 班次 A：昨天晚班，已确认，有一笔支付确认时无回执（晚到待同步） ——
const pumpsA = [
  {
    id: id("pump"),
    pumpNo: "3",
    grade: "95#",
    startReading: 1205000,
    endReading: 1258320,
    pricePerL: P95,
  },
  {
    id: id("pump"),
    pumpNo: "4",
    grade: "98#",
    startReading: 820000,
    endReading: 843610,
    pricePerL: P98,
  },
];
const payA1 = {
  id: id("pay"),
  terminalId: "T01",
  receiptNo: "2026100300412",
  amount: 30000,
  method: "微信",
  paidAt: Date.now() - 86400000,
};
const payA2 = {
  id: id("pay"),
  terminalId: "T01",
  receiptNo: "2026100300413",
  amount: 22000,
  method: "支付宝",
  paidAt: Date.now() - 86400000 + 1000,
};
const payA3 = {
  id: id("pay"),
  terminalId: "T02",
  receiptNo: "2026100300777",
  amount: 15000,
  method: "银联",
  paidAt: Date.now() - 86400000 + 2000, // 晚到回执，尚未同步
};

// A 班确认时只匹配到前两笔
const receiptsAMatched: BankReceipt[] = [
  {
    id: id("rcp"),
    terminalId: "T01",
    receiptNo: "2026100300412",
    amount: 30000,
    arrivedAt: Date.now() - 86400000 + 60000,
  },
  {
    id: id("rcp"),
    terminalId: "T01",
    receiptNo: "2026100300413",
    amount: 22000,
    arrivedAt: Date.now() - 86400000 + 60000,
  },
];

const shiftA = shift("shift-20261003-eve", {
  name: "晚班",
  station: "城央加油站",
  date: "2026-10-03",
  window: "22:00-次日06:00",
  status: "confirmed",
  pumps: pumpsA,
  cashTotal: 8300,
  payments: [payA1, payA2, payA3],
});

// —— 班次 B：今天早班，未确认，泵码/现金/支付齐全，一笔无回执，一笔错额待核 ——
const pumpsB = [
  {
    id: id("pump"),
    pumpNo: "1",
    grade: "92#",
    startReading: 3602100,
    endReading: 3669450,
    pricePerL: P92,
  },
  {
    id: id("pump"),
    pumpNo: "2",
    grade: "92#",
    startReading: 2104800,
    endReading: 2161300,
    pricePerL: P92,
  },
  {
    id: id("pump"),
    pumpNo: "5",
    grade: "0#",
    startReading: 990000,
    endReading: 1021200,
    pricePerL: D0,
  },
];
const payB1 = {
  id: id("pay"),
  terminalId: "T01",
  receiptNo: "2026100400101",
  amount: 26000,
  method: "微信",
  paidAt: Date.now() - 1000 * 60 * 60 * 5,
};
const payB2 = {
  id: id("pay"),
  terminalId: "T01",
  receiptNo: "2026100400102",
  amount: 18500,
  method: "支付宝",
  paidAt: Date.now() - 1000 * 60 * 60 * 4,
};
const payB3 = {
  id: id("pay"),
  terminalId: "T02",
  receiptNo: "2026100400208",
  amount: 9000,
  method: "银联",
  paidAt: Date.now() - 1000 * 60 * 60 * 3, // 回执未到
};

const shiftB = shift("shift-20261004-mor", {
  name: "早班",
  station: "城央加油站",
  date: "2026-10-04",
  window: "06:00-14:00",
  status: "open",
  pumps: pumpsB,
  cashTotal: 4600,
  payments: [payB1, payB2, payB3],
});

// 待核池：B 班前两笔的银行回执 + 一笔无人认领回执（保留差异）
const pool: BankReceipt[] = [
  {
    id: id("rcp"),
    terminalId: "T01",
    receiptNo: "2026100400101",
    amount: 26000,
    arrivedAt: Date.now() - 1000 * 60 * 60 * 4,
  },
  {
    id: id("rcp"),
    terminalId: "T01",
    receiptNo: "2026100400102",
    amount: 18500,
    arrivedAt: Date.now() - 1000 * 60 * 60 * 3,
  },
  {
    id: id("rcp"),
    terminalId: "T09",
    receiptNo: "2026100409009",
    amount: 12000,
    arrivedAt: Date.now() - 1000 * 60 * 60 * 2,
  },
];

// 构造 A 班确认快照（按确认时口径：只匹配前两笔）
function buildSnapshot(): void {
  // 内联计算避免 seed 依赖运行时函数循环
  const pumpAmount = (litersX100: number, price: number) =>
    Math.round((litersX100 * price) / 100);
  const pumpTotal = pumpsA.reduce(
    (s, p) => s + pumpAmount(p.endReading - p.startReading, p.pricePerL),
    0
  );
  const electronic = payA1.amount + payA2.amount;
  const income = shiftA.cashTotal + electronic;
  const pending = payA3.amount;
  shiftA.snapshot = {
    confirmedAt: Date.now() - 86400000 + 1000 * 60 * 60 * 8,
    confirmedBy: "王站长",
    version: 1,
    pumpTotals: JSON.parse(JSON.stringify(pumpsA)),
    cashTotal: shiftA.cashTotal,
    payments: JSON.parse(JSON.stringify([payA1, payA2, payA3])),
    matchedReceipts: JSON.parse(JSON.stringify(receiptsAMatched)),
    income: {
      pumpAmount: pumpTotal,
      cash: shiftA.cashTotal,
      electronicMatched: electronic,
      electronicPending: pending,
      incomeTotal: income,
      receiptsUnmatched: 0,
      pendingDiff: pending,
      crossDiff: pumpTotal - income,
    },
    pending: {
      pumpAmount: pumpTotal,
      cash: shiftA.cashTotal,
      electronicMatched: electronic,
      electronicPending: pending,
      incomeTotal: income,
      receiptsUnmatched: 0,
      pendingDiff: pending,
      crossDiff: pumpTotal - income,
    },
    pumpTotalAmount: pumpTotal,
  };
  shiftA.versionOwner.push({
    clientId: "seed",
    opId: "seed-confirm",
    at: shiftA.snapshot.confirmedAt,
  });
  shiftA.version = 2;
}
buildSnapshot();

export function createSeedState(): ServerState {
  return {
    revision: 1,
    shifts: [shiftB, shiftA],
    unassigned: JSON.parse(JSON.stringify(pool)),
    seenReceiptKeys: [
      ...receiptsAMatched.map((r) => `${r.terminalId}::${r.receiptNo}`),
      ...pool.map((r) => `${r.terminalId}::${r.receiptNo}`),
    ],
    appliedOpKeys: [],
  };
}

/** 演示用：晚到回执（A 班挂起的银联）+ 一笔新的无人认领回执 */
export function demoLateReceipts(): BankReceipt[] {
  return [
    {
      id: `rcp_late_${Date.now()}`,
      terminalId: "T02",
      receiptNo: "2026100300777",
      amount: 15000,
      arrivedAt: Date.now(),
    },
  ];
}

export function demoUnclaimedReceipt(): BankReceipt {
  return {
    id: `rcp_extra_${Date.now()}`,
    terminalId: "T09",
    receiptNo: `202610040${Math.floor(900 + Math.random() * 99)}`,
    amount: Math.floor(3000 + Math.random() * 20000),
    arrivedAt: Date.now(),
  };
}

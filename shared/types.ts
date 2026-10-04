// 班次核销台共享领域类型（前端 TS / 服务端 JS 共用）

export type PayMethod = "cash" | "electronic";

export type ShiftStatus = "open" | "confirmed";

/** 油枪泵码读数 */
export interface PumpReading {
  pumpNo: string; // 油枪号
  product: string; // 油品 92#/95#/0#
  price: number; // 当班单价 元/L
  startMeter: number; // 接班泵码 L
  endMeter: number; // 交班泵码 L
}

/** 收款记录（现金 / 电子支付） */
export interface Payment {
  id: string; // 服务端正式 id
  clientId: string; // 终端幂等键：终端号-本地流水
  method: PayMethod;
  amount: number;
  terminalNo?: string; // POS 终端号（电子支付）
  receiptNo?: string; // 匹配后回填银行回执号
  paidAt: string;
  note?: string;
}

/** 银行到账回执（全站收件箱，按 终端号+回执号 唯一） */
export interface BankReceipt {
  id: string;
  terminalNo: string;
  receiptNo: string;
  amount: number;
  txTime: string;
  arrivedAt: string;
  status: "pending" | "linked";
  linkedPaymentId?: string;
  shiftId?: string;
  amountMismatch?: boolean; // 同号但金额对不上
}

export type CorrectionType =
  | "cross_shift_refund" // 跨班退款
  | "late_receipt" // 晚到回执
  | "pump_adjust"; // 泵码更新

/** 冲正记录（只追加，不改原确认依据） */
export interface Correction {
  id: string;
  clientId: string;
  type: CorrectionType;
  createdAt: string;
  reason: string;
  terminalNo: string; // 由哪个终端登记
  /** 对泵码口径收入的调整（退款为负，泵码更新可正可负） */
  incomeDelta: number;
  /** 对实际到账的调整 */
  collectedDelta: number;
  volumeDelta?: number;
  pumpNo?: string;
  oldMeter?: number;
  newMeter?: number;
  originShiftId?: string; // 跨班退款：退款发生班次
  receiptSnapshot?: { terminalNo: string; receiptNo: string; amount: number };
}

/** 确认快照：原确认依据，永久保留 */
export interface ConfirmBasis {
  confirmedAt: string;
  version: number;
  volume: number;
  pumpAmount: number;
  cash: number;
  electronicMatched: number;
  electronicUnmatched: number;
  income: number;
  collected: number;
  diff: number;
  pumps: PumpReading[];
  matchedPayments: Array<{ id: string; method: PayMethod; amount: number; terminalNo?: string; receiptNo?: string }>;
}

export interface Shift {
  id: string;
  stationId: string;
  name: string; // 如 10-04 早班
  startTime: string;
  endTime?: string;
  status: ShiftStatus;
  version: number; // 乐观锁版本
  pumps: PumpReading[];
  payments: Payment[];
  correctionChain: Correction[];
  confirmedBasis?: ConfirmBasis;
  createdAt: string;
  updatedAt: string;
}

export interface Station {
  id: string;
  name: string;
  terminals: string[];
}

export interface ServerState {
  station: Station;
  shifts: Shift[];
  receipts: BankReceipt[];
  serverTime: string;
}

/** 班次实时核销视图（纯计算） */
export interface ShiftView {
  shiftId: string;
  status: ShiftStatus;
  volume: number;
  pumpAmount: number;
  cash: number;
  electronicMatched: number;
  electronicUnmatched: number;
  correctionIncome: number;
  correctionCollected: number;
  income: number; // 泵码口径应收
  collected: number; // 回执口径实收
  diff: number; // 对账差异（应收-实收），保留但不拉高收入
  corrections: Array<Correction & { incomeDelta: number; collectedDelta: number }>;
}

/** 本地未同步编辑草稿 */
export interface ShiftDraft {
  shiftId: string;
  baseVersion: number;
  pumps: PumpReading[];
  payments: Payment[];
  savedAt: string;
}

export type QueuedOpType =
  | "receipt"
  | "linkReceipt"
  | "commit"
  | "confirm"
  | "correction"
  | "createShift";

export interface QueuedOp {
  id: string;
  terminalNo: string;
  type: QueuedOpType;
  label: string;
  shiftId?: string;
  endpoint: string;
  payload: unknown;
  createdAt: string;
}

/** 后到旧版本保存失败后留下的冲突草稿 */
export interface ConflictDraft {
  id: string;
  shiftId: string;
  shiftName: string;
  kind: "commit" | "confirm" | "correction";
  terminalNo: string;
  label: string;
  clientPayload: unknown;
  serverSnapshot: Shift;
  at: string;
}

// 班次核销台领域模型
// 金额一律用「分」整数存储，避免浮点误差；油机读数/油量保留 2 位小数（同样以整数表示：×100）

export type ShiftStatus = "open" | "confirmed";

/** 油枪（泵）读数：用起止码差计算当班发油量与油款 */
export interface PumpReading {
  id: string;
  pumpNo: string; // 油枪号，如 1
  grade: string; // 油品，如 92#
  startReading: number; // 开班泵码（×100 的升数）
  endReading: number; // 收班泵码（×100 的升数）
  pricePerL: number; // 当班单价（分/升）
}

/** 电子支付流水：对应一笔支付终端交易，可凭回执号与银行回执匹配 */
export interface Payment {
  id: string;
  terminalId: string; // 终端号
  receiptNo: string; // 回执号
  amount: number; // 分
  method: string; // 微信 / 支付宝 / 银联
  paidAt: number; // 时间戳
  refundedInShiftId?: string; // 未确认状态下登记跨班退款：该流水已在某后续班次退款
}

/** 银行回执：由银行侧同步到达，可能晚于班次 */
export interface BankReceipt {
  id: string;
  terminalId: string;
  receiptNo: string;
  amount: number;
  arrivedAt: number; // 回执到账时间
}

/** 冲正类型 */
export type CorrectionType =
  | "late_receipt" // 晚到回执：补齐原确认时挂起的电子支付
  | "cross_shift_refund" // 跨班退款：本班交易在后续班次被退
  | "pump_adjust"; // 泵码更新：收班后泵码被修正

export interface Correction {
  id: string;
  type: CorrectionType;
  reason: string;
  createdAt: number;
  // 对当班收入（现金+已匹配电子）的影响（分）：晚到回执为正、跨班退款为负
  incomeDelta: number;
  // 对未解决待核差异的影响（分）：晚到回执把挂起转收入时为负、退款冲掉挂起时为负
  pendingDelta: number;
  // 对泵码油款口径的影响（分）：仅泵码调整使用
  pumpDelta: number;
  // 泵码调整专用
  pumpId?: string;
  fromEndReading?: number;
  toEndReading?: number;
  // 晚到回执 / 跨班退款关联的支付与回执
  paymentId?: string;
  bankReceiptId?: string;
  lateReceipt?: BankReceipt; // 晚到回执的内嵌快照（不依赖待核池）
  refundedInShiftId?: string; // 跨班退款发生在哪个班次
}

/** 确认时被冻结的依据快照（之后永不改写） */
export interface ConfirmSnapshot {
  confirmedAt: number;
  confirmedBy: string;
  version: number; // 确认所依据的班次版本
  pumpTotals: PumpReading[]; // 冻结的油枪读数
  cashTotal: number;
  payments: Payment[]; // 冻结的支付流水（含已挂起未匹配的）
  matchedReceipts: BankReceipt[]; // 冻结时已匹配回执
  income: ReconSummary; // 确认时收入口径
  pending: ReconSummary; // 确认时待核口径
  pumpTotalAmount: number; // 泵码口径油款（用于与收款差异核对）
}

export interface Shift {
  id: string;
  name: string; // 早班 / 中班 / 晚班
  station: string;
  date: string; // YYYY-MM-DD
  window: string; // 06:00-14:00
  status: ShiftStatus;
  version: number; // 乐观锁版本，每次生效结果 +1
  /** 每个版本由哪个设备/操作生效：versionOwner[v] 记录版本 v 生效时的 clientId 与 opId */
  versionOwner: { clientId: string; opId: string; at: number }[];
  // open：当前编辑数据；confirmed：仅作为追加冲正之外的原始参考（权威数据以 snapshot 为准）
  pumps: PumpReading[];
  cashTotal: number;
  payments: Payment[];
  corrections: Correction[];
  snapshot?: ConfirmSnapshot;
  createdAt: number;
}

/** 核销结果的一个口径 */
export interface ReconSummary {
  pumpAmount: number; // 泵码油款
  cash: number; // 现金
  electronicMatched: number; // 已匹配回执的电子支付
  electronicPending: number; // 未匹配回执的电子支付（挂起，不计收入）
  incomeTotal: number; // 当班收入 = 现金 + 已匹配电子
  receiptsUnmatched: number; // 到账但找不到支付流水的回执金额（挂账，不计收入）
  pendingDiff: number; // 待核差异合计
  crossDiff: number; // 油款与收款的交叉差异
}

/** 某班次在某一时刻的完整核销视图 */
export interface ShiftRecon {
  summary: ReconSummary;
  matchedPayments: Payment[];
  pendingPayments: Payment[]; // 电子支付有流水、无回执
  matchedReceipts: BankReceipt[];
  extraReceipts: BankReceipt[]; // 回执有、支付无（可能属于别班 / 错账）
}

/** 站点级未挂到任何班次的银行回执池 */
export interface UnassignedReceipt extends BankReceipt {
  note?: string;
}

/* ---------------- 服务端操作（事件溯源 / operation log） ---------------- */

export interface SaveShiftOp {
  kind: "saveShift";
  opId: string;
  shiftId: string;
  baseVersion: number;
  pumps: PumpReading[];
  cashTotal: number;
  payments: Payment[];
}

export interface ConfirmShiftOp {
  kind: "confirmShift";
  opId: string;
  shiftId: string;
  baseVersion: number;
  confirmedBy: string;
}

export interface AddRefundOp {
  kind: "addRefund";
  opId: string;
  shiftId: string; // 原交易所在班次
  baseVersion: number;
  paymentId: string;
  bankReceiptId?: string;
  refundedInShiftId: string;
  reason: string;
}

export interface AdjustPumpOp {
  kind: "adjustPump";
  opId: string;
  shiftId: string;
  baseVersion: number;
  pumpId: string;
  toEndReading: number;
  reason: string;
}

/** 银行回执同步：可能落入本班、晚到落入已确认班、或无人认领 */
export interface SyncReceiptsOp {
  kind: "syncReceipts";
  opId: string;
  receipts: BankReceipt[];
}

export type ServerOp =
  | SaveShiftOp
  | ConfirmShiftOp
  | AddRefundOp
  | AdjustPumpOp
  | SyncReceiptsOp;

/** 操作应用结果 */
export interface AppliedOp {
  state: ServerState;
  /** 被 bump 的班次版本（用于判断冲突影响面） */
  bumpedShiftIds: string[];
  /** 本次同步中晚到、自动挂到已确认班次的回执 */
  lateRouted: { shiftId: string; receipt: BankReceipt }[];
  /** 无人认领进入站点池的回执 */
  unassigned: BankReceipt[];
  /** 去重丢弃的回执号 */
  duplicated: string[];
}

export interface ServerState {
  revision: number; // 服务端整体单调版本
  shifts: Shift[];
  unassigned: UnassignedReceipt[]; // 站点级待处理回执（未匹配到支付流水）
  seenReceiptKeys: string[]; // 已处理回执键（终端号::回执号），同步幂等去重
  appliedOpKeys: string[]; // 操作幂等表
}

export class ConflictError extends Error {
  constructor(
    public shiftId: string,
    public baseVersion: number,
    public serverVersion: number
  ) {
    super(`版本冲突：依据版本 ${baseVersion}，服务端已生效到版本 ${serverVersion}`);
    this.name = "ConflictError";
  }
}

export function receiptKey(terminalId: string, receiptNo: string): string {
  return `${terminalId}::${receiptNo}`;
}

import { defineStore } from "pinia";
import { applyOp, uid } from "../domain/server";
import { createSeedState } from "../domain/seed";
import type {
  AppliedOp,
  BankReceipt,
  ServerOp,
  ServerState,
  Shift,
} from "../domain/types";
import { ConflictError as ConflictErr } from "../domain/types";

const LS_SERVER = "recon.server.v1";
const LS_OUTBOX = "recon.outbox.v1";
const LS_CONFLICTS = "recon.conflicts.v1";
const LS_PREFS = "recon.prefs.v1";
const LS_NETWORK = "recon.network.v1";
/** 跨窗口通知通道 */
const CHANNEL_NAME = "recon-bus-v1";

export interface OutboxItem {
  clientId: string; // 产生草稿的窗口会话
  op: ServerOp;
  label: string;
  createdAt: number;
  error?: string;
}

export interface ConflictDraft {
  id: string;
  opId: string; // 去重键：同一失败操作只保留一份冲突草稿
  clientId: string;
  shiftId: string;
  shiftName: string;
  baseVersion: number; // 草稿依据的旧版本
  serverVersion: number; // 保存时服务端已生效版本
  op: ServerOp; // 未生效的旧版本操作（只作草稿，永不覆盖）
  label: string;
  createdAt: number;
}

interface Prefs {
  activeShiftId?: string;
}

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function opShiftId(op: ServerOp): string {
  return "shiftId" in op ? op.shiftId : "";
}

/** 窗口会话身份：同机两个窗口是两个会话；关掉再开是新会话但共享持久化草稿 */
function windowId(): string {
  let v = sessionStorage.getItem("recon.windowId");
  if (!v) {
    v = uid("win");
    sessionStorage.setItem("recon.windowId", v);
  }
  return v;
}

function loadNetwork(): boolean {
  const raw = localStorage.getItem(LS_NETWORK);
  return raw === null ? navigator.onLine : raw === "online";
}

function loadServer(): ServerState {
  const existing = readJson<ServerState | null>(LS_SERVER, null);
  if (existing && Array.isArray(existing.shifts)) return existing;
  const seed = createSeedState();
  writeJson(LS_SERVER, seed);
  return seed;
}

export const useReconStore = defineStore("recon", {
  state: () => ({
    clientId: windowId(),
    server: loadServer(),
    online: loadNetwork(),
    outbox: readJson<OutboxItem[]>(LS_OUTBOX, []),
    conflicts: readJson<ConflictDraft[]>(LS_CONFLICTS, []),
    prefs: readJson<Prefs>(LS_PREFS, {}),
    activeShiftId: readJson<Prefs>(LS_PREFS, {}).activeShiftId ?? "",
    lastSyncAt: 0,
    notice: "" as string,
  }),

  getters: {
    shifts: (s): Shift[] =>
      [...s.server.shifts].sort((a, b) => b.createdAt - a.createdAt),
    activeShift(state): Shift | undefined {
      return (
        state.server.shifts.find((x) => x.id === state.activeShiftId) ??
        state.server.shifts[0]
      );
    },
    /** 所有待发草稿（可能来自本窗口或此前关掉的窗口） */
    pendingOutbox(state): OutboxItem[] {
      return [...state.outbox].sort((a, b) => a.createdAt - b.createdAt);
    },
    shiftConflicts: (state) => (shiftId: string) =>
      state.conflicts.filter((c) => c.shiftId === shiftId),
    /** 某班次最新一条尚未生效的保存草稿（离线预览用） */
    pendingSaveFor: (state) => (shiftId: string) => {
      for (let i = state.outbox.length - 1; i >= 0; i--) {
        const item = state.outbox[i];
        if (
          item.op.kind === "saveShift" &&
          item.op.shiftId === shiftId
        ) {
          return item;
        }
      }
      return undefined;
    },
    /** 某班次待发的确认草稿 */
    pendingConfirmFor: (state) => (shiftId: string) =>
      state.outbox.find(
        (o) => o.op.kind === "confirmShift" && o.op.shiftId === shiftId
      ),
  },

  actions: {
    init() {
      window.addEventListener("storage", this.onStorage);
      window.addEventListener("online", () => this.setOnline(true));
      window.addEventListener("offline", () => this.setOnline(false));
      if (!this.activeShiftId) {
        this.activeShiftId = this.server.shifts[0]?.id ?? "";
      }
      this.broadcast();
      if (this.online && this.outbox.length) this.flushOutbox();
    },

    onStorage(e: StorageEvent) {
      if (!e.key) return;
      if (e.key === LS_NETWORK) {
        this.online = loadNetwork();
        if (this.online) this.flushOutbox();
        return;
      }
      // 离线期间以本机草稿为准，避免其它窗口把「未确认视图」抖动；重连统一重放
      if (e.key === LS_SERVER && this.online) {
        this.server = readJson<ServerState>(LS_SERVER, this.server);
      } else if (e.key === LS_OUTBOX) {
        this.outbox = readJson<OutboxItem[]>(LS_OUTBOX, []);
        if (this.online) this.flushOutbox();
      } else if (e.key === LS_CONFLICTS) {
        this.conflicts = readJson<ConflictDraft[]>(LS_CONFLICTS, []);
      } else if (e.key === LS_PREFS) {
        this.prefs = readJson<Prefs>(LS_PREFS, {});
      }
    },

    broadcast() {
      try {
        const ch = new BroadcastChannel(CHANNEL_NAME);
        ch.postMessage("ping");
        ch.close();
      } catch {
        /* storage 事件已足够 */
      }
      writeJson(LS_PREFS, { ...this.prefs, activeShiftId: this.activeShiftId });
    },

    persistServer() {
      writeJson(LS_SERVER, this.server);
    },
    persistOutbox() {
      writeJson(LS_OUTBOX, this.outbox);
    },
    persistConflicts() {
      writeJson(LS_CONFLICTS, this.conflicts);
    },

    selectShift(id: string) {
      this.activeShiftId = id;
      this.prefs = { ...this.prefs, activeShiftId: id };
      writeJson(LS_PREFS, this.prefs);
      this.broadcast();
    },

    setOnline(v: boolean) {
      this.online = v;
      localStorage.setItem(LS_NETWORK, v ? "online" : "offline");
      if (v) this.flushOutbox();
    },

    /** 提交操作：在线即时生效；离线进草稿 outbox（不污染生效结果），恢复网络后重放合并 */
    submit(op: ServerOp, label: string): { ok: boolean; conflict?: ConflictDraft } {
      if (!this.online) {
        this.outbox.push({
          clientId: this.clientId,
          op,
          label,
          createdAt: Date.now(),
        });
        this.persistOutbox();
        this.broadcast();
        this.notice = `已离线留草稿：${label}（恢复网络后自动合并）`;
        return { ok: true, conflict: undefined };
      }
      return this.applyNow(op, label);
    },

    applyNow(op: ServerOp, label: string): { ok: boolean; conflict?: ConflictDraft } {
      try {
        const applied = applyOp(this.server, op, undefined, this.clientId);
        if (applied.state === this.server) return { ok: true }; // 幂等
        this.server = applied.state;
        this.persistServer();
        this.announceApplied(applied, label);
        this.broadcast();
        return { ok: true };
      } catch (e) {
        if (e instanceof ConflictErr) {
          const shift = this.server.shifts.find((x) => x.id === opShiftId(op));
          const draft = this.recordConflict(
            { clientId: this.clientId, op, label, createdAt: Date.now() },
            e.baseVersion,
            shift?.version ?? e.serverVersion
          );
          return { ok: false, conflict: draft };
        }
        throw e;
      }
    },

    announceApplied(applied: AppliedOp, label: string) {
      const notes: string[] = [`${label} 已生效`];
      if (applied.lateRouted.length) {
        notes.push(
          `晚到回执 ${applied.lateRouted
            .map((x) => x.receipt.receiptNo)
            .join("、")} 已追加为冲正，原确认依据保留`
        );
      }
      if (applied.unassigned.length) {
        notes.push(
          `未匹配回执 ${applied.unassigned
            .map((x) => x.receiptNo)
            .join("、")} 进入待核，差异保留、不计收入`
        );
      }
      if (applied.duplicated.length) {
        notes.push(`重复回执已忽略：${applied.duplicated.join("、")}`);
      }
      this.notice = notes.join("；");
    },

    /**
     * 网络恢复：按时间顺序重放全部离线草稿（含已关闭窗口留下的）。
     * 对每条带版本操作：检查 baseVersion→当前版本之间是否由「别的会话」生效过——
     *  - 没有（都是同一草稿链自己的 bump）：重定基到最新版本继续提交；
     *  - 有：判冲突，转冲突草稿，绝不覆盖已生效结果。
     * 纯函数 + opId 幂等保证多个窗口同时重放也收敛到同一结果。
     */
    flushOutbox() {
      if (!this.online) return;
      this.server = readJson<ServerState>(LS_SERVER, this.server);
      if (!this.outbox.length) return;

      const queue = [...this.outbox].sort((a, b) => a.createdAt - b.createdAt);
      const remaining: OutboxItem[] = [];

      for (const item of queue) {
        let op = item.op;
        const shiftId = opShiftId(op);
        const cur = this.server.shifts.find((x) => x.id === shiftId);

        if (cur && "baseVersion" in op && cur.version !== op.baseVersion) {
          const foreign = cur.versionOwner
            .slice(op.baseVersion, cur.version)
            .some((o) => o.clientId !== item.clientId);
          if (foreign) {
            this.recordConflict(item, op.baseVersion, cur.version);
            continue;
          }
          op = { ...op, baseVersion: cur.version };
        }

        try {
          const applied = applyOp(this.server, op, undefined, item.clientId);
          if (applied.state !== this.server) {
            this.server = applied.state;
            this.announceApplied(applied, item.label);
          }
          // 成功（或幂等）→ 草稿移除
        } catch (e) {
          if (e instanceof ConflictErr) {
            const srv = this.server.shifts.find((x) => x.id === shiftId);
            this.recordConflict(item, e.baseVersion, srv?.version ?? e.serverVersion);
          } else {
            item.error = (e as Error).message;
            remaining.push(item);
          }
        }
      }

      this.persistServer();
      this.outbox = remaining;
      this.persistOutbox();
      this.persistConflicts();
      this.lastSyncAt = Date.now();
      this.broadcast();
    },

    /** 记录冲突草稿（按 opId 去重），返回草稿 */
    recordConflict(
      item: Pick<OutboxItem, "clientId" | "op" | "label" | "createdAt">,
      baseVersion: number,
      serverVersion: number
    ): ConflictDraft {
      const opId = item.op.opId;
      const existing = this.conflicts.find((c) => c.opId === opId);
      if (existing) return existing;
      const shift = this.server.shifts.find((x) => x.id === opShiftId(item.op));
      const draft: ConflictDraft = {
        id: uid("conflict"),
        opId,
        clientId: item.clientId,
        shiftId: opShiftId(item.op),
        shiftName: shift?.name ?? opShiftId(item.op),
        baseVersion,
        serverVersion,
        op: item.op,
        label: item.label,
        createdAt: item.createdAt,
      };
      this.conflicts = [...this.conflicts, draft];
      this.notice = `版本冲突：「${item.label}」基于旧版本 v${baseVersion}，当前已生效 v${serverVersion}，已存为冲突草稿，未覆盖生效结果`;
      return draft;
    },

    syncReceipts(receipts: BankReceipt[], label = "银行回执同步") {
      return this.submit(
        { kind: "syncReceipts", opId: uid("op"), receipts },
        label
      );
    },

    saveShift(payload: {
      shiftId: string;
      baseVersion: number;
      pumps: Shift["pumps"];
      cashTotal: number;
      payments: Shift["payments"];
    }) {
      return this.submit(
        { kind: "saveShift", opId: uid("op"), ...payload },
        "保存班次"
      );
    },

    confirmShift(shiftId: string, baseVersion: number, confirmedBy: string) {
      return this.submit(
        { kind: "confirmShift", opId: uid("op"), shiftId, baseVersion, confirmedBy },
        "确认班次"
      );
    },

    addRefund(payload: {
      shiftId: string;
      baseVersion: number;
      paymentId: string;
      bankReceiptId?: string;
      refundedInShiftId: string;
      reason: string;
    }) {
      return this.submit(
        { kind: "addRefund", opId: uid("op"), ...payload },
        "登记跨班退款"
      );
    },

    adjustPump(payload: {
      shiftId: string;
      baseVersion: number;
      pumpId: string;
      toEndReading: number;
      reason: string;
    }) {
      return this.submit(
        { kind: "adjustPump", opId: uid("op"), ...payload },
        "泵码更新冲正"
      );
    },

    discardConflict(id: string) {
      this.conflicts = this.conflicts.filter((c) => c.id !== id);
      this.persistConflicts();
      this.broadcast();
    },

    /** 把冲突草稿载入编辑器，基于最新生效结果人工合并 */
    loadConflict(id: string): ConflictDraft | undefined {
      const c = this.conflicts.find((x) => x.id === id);
      if (c) this.selectShift(c.shiftId);
      return c;
    },

    resetAll() {
      this.server = createSeedState();
      this.outbox = [];
      this.conflicts = [];
      writeJson(LS_SERVER, this.server);
      writeJson(LS_OUTBOX, []);
      writeJson(LS_CONFLICTS, []);
      this.notice = "已重置为演示数据";
      this.broadcast();
    },
  },
});

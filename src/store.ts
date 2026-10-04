import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  BankReceipt,
  ConflictDraft,
  Payment,
  PumpReading,
  QueuedOp,
  ServerState,
  Shift,
  ShiftDraft,
} from "@shared/types";
import { computeView } from "@shared/domain";
import { api, ApiConflict, ApiReject } from "./lib/api";
import { K, storage } from "./lib/storage";
import { getTerminalNo, localId } from "./lib/terminal";

interface Toast {
  id: string;
  type: "success" | "warning" | "error" | "info";
  text: string;
}

export const useStore = defineStore("desk", () => {
  const terminalNo = ref(getTerminalNo());
  const online = ref(storage.read<boolean>(K.online, true));
  const state = ref<ServerState | null>(storage.read<ServerState | null>(K.cache, null));
  const drafts = ref<Record<string, ShiftDraft>>(storage.read(K.drafts, {}));
  const conflicts = ref<ConflictDraft[]>(storage.read(K.conflicts, []));
  const queue = ref<QueuedOp[]>(storage.read(K.queue, []));
  const toasts = ref<Toast[]>([]);
  const flushing = ref(false);
  const syncMsg = ref("");

  // ---------- 持久化 ----------
  function persist() {
    storage.write(K.online, online.value);
    if (state.value) storage.write(K.cache, state.value);
    storage.write(K.drafts, drafts.value);
    storage.write(K.conflicts, conflicts.value);
    storage.write(K.queue, queue.value);
    channel?.postMessage({ type: "local-mutated", at: Date.now() });
  }

  // 跨窗口：一个窗口成功同步/产生冲突后，其他窗口刷新视图（各自仍有独立草稿与终端身份）
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("gas-shift-desk");
    channel.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === "local-mutated") {
        // 重新读本地（其他窗口更新的缓存/冲突），在线则补一次服务端刷新
        conflicts.value = storage.read(K.conflicts, []);
        queue.value = storage.read(K.queue, []);
        drafts.value = storage.read(K.drafts, {});
        if (online.value && !flushing.value) void refresh();
      }
    };
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (ev: StorageEvent) => {
      if (ev.key && Object.values(K).includes(ev.key as (typeof K)[keyof typeof K])) {
        conflicts.value = storage.read(K.conflicts, []);
        queue.value = storage.read(K.queue, []);
        drafts.value = storage.read(K.drafts, {});
      }
    });
  }

  function toast(type: Toast["type"], text: string) {
    const id = Math.random().toString(36).slice(2);
    toasts.value.push({ id, type, text });
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, 4200);
  }

  function applyState(next: ServerState) {
    state.value = next;
    // 清理：服务器已不存在的班次、或已被其他终端确认的班次，其 open 期本地草稿失效
    const live = new Map(next.shifts.map((s) => [s.id, s.status]));
    for (const id of Object.keys(drafts.value)) {
      const status = live.get(id);
      if (!status || status === "confirmed") delete drafts.value[id];
    }
    persist();
  }

  // ---------- 网络 ----------
  function setOnline(v: boolean) {
    online.value = v;
    persist();
    if (v) {
      void refresh();
      void flushQueue();
    }
  }

  function setTerminal(t: string) {
    terminalNo.value = t;
    localStorage.setItem("gas-shift:terminal", t);
  }

  // 单调守卫：并发请求按发起顺序生效，迟到的旧响应不得覆盖新写结果
  let reqSeq = 0;
  let appliedSeq = 0;

  function ingest(next: ServerState, reqId: number) {
    if (reqId < appliedSeq) return false; // 迟到响应
    appliedSeq = reqId;
    applyState(next);
    return true;
  }

  async function refresh() {
    if (!online.value) return;
    const reqId = ++reqSeq;
    try {
      ingest(await api.state(), reqId);
    } catch (e) {
      toast("error", `拉取服务端失败：${(e as Error).message}`);
    }
  }

  // ---------- 队列执行 ----------
  async function execOp(op: QueuedOp): Promise<ServerState> {
    const p = op.payload as Record<string, unknown>;
    switch (op.type) {
      case "receipt": return api.receipts(p);
      case "linkReceipt": return api.linkReceipt(p);
      case "commit": return api.commit(op.shiftId!, p);
      case "confirm": return api.confirm(op.shiftId!, p);
      case "correction": {
        const kind = String(p.kind);
        return kind === "pump"
          ? api.pumpAdjust(op.shiftId!, p)
          : api.crossRefund(op.shiftId!, p);
      }
      case "createShift": return api.createShift(p);
      default: throw new Error("unknown op");
    }
  }

  /** 断网恢复：FIFO 重放，409 生成冲突草稿并跳过，绝不覆盖已生效版本 */
  async function flushQueue() {
    if (!online.value || flushing.value || queue.value.length === 0) return;
    flushing.value = true;
    const remaining: QueuedOp[] = [];
    let merged = 0;
    let dups = 0;
    while (queue.value.length > 0) {
      const op = queue.value.shift()!;
      const reqId = ++reqSeq;
      try {
        const next = await execOp(op);
        ingest(next, reqId);
        if (op.type === "receipt") {
          merged += (next as { merged?: number }).merged ?? 0;
          dups += (next as { duplicates?: number }).duplicates ?? 0;
        }
        // 提交/确认成功后清掉对应班次草稿
        if (op.type === "commit" || op.type === "confirm") {
          delete drafts.value[op.shiftId!];
        }
      } catch (e) {
        if (e instanceof ApiConflict) {
          appliedSeq = Math.max(appliedSeq, reqSeq); // 冲突响应携带的是更新的服务端事实
          const serverShift = e.serverShift;
          conflicts.value.unshift({
            id: localId(terminalNo.value, "conflict"),
            shiftId: serverShift.id,
            shiftName: serverShift.name,
            kind: op.type === "confirm" ? "confirm" : op.type === "correction" ? "correction" : "commit",
            terminalNo: op.terminalNo,
            label: op.label,
            clientPayload: op.payload,
            serverSnapshot: serverShift,
            at: new Date().toISOString(),
          });
          applyStateFromConflict(serverShift);
          toast("warning", `「${op.label}」版本过期，已存为冲突草稿，未覆盖生效结果`);
        } else if (e instanceof ApiReject) {
          toast("error", `「${op.label}」被服务端拒绝，已从队列移除：${e.message}`);
        } else {
          remaining.push(op); // 网络类错误留队重试
        }
      }
    }
    queue.value = remaining;
    flushing.value = false;
    persist();
    if (merged > 0 || dups > 0) {
      syncMsg.value = `回执合并完成：新收 ${merged} 张，重复回执幂等丢弃 ${dups} 张`;
      toast("success", syncMsg.value);
    }
  }

  function applyStateFromConflict(serverShift: Shift) {
    if (!state.value) return;
    const idx = state.value.shifts.findIndex((s) => s.id === serverShift.id);
    if (idx >= 0) state.value.shifts[idx] = serverShift;
    persist();
  }

  /** 在线直接执行；离线或失败则入队，先在本地留草稿 */
  async function dispatch(op: Omit<QueuedOp, "id" | "terminalNo" | "createdAt">): Promise<boolean> {
    const full: QueuedOp = {
      ...op,
      id: localId(terminalNo.value, "op"),
      terminalNo: terminalNo.value,
      createdAt: new Date().toISOString(),
    };
    if (!online.value) {
      queue.value.push(full);
      persist();
      toast("info", `当前断网，「${full.label}」已存为离线草稿，联网后自动上报`);
      return false;
    }
    const reqId = ++reqSeq;
    try {
      const next = await execOp(full);
      ingest(next, reqId);
      if (full.type === "commit" || full.type === "confirm") delete drafts.value[full.shiftId!];
      persist();
      return true;
    } catch (e) {
      if (e instanceof ApiConflict) {
        appliedSeq = Math.max(appliedSeq, reqId);
        const ss = e.serverShift;
        conflicts.value.unshift({
          id: localId(terminalNo.value, "conflict"),
          shiftId: ss.id,
          shiftName: ss.name,
          kind: full.type === "confirm" ? "confirm" : full.type === "correction" ? "correction" : "commit",
          terminalNo: full.terminalNo,
          label: full.label,
          clientPayload: full.payload,
          serverSnapshot: ss,
          at: new Date().toISOString(),
        });
        applyStateFromConflict(ss);
        persist();
        toast("error", `保存冲突：${ss.name} 已有生效的新版本（v${ss.version}），旧版本已留冲突草稿`);
        return false;
      } else if (e instanceof ApiReject) {
        toast("error", `「${full.label}」被拒绝：${e.message}`);
        return false;
      }
      queue.value.push(full);
      persist();
      toast("warning", `网络异常，「${full.label}」转入待发队列，联网后自动上报`);
      return false;
    }
  }

  // ---------- 班次工作稿（编辑态） ----------
  /** 断网或在线都可编辑：草稿即时落 localStorage，关掉再开仍在 */
  function getDraft(shiftId: string): ShiftDraft | undefined {
    return drafts.value[shiftId];
  }

  function saveDraft(shiftId: string, baseVersion: number, pumps: PumpReading[], payments: Payment[]) {
    drafts.value[shiftId] = {
      shiftId,
      baseVersion,
      pumps: JSON.parse(JSON.stringify(pumps)),
      payments: JSON.parse(JSON.stringify(payments)),
      savedAt: new Date().toISOString(),
    };
    persist();
  }

  function discardDraft(shiftId: string) {
    delete drafts.value[shiftId];
    persist();
  }

  async function commitDraft(shiftId: string, draft: ShiftDraft) {
    const ok = await dispatch({
      type: "commit",
      label: `保存班次 ${shiftId}`,
      shiftId,
      endpoint: `/api/shifts/${shiftId}/commit`,
      payload: { version: draft.baseVersion, pumps: draft.pumps, payments: draft.payments },
    });
    if (ok) toast("success", "班次工作稿已保存并生效");
    return ok;
  }

  // ---------- 冲突草稿处理 ----------
  /** 放弃旧版本，改用服务器已生效结果 */
  function resolveConflictDiscard(conflictId: string) {
    const cf = conflicts.value.find((x) => x.id === conflictId);
    if (cf) {
      delete drafts.value[cf.shiftId];
      toast("info", "已放弃旧版本，采用服务器生效结果");
    }
    conflicts.value = conflicts.value.filter((x) => x.id !== conflictId);
    persist();
  }

  /** 把旧版本转成可编辑草稿，基于最新版本重新提交（rebase） */
  function resolveConflictRebase(conflictId: string) {
    const cf = conflicts.value.find((x) => x.id === conflictId);
    if (!cf) return;
    const p = cf.clientPayload as { pumps?: PumpReading[]; payments?: Payment[] };
    drafts.value[cf.shiftId] = {
      shiftId: cf.shiftId,
      baseVersion: cf.serverSnapshot.version, // 关键：基线换成新版本
      pumps: p.pumps ?? cf.serverSnapshot.pumps,
      payments: p.payments ?? cf.serverSnapshot.payments,
      savedAt: new Date().toISOString(),
    };
    conflicts.value = conflicts.value.filter((x) => x.id !== conflictId);
    persist();
    toast("info", "旧版本已转为基于最新结果的草稿，请核对差异后再保存");
  }

  function discardConflict(conflictId: string) {
    conflicts.value = conflicts.value.filter((x) => x.id !== conflictId);
    persist();
  }

  async function resetDemo() {
    const s = await api.reset();
    drafts.value = {};
    conflicts.value = [];
    queue.value = [];
    applyState(s);
    toast("success", "已重置为演示数据");
  }

  // ---------- 查询派生 ----------
  const shifts = computed<Shift[]>(() => {
    if (!state.value) return [];
    // 有本地草稿的班次，列表用草稿泵码/收款叠加实时视图（未提交也能接着看）
    return state.value.shifts;
  });

  function view(shiftId: string) {
    const sh = state.value?.shifts.find((s) => s.id === shiftId);
    if (!sh) return null;
    const draft = drafts.value[shiftId];
    if (draft && sh.status === "open") {
      const preview: Shift = {
        ...sh,
        pumps: draft.pumps,
        payments: mergeForPreview(sh.payments, draft.payments),
      };
      return computeView(preview);
    }
    return computeView(sh);
  }

  const pendingReceipts = computed<BankReceipt[]>(() =>
    (state.value?.receipts ?? []).filter((r) => r.status !== "linked"),
  );

  const queueCount = computed(() => queue.value.length);
  const conflictCount = computed(() => conflicts.value.length);
  const dirtyShiftIds = computed(() => new Set(Object.keys(drafts.value)));

  return {
    terminalNo, online, state, drafts, conflicts, queue, toasts, flushing, syncMsg,
    shifts, pendingReceipts, queueCount, conflictCount, dirtyShiftIds,
    setOnline, setTerminal, refresh, dispatch, flushQueue,
    getDraft, saveDraft, discardDraft, commitDraft,
    resolveConflictDiscard, resolveConflictRebase, discardConflict,
    resetDemo,
    view, toast, persist,
  };
});

// 本地草稿里的收款按 clientId 与服务端合并后预览（与服务端同口径）
function mergeForPreview(server: Payment[], draft: Payment[]): Payment[] {
  const map = new Map<string, Payment>();
  for (const p of server) map.set(p.clientId, { ...p });
  for (const p of draft) map.set(p.clientId, { ...p });
  return [...map.values()];
}

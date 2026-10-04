// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useReconStore } from "../src/stores/recon";
import { applyOp } from "../src/domain/server";
import type { ServerState } from "../src/domain/types";

const KEYS = [
  "recon.server.v1",
  "recon.outbox.v1",
  "recon.conflicts.v1",
  "recon.prefs.v1",
  "recon.network.v1",
];

function clearStorage() {
  KEYS.forEach((k) => localStorage.removeItem(k));
  sessionStorage.clear();
}

let seededVersion = 0;
function openShiftId(store: ReturnType<typeof useReconStore>) {
  const s = store.server.shifts.find((x) => x.status === "open")!;
  seededVersion = s.version;
  return s.id;
}

describe("store 离线草稿与重放", () => {
  beforeEach(() => {
    clearStorage();
    setActivePinia(createPinia());
  });
  afterEach(() => clearStorage());

  it("断网保存只进草稿箱不改生效结果；恢复后按序合并并 bump 版本", () => {
    const store = useReconStore();
    const id = openShiftId(store);
    const sh = store.server.shifts.find((x) => x.id === id)!;
    const beforeCash = sh.cashTotal;

    store.setOnline(false);
    store.saveShift({
      shiftId: id,
      baseVersion: sh.version,
      pumps: sh.pumps,
      cashTotal: beforeCash + 1000,
      payments: sh.payments,
    });
    // 生效结果不变
    expect(store.server.shifts.find((x) => x.id === id)!.cashTotal).toBe(beforeCash);
    expect(store.outbox).toHaveLength(1);

    // 同窗口离线期间再保存一次（连续编辑）
    const sh2 = store.server.shifts.find((x) => x.id === id)!;
    store.saveShift({
      shiftId: id,
      baseVersion: sh2.version,
      pumps: sh2.pumps,
      cashTotal: beforeCash + 2000,
      payments: sh2.payments,
    });
    expect(store.outbox).toHaveLength(2);

    // 恢复网络：同一草稿链重定基，两条都生效
    store.setOnline(true);
    const after = store.server.shifts.find((x) => x.id === id)!;
    expect(after.cashTotal).toBe(beforeCash + 2000);
    expect(after.version).toBe(seededVersion + 2);
    expect(store.outbox).toHaveLength(0);
    expect(store.conflicts).toHaveLength(0);
  });

  it("两个窗口并发：后到的旧版本存为冲突草稿，不能覆盖已生效结果", () => {
    const store = useReconStore(); // 窗口 A
    const winA = store.clientId;
    const id = openShiftId(store);
    const sh = store.server.shifts.find((x) => x.id === id)!;

    // 窗口 A 在线先保存并生效 v+1
    let state: ServerState = store.server;
    state = applyOp(
      state,
      {
        kind: "saveShift",
        opId: "winA-save",
        shiftId: id,
        baseVersion: sh.version,
        pumps: sh.pumps,
        cashTotal: 888800,
        payments: sh.payments,
      },
      1,
      winA
    ).state;
    store.server = state;
    store.persistServer();

    // 窗口 B（不同 clientId）断网时基于旧版本 sh.version 留了草稿
    store.outbox.push({
      clientId: "winB-session",
      label: "保存班次",
      createdAt: 2,
      op: {
        kind: "saveShift",
        opId: "winB-save",
        shiftId: id,
        baseVersion: sh.version, // 旧版本
        pumps: sh.pumps,
        cashTotal: 11100,
        payments: sh.payments,
      },
    });

    // 恢复网络统一重放
    store.setOnline(true);

    // A 的生效结果保持，不被 B 覆盖
    const after = store.server.shifts.find((x) => x.id === id)!;
    expect(after.cashTotal).toBe(888800);
    expect(after.version).toBe(seededVersion + 1);
    // B 变成冲突草稿
    expect(store.conflicts).toHaveLength(1);
    const c = store.conflicts[0];
    expect(c.opId).toBe("winB-save");
    expect(c.baseVersion).toBe(seededVersion);
    expect(c.serverVersion).toBe(seededVersion + 1);
    // 草稿内容仍可取回人工合并
    expect(c.op.kind).toBe("saveShift");
    if (c.op.kind === "saveShift") expect(c.op.cashTotal).toBe(11100);
  });

  it("关掉再打开：草稿与冲突仍在，可继续处理（持久化）", () => {
    let store = useReconStore();
    const id = openShiftId(store);
    const sh = store.server.shifts.find((x) => x.id === id)!;
    store.setOnline(false);
    store.saveShift({
      shiftId: id,
      baseVersion: sh.version,
      pumps: sh.pumps,
      cashTotal: 5000,
      payments: sh.payments,
    });
    expect(store.outbox.length).toBeGreaterThan(0);

    // 模拟新窗口/新会话：清 session、重建 pinia 与 store
    sessionStorage.clear();
    setActivePinia(createPinia());
    store = useReconStore();
    expect(store.clientId).not.toBe("");
    expect(store.outbox).toHaveLength(1);

    store.setOnline(true);
    const after = store.server.shifts.find((x) => x.id === id)!;
    expect(after.cashTotal).toBe(5000);
    expect(store.outbox).toHaveLength(0);
  });
});

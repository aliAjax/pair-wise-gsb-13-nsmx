import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ServerState } from "../shared/types.ts";
import { buildSeed } from "./seed.ts";

const DB_FILE = process.env.DB_FILE || resolve(process.cwd(), "data", "gas-shift-db.json");

let state: ServerState | null = null;

function freshSeed(): ServerState {
  const { station, shifts, receipts } = buildSeed(new Date().toISOString());
  return { station, shifts, receipts, serverTime: new Date().toISOString() };
}

/** 始终返回当前生效的状态对象（reseed 后引用也会更新） */
export function getState(): ServerState {
  if (state) return state;
  if (existsSync(DB_FILE)) {
    state = JSON.parse(readFileSync(DB_FILE, "utf-8")) as ServerState;
  } else {
    state = freshSeed();
    persist();
  }
  return state;
}

export function reseed(): ServerState {
  state = freshSeed();
  persist();
  return state;
}

/** 全量原子落盘（tmp + rename），保证关掉再开数据还在 */
export function persist(): void {
  if (!state) return;
  state.serverTime = new Date().toISOString();
  mkdirSync(dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, DB_FILE);
}

// worker：独立 realm 模拟一个浏览器窗口（独立 localStorage / Pinia / store）
import { parentPort } from "node:worker_threads";
import { createPinia, setActivePinia } from "pinia";
import { useStore } from "../src/store";

type Dict = Record<string, string>;

function makeLocalStorage(initial: Dict) {
  const mem: Dict = { ...initial };
  return {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
    key: (i: number) => Object.keys(mem)[i] ?? null,
    get length() {
      return Object.keys(mem).length;
    },
    _dump: () => JSON.parse(JSON.stringify(mem)) as Dict,
  };
}

class NoopBC {
  onmessage: null | ((e: unknown) => void) = null;
  postMessage() {}
  close() {}
}

const origFetch = globalThis.fetch;
globalThis.fetch = (input: any, init?: any) => {
  const url = typeof input === "string" && input.startsWith("/") ? `http://localhost:3001${input}` : input;
  return origFetch(url, init);
};

// 握手：worker 先报 ready → 主线程发 initial → 建好环境/store → 报 started
parentPort!.postMessage({ id: "ready", ok: true, val: true });
const ctx = await new Promise<any>((resolve) => {
  const onInit = (msg: any) => {
    if (msg && typeof msg === "object" && "initial" in msg) {
      parentPort!.off("message", onInit);
      resolve(msg);
    }
  };
  parentPort!.on("message", onInit);
});

const storage = makeLocalStorage(ctx.initial ?? {});
(globalThis as any).localStorage = storage;
(globalThis as any).window = { addEventListener: () => {} };
(globalThis as any).BroadcastChannel = NoopBC;

setActivePinia(createPinia());
const store = useStore();

const methods = new Set([
  "setTerminal", "setOnline", "refresh", "flushQueue", "dispatch",
  "getDraft", "saveDraft", "commitDraft", "discardDraft", "resolveConflictRebase",
  "resolveConflictDiscard", "discardConflict", "resetDemo", "view",
]);

parentPort!.on("message", async (msg: any) => {
  // Vue 的 reactive/ref 跨线程 structuredClone 会丢；用 JSON 往返转纯对象
  const toPlain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
  const reply = (ok: boolean, val: unknown) => parentPort!.postMessage({ id: msg.id, ok, val });
  try {
    if (msg.cmd === "call") {
      if (!methods.has(msg.method)) throw new Error(`method not allowed: ${msg.method}`);
      const fn = (store as any)[msg.method];
      const val = await fn.call(store, ...(msg.args ?? []));
      reply(true, val === undefined ? undefined : toPlain(val));
    } else if (msg.cmd === "eval") {
      // 语句体，需显式 return
      // eslint-disable-next-line no-new-func
      const val = await new Function(
        "store",
        `"use strict";return (async()=>{ ${msg.body} })()`,
      )(store);
      reply(true, val === undefined ? undefined : toPlain(val));
    } else if (msg.cmd === "expr") {
      // 纯表达式，直接作为返回值
      // eslint-disable-next-line no-new-func
      const val = await new Function(
        "store",
        `"use strict";return (${msg.body});`,
      )(store);
      reply(true, toPlain(val));
    } else if (msg.cmd === "dump") {
      reply(true, storage._dump());
    }
  } catch (e) {
    reply(false, (e as Error).message);
  }
});

parentPort!.postMessage({ id: "started", ok: true, val: true });

// localStorage 持久化：草稿、冲突草稿、待发队列 —— 关掉再打开接着处理
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const K = {
  online: "gas-shift:online",
  cache: "gas-shift:state-cache",
  drafts: "gas-shift:shift-drafts",
  conflicts: "gas-shift:conflict-drafts",
  queue: "gas-shift:op-queue",
} as const;

export const storage = { read, write };

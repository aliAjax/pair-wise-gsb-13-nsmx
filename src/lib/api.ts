import type { ServerState, Shift } from "@shared/types";

export class ApiConflict extends Error {
  serverShift: Shift;
  serverVersion: number;
  constructor(shift: Shift) {
    super("VERSION_CONFLICT");
    this.name = "ApiConflict";
    this.serverShift = shift;
    this.serverVersion = shift.version;
  }
}

/** 业务错误（4xx，非冲突）：不可重试，不应进入离线队列 */
export class ApiReject extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiReject";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, payload?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`网络不可达：${(e as Error).message}`); // 网络层失败 → 可入队重试
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) throw new ApiConflict((body as { serverShift: Shift }).serverShift);
  if (!res.ok) throw new ApiReject(res.status, (body as { message?: string }).message || `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  state: () => request<ServerState>("GET", "/api/state"),
  reset: () => request<ServerState>("POST", "/api/state/reset"),
  createShift: (p: unknown) => request<ServerState>("POST", "/api/shifts", p),
  commit: (shiftId: string, p: unknown) =>
    request<ServerState>("PUT", `/api/shifts/${encodeURIComponent(shiftId)}/commit`, p),
  confirm: (shiftId: string, p: unknown) =>
    request<ServerState>("POST", `/api/shifts/${encodeURIComponent(shiftId)}/confirm`, p),
  crossRefund: (shiftId: string, p: unknown) =>
    request<ServerState>("POST", `/api/shifts/${encodeURIComponent(shiftId)}/corrections/cross-shift-refund`, p),
  pumpAdjust: (shiftId: string, p: unknown) =>
    request<ServerState>("POST", `/api/shifts/${encodeURIComponent(shiftId)}/corrections/pump-adjust`, p),
  receipts: (p: unknown) =>
    request<ServerState & { merged: number; duplicates: number; mismatchKeys: string[] }>(
      "POST",
      "/api/receipts",
      p,
    ),
  linkReceipt: (p: unknown) => request<ServerState>("POST", "/api/receipts/link", p),
};

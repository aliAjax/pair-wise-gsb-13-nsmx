// 终端身份：模拟 POS 终端号（T01/T02），用于幂等键和操作留痕
const KEY = "gas-shift:terminal";

export function getTerminalNo(): string {
  let t = localStorage.getItem(KEY);
  if (!t) {
    t = "T01";
    localStorage.setItem(KEY, t);
  }
  return t;
}

export function setTerminalNo(t: string): void {
  localStorage.setItem(KEY, t);
}

export function localId(terminalNo: string, kind: string): string {
  const seq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${terminalNo}-${kind}-${seq}`;
}

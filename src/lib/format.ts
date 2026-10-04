export function yuan(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  return `¥${v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function liters(n: number | undefined | null): string {
  return `${Number(n ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} L`;
}

export function time(iso?: string): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}

export function signedYuan(n: number): string {
  const v = Number(n ?? 0);
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}¥${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export { formatDuration, truncate } from '../../../shared/text.ts';

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

export function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  const dt = new Date(ts);
  const now = new Date();
  const md = `${dt.getMonth() + 1}月${dt.getDate()}日`;
  return dt.getFullYear() === now.getFullYear() ? md : `${dt.getFullYear()}年${md}`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch { return fallback; }
}

export function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式等 */ }
}

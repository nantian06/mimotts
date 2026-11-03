import crypto from 'node:crypto';

/** 按时间排序的短 ID：时间戳(36进制) + 随机串 */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 6).toLowerCase();
  return `${prefix}${t}${r}`;
}

export function isSafeId(id: string): boolean {
  return /^[a-z0-9-]{4,64}$/i.test(id);
}

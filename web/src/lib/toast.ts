import { useSyncExternalStore } from 'react';

export interface Toast { id: number; kind: 'ok' | 'err' | 'info'; text: string }

let list: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function toast(text: string, kind: Toast['kind'] = 'ok', ms = kind === 'err' ? 6000 : 2600) {
  const t = { id: ++seq, kind, text };
  list = [...list, t].slice(-4);
  emit();
  setTimeout(() => { list = list.filter((x) => x.id !== t.id); emit(); }, ms);
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'err');
}

export function useToasts(): Toast[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => list);
}

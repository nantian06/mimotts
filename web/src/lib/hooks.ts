import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicSettings, SystemStatus, VoiceSummary } from '../../../shared/types.ts';
import { useApi } from './store.ts';

export type VoiceItem = VoiceSummary & { refCount: number };

export function useSettings() {
  return useApi<PublicSettings>('/api/settings');
}

export function useStatus() {
  return useApi<SystemStatus>('/api/status');
}

export function useVoices(trash = false) {
  return useApi<VoiceItem[]>(trash ? '/api/voices?trash=1' : '/api/voices');
}

export function useVoiceMap(): Map<string, VoiceItem> {
  const { data } = useVoices();
  const { data: trash } = useVoices(true);
  return useMemo(() => {
    const m = new Map<string, VoiceItem>();
    for (const v of [...(data ?? []), ...(trash ?? [])]) m.set(v.id, v);
    return m;
  }, [data, trash]);
}

/** 防抖值 */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** 秒表（显示等待时长） */
export function useElapsed(since: number | undefined, active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return since ? Math.max(0, now - since) : 0;
}

/** 文本框本地草稿：外部值变化时只在没聚焦/没改动时同步 */
export function useDraft(value: string, save: (v: string) => void, delay = 700) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const dirty = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (!dirty.current && !focused.current) { latest.current = value; setDraft(value); } }, [value]);
  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // 用 ref 里的最新值：onChange 后同步调用 flush 时，state 还没更新
    if (dirty.current) { dirty.current = false; save(latest.current); }
  };
  const change = (v: string) => {
    setDraft(v);
    latest.current = v;
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; if (dirty.current) { dirty.current = false; save(v); } }, delay);
  };
  return {
    value: draft,
    onChange: change,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; flush(); },
    flush,
  };
}

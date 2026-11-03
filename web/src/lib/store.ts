// 轻量数据缓存：useApi(url) 订阅接口数据；服务端 SSE 推送变更时自动刷新
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ChangeEvent, JobInfo } from '../../../shared/types.ts';
import { get } from './api.ts';

interface Entry {
  data?: unknown;
  error?: Error;
  loading: boolean;
  stale: boolean;
  promise?: Promise<void>;
  subs: Set<() => void>;
  version: number;
}

const cache = new Map<string, Entry>();

function entry(url: string): Entry {
  let e = cache.get(url);
  if (!e) { e = { loading: false, stale: true, subs: new Set(), version: 0 }; cache.set(url, e); }
  return e;
}

function notify(e: Entry) { e.version++; for (const s of e.subs) s(); }

export function fetchInto(url: string): Promise<void> {
  const e = entry(url);
  if (e.promise) return e.promise;
  e.loading = true;
  notify(e);
  e.promise = get(url).then(
    (d) => { e.data = d; e.error = undefined; e.stale = false; },
    (err) => { e.error = err; e.stale = false; },
  ).finally(() => { e.loading = false; e.promise = undefined; notify(e); });
  return e.promise;
}

const EMPTY = { data: undefined, error: undefined, loading: false, version: -1 };

export function useApi<T>(url: string | null): { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => Promise<void> } {
  const subscribe = useCallback((cb: () => void) => {
    if (!url) return () => undefined;
    const e = entry(url);
    e.subs.add(cb);
    return () => e.subs.delete(cb);
  }, [url]);
  const snap = useSyncExternalStore(subscribe, () => (url ? entry(url).version : -1));
  useEffect(() => {
    if (!url) return;
    const e = entry(url);
    if ((e.stale || e.data === undefined) && !e.promise && !e.error) fetchInto(url);
  }, [url, snap]);
  const reload = useCallback(() => (url ? fetchInto(url) : Promise.resolve()), [url]);
  if (!url) return { ...EMPTY, reload } as any;
  const e = entry(url);
  return { data: e.data as T | undefined, error: e.error, loading: e.loading, reload };
}

export function setCache<T>(url: string, data: T) {
  const e = entry(url);
  e.data = data;
  e.error = undefined;
  e.stale = false;
  notify(e);
}

export function peekCache<T>(url: string): T | undefined {
  return cache.get(url)?.data as T | undefined;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** 让匹配的缓存失效：正在被使用的立即重新请求（合并 120ms 内的连续变更） */
export function invalidate(pred: string | ((url: string) => boolean)) {
  const match = typeof pred === 'string' ? (u: string) => u === pred || u.startsWith(pred + '?') || u.startsWith(pred + '/') : pred;
  for (const [url, e] of cache) {
    if (!match(url)) continue;
    e.stale = true;
    e.error = undefined;
    if (!e.subs.size) continue;
    clearTimeout(pending.get(url));
    pending.set(url, setTimeout(() => { pending.delete(url); fetchInto(url); }, 120));
  }
}

// ───────────────────────── 任务 ─────────────────────────

const jobs = new Map<string, JobInfo>();
const jobSubs = new Set<() => void>();
let jobVersion = 0;
const waiters = new Map<string, ((j: JobInfo) => void)[]>();
const TERMINAL = new Set(['done', 'failed', 'canceled']);

function setJob(j: JobInfo) {
  jobs.set(j.id, j);
  jobVersion++;
  for (const s of jobSubs) s();
  if (TERMINAL.has(j.status)) {
    const ws = waiters.get(j.id);
    if (ws) { waiters.delete(j.id); ws.forEach((w) => w(j)); }
  }
}

export function upsertJob(j: JobInfo) { setJob(j); }

export function useJobs(filter?: (j: JobInfo) => boolean): JobInfo[] {
  useSyncExternalStore((cb) => { jobSubs.add(cb); return () => jobSubs.delete(cb); }, () => jobVersion);
  const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  return filter ? list.filter(filter) : list;
}

export function waitForJob(id: string): Promise<JobInfo> {
  const j = jobs.get(id);
  if (j && TERMINAL.has(j.status)) return Promise.resolve(j);
  return new Promise((resolve) => {
    const ws = waiters.get(id) ?? [];
    ws.push(resolve);
    waiters.set(id, ws);
  });
}

export function isActiveJob(j: JobInfo) { return !TERMINAL.has(j.status); }

// ───────────────────────── SSE ─────────────────────────

type ChangeListener = (ev: ChangeEvent) => void;
const changeListeners = new Set<ChangeListener>();
export function onChange(fn: ChangeListener) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

function applyChange(ev: ChangeEvent) {
  switch (ev.topic) {
    case 'voices': invalidate((u) => u.startsWith('/api/voices')); break;
    case 'project':
      if (ev.id) invalidate((u) => u.startsWith(`/api/projects/${ev.id}`));
      invalidate((u) => u === '/api/projects' || u.startsWith('/api/projects?'));
      break;
    case 'projects': invalidate((u) => u === '/api/projects' || u.startsWith('/api/projects?')); break;
    case 'quick': invalidate((u) => u.startsWith('/api/quick')); break;
    case 'settings': invalidate((u) => u.startsWith('/api/settings') || u.startsWith('/api/status')); break;
    case 'prompts': invalidate('/api/prompts'); break;
  }
  changeListeners.forEach((l) => l(ev));
}

let es: EventSource | null = null;
export function connectEvents() {
  if (es) return;
  const open = () => {
    es = new EventSource('/api/events');
    es.addEventListener('job', (e) => setJob(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('change', (e) => applyChange(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => {
      get<JobInfo[]>('/api/jobs').then((list) => list.forEach(setJob)).catch(() => undefined);
      invalidate(() => true);
    };
    es.onerror = () => {
      if (es?.readyState === EventSource.CLOSED) { es = null; setTimeout(open, 3000); }
    };
  };
  open();
}

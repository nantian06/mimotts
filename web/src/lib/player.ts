// 全局播放器：一个 <audio>，支持单条播放与按剧本顺序连播（段间停顿）；附带电平表
import { useSyncExternalStore } from 'react';

export interface PlayItem {
  id: string;
  url: string;
  title: string;
  subtitle?: string;
  peaks?: number[];
  durationMs?: number;
  /** 连播时这一条之后的停顿 */
  pauseAfterMs?: number;
}

interface State {
  item: PlayItem | null;
  playing: boolean;
  /** 正在实时流式播放（不走 <audio>） */
  live: { title: string; subtitle?: string } | null;
  sequence: { items: PlayItem[]; index: number; tag: string } | null;
}

let state: State = { item: null, playing: false, live: null, sequence: null };
const subs = new Set<() => void>();
function set(p: Partial<State>) { state = { ...state, ...p }; subs.forEach((s) => s()); }

export function usePlayer(): State {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => state);
}

export const audio = typeof Audio !== 'undefined' ? new Audio() : (null as unknown as HTMLAudioElement);
let gapTimer: ReturnType<typeof setTimeout> | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let liveAnalyser: AnalyserNode | null = null;

if (audio) {
  audio.preload = 'auto';
  audio.addEventListener('play', () => set({ playing: true }));
  audio.addEventListener('pause', () => set({ playing: false }));
  audio.addEventListener('ended', () => {
    set({ playing: false });
    const seq = state.sequence;
    if (seq && seq.index < seq.items.length - 1) {
      const gap = seq.items[seq.index].pauseAfterMs ?? 0;
      gapTimer = setTimeout(() => {
        const next = { ...seq, index: seq.index + 1 };
        set({ sequence: next });
        start(next.items[next.index]);
      }, gap);
    } else if (seq) set({ sequence: null });
  });
}

function ensureGraph() {
  if (ctx || !audio) return;
  try {
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    analyser.connect(ctx.destination);
  } catch { /* 电平表不可用不影响播放 */ }
}

function start(item: PlayItem) {
  ensureGraph();
  ctx?.resume().catch(() => undefined);
  if (audio.src !== new URL(item.url, location.href).href) audio.src = item.url;
  else audio.currentTime = 0;
  set({ item, live: null });
  audio.play().catch(() => set({ playing: false }));
}

export function play(item: PlayItem) {
  if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  set({ sequence: null });
  start(item);
}

export function toggle(item: PlayItem) {
  if (state.item?.id === item.id && !state.sequence) {
    if (audio.paused) { ensureGraph(); ctx?.resume(); audio.play().catch(() => undefined); } else audio.pause();
  } else play(item);
}

export function pause() {
  if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  audio?.pause();
}

export function resume() {
  if (state.item) { ensureGraph(); ctx?.resume(); audio.play().catch(() => undefined); }
}

export function stop() {
  pause();
  set({ sequence: null, playing: false });
}

export function seek(ratio: number) {
  if (!audio.duration || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
}

export function playSequence(items: PlayItem[], startIndex: number, tag: string) {
  if (!items.length) return;
  if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  const seq = { items, index: Math.max(0, Math.min(items.length - 1, startIndex)), tag };
  set({ sequence: seq });
  start(seq.items[seq.index]);
}

export function setLive(info: State['live'], node?: AnalyserNode | null) {
  liveAnalyser = node ?? null;
  if (info) audio?.pause();
  set({ live: info });
}

export function progress(): { time: number; duration: number } {
  return { time: audio?.currentTime ?? 0, duration: isFinite(audio?.duration) ? audio.duration : 0 };
}

const buf = new Float32Array(1024);
/** 当前电平 0..1（RMS，对数映射） */
export function level(): number {
  const a = state.live ? liveAnalyser : state.playing ? analyser : null;
  if (!a) return 0;
  a.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const db = 10 * Math.log10(s / buf.length + 1e-10);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

export function isCurrent(id: string): boolean {
  return state.item?.id === id;
}

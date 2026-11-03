// 波形：缩略播放器（走全局播放器）与可拖选区间的波形编辑器（克隆参考音频截取）
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { audio, play, progress, seek, toggle, usePlayer, type PlayItem } from '../lib/player.ts';
import { formatDuration } from '../lib/format.ts';
import { Icon } from './icons.tsx';
import type { Region } from '../../../shared/types.ts';

export function Bars({ peaks, className = '' }: { peaks: number[]; className?: string }) {
  const n = peaks.length || 1;
  const max = Math.max(0.05, ...peaks);
  return (
    <svg className={`bars ${className}`} viewBox={`0 0 ${n} 40`} preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((p, i) => {
        const h = Math.max(1.2, (p / max) * 38);
        return <rect key={i} x={i + 0.18} width={0.64} y={20 - h / 2} height={h} rx={0.3} />;
      })}
    </svg>
  );
}

export function WavePlayer({ item, size = 'md', showTime = true }: { item: PlayItem; size?: 'sm' | 'md' | 'lg'; showTime?: boolean }) {
  const st = usePlayer();
  const current = st.item?.id === item.id;
  const playing = current && st.playing;
  const overlay = useRef<HTMLDivElement>(null);
  const timeEl = useRef<HTMLSpanElement>(null);
  const total = item.durationMs ?? 0;

  useEffect(() => {
    if (!current) {
      if (overlay.current) overlay.current.style.width = '0%';
      if (timeEl.current) timeEl.current.textContent = formatDuration(total);
      return;
    }
    let raf = 0;
    const tick = () => {
      const { time, duration } = progress();
      const d = duration || total / 1000;
      if (overlay.current) overlay.current.style.width = `${d ? Math.min(100, (time / d) * 100) : 0}%`;
      if (timeEl.current) timeEl.current.textContent = `${formatDuration(time * 1000)} / ${formatDuration(d * 1000)}`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [current, total]);

  const onWave = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    if (current) { seek(ratio); if (!st.playing) audio.play().catch(() => undefined); return; }
    play(item);
    const once = () => { seek(ratio); audio.removeEventListener('loadedmetadata', once); };
    audio.addEventListener('loadedmetadata', once);
  };

  return (
    <div className={`wave-player wave-${size} ${current ? 'is-current' : ''}`}>
      <button type="button" className={`wave-play ${playing ? 'is-playing' : ''}`} aria-label={playing ? '暂停' : '播放'} onClick={() => toggle(item)}>
        <Icon name={playing ? 'pause' : 'play'} size={size === 'sm' ? 13 : 15} />
      </button>
      <div className="wave-track" onPointerDown={onWave} role="slider" aria-label="播放进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} tabIndex={-1}>
        <Bars peaks={item.peaks ?? []} />
        <div className="wave-played" ref={overlay}><Bars peaks={item.peaks ?? []} /></div>
      </div>
      {showTime && <span className="wave-time" ref={timeEl}>{formatDuration(total)}</span>}
    </div>
  );
}

// ───────────────────────── 区间编辑器 ─────────────────────────

function tickStep(duration: number, width: number): number {
  const target = duration / Math.max(1, width / 90);
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= target) return s;
  return 600;
}

const fmtT = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
};

export function RegionEditor({ url, peaks, duration, region, onChange, suggestion }: {
  url: string;
  peaks: number[];
  duration: number;
  region: Region | null;
  onChange: (r: Region | null) => void;
  suggestion?: Region | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [playing, setPlaying] = useState(false);
  const local = useMemo(() => new Audio(), []);
  const drag = useRef<{ mode: 'start' | 'end' | 'new' | 'move'; anchor: number; x0: number; prev: Region | null; moved: boolean } | null>(null);
  const r = region ?? { start: 0, end: duration };

  useEffect(() => { local.src = url; local.preload = 'auto'; return () => { local.pause(); }; }, [url]);
  useEffect(() => {
    const on = () => setPlaying(!local.paused);
    local.addEventListener('play', on);
    local.addEventListener('pause', on);
    local.addEventListener('ended', on);
    return () => { local.removeEventListener('play', on); local.removeEventListener('pause', on); local.removeEventListener('ended', on); };
  }, []);

  useLayoutEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 120;
    c.width = width * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, h);
    const ink = getComputedStyle(c).getPropertyValue('--wave-ink').trim() || '#18233d';
    const max = Math.max(0.05, ...peaks);
    const cols = Math.min(width, peaks.length);
    for (let x = 0; x < cols; x++) {
      const a = Math.floor((x / cols) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((x + 1) / cols) * peaks.length));
      let m = 0;
      for (let i = a; i < b; i++) m = Math.max(m, peaks[i]);
      const bh = Math.max(1, (m / max) * (h - 8));
      g.fillStyle = ink;
      g.fillRect((x / cols) * width, (h - bh) / 2, Math.max(1, width / cols - 0.6), bh);
    }
  }, [peaks, width]);

  // 播放头 + 选区播放到终点自动停
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (head.current) head.current.style.left = `${(local.currentTime / (duration || 1)) * 100}%`;
      if (!local.paused && region && local.currentTime >= region.end) local.pause();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [duration, region]);

  const tAt = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const t = tAt(e.clientX);
    const mode = target.dataset.handle === 'start' ? 'start' : target.dataset.handle === 'end' ? 'end' : target.dataset.handle === 'body' ? 'move' : 'new';
    drag.current = { mode, anchor: t, x0: e.clientX, prev: region, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    const t = tAt(e.clientX);
    const cur = d.prev ?? { start: 0, end: duration };
    const minLen = Math.min(0.3, duration);
    if (d.mode === 'start') onChange({ start: Math.min(t, cur.end - minLen), end: cur.end });
    else if (d.mode === 'end') onChange({ start: cur.start, end: Math.max(t, cur.start + minLen) });
    else if (d.mode === 'move') {
      const len = cur.end - cur.start;
      const s = Math.max(0, Math.min(duration - len, cur.start + (t - d.anchor)));
      onChange({ start: s, end: s + len });
    } else onChange({ start: Math.min(d.anchor, t), end: Math.max(d.anchor, t) });
  };
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // 单击：从这里开始播放
      local.currentTime = tAt(e.clientX);
      local.play().catch(() => undefined);
    } else if (region && region.end - region.start < 0.3) onChange(d.prev);
  };

  const nudge = (which: 'start' | 'end', delta: number) => {
    const cur = region ?? { start: 0, end: duration };
    if (which === 'start') onChange({ start: Math.max(0, Math.min(cur.end - 0.3, cur.start + delta)), end: cur.end });
    else onChange({ start: cur.start, end: Math.min(duration, Math.max(cur.start + 0.3, cur.end + delta)) });
  };

  const playRegion = () => {
    if (playing) { local.pause(); return; }
    local.currentTime = r.start;
    local.play().catch(() => undefined);
  };

  const step = tickStep(duration, width);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t);

  return (
    <div className="region-editor">
      <div className="region-stage" ref={wrap} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
        <canvas ref={canvas} style={{ width: '100%', height: 120 }} />
        <div className="region-dim" style={{ left: 0, width: `${(r.start / duration) * 100}%` }} />
        <div className="region-dim" style={{ left: `${(r.end / duration) * 100}%`, right: 0 }} />
        <div className="region-sel" data-handle="body" style={{ left: `${(r.start / duration) * 100}%`, width: `${((r.end - r.start) / duration) * 100}%` }}>
          <span className="region-handle is-start" data-handle="start" role="slider" tabIndex={0} aria-label="起点" aria-valuenow={r.start}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft') nudge('start', -0.1); if (e.key === 'ArrowRight') nudge('start', 0.1); }} />
          <span className="region-handle is-end" data-handle="end" role="slider" tabIndex={0} aria-label="终点" aria-valuenow={r.end}
            onKeyDown={(e) => { if (e.key === 'ArrowLeft') nudge('end', -0.1); if (e.key === 'ArrowRight') nudge('end', 0.1); }} />
        </div>
        <div className="region-head" ref={head} />
      </div>
      <div className="region-ruler">
        {ticks.map((t) => <span key={t} style={{ left: `${(t / duration) * 100}%` }}>{fmtT(t)}</span>)}
      </div>
      <div className="region-bar">
        <button type="button" className="btn btn-plain btn-sm" onClick={playRegion}>
          <Icon name={playing ? 'pause' : 'play'} size={14} />{playing ? '暂停' : region ? '播放选区' : '播放'}
        </button>
        <span className="region-info">
          {region ? <>选区 {fmtT(r.start)} – {fmtT(r.end)}，共 <b>{(r.end - r.start).toFixed(1)}</b> 秒</> : <>全部 <b>{duration.toFixed(1)}</b> 秒 · 在波形上拖动可以截取一段</>}
        </span>
        <span className="spacer" />
        {suggestion && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(suggestion)} title="选出语音最密集、没有破音的一段">
            <Icon name="sparkle" size={14} />自动选取 {(suggestion.end - suggestion.start).toFixed(0)} 秒
          </button>
        )}
        {region && <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(null)}>用全部</button>}
      </div>
    </div>
  );
}

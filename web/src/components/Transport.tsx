// 底部走带条：当前播放、进度、电平表、任务队列
import { useEffect, useRef, useState } from 'react';
import { audio, level, pause, progress, resume, seek, stop, usePlayer } from '../lib/player.ts';
import { isActiveJob, useJobs } from '../lib/store.ts';
import { del, post } from '../lib/api.ts';
import { formatDuration } from '../lib/format.ts';
import { Bars } from './Wave.tsx';
import { Icon } from './icons.tsx';
import { IconButton } from './ui.tsx';

const STATUS: Record<string, string> = { queued: '排队中', running: '生成中', retrying: '重试中', done: '完成', failed: '失败', canceled: '已取消' };

export function Transport() {
  const st = usePlayer();
  const jobs = useJobs();
  const active = jobs.filter(isActiveJob);
  const [open, setOpen] = useState(false);
  const meter = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const l = level();
      if (meter.current) meter.current.style.transform = `scaleX(${l})`;
      const { time: t, duration } = progress();
      if (bar.current) bar.current.style.width = `${duration ? (t / duration) * 100 : 0}%`;
      if (time.current) time.current.textContent = st.item ? `${formatDuration(t * 1000)} / ${formatDuration((duration || (st.item.durationMs ?? 0) / 1000) * 1000)}` : '';
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [st.item]);

  const title = st.live ? st.live.title : st.item?.title ?? '没有在播放';
  const sub = st.live ? st.live.subtitle : st.sequence ? `连播 ${st.sequence.index + 1}/${st.sequence.items.length}` : st.item?.subtitle;

  return (
    <footer className={`transport ${st.live ? 'is-live' : ''}`}>
      <div className="transport-play">
        <IconButton icon={st.playing ? 'pause' : 'play'} label={st.playing ? '暂停' : '播放'} disabled={!st.item || !!st.live} onClick={() => (st.playing ? pause() : resume())} />
        {(st.sequence || st.live) && <IconButton icon="stop" label="停止" onClick={() => stop()} />}
      </div>
      <div className="transport-info">
        <span className="transport-title">{st.live && <span className="tally" aria-hidden="true" />}{title}</span>
        <span className="transport-sub">{st.live ? '实时生成并播放' : sub}</span>
      </div>
      <div className="transport-track" onPointerDown={(e) => {
        if (!st.item || st.live) return;
        const r = e.currentTarget.getBoundingClientRect();
        seek((e.clientX - r.left) / r.width);
        if (audio.paused) resume();
      }}>
        {st.item && !st.live && <><Bars peaks={st.item.peaks ?? []} /><div className="transport-played" ref={bar}><Bars peaks={st.item.peaks ?? []} /></div></>}
      </div>
      <span className="transport-time" ref={time} />
      <span className="meter" aria-hidden="true"><span ref={meter} /></span>
      <div className="transport-jobs">
        <button type="button" className={`jobs-btn ${active.length ? 'is-busy' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Icon name="queue" size={16} />{active.length ? `${active.length} 个任务` : '任务'}
        </button>
        {open && (
          <div className="jobs-pop" role="dialog" aria-label="任务队列">
            <div className="jobs-pop-head">
              <b>任务队列</b><span className="spacer" />
              {active.length > 0 && <button type="button" className="link-btn" onClick={() => post('/api/jobs/cancel', {})}>全部取消</button>}
              <IconButton size="sm" icon="close" label="关闭" onClick={() => setOpen(false)} />
            </div>
            <ul>
              {jobs.slice(0, 40).map((j) => (
                <li key={j.id} className={`job job-${j.status}`}>
                  <span className="job-label">{j.label}</span>
                  <span className="job-status">
                    {STATUS[j.status]}{j.progress && j.progress.total > 1 && isActiveJob(j) ? ` ${Math.min(j.progress.done + 1, j.progress.total)}/${j.progress.total}` : ''}
                    {j.status === 'retrying' && j.attempt ? `（第 ${j.attempt} 次）` : ''}
                  </span>
                  {j.error && j.status !== 'done' && <span className="job-error">{j.error}</span>}
                  {isActiveJob(j) && <IconButton size="sm" icon="close" label="取消" onClick={() => del(`/api/jobs/${j.id}`)} />}
                </li>
              ))}
              {!jobs.length && <li className="muted">还没有任务</li>}
            </ul>
          </div>
        )}
      </div>
    </footer>
  );
}

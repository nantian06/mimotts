// 快速合成：选音色 → 写指令和文本 → 生成（预置音色可流式边生成边播放）；右侧历史记录
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobInfo, QuickResult, UploadInfo, VoiceSelector } from '../../../shared/types.ts';
import { ApiError, del, downloadFile, patch, post } from '../lib/api.ts';
import { fetchInto, peekCache, upsertJob, useApi, useJobs, waitForJob } from '../lib/store.ts';
import { useElapsed, useSettings, useStatus, useVoices } from '../lib/hooks.ts';
import { ago, lsGet, lsSet, seconds, truncate } from '../lib/format.ts';
import { play, setLive } from '../lib/player.ts';
import { StreamPlayer } from '../lib/stream.ts';
import { toast, toastError } from '../lib/toast.ts';
import { navigate } from '../lib/router.ts';
import { Button, Empty, IconButton, KindBadge, Menu, Notice, Progress, Toggle, useConfirm } from '../components/ui.tsx';
import { VoiceSlot } from '../components/VoicePicker.tsx';
import { InstructionEditor, TextEditor } from '../components/Editors.tsx';
import { WavePlayer } from '../components/Wave.tsx';
import { CloneEditor, uploadFrom } from '../components/CloneEditor.tsx';
import { NamePrompt, SendToProject } from '../components/Dialogs.tsx';
import { Icon } from '../components/icons.tsx';

type QuickItem = QuickResult & { url: string };
const HISTORY = '/api/quick?limit=100';
const MODEL_LABEL: Record<string, string> = { 'mimo-v2.5-tts': '预置模型', 'mimo-v2.5-tts-voicedesign': '音色设计模型', 'mimo-v2.5-tts-voiceclone': '音色克隆模型' };

interface Draft {
  voice: VoiceSelector | null;
  instruction: string;
  text: string;
  useDefaultInstruction: boolean;
  optimizeTextPreview: boolean;
}

const EMPTY_DRAFT: Draft = { voice: { type: 'library', id: 'builtin-default' }, instruction: '', text: '', useDefaultInstruction: true, optimizeTextPreview: false };

interface Running {
  kind: 'job' | 'stream';
  jobId?: string;
  startedAt: number;
  note?: string;
  progress?: { done: number; total: number };
  abort?: () => void;
}

function playItem(r: QuickItem) {
  play({ id: `q-${r.id}`, url: r.url, title: r.voice.name, subtitle: truncate(r.text, 40), peaks: r.peaks, durationMs: r.durationMs });
}

export function QuickPage() {
  const [draft, setDraftState] = useState<Draft>(() => ({ ...EMPTY_DRAFT, ...lsGet<Partial<Draft>>('mt.quick.draft', {}) }));
  const setDraft = (p: Partial<Draft>) => setDraftState((d) => { const n = { ...d, ...p }; lsSet('mt.quick.draft', n); return n; });
  const { data: voices } = useVoices();
  const { data: settings } = useSettings();
  const [running, setRunning] = useState<Running | null>(null);
  const [error, setError] = useState('');
  const elapsed = useElapsed(running?.startedAt, !!running);
  const job = useJobs((j) => j.id === running?.jobId)[0];

  const v = draft.voice?.type === 'library' ? voices?.find((x) => x.id === (draft.voice as { id: string }).id) : undefined;
  const mode = draft.voice?.type === 'adhoc-design' ? 'design' : v?.mode;
  const designLocked = mode === 'design';
  const canStream = mode === 'preset' && !!settings?.mimo.streamPreset;
  const textEmpty = !draft.text.trim();
  const canGenerate = !!draft.voice && (!!v || draft.voice?.type === 'adhoc-design') && !running && (!textEmpty || (designLocked && draft.optimizeTextPreview));

  // 同步的忙碌标记：提交请求返回之前 running 还没更新，防止连点或连按快捷键重复提交付费请求
  const busy = useRef(false);
  const generate = async () => {
    if (!draft.voice || busy.current) return;
    busy.current = true;
    try { await submit(draft.voice); } finally { busy.current = false; }
  };

  const submit = async (voice: VoiceSelector) => {
    setError('');
    const body = {
      voice,
      text: draft.text,
      instruction: designLocked ? '' : draft.instruction,
      useDefaultInstruction: draft.useDefaultInstruction,
      optimizeTextPreview: designLocked ? draft.optimizeTextPreview : undefined,
    };
    if (canStream) return stream(body);
    setRunning({ kind: 'job', startedAt: Date.now() });
    try {
      const { job } = await post<{ job: JobInfo }>('/api/synth', body);
      upsertJob(job);
      setRunning((r) => r && { ...r, jobId: job.id });
      const done = await waitForJob(job.id);
      if (done.status === 'done') {
        const id = (done.result as { resultId?: string } | undefined)?.resultId;
        await fetchInto(HISTORY);
        const r = peekCache<QuickItem[]>(HISTORY)?.find((x) => x.id === id);
        // 页面已经离开就不自动播放，免得打断剧本连播等别处的播放；结果照样进历史
        if (r && mounted.current) playItem(r);
      } else if (done.status === 'failed') setError(done.error ?? '合成失败');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRunning(null); }
  };

  const stream = async (body: unknown) => {
    const ctrl = new AbortController();
    streamCtrl.current = ctrl;
    let player: StreamPlayer | null = null;
    // 播放别的音频或按走带条的停止时：停掉实时播放，但继续接收，生成完照样存进历史
    let interrupted = false;
    let wakeWait: (() => void) | null = null;
    const interrupt = () => { interrupted = true; player?.stop(); wakeWait?.(); };
    const title = v?.name ?? '流式合成';
    setRunning({ kind: 'stream', startedAt: Date.now(), abort: () => ctrl.abort() });
    let finished: QuickItem | null = null;
    try {
      const res = await fetch('/api/synth/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, credentials: 'same-origin' });
      if (!res.ok || !res.body) {
        const t = await res.text();
        let msg = `请求失败（${res.status}）`;
        try { msg = JSON.parse(t).error ?? msg; } catch { /* 非 JSON */ }
        throw new ApiError(msg, res.status);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'start') {
            player = new StreamPlayer(ev.sampleRate);
            setLive({ title, subtitle: truncate(draft.text, 40) }, player.analyser, interrupt);
          } else if (ev.type === 'audio') { if (!interrupted) player?.push(ev.data); }
          else if (ev.type === 'progress') setRunning((r) => r && { ...r, progress: { done: ev.done, total: ev.total }, note: undefined });
          else if (ev.type === 'retry') setRunning((r) => r && { ...r, note: `第 ${ev.chunk + 1} 段重试（第 ${ev.attempt} 次）：${ev.message}` });
          else if (ev.type === 'done') finished = ev.result;
          else if (ev.type === 'error') throw new Error(ev.message);
        }
      }
      // 等剩下的音频播完
      const left = interrupted ? 0 : player?.remaining() ?? 0;
      if (left > 0 && !ctrl.signal.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, left * 1000 + 100);
          function done() { clearTimeout(t); wakeWait = null; ctrl.signal.removeEventListener('abort', done); resolve(); }
          wakeWait = done;
          ctrl.signal.addEventListener('abort', done);
        });
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message ?? String(e));
    } finally {
      if (!interrupted) { player?.stop(); setLive(null); }
      setRunning(null);
      fetchInto(HISTORY);
    }
    if (finished && !ctrl.signal.aborted) toast(`已生成 ${seconds((finished as QuickItem).durationMs)}`);
  };

  const cancel = () => {
    if (!running) return;
    if (running.abort) running.abort();
    else if (running.jobId) del(`/api/jobs/${running.jobId}`).catch(toastError);
  };

  // Ctrl/⌘ + Enter 生成
  // 离开页面时中止流式合成并停止播放（取消按钮只在这个页面里）
  const streamCtrl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; streamCtrl.current?.abort(); };
  }, []);

  const genRef = useRef<() => void>(() => undefined);
  genRef.current = () => { if (canGenerate) generate(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !document.body.classList.contains('has-modal')) { e.preventDefault(); genRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reuse = (r: QuickItem) => {
    const voice: VoiceSelector = r.voice.type === 'adhoc-design' ? { type: 'adhoc-design', description: r.voice.description ?? '' } : { type: 'library', id: r.voice.id ?? '' };
    // 历史里存的是实际生效的指令（已含当时继承的默认指令），所以关闭继承，空指令保持为空
    setDraft({ voice, text: r.text, instruction: r.instruction, useDefaultInstruction: false });
    toast('已填入这条的音色、指令和文本', 'info');
  };

  const statusText = running
    ? running.kind === 'stream'
      ? running.progress && running.progress.total > 1 ? `边生成边播放 · 第 ${Math.min(running.progress.done + 1, running.progress.total)}/${running.progress.total} 段` : '边生成边播放'
      : job?.status === 'queued' ? '排队中' : job?.status === 'retrying' ? `重试中（第 ${job.attempt} 次）` : job?.progress && job.progress.total > 1 ? `生成中 · 第 ${Math.min(job.progress.done + 1, job.progress.total)}/${job.progress.total} 段` : '生成中'
    : '';
  const prog = running?.kind === 'stream' ? running.progress : job?.progress;

  return (
    <div className="page quick-page">
      <section className="quick-compose" aria-label="合成">
        <header className="page-head">
          <h1>快速合成</h1>
          <span className="muted small">按 Ctrl/⌘ + Enter 生成</span>
        </header>
        <div className="card compose-card">
          <div className="compose-row">
            <span className="compose-label">音色</span>
            <VoiceSlot value={draft.voice} onChange={(voice) => setDraft({ voice })} />
          </div>
          <div className="compose-row">
            <span className="compose-label">风格指令</span>
            <div className="compose-field">
              <InstructionEditor
                value={draft.instruction}
                onChange={(instruction) => setDraft({ instruction })}
                text={draft.text}
                voiceLabel={v ? `${v.name}（${v.kind}）` : draft.voice?.type === 'adhoc-design' ? draft.voice.description : undefined}
                disabled={designLocked}
                disabledReason={draft.voice?.type === 'adhoc-design'
                  ? '临时设计音色的风格由音色描述决定，不能再叠加风格指令。想要什么语气，直接写进音色描述里。'
                  : '这个设计音色还没有固化：风格完全由音色描述决定，不能再叠加风格指令。到音色库里挑一条试听「固化」后就能用指令了。'}
                inheritHint={v?.defaultInstruction && draft.useDefaultInstruction ? `音色默认指令「${truncate(v.defaultInstruction, 60)}」` : undefined}
              />
              {!designLocked && v?.defaultInstruction && (
                <Toggle checked={draft.useDefaultInstruction} onChange={(useDefaultInstruction) => setDraft({ useDefaultInstruction })} label="指令留空时使用音色的默认指令" />
              )}
            </div>
          </div>
          <div className="compose-row">
            <span className="compose-label">文本</span>
            <div className="compose-field">
              <TextEditor value={draft.text} onChange={(text) => setDraft({ text })} mode={mode} />
              {designLocked && (
                <Toggle checked={draft.optimizeTextPreview} onChange={(optimizeTextPreview) => setDraft({ optimizeTextPreview })}
                  label="智能润色试听文本" hint="让模型按音色描述自己改写或生成一段文本来读；文本留空时必须打开" />
              )}
            </div>
          </div>
          <div className="compose-actions">
            {running ? (
              <>
                <span className={`run-state ${running.kind === 'stream' ? 'is-live' : ''}`}>
                  {running.kind === 'stream' ? <span className="tally" aria-hidden="true" /> : <Icon name="queue" size={16} />}
                  {statusText} · {(elapsed / 1000).toFixed(0)} 秒
                </span>
                {prog && prog.total > 1 && <Progress value={prog.done} max={prog.total} />}
                <span className="spacer" />
                <Button variant="ghost" icon="close" onClick={cancel}>取消</Button>
              </>
            ) : (
              <>
                <span className="muted small">
                  {mode === 'preset' ? (canStream ? '预置音色：边生成边播放' : '预置音色') : mode === 'design' ? '音色设计模型：每次生成的声音都会有些不同' : mode === 'clone' ? '音色克隆模型' : ''}
                </span>
                <span className="spacer" />
                <Button variant="primary" icon="play" disabled={!canGenerate} onClick={generate}>生成</Button>
              </>
            )}
          </div>
          {running?.note && <Notice kind="warn">{running.note}</Notice>}
          {error && <Notice kind="error" action={<IconButton size="sm" icon="close" label="关闭" onClick={() => setError('')} />}>{error}</Notice>}
        </div>
      </section>
      <History onReuse={reuse} />
    </div>
  );
}

function History({ onReuse }: { onReuse: (r: QuickItem) => void }) {
  const { data, loading } = useApi<QuickItem[]>(HISTORY);
  const { data: status } = useStatus();
  const [q, setQ] = useState('');
  const [starOnly, setStarOnly] = useState(false);
  const [clone, setClone] = useState<UploadInfo | null>(null);
  const [designFrom, setDesignFrom] = useState<QuickItem | null>(null);
  const [sendId, setSendId] = useState<string | null>(null);
  const { confirm, node } = useConfirm();
  const list = useMemo(() => (data ?? []).filter((r) => (!starOnly || r.starred) && (!q.trim() || r.text.includes(q.trim()) || r.voice.name.includes(q.trim()))), [data, q, starOnly]);
  const unstarred = (data ?? []).filter((r) => !r.starred).length;

  const clear = async () => {
    if (!(await confirm('清空历史', `删除 ${unstarred} 条未收藏的记录？收藏的会保留。`, '清空', true))) return;
    try { const r = await post<{ deleted: number }>('/api/quick/clear'); toast(`已删除 ${r.deleted} 条`); } catch (e) { toastError(e); }
  };

  return (
    <aside className="quick-history" aria-label="历史记录">
      <header className="history-head">
        <h2>历史</h2>
        <span className="spacer" />
        <label className="search search-sm"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" aria-label="搜索历史" /></label>
        <IconButton size="sm" icon="star" label="只看收藏" active={starOnly} onClick={() => setStarOnly((v) => !v)} />
        <Menu trigger={(open) => <IconButton size="sm" icon="more" label="更多" onClick={open} />} items={[
          { label: `清空未收藏（${unstarred}）`, icon: 'trash', danger: true, disabled: !unstarred, onSelect: clear },
        ]} />
      </header>
      {!data && loading && <p className="muted pad">加载中…</p>}
      {data && !list.length && <Empty icon="wave" title={data.length ? '没有匹配的记录' : '还没有合成记录'}>{!data.length && '生成的音频会出现在这里，可以下载、复用参数、存成音色或送进剧本。'}</Empty>}
      <ul className="history-list">
        {list.map((r) => (
          <li key={r.id} className={`history-item kind-edge-${r.voice.kind ?? 'design'}`}>
            <div className="history-meta">
              <span className="history-voice">{r.voice.name}</span>
              {r.voice.kind ? <KindBadge kind={r.voice.kind} mode={r.voice.mode} /> : <span className="kind-badge kind-design">临时设计</span>}
              <span className="spacer" />
              <span className="muted small" title={new Date(r.createdAt).toLocaleString('zh-CN')}>{ago(r.createdAt)}</span>
            </div>
            <p className="history-text" title={r.text}>{truncate(r.text || r.actualText || '', 120)}</p>
            {r.actualText && r.actualText !== r.text && <p className="history-ins muted small">实际朗读：{truncate(r.actualText, 80)}</p>}
            {r.instruction && <p className="history-ins muted small" title={r.instruction}><Icon name="pen" size={12} /> {truncate(r.instruction, 70)}</p>}
            {r.instructionIgnored && <p className="muted small">风格指令被忽略（未固化的设计音色不支持）</p>}
            {r.warnings.map((w) => <p key={w} className="history-warn small"><Icon name="warn" size={12} /> {w}</p>)}
            <div className="history-actions">
              <WavePlayer size="sm" item={{ id: `q-${r.id}`, url: r.url, title: r.voice.name, subtitle: truncate(r.text, 40), peaks: r.peaks, durationMs: r.durationMs }} />
              <IconButton size="sm" icon="star" label={r.starred ? '取消收藏' : '收藏'} active={r.starred} onClick={() => patch(`/api/quick/${r.id}`, { starred: !r.starred }).catch(toastError)} />
              <Menu trigger={(open) => <IconButton size="sm" icon="more" label="更多操作" onClick={open} />} items={[
                { label: '复用参数', icon: 'refresh', onSelect: () => onReuse(r) },
                { label: '下载 WAV', icon: 'download', onSelect: () => downloadFile(r.url, `${r.voice.name}-${r.id}.wav`) },
                status?.ffmpeg.mp3 ? { label: '下载 MP3', icon: 'download', onSelect: () => downloadFile(r.url, `${r.voice.name}-${r.id}.wav`, true) } : null,
                'sep',
                { label: '存为克隆音色…', icon: 'mic', onSelect: async () => { try { setClone(await uploadFrom({ type: 'quick', id: r.id })); } catch (e) { toastError(e); } } },
                r.voice.type === 'adhoc-design' ? { label: '存为设计音色…', icon: 'pen', onSelect: () => setDesignFrom(r) } : null,
                { label: '送入剧本…', icon: 'script', onSelect: () => setSendId(r.id) },
                'sep',
                { label: '删除', icon: 'trash', danger: true, onSelect: () => del(`/api/quick/${r.id}`).catch(toastError) },
              ]} />
            </div>
            <p className="history-foot muted small">{MODEL_LABEL[r.model] ?? r.model} · 用时 {seconds(r.elapsedMs)}{r.chunks.length > 1 ? ` · ${r.chunks.length} 段拼接` : ''}</p>
          </li>
        ))}
      </ul>
      {clone && <CloneEditor target={{ type: 'new' }} initialUpload={clone} onClose={() => setClone(null)} onSaved={(rec) => { setClone(null); navigate(`/voices/${rec.id}`); }} />}
      {designFrom && (
        <NamePrompt title="存为设计音色" label="音色名称" initial="新设计音色" ok="保存"
          hint="会用这条的音色描述新建一个设计音色，并把这条音频作为第一条试听。之后可以继续抽卡、挑一条固化。"
          onClose={() => setDesignFrom(null)}
          onSubmit={async (name) => {
            const rec = await post<{ id: string }>('/api/voices/from-quick', { resultId: designFrom.id, name });
            toast('已存为设计音色');
            navigate(`/voices/${rec.id}`);
          }} />
      )}
      {sendId && <SendToProject resultId={sendId} onClose={() => setSendId(null)} />}
      {node}
    </aside>
  );
}

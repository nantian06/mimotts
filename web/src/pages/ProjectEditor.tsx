// 剧本编辑器：角色面板 + 片段列表（继承关系、过期检测、版本、批量操作、连播）
import { memo, useMemo, useRef, useState, type DragEvent } from 'react';
import type { JobInfo, Project, Role, Segment, SegmentTake, UploadInfo } from '../../../shared/types.ts';
import { ROLE_COLORS } from '../../../shared/presets.ts';
import { activeTake, effectiveSegment, segmentPause, staleReasons, type EffectiveSegment } from '../../../shared/effective.ts';
import { del, downloadFile, patch, post } from '../lib/api.ts';
import { isActiveJob, upsertJob, useApi, useJobs } from '../lib/store.ts';
import { useDraft, useVoiceMap, type VoiceItem } from '../lib/hooks.ts';
import { clock, formatDuration, truncate } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { playSequence, usePlayer, type PlayItem } from '../lib/player.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Empty, IconButton, Menu, Modal, Field, Notice, Progress, Spinner, useConfirm } from '../components/ui.tsx';
import { VoiceSlot } from '../components/VoicePicker.tsx';
import { InstructionEditor } from '../components/Editors.tsx';
import { WavePlayer } from '../components/Wave.tsx';
import { CloneEditor, uploadFrom } from '../components/CloneEditor.tsx';
import { Icon } from '../components/icons.tsx';
import { BatchLlm, CastDialog, ExportDialog, ImportText, ProjectSettingsDialog } from './ProjectDialogs.tsx';

type ProjectView = Project & { filesBase: string };

const SOURCE_LABEL = { segment: '片段指令', role: '角色指令', voice: '音色默认指令', none: '' } as const;

function takeItem(p: ProjectView, s: Segment, t: SegmentTake, roleName: string): PlayItem {
  return { id: `seg-${s.id}-${t.id}`, url: p.filesBase + t.file, title: roleName || '未指定角色', subtitle: truncate(s.text, 40), peaks: t.peaks, durationMs: t.durationMs, pauseAfterMs: segmentPause(p, s) };
}

export function ProjectEditor({ id }: { id: string }) {
  const { data: p, error } = useApi<ProjectView>(`/api/projects/${id}`);
  const vmap = useVoiceMap();
  const jobs = useJobs((j) => j.projectId === id && j.kind === 'segment' && isActiveJob(j));
  const [sel, setSel] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const [dialog, setDialog] = useState<null | 'import' | 'export' | 'cast' | 'settings' | 'batch-instruction' | 'batch-tags' | { insertAfter: string | null }>(null);
  const [clone, setClone] = useState<UploadInfo | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const { confirm, node } = useConfirm();

  const effs = useMemo(() => {
    const m = new Map<string, EffectiveSegment>();
    if (p) for (const s of p.segments) m.set(s.id, effectiveSegment(p, s, vmap));
    return m;
  }, [p, vmap]);

  if (error) return <div className="page"><a className="back-link" href="#/projects"><Icon name="back" size={15} />剧本</a><Empty icon="script" title="找不到这个剧本">{error.message}</Empty></div>;
  if (!p) return <div className="page"><a className="back-link" href="#/projects"><Icon name="back" size={15} />剧本</a><p className="muted pad"><Spinner /> 加载中…</p></div>;

  const base = `/api/projects/${id}`;
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); } catch (e) { toastError(e); } };
  const roleName = (rid: string | null) => p.roles.find((r) => r.id === rid)?.name ?? '';
  const done = p.segments.filter((s) => s.activeTakeId).length;
  const stale = p.segments.filter((s) => staleReasons(s, effs.get(s.id)!).length).length;
  const totalMs = p.segments.reduce((n, s, i) => {
    const t = activeTake(s);
    return t ? n + t.durationMs + (i < p.segments.length - 1 ? segmentPause(p, s) : 0) : n;
  }, 0);
  const selIds = p.segments.filter((s) => sel.has(s.id)).map((s) => s.id);

  const generate = async (mode: 'missing' | 'stale' | 'all' | 'selected', ids?: string[]) => {
    if (mode === 'all' && !(await confirm('全部重新生成', `重新生成全部 ${p.segments.length} 段（锁定的除外）？已有版本会保留，按「每段保留版本数」清理。`, '全部重新生成'))) return;
    try {
      const r = await post<{ jobs: JobInfo[]; skipped: { id: string; reason: string }[] }>(`${base}/generate`, { mode, ids });
      r.jobs.forEach(upsertJob);
      const reasons = [...new Set(r.skipped.map((x) => x.reason))];
      if (!r.jobs.length && !r.skipped.length) toast(mode === 'missing' ? '所有片段都已生成' : mode === 'stale' ? '没有过期的片段' : '没有可生成的片段', 'info');
      else toast(`已加入 ${r.jobs.length} 段${r.skipped.length ? `，跳过 ${r.skipped.length} 段（${truncate(reasons.join('；'), 60)}）` : ''}`, r.skipped.length ? 'info' : 'ok');
    } catch (e) { toastError(e); }
  };
  const playFrom = (startId?: string) => {
    const items: PlayItem[] = [];
    let start = 0;
    for (const s of p.segments) {
      const t = activeTake(s);
      if (!t) continue;
      if (s.id === startId) start = items.length;
      items.push(takeItem(p, s, t, roleName(s.roleId)));
    }
    if (!items.length) { toast('还没有已生成的片段', 'info'); return; }
    playSequence(items, start, `project:${id}`);
  };
  const toggleSel = (sid: string, shift: boolean) => {
    setSel((cur) => {
      const n = new Set(cur);
      if (shift && lastClicked.current) {
        const ids = p.segments.map((s) => s.id);
        const a = ids.indexOf(lastClicked.current);
        const b = ids.indexOf(sid);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(ids[i]); return n; }
      }
      if (n.has(sid)) n.delete(sid); else n.add(sid);
      return n;
    });
    lastClicked.current = sid;
  };
  const move = (sid: string, to: number) => {
    const ids = p.segments.map((s) => s.id).filter((x) => x !== sid);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, sid);
    act(() => post(`${base}/segments/reorder`, { ids }));
  };
  const deleteSel = async () => {
    if (!(await confirm('删除片段', `删除选中的 ${selIds.length} 段和它们生成的音频？`, '删除', true))) return;
    await act(() => post(`${base}/segments/delete`, { ids: selIds }), '已删除');
    setSel(new Set());
  };
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    if (dragId && dragId !== targetId) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const ids = p.segments.map((s) => s.id).filter((x) => x !== dragId);
      move(dragId, ids.indexOf(targetId) + (after ? 1 : 0));
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="page project-editor">
      <a className="back-link" href="#/projects"><Icon name="back" size={15} />剧本</a>
      <header className="page-head project-head">
        <h1>{p.name}</h1>
        <IconButton size="sm" icon="settings" label="剧本设置" onClick={() => setDialog('settings')} />
        <span className="muted small project-stats">
          {done}/{p.segments.length} 段已生成{stale ? <span className="warn-text"> · {stale} 段过期</span> : null}{totalMs ? ` · ${formatDuration(totalMs)}` : ''}
        </span>
        <span className="spacer" />
        <Button icon="import" onClick={() => setDialog('import')}>导入文本</Button>
        <Button icon="play" disabled={!done} onClick={() => playFrom()}>连播</Button>
        {jobs.length > 0 ? (
          <Button variant="ghost" icon="close" onClick={() => act(() => post(`${base}/cancel`), '已取消排队中的片段')}>取消生成（{jobs.length}）</Button>
        ) : null}
        <Menu trigger={(open) => <Button variant="primary" icon="bolt" onClick={open}>生成</Button>} items={[
          { label: `生成未生成的（${p.segments.length - done}）`, icon: 'play', onSelect: () => generate('missing') },
          { label: `重新生成过期的（${stale}）`, icon: 'refresh', disabled: !stale, onSelect: () => generate('stale') },
          selIds.length ? { label: `生成所选（${selIds.length}）`, icon: 'check', onSelect: () => generate('selected', selIds) } : null,
          'sep',
          { label: '全部重新生成', icon: 'bolt', onSelect: () => generate('all') },
        ]} />
        <Button icon="download" disabled={!done} onClick={() => setDialog('export')}>导出</Button>
      </header>
      {jobs.length > 0 && <Progress value={p.segments.length - jobs.length} max={p.segments.length} />}
      {p.notes && <p className="muted small project-notes">{p.notes}</p>}

      <div className="editor-grid">
        <RolesPanel project={p} vmap={vmap} onCast={() => setDialog('cast')} />
        <section className="segments" aria-label="片段">
          {selIds.length > 0 && (
            <div className="batch-bar" role="toolbar" aria-label="批量操作">
              <b>已选 {selIds.length} 段</b>
              <select value="" onChange={(e) => { if (e.target.value) act(() => post(`${base}/segments/batch`, { ids: selIds, patch: { roleId: e.target.value === '-' ? null : e.target.value } })); }} aria-label="设置角色">
                <option value="">设为角色…</option>
                {p.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                <option value="-">（不指定）</option>
              </select>
              <Button size="sm" icon="play" onClick={() => generate('selected', selIds)}>生成</Button>
              <Button size="sm" icon="sparkle" onClick={() => setDialog('batch-instruction')}>补指令</Button>
              <Button size="sm" icon="tag" onClick={() => setDialog('batch-tags')}>打标签</Button>
              <Menu trigger={(open) => <Button size="sm" icon="more" onClick={open}>更多</Button>} items={[
                { label: '锁定', icon: 'lock', onSelect: () => act(() => post(`${base}/segments/batch`, { ids: selIds, patch: { locked: true } })) },
                { label: '解锁', icon: 'unlock', onSelect: () => act(() => post(`${base}/segments/batch`, { ids: selIds, patch: { locked: false } })) },
                { label: '清空片段指令', icon: 'close', onSelect: () => act(() => post(`${base}/segments/batch`, { ids: selIds, patch: { instruction: '' } })) },
                { label: '段后停顿恢复默认', icon: 'refresh', onSelect: () => act(() => post(`${base}/segments/batch`, { ids: selIds, patch: { pauseAfterMs: null } })) },
                { label: '合并为一段', icon: 'merge', disabled: selIds.length < 2, onSelect: () => act(async () => { await post(`${base}/segments/merge`, { ids: selIds }); setSel(new Set()); }, '已合并') },
                'sep',
                { label: '删除', icon: 'trash', danger: true, onSelect: deleteSel },
              ]} />
              <span className="spacer" />
              <button type="button" className="link-btn" onClick={() => setSel(new Set(p.segments.map((s) => s.id)))}>全选</button>
              <button type="button" className="link-btn" onClick={() => setSel(new Set())}>取消选择</button>
            </div>
          )}
          {!p.segments.length ? (
            <Empty icon="list" title="还没有片段">
              粘贴小说或台本，让大模型拆成角色和片段；或者按行导入。<br />
              <Button variant="primary" icon="import" onClick={() => setDialog('import')}>导入文本</Button>
            </Empty>
          ) : (
            <ol className="seg-list">
              {p.segments.map((s, i) => (
                <SegmentRow key={s.id} project={p} seg={s} index={i} eff={effs.get(s.id)!} selected={sel.has(s.id)}
                  onSelect={(shift) => toggleSel(s.id, shift)}
                  onPlayFrom={() => playFrom(s.id)}
                  onGenerate={() => generate('selected', [s.id])}
                  onMove={(d) => move(s.id, i + d)}
                  onInsert={() => setDialog({ insertAfter: s.id })}
                  onClone={async (t) => { try { setClone(await uploadFrom({ type: 'segment-take', projectId: id, segmentId: s.id, takeId: t.id })); } catch (e) { toastError(e); } }}
                  onDelete={async () => { if (await confirm('删除片段', `删除第 ${i + 1} 段？`, '删除', true)) act(() => post(`${base}/segments/delete`, { ids: [s.id] })); }}
                  drag={{
                    dragging: dragId === s.id, over: overId === s.id && dragId !== s.id,
                    start: () => setDragId(s.id), end: () => { setDragId(null); setOverId(null); },
                    over_: (e: DragEvent) => { if (dragId) { e.preventDefault(); setOverId(s.id); } }, drop: (e: DragEvent) => onDrop(e, s.id),
                  }} />
              ))}
            </ol>
          )}
          {p.segments.length > 0 && (
            <div className="seg-add">
              <Button variant="quiet" icon="plus" onClick={() => setDialog({ insertAfter: p.segments[p.segments.length - 1].id })}>添加片段</Button>
            </div>
          )}
        </section>
      </div>

      {dialog === 'import' && <ImportText project={p} onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog project={p} onClose={() => setDialog(null)} />}
      {dialog === 'cast' && <CastDialog project={p} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <ProjectSettingsDialog project={p} onClose={() => setDialog(null)} />}
      {(dialog === 'batch-instruction' || dialog === 'batch-tags') && <BatchLlm project={p} task={dialog} ids={selIds} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && <InsertSegment project={p} afterId={dialog.insertAfter} onClose={() => setDialog(null)} />}
      {clone && <CloneEditor target={{ type: 'new' }} initialUpload={clone} onClose={() => setClone(null)} onSaved={(rec) => { setClone(null); navigate(`/voices/${rec.id}`); }} />}
      {node}
    </div>
  );
}

// ───────────────────────── 角色 ─────────────────────────

function RolesPanel({ project, vmap, onCast }: { project: ProjectView; vmap: Map<string, VoiceItem>; onCast: () => void }) {
  const base = `/api/projects/${project.id}`;
  const [removing, setRemoving] = useState<Role | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of project.segments) if (s.roleId) m.set(s.roleId, (m.get(s.roleId) ?? 0) + 1);
    return m;
  }, [project.segments]);
  const add = () => {
    let n = project.roles.length + 1;
    while (project.roles.some((r) => r.name === `角色${n}`)) n++;
    post(`${base}/roles`, { name: `角色${n}` }).catch(toastError);
  };
  return (
    <aside className="roles-panel" aria-label="角色">
      <div className="section-head">
        <h2>角色</h2>
        <span className="spacer" />
        <Button size="sm" variant="quiet" icon="sparkle" disabled={!project.roles.length} onClick={onCast} title="让大模型按角色设定推荐音色">配音推荐</Button>
        <IconButton size="sm" icon="plus" label="添加角色" onClick={add} />
      </div>
      {!project.roles.length && <p className="muted small">还没有角色。导入文本时会自动创建，也可以手动添加。</p>}
      <ul className="role-list">
        {project.roles.map((r) => (
          <RoleCard key={r.id} project={project} role={r} voice={r.voiceId ? vmap.get(r.voiceId) : undefined} count={counts.get(r.id) ?? 0} onRemove={() => setRemoving(r)} />
        ))}
      </ul>
      {removing && <RemoveRole project={project} role={removing} count={counts.get(removing.id) ?? 0} onClose={() => setRemoving(null)} />}
    </aside>
  );
}

function RoleCard({ project, role, voice, count, onRemove }: { project: ProjectView; role: Role; voice?: VoiceItem; count: number; onRemove: () => void }) {
  const url = `/api/projects/${project.id}/roles/${role.id}`;
  const save = (p: Partial<Role>) => patch(url, p).catch(toastError);
  const name = useDraft(role.name, (v) => { if (v.trim()) save({ name: v.trim() }); });
  const ins = useDraft(role.instruction, (v) => save({ instruction: v }));
  const notes = useDraft(role.notes, (v) => save({ notes: v }));
  const [open, setOpen] = useState(false);
  const designLocked = voice?.mode === 'design';
  return (
    <li className="role-card" style={{ ['--role' as string]: role.color }}>
      <div className="role-head">
        <Menu align="start" trigger={(o) => <button type="button" className="role-swatch" style={{ background: role.color }} onClick={o} aria-label="角色颜色" />}
          items={ROLE_COLORS.map((c) => ({ label: <span className="swatch-item"><i style={{ background: c }} />{c}</span>, onSelect: () => save({ color: c }) }))} />
        <input className="role-name" value={name.value} onChange={(e) => name.onChange(e.target.value)} onFocus={name.onFocus} onBlur={name.onBlur} aria-label="角色名" />
        <span className="muted small">{count} 段</span>
        <IconButton size="sm" icon="chevron" className={`role-toggle ${open ? 'is-open' : ''}`} label={open ? '收起' : '展开指令和设定'} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      </div>
      <VoiceSlot compact allowAdhoc={false} value={role.voiceId ? { type: 'library', id: role.voiceId } : null} onChange={(v) => { if (v.type === 'library') save({ voiceId: v.id }); }} />
      {!open && (role.instruction || role.notes) && (
        <p className="role-summary" onClick={() => setOpen(true)} title="点击展开编辑">
          {role.instruction ? <>指令：{truncate(role.instruction, 40)}</> : <>设定：{truncate(role.notes, 40)}</>}
        </p>
      )}
      {open && (
        <div className="role-body">
          <InstructionEditor compact value={ins.value} onChange={ins.onChange} onFocus={ins.onFocus} onBlur={ins.onBlur} text=""
            disabled={designLocked} disabledReason="绑定的设计音色还没固化，角色指令不会生效。"
            placeholder="角色默认指令：这个角色平时怎么说话（片段可以单独覆盖）"
            inheritHint={voice?.defaultInstruction ? `音色默认指令「${truncate(voice.defaultInstruction, 40)}」` : undefined} />
          <AutoTextarea value={notes.value} onChange={(e) => notes.onChange(e.target.value)} onFocus={notes.onFocus} onBlur={notes.onBlur} minRows={1}
            placeholder="角色设定（年龄、性格、身份），配音推荐会参考" aria-label="角色设定" />
          <div className="row">
            {voice && <a className="small" href={`#/voices/${voice.id}`}>查看音色</a>}
            <span className="spacer" />
            <button type="button" className="link-btn danger" onClick={onRemove}>删除角色</button>
          </div>
        </div>
      )}
    </li>
  );
}

function RemoveRole({ project, role, count, onClose }: { project: ProjectView; role: Role; count: number; onClose: () => void }) {
  const others = project.roles.filter((r) => r.id !== role.id);
  const [to, setTo] = useState(others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await del(`/api/projects/${project.id}/roles/${role.id}${to ? `?reassign=${to}` : ''}`);
      toast('已删除角色');
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`删除角色「${role.name}」`} width={440} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="danger" busy={busy} onClick={go}>删除</Button></>}>
      {count ? (
        <Field label={`它的 ${count} 段改归给`}>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            <option value="">（不指定角色）</option>
          </select>
        </Field>
      ) : <p>这个角色没有片段。</p>}
    </Modal>
  );
}

// ───────────────────────── 片段 ─────────────────────────

interface RowProps {
  project: ProjectView;
  seg: Segment;
  index: number;
  eff: EffectiveSegment;
  selected: boolean;
  onSelect: (shift: boolean) => void;
  onPlayFrom: () => void;
  onGenerate: () => void;
  onMove: (delta: number) => void;
  onInsert: () => void;
  onClone: (t: SegmentTake) => void;
  onDelete: () => void;
  drag: { dragging: boolean; over: boolean; start: () => void; end: () => void; over_: (e: DragEvent) => void; drop: (e: DragEvent) => void };
}

const SegmentRow = memo(function SegmentRow({ project: p, seg: s, index, eff, selected, onSelect, onPlayFrom, onGenerate, onMove, onInsert, onClone, onDelete, drag }: RowProps) {
  const url = `/api/projects/${p.id}/segments/${s.id}`;
  const save = (body: Partial<Segment>) => patch(url, body).catch(toastError);
  const text = useDraft(s.text, (v) => save({ text: v }));
  const ins = useDraft(s.instruction, (v) => save({ instruction: v }));
  const [showIns, setShowIns] = useState(!!s.instruction);
  const [pause, setPause] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const job = useJobs((j) => j.segmentId === s.id && isActiveJob(j))[0];
  const st = usePlayer();
  const role = p.roles.find((r) => r.id === s.roleId);
  const take = activeTake(s);
  const stale = staleReasons(s, eff);
  const playing = !!take && st.item?.id === `seg-${s.id}-${take.id}`;
  const roleName = role?.name ?? '';

  const split = () => {
    const el = taRef.current;
    const pos = el ? Array.from(text.value.slice(0, el.selectionStart ?? 0)).length : 0;
    if (pos <= 0 || pos >= Array.from(text.value).length) { toast('先把光标放到要拆开的位置', 'info'); return; }
    text.flush();
    post(`${url}/split`, { at: pos }).catch(toastError);
  };

  const status = job
    ? <span className={`seg-status is-${job.status}`}><Spinner size={12} />{job.status === 'queued' ? '排队中' : job.status === 'retrying' ? `重试中（第 ${job.attempt} 次）` : job.progress && job.progress.total > 1 ? `生成中 ${Math.min(job.progress.done + 1, job.progress.total)}/${job.progress.total}` : '生成中'}</span>
    : eff.problems.length ? <span className="seg-status is-problem"><Icon name="warn" size={12} />{eff.problems[0]}</span>
    : s.lastError ? <span className="seg-status is-failed" title={s.lastError}><Icon name="error" size={12} />生成失败</span>
    : !take ? <span className="seg-status is-missing">未生成</span>
    : stale.length ? <span className="seg-status is-stale" title="当前配置和已生成的音频不一致"><Icon name="refresh" size={12} />过期：{stale.join('、')}</span>
    : <span className="seg-status is-ok"><Icon name="check" size={12} />已生成</span>;

  return (
    <li className={`seg ${selected ? 'is-selected' : ''} ${playing ? 'is-playing' : ''} ${s.locked ? 'is-locked' : ''} ${drag.dragging ? 'is-dragging' : ''} ${drag.over ? 'is-over' : ''}`}
      style={{ ['--role' as string]: role?.color ?? 'var(--line)' }}
      onDragOver={drag.over_} onDrop={drag.drop}>
      <div className="seg-gutter">
        <span className="drag-handle" draggable={!s.locked} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); drag.start(); }} onDragEnd={drag.end} title="拖动调整顺序" aria-hidden="true"><Icon name="drag" size={14} /></span>
        <input type="checkbox" checked={selected} onChange={() => undefined} onClick={(e) => onSelect(e.shiftKey)} aria-label={`选择第 ${index + 1} 段`} />
        <span className="seg-index">{index + 1}</span>
      </div>
      <div className="seg-body">
        <div className="seg-top">
          <select className="seg-role" value={s.roleId ?? ''} disabled={s.locked} onChange={(e) => save({ roleId: e.target.value || null })} aria-label="角色" style={{ color: role?.color }}>
            <option value="">未指定角色</option>
            {p.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {eff.voice && <span className={`seg-voice kind-edge-${eff.voice.kind}`} title="实际使用的音色">{eff.voice.name}</span>}
          {status}
          <span className="spacer" />
          {s.locked && <Icon name="lock" size={13} className="muted" />}
          <button type="button" className={`link-btn small ${showIns || s.instruction ? 'is-on' : ''}`} onClick={() => setShowIns((v) => !v)} aria-expanded={showIns}>
            {s.instruction ? '片段指令' : eff.instructionSource !== 'none' ? `继承${SOURCE_LABEL[eff.instructionSource]}` : '加指令'}
          </button>
        </div>
        <AutoTextarea innerRef={taRef} className="seg-text" value={text.value} disabled={s.locked} minRows={1}
          onChange={(e) => text.onChange(e.target.value)} onFocus={text.onFocus} onBlur={text.onBlur} aria-label={`第 ${index + 1} 段文本`} />
        {showIns && (
          <InstructionEditor compact value={ins.value} onChange={ins.onChange} onFocus={ins.onFocus} onBlur={ins.onBlur} text={text.value} voiceLabel={eff.voice?.name}
            disabled={s.locked || eff.voice?.mode === 'design'} disabledReason={s.locked ? '片段已锁定' : '这个角色用的设计音色还没固化，指令不会生效。'}
            inheritHint={eff.instructionSource === 'role' ? `角色指令「${truncate(role?.instruction ?? '', 50)}」` : eff.instructionSource === 'voice' ? `音色默认指令「${truncate(eff.voice?.defaultInstruction ?? '', 50)}」` : undefined} />
        )}
        {eff.instructionIgnored && !showIns && <p className="muted small">设计音色未固化，{SOURCE_LABEL[eff.instructionSource]}不会生效</p>}
        {s.lastError && !job && <Notice kind="error">{s.lastError}</Notice>}
        <div className="seg-foot">
          {take ? (
            <>
              <WavePlayer size="sm" item={takeItem(p, s, take, roleName)} />
              {s.takes.length > 1 && (
                <select className="take-select" value={s.activeTakeId ?? ''} onChange={(e) => save({ activeTakeId: e.target.value })} aria-label="版本">
                  {s.takes.map((t, i) => <option key={t.id} value={t.id}>{t.starred ? '★ ' : ''}v{s.takes.length - i} · {clock(t.createdAt)} · {t.voiceName}</option>)}
                </select>
              )}
              <IconButton size="sm" icon="star" label={take.starred ? '取消收藏这个版本' : '收藏这个版本（不会被自动清理）'} active={take.starred} onClick={() => patch(`${url}/takes/${take.id}`, { starred: !take.starred }).catch(toastError)} />
            </>
          ) : <span className="muted small">—</span>}
          <span className="spacer" />
          <label className="pause-input" title="这一段之后的停顿">
            <Icon name="pause" size={11} />
            <input type="number" min={0} max={20000} step={50} placeholder={String(p.settings.defaultGapMs)}
              value={pause ?? (s.pauseAfterMs ?? '')} onChange={(e) => setPause(e.target.value)}
              onBlur={() => { if (pause !== null) { save({ pauseAfterMs: pause === '' ? null : Number(pause) }); setPause(null); } }} aria-label="段后停顿（毫秒）" />
            <i>ms</i>
          </label>
          <IconButton size="sm" icon="play" label="从这里开始连播" disabled={!take} onClick={onPlayFrom} />
          <IconButton size="sm" icon={take ? 'refresh' : 'bolt'} label={take ? '重新生成这一段' : '生成这一段'} disabled={!!job || s.locked || !!eff.problems.length} onClick={onGenerate} />
          <Menu trigger={(open) => <IconButton size="sm" icon="more" label="更多操作" onClick={open} />} items={[
            { label: s.locked ? '解锁' : '锁定（不再改动和重新生成）', icon: s.locked ? 'unlock' : 'lock', onSelect: () => save({ locked: !s.locked }) },
            { label: '在光标处拆成两段', icon: 'scissors', disabled: s.locked, onSelect: split },
            { label: '在下方插入片段', icon: 'plus', onSelect: onInsert },
            { label: '上移', icon: 'upload', disabled: index === 0, onSelect: () => onMove(-1) },
            { label: '下移', icon: 'download', disabled: index === p.segments.length - 1, onSelect: () => onMove(1) },
            take ? 'sep' : null,
            take ? { label: '下载这一段', icon: 'download', onSelect: () => downloadFile(p.filesBase + take.file, `${String(index + 1).padStart(3, '0')}-${roleName || '片段'}.wav`) } : null,
            take ? { label: '用这段音频新建克隆音色…', icon: 'mic', onSelect: () => onClone(take) } : null,
            take && s.takes.length > 1 ? { label: '删除当前版本', icon: 'trash', onSelect: () => del(`${url}/takes/${take.id}`).catch(toastError) } : null,
            'sep',
            { label: '删除片段', icon: 'trash', danger: true, onSelect: onDelete },
          ]} />
        </div>
        {take && take.warnings.length > 0 && <p className="history-warn small"><Icon name="warn" size={12} /> {take.warnings.join('；')}</p>}
      </div>
    </li>
  );
});

function InsertSegment({ project, afterId, onClose }: { project: ProjectView; afterId: string | null; onClose: () => void }) {
  const after = project.segments.find((s) => s.id === afterId);
  const [roleId, setRoleId] = useState(after?.roleId ?? project.roles[0]?.id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const items = text.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => ({ roleId: roleId || null, text: t }));
      await post(`/api/projects/${project.id}/segments`, { afterId, items });
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="插入片段" width={560} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!text.trim()} onClick={go}>插入</Button></>}>
      <Field label="角色">
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">不指定</option>
          {project.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="文本" hint="多行会插入成多段">
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={3} data-autofocus />
      </Field>
    </Modal>
  );
}

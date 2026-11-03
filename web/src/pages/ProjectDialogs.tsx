// 剧本编辑器的对话框：导入文本（AI 拆分 / 按行）、导出、配音推荐、批量补指令与打标签、项目设置
import { useMemo, useState } from 'react';
import type { CastSuggestion, JobInfo, LlmDebug, Project, ProjectExportFile, SplitPreview, SplitPreviewSegment } from '../../../shared/types.ts';
import { del, downloadFile, downloadUrl, patch, post } from '../lib/api.ts';
import { upsertJob, useApi, useJobs, waitForJob } from '../lib/store.ts';
import { useStatus, useVoiceMap } from '../lib/hooks.ts';
import { bytes, clock, truncate } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Field, IconButton, Modal, Notice, Progress, Segmented, Spinner, Toggle } from '../components/ui.tsx';
import { DebugPanel, DiffView, llmReady, ModelSelect, NeedLlm, useModelChoice } from '../components/Assist.tsx';
import { Icon } from '../components/icons.tsx';

// ───────────────────────── 导入文本 ─────────────────────────

const LINE_ROLE = /^\s*([^\s：:「“"]{1,12})\s*[：:]\s*(.+)$/;

export function ImportText({ project, onClose }: { project: Project; onClose: () => void }) {
  const [mode, setMode] = useState<'ai' | 'lines'>('ai');
  const [text, setText] = useState('');
  const [model, setModel, settings] = useModelChoice();
  const [rewrite, setRewrite] = useState(false);
  const [withInstruction, setWithInstruction] = useState(true);
  const [targetLen, setTargetLen] = useState('120');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobs((j) => j.id === jobId)[0];
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [replaceAll, setReplaceAll] = useState(false);
  const [parseRole, setParseRole] = useState(true);
  const [lineRole, setLineRole] = useState(project.roles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const hasSegs = project.segments.length > 0;

  const lines = useMemo(() => text.split(/\n+/).map((l) => l.trim()).filter(Boolean), [text]);
  const runSplit = async () => {
    setPreview(null);
    try {
      const { job } = await post<{ job: JobInfo }>(`/api/projects/${project.id}/split`, { text, rewrite, withInstruction, targetLen: Number(targetLen) || 120, model });
      upsertJob(job);
      setJobId(job.id);
      const done = await waitForJob(job.id);
      if (done.status === 'done') setPreview(done.result as SplitPreview);
      else if (done.status === 'failed') toast(done.error ?? '拆分失败', 'err');
    } catch (e) { toastError(e); } finally { setJobId(null); }
  };
  const applyAi = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await post(`/api/projects/${project.id}/apply-split`, { roles: preview.roles, segments: preview.segments, replaceAll });
      toast(`导入了 ${preview.segments.length} 段`);
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const applyLines = async () => {
    setBusy(true);
    try {
      if (parseRole) {
        const fallback = project.roles.find((r) => r.id === lineRole)?.name ?? '旁白';
        const segments = lines.map((l) => { const m = LINE_ROLE.exec(l); return m ? { role: m[1], text: m[2].trim() } : { role: fallback, text: l }; });
        await post(`/api/projects/${project.id}/apply-split`, { roles: [], segments, replaceAll });
      } else {
        if (replaceAll) await post(`/api/projects/${project.id}/segments`, { replaceAll: true, items: lines.map((t) => ({ roleId: lineRole || null, text: t })) });
        else await post(`/api/projects/${project.id}/segments`, { items: lines.map((t) => ({ roleId: lineRole || null, text: t })) });
      }
      toast(`导入了 ${lines.length} 段`);
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const editSeg = (i: number, p: Partial<SplitPreviewSegment>) => setPreview((pv) => pv && { ...pv, segments: pv.segments.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const dropSeg = (i: number) => setPreview((pv) => pv && { ...pv, segments: pv.segments.filter((_, j) => j !== i) });
  const roleNames = preview ? [...new Set([...preview.roles.map((r) => r.name), ...preview.segments.map((s) => s.role)])] : [];
  const running = !!jobId;

  return (
    <Modal title="导入文本" width={preview ? 1000 : 760} onClose={onClose} className="import-modal"
      footer={<>
        {mode === 'ai' && <ModelSelect value={model} onChange={setModel} settings={settings} />}
        {hasSegs && <Toggle checked={replaceAll} onChange={setReplaceAll} label="替换现有全部片段" hint={replaceAll ? '现有片段和已生成的音频都会删除' : '追加到末尾'} />}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        {mode === 'ai'
          ? preview
            ? <Button variant="primary" busy={busy} disabled={!preview.segments.length} onClick={applyAi}>导入 {preview.segments.length} 段</Button>
            : <Button variant="primary" icon="sparkle" busy={running} disabled={!text.trim() || !llmReady(settings)} onClick={runSplit}>拆分</Button>
          : <Button variant="primary" busy={busy} disabled={!lines.length} onClick={applyLines}>导入 {lines.length} 段</Button>}
      </>}>
      <Segmented value={mode} onChange={(m) => { setMode(m); setPreview(null); }} ariaLabel="导入方式"
        options={[{ value: 'ai', label: 'AI 拆分角色和片段' }, { value: 'lines', label: '按行导入', disabled: running, title: running ? '正在拆分，完成后再切换' : undefined }]} />
      {preview ? (
        <SplitPreviewView preview={preview} roleNames={roleNames} onEdit={editSeg} onDrop={dropSeg} onBack={() => setPreview(null)} />
      ) : (
        <>
          {mode === 'ai' && !llmReady(settings) && <NeedLlm />}
          <Field label={mode === 'ai' ? '小说、台本或任意文本' : '每行一段'} hint={mode === 'lines' ? '空行会被忽略。可以写成「角色：台词」，角色会自动创建。' : '大模型会识别旁白和角色台词，按朗读节奏切成片段。原文覆盖率过低时会提示。'}>
            <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={10} placeholder={mode === 'ai' ? '把文本粘贴到这里' : '旁白：夜色渐深。\n小雨：你还在等他吗？\n……'} data-autofocus />
          </Field>
          {mode === 'ai' ? (
            <div className="row gap wrap">
              <Toggle checked={withInstruction} onChange={setWithInstruction} label="同时生成每段的风格指令" />
              <Toggle checked={rewrite} onChange={setRewrite} label="允许改写成适合朗读的口语" hint="关闭时尽量保留原文" />
              <Field label="每段目标字数" inline><input type="number" value={targetLen} min={20} max={600} step={10} onChange={(e) => setTargetLen(e.target.value)} style={{ width: 90 }} /></Field>
            </div>
          ) : (
            <div className="row gap wrap">
              <Toggle checked={parseRole} onChange={setParseRole} label="识别「角色：台词」" />
              <Field label={parseRole ? '没写角色的行归给' : '全部归给'} inline>
                <select value={lineRole} onChange={(e) => setLineRole(e.target.value)}>
                  <option value="">{parseRole ? '旁白（自动创建）' : '不指定'}</option>
                  {project.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          {running && (
            <div className="run-state">
              <Spinner /> {job?.status === 'queued' ? '排队中' : job?.progress?.note ?? '大模型正在拆分'}…
              {job?.progress && job.progress.total > 1 && <Progress value={job.progress.done} max={job.progress.total} />}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function SplitPreviewView({ preview, roleNames, onEdit, onDrop, onBack }: {
  preview: SplitPreview; roleNames: string[]; onEdit: (i: number, p: Partial<SplitPreviewSegment>) => void; onDrop: (i: number) => void; onBack: () => void;
}) {
  const cov = Math.round(preview.coverage * 100);
  return (
    <div className="split-preview">
      <div className="row gap">
        <Button size="sm" variant="quiet" icon="back" onClick={onBack}>重新拆分</Button>
        <span className="muted small">{preview.roles.length} 个角色 · {preview.segments.length} 段 · 原文覆盖率 <b className={cov < 90 ? 'warn-text' : ''}>{cov}%</b></span>
      </div>
      {preview.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      {preview.roles.length > 0 && (
        <ul className="split-roles">
          {preview.roles.map((r) => <li key={r.name}><b>{r.name}</b>{r.description && <span className="muted small">{r.description}</span>}</li>)}
        </ul>
      )}
      <ol className="split-segs">
        {preview.segments.map((s, i) => (
          <li key={i}>
            <select value={s.role} onChange={(e) => onEdit(i, { role: e.target.value })} aria-label="角色">
              {roleNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <div className="split-seg-body">
              <AutoTextarea value={s.text} onChange={(e) => onEdit(i, { text: e.target.value })} minRows={1} aria-label="文本" />
              {s.instruction !== undefined && (
                <AutoTextarea className="split-ins" value={s.instruction} onChange={(e) => onEdit(i, { instruction: e.target.value })} minRows={1} placeholder="风格指令（可空）" aria-label="指令" />
              )}
            </div>
            <IconButton size="sm" icon="close" label="去掉这段" onClick={() => onDrop(i)} />
          </li>
        ))}
      </ol>
      <DebugPanel debug={preview.debug} />
    </div>
  );
}

// ───────────────────────── 导出 ─────────────────────────

const FORMATS = [
  { value: 'wav', label: '整段 WAV' },
  { value: 'mp3', label: '整段 MP3' },
  { value: 'srt', label: 'SRT 字幕' },
  { value: 'zip', label: '分段 ZIP' },
  { value: 'package', label: '项目包' },
] as const;
type Format = (typeof FORMATS)[number]['value'];

const FORMAT_HINT: Record<Format, string> = {
  wav: '按顺序拼接所有已生成的片段，段间插入设置的停顿',
  mp3: '同上，转成 MP3（需要 ffmpeg 支持 libmp3lame）',
  srt: '按片段时间轴生成字幕；长句会按标点再切开',
  zip: '每段一个 WAV（按序号和角色命名），附带 SRT 和 project.json',
  package: '项目数据 + 所有生成的音频，可以在另一台机器上导入继续编辑',
};

export function ExportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { data: status } = useStatus();
  const { data: files } = useApi<ProjectExportFile[]>(`/api/projects/${project.id}/exports`);
  const [format, setFormat] = useState<Format>('wav');
  const [includeRole, setIncludeRole] = useState(false);
  const [splitSentences, setSplitSentences] = useState(true);
  const [busy, setBusy] = useState(false);
  const missing = project.segments.filter((s) => !s.activeTakeId).length;
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ name: string; url: string; missing: number }>(`/api/projects/${project.id}/export`, { format, includeRole, splitSentences });
      toast(r.missing ? `已导出，跳过了 ${r.missing} 段未生成的` : '已导出', r.missing ? 'info' : 'ok');
      downloadFile(r.url, r.name);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="导出" width={620} onClose={onClose}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" icon="download" busy={busy} disabled={format === 'mp3' && !status?.ffmpeg.mp3} onClick={go}>导出</Button></>}>
      <Segmented value={format} onChange={setFormat} options={FORMATS.map((f) => ({ ...f, disabled: f.value === 'mp3' && status && !status.ffmpeg.mp3 }))} ariaLabel="格式" />
      <p className="muted small">{FORMAT_HINT[format]}</p>
      {(format === 'srt' || format === 'zip') && (
        <div className="row gap wrap">
          <Toggle checked={includeRole} onChange={setIncludeRole} label="字幕前加角色名" />
          <Toggle checked={splitSentences} onChange={setSplitSentences} label="长句按标点切成多条字幕" />
        </div>
      )}
      {missing > 0 && format !== 'package' && <Notice kind="warn">还有 {missing} 段没生成，导出时会跳过。</Notice>}
      <h4 className="sub-title">导出记录</h4>
      {!files?.length ? <p className="muted small">还没有导出过。</p> : (
        <ul className="export-list">
          {files.map((f) => (
            <li key={f.name}>
              <a href={downloadUrl(f.url, f.name)} download={f.name}><Icon name="download" size={14} /> {f.name}</a>
              <span className="muted small">{bytes(f.bytes)} · {clock(f.createdAt)}</span>
              <IconButton size="sm" icon="trash" label="删除" onClick={() => del(`/api/projects/${project.id}/exports/${encodeURIComponent(f.name)}`).catch(toastError)} />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ───────────────────────── 配音推荐 ─────────────────────────

export function CastDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [model, setModel, settings] = useModelChoice();
  const vmap = useVoiceMap();
  const [onlyUnbound, setOnlyUnbound] = useState(project.roles.some((r) => !r.voiceId));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ suggestions: CastSuggestion[]; debug: LlmDebug; warnings: string[] } | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const unbound = project.roles.filter((r) => !r.voiceId).map((r) => r.id);
  const go = async () => {
    // 服务端把空的 roleIds 当作「全部角色」，所以没有未绑定角色时直接不请求
    if (onlyUnbound && !unbound.length) { toast('所有角色都已绑定音色', 'info'); return; }
    setBusy(true);
    try {
      const roleIds = onlyUnbound ? unbound : [];
      const r = await post<typeof res & {}>(`/api/projects/${project.id}/cast`, { model, roleIds });
      setRes(r);
      setPick(new Set(r.suggestions.map((s) => s.role)));
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!res) return;
    setApplying(true);
    try {
      let n = 0;
      for (const s of res.suggestions) {
        if (!pick.has(s.role)) continue;
        const role = project.roles.find((r) => r.name === s.role);
        if (!role) continue;
        await patch(`/api/projects/${project.id}/roles/${role.id}`, { voiceId: s.voiceId });
        n++;
      }
      toast(`已为 ${n} 个角色绑定音色`);
      onClose();
    } catch (e) { toastError(e); } finally { setApplying(false); }
  };
  return (
    <Modal title="配音推荐" width={720} onClose={onClose}
      footer={<>
        <ModelSelect value={model} onChange={setModel} settings={settings} />
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" busy={applying} disabled={!res || !pick.size} onClick={apply}>采用所选（{pick.size}）</Button>
      </>}>
      {!llmReady(settings) && <NeedLlm />}
      <p className="muted small">大模型会根据角色备注、指令和音色库里每个音色的标签、描述，为角色挑选音色。角色备注写得越清楚，推荐越准。</p>
      <div className="row gap">
        <Toggle checked={onlyUnbound} onChange={setOnlyUnbound} label="只推荐还没绑定音色的角色" />
        <span className="spacer" />
        <Button icon="sparkle" variant="primary" busy={busy} disabled={!llmReady(settings) || !project.roles.length || (onlyUnbound && !unbound.length)} onClick={go}>{res ? '重新推荐' : '推荐'}</Button>
      </div>
      {res && (
        <ul className="cast-list">
          {res.suggestions.map((s) => {
            const role = project.roles.find((r) => r.name === s.role);
            const cur = role?.voiceId ? vmap.get(role.voiceId) : undefined;
            const v = vmap.get(s.voiceId);
            return (
              <li key={s.role}>
                <input type="checkbox" checked={pick.has(s.role)} onChange={() => setPick((p) => { const n = new Set(p); if (n.has(s.role)) n.delete(s.role); else n.add(s.role); return n; })} aria-label={`采用 ${s.role}`} />
                <span className="cast-role" style={{ borderColor: role?.color }}>{s.role}</span>
                <Icon name="back" size={14} className="flip" />
                <span className={`cast-voice kind-edge-${v?.kind ?? 'preset'}`}>{s.voiceName}</span>
                {cur && cur.id !== s.voiceId && <span className="muted small">（现在是 {cur.name}）</span>}
                <span className="cast-reason muted small">{s.reason}</span>
              </li>
            );
          })}
          {!res.suggestions.length && <li className="muted">没有拿到推荐结果</li>}
        </ul>
      )}
      {res?.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      <DebugPanel debug={res?.debug} />
    </Modal>
  );
}

// ───────────────────────── 批量补指令 / 打标签 ─────────────────────────

interface BatchValue { id: string; text?: string; instruction?: string; beforeText: string; beforeInstruction: string }

export function BatchLlm({ project, task, ids, onClose }: { project: Project; task: 'batch-instruction' | 'batch-tags'; ids: string[]; onClose: () => void }) {
  const [model, setModel, settings] = useModelChoice();
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ values: BatchValue[]; warnings: string[]; debug: LlmDebug[] } | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const targets = project.segments.filter((s) => ids.includes(s.id));
  const locked = targets.filter((s) => s.locked).length;
  const isIns = task === 'batch-instruction';
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<NonNullable<typeof res>>(`/api/projects/${project.id}/llm-batch`, { task, ids, intent, model });
      setRes(r);
      setPick(new Set(r.values.filter((v) => (isIns ? v.instruction !== v.beforeInstruction : v.text !== v.beforeText)).map((v) => v.id)));
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!res) return;
    setApplying(true);
    try {
      const values = res.values.filter((v) => pick.has(v.id)).map((v) => (isIns ? { id: v.id, instruction: v.instruction ?? '' } : { id: v.id, text: v.text }));
      const r = await post<{ updated: number }>(`/api/projects/${project.id}/segments/values`, { values });
      toast(`已更新 ${r.updated} 段`);
      onClose();
    } catch (e) { toastError(e); } finally { setApplying(false); }
  };
  return (
    <Modal title={isIns ? `批量补风格指令（${targets.length} 段）` : `批量打音频标签（${targets.length} 段）`} width={860} onClose={onClose}
      footer={<>
        <ModelSelect value={model} onChange={setModel} settings={settings} />
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" busy={applying} disabled={!res || !pick.size} onClick={apply}>采用所选（{pick.size}）</Button>
      </>}>
      {!llmReady(settings) && <NeedLlm />}
      <p className="muted small">{isIns ? '结合上下文和角色设定，为每段写片段级风格指令（会覆盖原有的片段指令）。' : '只插入开头的 (风格) 标签和行内音频标签，不改原文。'}{locked ? ` 已锁定的 ${locked} 段会跳过。` : ''}</p>
      <div className="row gap">
        <input className="grow" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="整体意图（可选），例如：悬疑感逐渐加强，结尾要压低声音" aria-label="意图" />
        <Button icon="sparkle" variant="primary" busy={busy} disabled={!llmReady(settings) || !targets.length} onClick={go}>{res ? '重新生成' : '生成'}</Button>
      </div>
      {res && (
        <ol className="batch-list">
          {res.values.map((v) => {
            const seg = project.segments.find((s) => s.id === v.id);
            const role = project.roles.find((r) => r.id === seg?.roleId);
            const changed = isIns ? v.instruction !== v.beforeInstruction : v.text !== v.beforeText;
            return (
              <li key={v.id} className={changed ? '' : 'is-same'}>
                <input type="checkbox" checked={pick.has(v.id)} disabled={!changed} onChange={() => setPick((p) => { const n = new Set(p); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; })} aria-label="采用" />
                <div className="batch-body">
                  <span className="batch-role" style={{ color: role?.color }}>{role?.name ?? '未指定'}</span>
                  {isIns ? (
                    <>
                      <p className="muted small">{truncate(v.beforeText, 80)}</p>
                      <DiffView before={v.beforeInstruction} after={v.instruction ?? ''} />
                    </>
                  ) : <DiffView before={v.beforeText} after={v.text ?? ''} />}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {res?.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      <DebugPanel debug={res?.debug} />
    </Modal>
  );
}

// ───────────────────────── 项目设置 ─────────────────────────

export function ProjectSettingsDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [notes, setNotes] = useState(project.notes);
  const [gap, setGap] = useState(String(project.settings.defaultGapMs));
  const [keep, setKeep] = useState(String(project.settings.keepTakes));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/projects/${project.id}`, { name, notes, settings: { defaultGapMs: Number(gap), keepTakes: Number(keep) } });
      toast('已保存');
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="剧本设置" width={520} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={save}>保存</Button></>}>
      <Field label="名称"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="备注"><AutoTextarea value={notes} onChange={(e) => setNotes(e.target.value)} minRows={2} placeholder="故事梗概、风格要求，配音推荐时也会参考" /></Field>
      <div className="row gap">
        <Field label="默认段间停顿" hint="片段没有单独设置时用这个"><span className="unit-input"><input type="number" min={0} max={10000} step={50} value={gap} onChange={(e) => setGap(e.target.value)} /><i>ms</i></span></Field>
        <Field label="每段保留版本数" hint="收藏的版本不计入"><input type="number" min={1} max={50} value={keep} onChange={(e) => setKeep(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

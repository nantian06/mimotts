// 音色详情：通用信息、标准试听、设计音色（描述 / 抽卡 / 固化）、克隆音色（参考音频版本）
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignTake, JobInfo, RefVersion, UploadInfo, VoiceGender, VoiceLang, VoiceRecord, VoiceSummary } from '../../../shared/types.ts';
import { GENDER_LABELS, LANG_LABELS, PROCESS_PRESETS } from '../../../shared/presets.ts';
import { del, downloadFile, patch, post, startDownload } from '../lib/api.ts';
import { isActiveJob, upsertJob, useApi, useJobs } from '../lib/store.ts';
import { useSettings, useVoices } from '../lib/hooks.ts';
import { ago, bytes, clock, seconds, truncate } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Empty, Field, GradeBadge, IconButton, KindBadge, Menu, Notice, Segmented, Spinner, TagInput, Toggle, useConfirm } from '../components/ui.tsx';
import { InstructionEditor } from '../components/Editors.tsx';
import { DesignAssist, generatePreviewText, useModelChoice, llmReady } from '../components/Assist.tsx';
import { CloneEditor, QualityReportView, uploadFrom } from '../components/CloneEditor.tsx';
import { WavePlayer } from '../components/Wave.tsx';
import { Icon } from '../components/icons.tsx';

interface Detail extends VoiceRecord {
  builtin: boolean;
  summary: VoiceSummary;
  urls: { takes: Record<string, string>; refs: Record<number, { original: string; source: string; processed: string }> };
  references: { projectId: string; projectName: string; roles: string[] }[];
}

const SOURCE_LABELS: Record<string, string> = { upload: '上传', record: '录音', 'design-take': '设计试听', quick: '快速合成', 'segment-take': '剧本片段', 'voice-ref': '旧版本', import: '导入' };

export function VoiceDetail({ id }: { id: string }) {
  const { data: v, error } = useApi<Detail>(`/api/voices/${id}`);
  const { confirm, node } = useConfirm();
  if (error) {
    return (
      <div className="page">
        <BackLink />
        <Empty icon="library" title="找不到这个音色">{error.message}</Empty>
      </div>
    );
  }
  if (!v) return <div className="page"><BackLink /><p className="muted pad"><Spinner /> 加载中…</p></div>;

  const trashed = !!v.trashedAt;
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); } catch (e) { toastError(e); } };
  const duplicate = () => act(async () => { const r = await post<VoiceRecord>(`/api/voices/${id}/duplicate`); navigate(`/voices/${r.id}`); }, v.builtin ? '已新建预置变体' : '已复制');
  const trash = async () => {
    const refs = v.references.reduce((n, r) => n + r.roles.length, 0);
    if (!(await confirm('移入回收站', refs ? `有 ${refs} 个剧本角色正在用这个音色，移走后这些角色就没法生成了。仍然移入回收站？` : `把「${v.name}」移入回收站？之后可以恢复。`, '移入回收站', true))) return;
    act(() => post(`/api/voices/${id}/trash`), '已移入回收站');
  };
  const destroy = async () => {
    if (!(await confirm('彻底删除', `彻底删除「${v.name}」和它的所有音频？无法恢复。`, '彻底删除', true))) return;
    act(async () => { await del(`/api/voices/${id}`); navigate('/voices'); }, '已删除');
  };

  return (
    <div className="page voice-detail">
      <BackLink />
      <header className={`detail-head kind-edge-${v.kind}`}>
        <div className="detail-title">
          <h1>{v.name}</h1>
          <KindBadge kind={v.kind} mode={v.summary.mode} builtin={v.builtin} />
          {trashed && <span className="chip chip-sm chip-warn">回收站</span>}
          <IconButton icon="star" label={v.favorite ? '取消收藏' : '收藏'} active={v.favorite} onClick={() => act(() => patch(`/api/voices/${id}`, { favorite: !v.favorite }))} />
        </div>
        <span className="spacer" />
        {trashed ? (
          <>
            <Button icon="restore" onClick={() => act(() => post(`/api/voices/${id}/restore`), '已恢复')}>恢复</Button>
            <Button variant="danger" icon="trash" onClick={destroy}>彻底删除</Button>
          </>
        ) : (
          <Menu trigger={(open) => <Button icon="more" onClick={open}>操作</Button>} items={[
            { label: v.builtin ? '新建预置变体' : '复制一份', icon: 'copy', onSelect: duplicate },
            !v.builtin && { label: '导出音色包', icon: 'export', onSelect: () => startDownload(`/api/voices/${id}/export`, `音色-${v.name}.zip`) },
            !v.builtin && 'sep',
            !v.builtin && { label: '移入回收站', icon: 'trash', danger: true, onSelect: trash },
          ]} />
        )}
      </header>
      {v.origin && <OriginLine origin={v.origin} />}

      <div className="detail-grid">
        <div className="detail-main">
          {v.kind === 'design' && <DesignSection v={v} />}
          {(v.kind === 'clone' || (v.kind === 'design' && v.refs.length > 0)) && <RefSection v={v} />}
          {v.kind === 'preset' && !v.builtin && <PresetSection v={v} />}
          <PreviewSection v={v} />
        </div>
        <aside className="detail-side">
          {v.builtin ? <BuiltinInfo v={v} /> : <InfoForm v={v} />}
          {v.references.length > 0 && (
            <div className="card">
              <h3 className="card-title">正在使用的剧本</h3>
              <ul className="ref-list">
                {v.references.map((r) => (
                  <li key={r.projectId}><a href={`#/projects/${r.projectId}`}>{r.projectName}</a><span className="muted small">{r.roles.join('、')}</span></li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
      {node}
    </div>
  );
}

function BackLink() {
  return <a className="back-link" href="#/voices"><Icon name="back" size={15} />音色库</a>;
}

function OriginLine({ origin }: { origin: NonNullable<VoiceRecord['origin']> }) {
  const label = origin.type === 'duplicate' ? `复制自「${origin.voiceName ?? ''}」`
    : origin.type === 'adhoc-design' ? '来自快速合成的临时设计音色'
    : origin.type === 'quick' ? '来自快速合成的结果'
    : origin.type === 'design-take' ? `来自设计音色「${origin.voiceName ?? ''}」的试听`
    : origin.type === 'segment-take' ? '来自剧本片段'
    : origin.type === 'import' ? '从音色包导入' : '';
  if (!label) return null;
  return <p className="origin-line muted small"><Icon name="link" size={13} /> {label}{origin.voiceId && origin.type !== 'import' ? <> · <a href={`#/voices/${origin.voiceId}`}>查看来源</a></> : null}</p>;
}

// ───────────────────────── 通用信息 ─────────────────────────

function InfoForm({ v }: { v: Detail }) {
  const { data: all } = useVoices();
  const init = () => ({ name: v.name, tags: v.tags, lang: v.lang, gender: v.gender, notes: v.notes, defaultInstruction: v.defaultInstruction });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  // 只在可编辑字段变化时同步，并且只覆盖用户没改过的字段（抽卡、收藏等后台更新不会冲掉正在编辑的内容）
  const serverKey = JSON.stringify(init());
  const lastServer = useRef(init());
  useEffect(() => {
    const prev = lastServer.current;
    const next = init();
    lastServer.current = next;
    setF((cur) => {
      const out = { ...cur } as Record<string, unknown>;
      for (const k of Object.keys(next) as (keyof typeof next)[]) {
        if (JSON.stringify(cur[k]) === JSON.stringify(prev[k])) out[k] = next[k];
      }
      return out as typeof cur;
    });
  }, [serverKey]);
  const dirty = JSON.stringify(f) !== serverKey;
  const tagSuggest = useMemo(() => [...new Set((all ?? []).flatMap((x) => x.tags))].filter((t) => t !== '官方'), [all]);
  const save = async () => {
    setBusy(true);
    try { await patch(`/api/voices/${v.id}`, f); toast('已保存'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const unfixedDesign = v.kind === 'design' && v.currentRef == null;
  return (
    <div className="card info-form">
      <h3 className="card-title">基本信息</h3>
      <Field label="名称"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="row gap">
        <Field label="性别"><select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value as VoiceGender })}>{Object.entries(GENDER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="语言"><select value={f.lang} onChange={(e) => setF({ ...f, lang: e.target.value as VoiceLang })}>{Object.entries(LANG_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <Field label="标签"><TagInput value={f.tags} onChange={(tags) => setF({ ...f, tags })} suggestions={tagSuggest} /></Field>
      <Field label="默认风格指令" hint={unfixedDesign ? undefined : '合成时指令留空就用这条；剧本里角色和片段的指令优先'}>
        <InstructionEditor compact value={f.defaultInstruction} onChange={(defaultInstruction) => setF({ ...f, defaultInstruction })} text=""
          disabled={unfixedDesign} disabledReason="未固化的设计音色不能使用风格指令。固化后再来设置。" />
      </Field>
      <Field label="备注"><AutoTextarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} minRows={2} placeholder="用途、来源、注意事项" /></Field>
      <div className="row gap">
        <span className="muted small">创建于 {clock(v.createdAt)}</span>
        <span className="spacer" />
        {dirty && <Button variant="ghost" size="sm" onClick={() => setF(init())}>还原</Button>}
        <Button variant="primary" size="sm" busy={busy} disabled={!dirty} onClick={save}>保存</Button>
      </div>
    </div>
  );
}

function BuiltinInfo({ v }: { v: Detail }) {
  return (
    <div className="card">
      <h3 className="card-title">官方预置音色</h3>
      <dl className="kv">
        <dt>音色 ID</dt><dd><code>{v.presetId}</code></dd>
        <dt>性别</dt><dd>{GENDER_LABELS[v.gender]}</dd>
        <dt>语言</dt><dd>{LANG_LABELS[v.lang]}</dd>
        <dt>说明</dt><dd>{v.notes}</dd>
      </dl>
      <p className="muted small">官方音色不能修改。想要固定的默认指令，可以「新建预置变体」。预置音色支持流式合成和唱歌。</p>
    </div>
  );
}

function PresetSection({ v }: { v: Detail }) {
  const [presetId, setPresetId] = useState(v.presetId ?? '');
  useEffect(() => setPresetId(v.presetId ?? ''), [v.presetId]);
  return (
    <section className="card">
      <h3 className="card-title">基于官方音色</h3>
      <div className="row gap">
        <select value={presetId} onChange={(e) => { setPresetId(e.target.value); patch(`/api/voices/${v.id}`, { presetId: e.target.value }).then(() => toast('已切换')).catch(toastError); }} aria-label="官方音色">
          {['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="muted small">变体 = 官方音色 + 默认风格指令（在右侧「基本信息」里编辑）。</span>
      </div>
    </section>
  );
}

// ───────────────────────── 标准试听 ─────────────────────────

function PreviewSection({ v }: { v: Detail }) {
  const { data: s } = useSettings();
  const pv = v.summary.preview;
  const job = useJobs((j) => j.kind === 'preview' && j.voiceId === v.id && isActiveJob(j))[0];
  const [text, setText] = useState('');
  const [custom, setCustom] = useState(false);
  const go = async () => {
    try { const { job } = await post<{ job: JobInfo }>(`/api/voices/${v.id}/preview`, { text: custom ? text : '' }); upsertJob(job); } catch (e) { toastError(e); }
  };
  const stale = pv && pv.voiceVersion !== v.summary.version;
  const blocked = v.kind === 'design' && !v.description;
  return (
    <section className="card">
      <div className="section-head">
        <h3 className="card-title">标准试听</h3>
        <span className="spacer" />
        {job ? <span className="muted small"><Spinner size={13} /> {job.status === 'queued' ? '排队中' : '生成中'}</span>
          : <Button size="sm" icon={pv ? 'refresh' : 'play'} disabled={blocked || !!v.trashedAt} onClick={go}>{pv ? '重新生成' : '生成试听'}</Button>}
      </div>
      <p className="muted small">音色库列表和选择器里播放的就是这条。用统一的文本，方便横向比较不同音色。</p>
      {pv ? (
        <>
          <WavePlayer item={{ id: `pv-${v.id}`, url: pv.url, title: v.name, subtitle: '标准试听', peaks: pv.peaks, durationMs: pv.durationMs }} />
          <p className="muted small">「{truncate(pv.text, 60)}」{stale && <span className="warn-text"> · 音色已更新，这条试听是旧的</span>}</p>
        </>
      ) : <p className="muted small">还没有试听。</p>}
      <Toggle checked={custom} onChange={setCustom} label="用自定义文本" />
      {custom && <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} placeholder={s?.ui.previewText} />}
    </section>
  );
}

// ───────────────────────── 设计音色 ─────────────────────────

function DesignSection({ v }: { v: Detail }) {
  const { data: s } = useSettings();
  const [model, , settings] = useModelChoice();
  const [desc, setDesc] = useState(v.description ?? '');
  const [savingDesc, setSavingDesc] = useState(false);
  const [assist, setAssist] = useState(false);
  const [count, setCount] = useState('3');
  const [text, setText] = useState('');
  const [optimize, setOptimize] = useState(false);
  const [genText, setGenText] = useState(false);
  const [clone, setClone] = useState<UploadInfo | null>(null);
  const [starOnly, setStarOnly] = useState(false);
  const { confirm, node } = useConfirm();
  useEffect(() => setDesc(v.description ?? ''), [v.description]);
  const descDirty = desc.trim() !== (v.description ?? '').trim();
  const running = useJobs((j) => j.kind === 'design-take' && j.voiceId === v.id && isActiveJob(j));
  const fixed = v.currentRef != null;
  const currentRef = v.refs.find((r) => r.version === v.currentRef);
  const fixedTakeId = currentRef?.takeId;
  const takes = (v.takes ?? []).filter((t) => !starOnly || t.starred);

  const saveDesc = async () => {
    if (fixed && !(await confirm('修改描述', '这个音色已经固化，合成用的是固化的参考音频，改描述不会影响现在的声音；只影响之后抽卡。继续保存？', '保存'))) return;
    setSavingDesc(true);
    try { await patch(`/api/voices/${v.id}`, { description: desc }); toast('描述已保存'); } catch (e) { toastError(e); } finally { setSavingDesc(false); }
  };
  const draw = async () => {
    try {
      if (descDirty) await patch(`/api/voices/${v.id}`, { description: desc });
      const r = await post<{ jobs: JobInfo[] }>(`/api/voices/${v.id}/takes`, { count: Number(count), text, optimizeTextPreview: optimize });
      r.jobs.forEach(upsertJob);
    } catch (e) { toastError(e); }
  };
  const fix = async (t: DesignTake) => {
    try {
      await post(`/api/voices/${v.id}/fix`, { takeId: t.id });
      toast('已固化：之后合成会用这条试听作为参考音频，音色稳定，也能用风格指令了');
    } catch (e) { toastError(e); }
  };
  const unfix = async () => {
    if (!(await confirm('取消固化', '取消后合成重新走音色设计模型，每次声音会略有不同，也不能再用风格指令。已固化的参考音频会保留，可以随时重新启用。', '取消固化'))) return;
    try { await post(`/api/voices/${v.id}/unfix`); toast('已取消固化'); } catch (e) { toastError(e); }
  };
  const autoText = async () => {
    setGenText(true);
    const t = await generatePreviewText(desc, model);
    if (t) setText(t);
    setGenText(false);
  };

  return (
    <>
      <section className="card">
        <div className="section-head">
          <h3 className="card-title">音色描述</h3>
          <span className="spacer" />
          <Button size="sm" variant="quiet" icon="sparkle" onClick={() => setAssist(true)}>润色</Button>
        </div>
        <AutoTextarea value={desc} onChange={(e) => setDesc(e.target.value)} minRows={3} aria-label="音色描述" />
        {descDirty && (
          <div className="row gap">
            <span className="muted small">描述改过了，还没保存（抽卡时会自动保存）</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => setDesc(v.description ?? '')}>还原</Button>
            <Button size="sm" variant="primary" busy={savingDesc} disabled={!desc.trim()} onClick={saveDesc}>保存描述</Button>
          </div>
        )}
        {assist && <DesignAssist draft={desc} onClose={() => setAssist(false)} onApply={(o) => { setDesc(o.description); if (o.previewText) setText(o.previewText); }} />}
      </section>

      <section className="card">
        <div className="section-head">
          <h3 className="card-title">抽卡试听</h3>
          <span className="muted small">{fixed ? '已固化，可以继续抽卡换一条' : '多抽几条，挑一条满意的固化'}</span>
          <span className="spacer" />
          {fixed && <Button size="sm" variant="ghost" onClick={unfix}>取消固化</Button>}
        </div>
        {fixed && currentRef ? (
          <Notice kind="ok">已固化：{fixedTakeId && v.takes?.some((t) => t.id === fixedTakeId) ? `${clock(v.takes!.find((t) => t.id === fixedTakeId)!.createdAt)} 那条试听` : `参考音频 v${currentRef.version}`}。合成走克隆模型，声音稳定，可以使用风格指令。</Notice>
        ) : (
          <Notice kind="info">还没固化：每次合成都会根据描述重新「设计」，声音会有差异，也不能叠加风格指令。</Notice>
        )}
        <div className="draw-bar">
          <Field label="试听文本" hint={optimize ? '开启润色后，模型会按描述改写这段文本（留空则自己生成）' : `留空用默认试听文本`}>
            <div className="row gap">
              <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={1} placeholder={s?.ui.previewText} />
              <Button size="sm" variant="quiet" icon="sparkle" busy={genText} disabled={!llmReady(settings) || !desc.trim()} onClick={autoText} title={llmReady(settings) ? '按音色描述写一段贴合人设的试听文本' : '需要先配置辅助大模型'}>按描述写</Button>
            </div>
          </Field>
          <div className="row gap wrap">
            <Toggle checked={optimize} onChange={setOptimize} label="智能润色试听文本" />
            <span className="spacer" />
            <Segmented size="sm" value={count} onChange={setCount} ariaLabel="抽几条" options={['1', '3', '6'].map((n) => ({ value: n, label: `${n} 条` }))} />
            <Button variant="primary" icon="sparkle" disabled={!desc.trim() || !!v.trashedAt} onClick={draw}>抽卡</Button>
          </div>
        </div>
        <div className="row gap">
          <span className="muted small">{v.takes?.length ?? 0} 条试听{running.length ? `，${running.length} 条生成中` : ''}</span>
          <span className="spacer" />
          <Toggle checked={starOnly} onChange={setStarOnly} label="只看收藏" />
        </div>
        <ul className="take-list">
          {running.map((j) => (
            <li key={j.id} className="take is-pending"><Spinner /> <span className="muted small">{j.status === 'queued' ? '排队中' : j.status === 'retrying' ? `重试中：${j.error ?? ''}` : '生成中'}…</span></li>
          ))}
          {takes.map((t) => (
            <TakeRow key={t.id} v={v} t={t} url={v.urls.takes[t.id]} isFixed={t.id === fixedTakeId && fixed} descChanged={t.description.trim() !== (v.description ?? '').trim()}
              onFix={() => fix(t)} onClone={async () => { try { setClone(await uploadFrom({ type: 'design-take', voiceId: v.id, takeId: t.id })); } catch (e) { toastError(e); } }} />
          ))}
          {!running.length && !takes.length && <li className="muted small pad">{starOnly ? '没有收藏的试听' : '还没有试听，点「抽卡」生成几条。'}</li>}
        </ul>
      </section>
      {clone && <CloneEditor target={{ type: 'new' }} initialUpload={clone} onClose={() => setClone(null)} onSaved={(rec) => { setClone(null); navigate(`/voices/${rec.id}`); }} />}
      {node}
    </>
  );
}

function TakeRow({ v, t, url, isFixed, descChanged, onFix, onClone }: { v: Detail; t: DesignTake; url: string; isFixed: boolean; descChanged: boolean; onFix: () => void; onClone: () => void }) {
  const [note, setNote] = useState(t.note);
  useEffect(() => setNote(t.note), [t.note]);
  return (
    <li className={`take ${isFixed ? 'is-fixed' : ''}`}>
      <div className="take-main">
        <WavePlayer item={{ id: `take-${t.id}`, url, title: `${v.name} 试听`, subtitle: clock(t.createdAt), peaks: t.peaks, durationMs: t.durationMs }} />
        <div className="take-meta">
          <span className="muted small">{ago(t.createdAt)}</span>
          {isFixed && <span className="chip chip-sm chip-on">已固化</span>}
          {descChanged && <span className="chip chip-sm" title={t.description}>旧描述</span>}
          {t.optimizeTextPreview && <span className="chip chip-sm">润色</span>}
        </div>
      </div>
      {(t.actualText || t.text) && <p className="take-text muted small" title={t.actualText ?? t.text}>「{truncate(t.actualText ?? t.text, 80)}」</p>}
      <div className="take-actions">
        <input className="take-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注" aria-label="备注"
          onBlur={() => { if (note !== t.note) patch(`/api/voices/${v.id}/takes/${t.id}`, { note }).catch(toastError); }} />
        <IconButton size="sm" icon="star" label={t.starred ? '取消收藏' : '收藏'} active={t.starred} onClick={() => patch(`/api/voices/${v.id}/takes/${t.id}`, { starred: !t.starred }).catch(toastError)} />
        {!isFixed && <Button size="sm" icon="pin" onClick={onFix} title="把这条作为参考音频，之后音色固定">固化</Button>}
        <Menu trigger={(open) => <IconButton size="sm" icon="more" label="更多" onClick={open} />} items={[
          { label: '另存为克隆音色…', icon: 'mic', onSelect: onClone },
          { label: '下载', icon: 'download', onSelect: () => downloadFile(url, `${v.name}-试听.wav`) },
          'sep',
          { label: '删除', icon: 'trash', danger: true, onSelect: () => del(`/api/voices/${v.id}/takes/${t.id}`).catch(toastError) },
        ]} />
      </div>
    </li>
  );
}

// ───────────────────────── 参考音频（克隆 / 已固化） ─────────────────────────

function RefSection({ v }: { v: Detail }) {
  const [editor, setEditor] = useState<{ upload?: UploadInfo; from?: RefVersion } | null>(null);
  const [loadingAdjust, setLoadingAdjust] = useState(false);
  const { confirm, node } = useConfirm();
  const cur = v.refs.find((r) => r.version === v.currentRef);
  const urls = cur ? v.urls.refs[cur.version] : undefined;
  const isDesign = v.kind === 'design';
  const adjust = async (r: RefVersion) => {
    setLoadingAdjust(true);
    try { setEditor({ upload: await uploadFrom({ type: 'voice-ref', voiceId: v.id, version: r.version }), from: r }); } catch (e) { toastError(e); } finally { setLoadingAdjust(false); }
  };
  const remove = async (r: RefVersion) => {
    if (!(await confirm('删除版本', `删除参考音频 v${r.version}？`, '删除', true))) return;
    try { await del(`/api/voices/${v.id}/refs/${r.version}`); } catch (e) { toastError(e); }
  };
  const activate = async (r: RefVersion) => {
    try { await post(`/api/voices/${v.id}/refs/${r.version}/activate`); toast(`已切换到 v${r.version}`); } catch (e) { toastError(e); }
  };
  return (
    <section className="card">
      <div className="section-head">
        <h3 className="card-title">{isDesign ? '固化的参考音频' : '参考音频'}</h3>
        {cur && <span className="muted small">v{cur.version} · {seconds(cur.processedDurationMs)} · {bytes(cur.processedBytes)}</span>}
        <span className="spacer" />
        {cur && <Button size="sm" icon="settings" busy={loadingAdjust} onClick={() => adjust(cur)} title="基于这个版本的原始音频重新截取和处理">调整预处理</Button>}
        {!isDesign && <Button size="sm" icon="upload" onClick={() => setEditor({})}>替换参考音频</Button>}
      </div>
      {isDesign && !cur && <Notice kind="info">当前没有固化（有 {v.refs.length} 个历史参考音频版本，可以重新启用）。</Notice>}
      {cur && urls && (
        <div className="ref-current">
          <div className="ab-row">
            <span className="ab-label">处理后</span>
            <WavePlayer item={{ id: `ref-${v.id}-${cur.version}`, url: urls.processed, title: `${v.name} 参考音频`, subtitle: `v${cur.version} 处理后`, peaks: cur.peaks, durationMs: cur.processedDurationMs }} />
          </div>
          <div className="ab-row">
            <span className="ab-label">原始</span>
            <WavePlayer item={{ id: `ref-src-${v.id}-${cur.version}`, url: urls.source, title: `${v.name} 参考音频`, subtitle: `v${cur.version} 原始${cur.region ? '（未截取）' : ''}`, peaks: [], durationMs: Math.round(cur.original.info.durationSec * 1000) }} />
          </div>
          <p className="muted small">
            来源：{SOURCE_LABELS[cur.source] ?? cur.source}{cur.sourceLabel ? `（${cur.sourceLabel}）` : ''} · 预设：{cur.preset === 'custom' ? '自定义' : PROCESS_PRESETS[cur.preset]?.label ?? cur.preset}
            {cur.region && ` · 截取 ${cur.region.start.toFixed(1)}–${cur.region.end.toFixed(1)} 秒`}
            {' · '}原始 {cur.original.info.codec} {cur.original.info.sampleRate / 1000} kHz {bytes(cur.original.bytes)}
          </p>
          <QualityReportView report={cur.report} />
        </div>
      )}
      {v.refs.length > 1 || (isDesign && v.refs.length && !cur) ? (
        <>
          <h4 className="sub-title">历史版本</h4>
          <ul className="version-list">
            {[...v.refs].sort((a, b) => b.version - a.version).map((r) => (
              <li key={r.version} className={r.version === v.currentRef ? 'is-current' : ''}>
                <b>v{r.version}</b>
                <span className="muted small">{clock(r.createdAt)} · {SOURCE_LABELS[r.source] ?? r.source} · {seconds(r.processedDurationMs)}</span>
                <GradeBadge grade={r.report.grade} />
                <span className="spacer" />
                <WavePlayer size="sm" showTime={false} item={{ id: `ref-${v.id}-${r.version}`, url: v.urls.refs[r.version]?.processed, title: `${v.name} v${r.version}`, peaks: r.peaks, durationMs: r.processedDurationMs }} />
                {r.version === v.currentRef ? <span className="chip chip-sm chip-on">使用中</span> : (
                  <>
                    <Button size="sm" onClick={() => activate(r)}>启用</Button>
                    <IconButton size="sm" icon="trash" label="删除这个版本" onClick={() => remove(r)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {editor && (
        <CloneEditor target={{ type: 'version', voiceId: v.id, voiceName: v.name }} initialUpload={editor.upload}
          initial={editor.from ? { preset: editor.from.preset, params: editor.from.params, region: editor.from.region } : undefined}
          onClose={() => setEditor(null)} onSaved={() => setEditor(null)} />
      )}
      {node}
    </section>
  );
}

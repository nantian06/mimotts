// 音色库：列表、筛选、新建（设计 / 克隆 / 预置变体）、导入导出、对比试听、回收站
import { useMemo, useRef, useState } from 'react';
import type { JobInfo, VoiceGender, VoiceKind, VoiceLang, VoiceRecord } from '../../../shared/types.ts';
import { BUILTIN_VOICES, GENDER_LABELS, LANG_LABELS } from '../../../shared/presets.ts';
import { del, downloadPost, patch, post, uploadRaw } from '../lib/api.ts';
import { fetchInto, peekCache, upsertJob, waitForJob } from '../lib/store.ts';
import { useSettings, useVoices, type VoiceItem } from '../lib/hooks.ts';
import { lsGet, lsSet, truncate } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { playSequence } from '../lib/player.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Empty, Field, GradeBadge, IconButton, KindBadge, Menu, Modal, Segmented, Spinner, useConfirm } from '../components/ui.tsx';
import { voiceStatusText } from '../components/VoicePicker.tsx';
import { WavePlayer } from '../components/Wave.tsx';
import { CloneEditor } from '../components/CloneEditor.tsx';
import { DesignAssist } from '../components/Assist.tsx';
import { InstructionEditor } from '../components/Editors.tsx';
import { Icon } from '../components/icons.tsx';
import { useJobs } from '../lib/store.ts';

type KindFilter = 'all' | VoiceKind;

interface Filters { kind: KindFilter; fav: boolean; gender: VoiceGender | 'any'; lang: VoiceLang | 'any'; tag: string }

export function VoicesPage() {
  const [trash, setTrash] = useState(false);
  const { data, loading } = useVoices(trash);
  const [q, setQ] = useState('');
  const [f, setF] = useState<Filters>(() => lsGet<Filters>('mt.voices.filter', { kind: 'all', fav: false, gender: 'any', lang: 'any', tag: '' }));
  const setFilter = (p: Partial<Filters>) => setF((o) => { const n = { ...o, ...p }; lsSet('mt.voices.filter', n); return n; });
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<'design' | 'clone' | 'preset' | null>(null);
  const [comparing, setComparing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const { confirm, node } = useConfirm();

  const allTags = useMemo(() => [...new Set((data ?? []).flatMap((v) => v.tags))].filter((t) => t !== '官方').sort(), [data]);
  const list = useMemo(() => (data ?? []).filter((v) => {
    if (f.kind !== 'all' && v.kind !== f.kind) return false;
    if (f.fav && !v.favorite) return false;
    if (f.gender !== 'any' && v.gender !== f.gender) return false;
    if (f.lang !== 'any' && v.lang !== f.lang) return false;
    if (f.tag && !v.tags.includes(f.tag)) return false;
    const k = q.trim().toLowerCase();
    if (k && ![v.name, v.notes, v.description ?? '', v.defaultInstruction, ...v.tags].some((s) => s.toLowerCase().includes(k))) return false;
    return true;
  }), [data, f, q]);
  const counts = useMemo(() => {
    const c = { all: 0, preset: 0, design: 0, clone: 0 } as Record<KindFilter, number>;
    for (const v of data ?? []) { c.all++; c[v.kind]++; }
    return c;
  }, [data]);

  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const r = await uploadRaw<{ imported: { name: string }[] }>('/api/voices/import', file, 'application/zip');
      toast(r.imported.length ? `导入了 ${r.imported.length} 个音色：${r.imported.slice(0, 3).map((x) => x.name).join('、')}${r.imported.length > 3 ? ' 等' : ''}` : '压缩包里没有可导入的音色', r.imported.length ? 'ok' : 'info');
    } catch (e) { toastError(e); } finally { setImporting(false); }
  };
  const exportIds = (ids: string[]) => downloadPost('/api/voices/export', { ids }, 'mimotts-音色库.zip').catch(toastError);
  const selectedUser = [...sel].filter((id) => !id.startsWith('builtin-'));
  const emptyTrash = async () => {
    const items = data ?? [];
    if (!items.length) return;
    if (!(await confirm('清空回收站', `彻底删除回收站里的 ${items.length} 个音色？删除后无法恢复。`, '彻底删除', true))) return;
    for (const v of items) await del(`/api/voices/${v.id}`).catch(toastError);
  };

  return (
    <div className="page voices-page">
      <header className="page-head">
        <h1>{trash ? '音色回收站' : '音色库'}</h1>
        {!trash && <span className="muted small">{counts.preset} 预置 · {counts.design} 设计 · {counts.clone} 克隆</span>}
        <span className="spacer" />
        {trash ? (
          <>
            <Button variant="danger" icon="trash" disabled={!data?.length} onClick={emptyTrash}>清空回收站</Button>
            <Button icon="back" onClick={() => setTrash(false)}>返回音色库</Button>
          </>
        ) : selecting ? (
          <>
            <span className="muted small">已选 {sel.size} 个</span>
            <Button icon="play" disabled={!sel.size} onClick={() => setComparing(true)}>对比试听</Button>
            <Button icon="export" disabled={!selectedUser.length} onClick={() => exportIds(selectedUser)} title="官方预置音色不需要导出">导出所选</Button>
            <Button variant="ghost" onClick={() => { setSelecting(false); setSel(new Set()); }}>完成</Button>
          </>
        ) : (
          <>
            <Button icon="check" onClick={() => setSelecting(true)}>多选</Button>
            <Menu trigger={(open) => <Button icon="more" onClick={open}>导入导出</Button>} items={[
              { label: importing ? '正在导入…' : '导入音色包（.zip）', icon: 'import', disabled: importing, onSelect: () => fileRef.current?.click() },
              { label: '导出全部自建音色', icon: 'export', onSelect: () => exportIds([]) },
              'sep',
              { label: '回收站', icon: 'trash', onSelect: () => { setTrash(true); setSelecting(false); } },
            ]} />
            <Menu trigger={(open) => <Button variant="primary" icon="plus" onClick={open}>新建音色</Button>} items={[
              { label: '设计音色：用文字描述一个声音', icon: 'pen', onSelect: () => setCreating('design') },
              { label: '克隆音色：上传或录一段参考音频', icon: 'mic', onSelect: () => setCreating('clone') },
              { label: '预置变体：官方音色 + 默认指令', icon: 'wave', onSelect: () => setCreating('preset') },
            ]} />
          </>
        )}
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) doImport(file); e.target.value = ''; }} />
      </header>

      <div className="toolbar">
        <label className="search"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称、标签、描述、备注" aria-label="搜索音色" /></label>
        <Segmented size="sm" value={f.kind} onChange={(kind) => setFilter({ kind })} ariaLabel="音色类型" options={[
          { value: 'all', label: `全部` }, { value: 'preset', label: '预置' }, { value: 'design', label: '设计' }, { value: 'clone', label: '克隆' },
        ]} />
        <IconButton icon="star" label="只看收藏" active={f.fav} onClick={() => setFilter({ fav: !f.fav })} />
        <select value={f.gender} onChange={(e) => setFilter({ gender: e.target.value as Filters['gender'] })} aria-label="性别">
          <option value="any">性别不限</option>
          {Object.entries(GENDER_LABELS).filter(([k]) => k).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={f.lang} onChange={(e) => setFilter({ lang: e.target.value as Filters['lang'] })} aria-label="语言">
          <option value="any">语言不限</option>
          {Object.entries(LANG_LABELS).filter(([k]) => k).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {allTags.length > 0 && (
          <select value={f.tag} onChange={(e) => setFilter({ tag: e.target.value })} aria-label="标签">
            <option value="">全部标签</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {!data && loading && <p className="muted pad">加载中…</p>}
      {data && !list.length && (
        <Empty icon="library" title={trash ? '回收站是空的' : data.length ? '没有匹配的音色' : '音色库是空的'}>
          {!trash && !data.length && '新建一个设计或克隆音色试试。'}
        </Empty>
      )}
      <ul className="voice-grid">
        {list.map((v) => (
          <VoiceCard key={v.id} v={v} trash={trash} selecting={selecting} selected={sel.has(v.id)} onSelect={() => toggleSel(v.id)} />
        ))}
      </ul>

      {creating === 'design' && <NewDesign onClose={() => setCreating(null)} />}
      {creating === 'preset' && <NewPresetVariant onClose={() => setCreating(null)} />}
      {creating === 'clone' && <CloneEditor target={{ type: 'new' }} onClose={() => setCreating(null)} onSaved={(rec) => { setCreating(null); navigate(`/voices/${rec.id}`); }} />}
      {comparing && <Compare ids={[...sel]} voices={data ?? []} onClose={() => setComparing(false)} />}
      {node}
    </div>
  );
}

function VoiceCard({ v, trash, selecting, selected, onSelect }: { v: VoiceItem; trash: boolean; selecting: boolean; selected: boolean; onSelect: () => void }) {
  const previewJob = useJobs((j) => j.kind === 'preview' && j.voiceId === v.id && !['done', 'failed', 'canceled'].includes(j.status))[0];
  const { data: s } = useSettings();
  const stalePreview = v.preview && v.preview.voiceVersion !== v.version;
  const preview = async () => {
    try { const { job } = await post<{ job: JobInfo }>(`/api/voices/${v.id}/preview`, {}); upsertJob(job); } catch (e) { toastError(e); }
  };
  const open = () => (selecting ? onSelect() : navigate(`/voices/${v.id}`));
  return (
    <li className={`voice-card kind-edge-${v.kind} ${selected ? 'is-selected' : ''}`}>
      <div className="voice-card-head">
        {selecting && <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择 ${v.name}`} />}
        <button type="button" className="voice-card-name" onClick={open}>{v.name}</button>
        <KindBadge kind={v.kind} mode={v.mode} builtin={v.builtin} />
        <span className="spacer" />
        {!trash && <IconButton size="sm" icon="star" label={v.favorite ? '取消收藏' : '收藏'} active={v.favorite} onClick={() => patch(`/api/voices/${v.id}`, { favorite: !v.favorite }).catch(toastError)} />}
      </div>
      <p className="voice-card-sub">
        {voiceStatusText(v)}
        {v.grade && <> · <GradeBadge grade={v.grade} /></>}
      </p>
      {v.kind === 'design' && v.description && <p className="voice-card-desc" title={v.description}>{truncate(v.description, 70)}</p>}
      {v.defaultInstruction && <p className="voice-card-desc muted" title={v.defaultInstruction}><Icon name="pen" size={12} /> {truncate(v.defaultInstruction, 50)}</p>}
      {v.tags.filter((t) => t !== '官方').length > 0 && (
        <div className="chips">{v.tags.filter((t) => t !== '官方').slice(0, 5).map((t) => <span key={t} className="chip chip-sm">{t}</span>)}</div>
      )}
      <div className="voice-card-foot">
        {previewJob ? <span className="muted small"><Spinner size={13} /> 生成试听中…</span>
          : v.preview ? <WavePlayer size="sm" item={{ id: `pv-${v.id}`, url: v.preview.url, title: v.name, subtitle: '标准试听', peaks: v.preview.peaks, durationMs: v.preview.durationMs }} />
          : <Button size="sm" variant="quiet" icon="play" disabled={trash || (v.kind === 'design' && v.status === 'draft' && !v.description)} onClick={preview}>生成试听</Button>}
        {(stalePreview || (v.preview && s && v.preview.text !== s.ui.previewText)) && !previewJob && !trash && (
          <IconButton size="sm" icon="refresh" label={stalePreview ? '音色已更新，重新生成试听' : '试听文本已改，重新生成'} onClick={preview} />
        )}
        <span className="spacer" />
        {v.refCount > 0 && <span className="muted small" title="被剧本项目里的角色使用"><Icon name="users" size={13} /> {v.refCount}</span>}
      </div>
    </li>
  );
}

function NewDesign({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gender, setGender] = useState<VoiceGender>('');
  const [assist, setAssist] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const rec = await post<VoiceRecord>('/api/voices', { kind: 'design', name: name.trim() || '新设计音色', description: description.trim(), gender, lang: 'zh' });
      onClose();
      navigate(`/voices/${rec.id}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="新建设计音色" width={600} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" busy={busy} disabled={!description.trim()} onClick={save}>创建并去抽卡</Button></>}>
      <p className="muted small">用一段文字描述声音，用「音色设计」模型生成。同一段描述每次生成的声音都会略有不同：先多抽几条试听，挑一条满意的「固化」，之后这个音色就稳定了，也能配合风格指令使用。</p>
      <Field label="名称"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：温柔大姐姐" data-autofocus /></Field>
      <Field label={<>音色描述 <button type="button" className="link-btn" onClick={() => setAssist(true)}><Icon name="sparkle" size={13} /> 帮我写</button></>}
        hint="性别年龄、音色质感、情绪基调、语速节奏、人设口音。写得越具体越稳定。">
        <AutoTextarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={3} placeholder="例如：二十多岁的年轻女性，声音清亮带一点气声，语速偏慢，说话温柔有耐心，像深夜电台主播" />
      </Field>
      <Field label="性别"><select value={gender} onChange={(e) => setGender(e.target.value as VoiceGender)}>{Object.entries(GENDER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {assist && <DesignAssist draft={description} onClose={() => setAssist(false)} onApply={(o) => setDescription(o.description)} />}
    </Modal>
  );
}

function NewPresetVariant({ onClose }: { onClose: () => void }) {
  const [presetId, setPresetId] = useState(BUILTIN_VOICES[1].presetId);
  const [name, setName] = useState('');
  const [ins, setIns] = useState('');
  const [busy, setBusy] = useState(false);
  const b = BUILTIN_VOICES.find((x) => x.presetId === presetId)!;
  const save = async () => {
    setBusy(true);
    try {
      const rec = await post<VoiceRecord>('/api/voices', { kind: 'preset', presetId, name: name.trim() || `${b.name}·变体`, defaultInstruction: ins, gender: b.gender, lang: b.lang });
      onClose();
      navigate(`/voices/${rec.id}`);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="新建预置变体" width={600} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" busy={busy} onClick={save}>创建</Button></>}>
      <p className="muted small">给官方音色配一条默认风格指令，存成一个常用的「人设」。合成时指令留空就会用这条。</p>
      <div className="row gap">
        <Field label="官方音色">
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} data-autofocus>
            {BUILTIN_VOICES.map((x) => <option key={x.id} value={x.presetId}>{x.name}（{x.notes}）</option>)}
          </select>
        </Field>
        <Field label="名称"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${b.name}·变体`} /></Field>
      </div>
      <Field label="默认风格指令">
        <InstructionEditor value={ins} onChange={setIns} text="" placeholder="例如：用新闻播报的腔调，字正腔圆，语速平稳" />
      </Field>
    </Modal>
  );
}

function Compare({ ids, voices, onClose }: { ids: string[]; voices: VoiceItem[]; onClose: () => void }) {
  const { data: s } = useSettings();
  const [text, setText] = useState(s?.ui.previewText ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const items = ids.map((id) => voices.find((v) => v.id === id)).filter(Boolean) as VoiceItem[];
  const go = async (force = false) => {
    setBusy(true);
    setDone(0);
    try {
      const r = await post<{ text: string; items: { voiceId: string; job?: JobInfo; cached?: boolean }[] }>('/api/voices/compare', { ids, text, force });
      let n = 0;
      await Promise.all(r.items.map(async (it) => {
        if (it.job) { upsertJob(it.job); const j = await waitForJob(it.job.id); if (j.status === 'failed') toast(`${voices.find((v) => v.id === it.voiceId)?.name}：${j.error}`, 'err'); }
        setDone(++n);
      }));
      await fetchInto('/api/voices');
      const fresh = peekCache<VoiceItem[]>('/api/voices') ?? [];
      const seq = r.items.map((it) => fresh.find((v) => v.id === it.voiceId)).filter((v): v is VoiceItem => !!v?.preview)
        .map((v) => ({ id: `pv-${v.id}`, url: v.preview!.url, title: v.name, subtitle: '对比试听', peaks: v.preview!.peaks, durationMs: v.preview!.durationMs, pauseAfterMs: 600 }));
      playSequence(seq, 0, 'compare');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`对比试听（${items.length} 个音色）`} width={600} onClose={onClose}
      footer={<>
        <span className="muted small">{busy ? `准备中 ${done}/${items.length}` : '用同一段文本依次播放，已有相同文本的试听会直接复用'}</span>
        <span className="spacer" />
        <Button variant="ghost" disabled={busy} onClick={() => go(true)}>全部重新生成</Button>
        <Button variant="primary" icon="play" busy={busy} disabled={!items.length} onClick={() => go(false)}>依次播放</Button>
      </>}>
      <Field label="试听文本"><AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} /></Field>
      <ol className="compare-list">{items.map((v) => <li key={v.id} className={`kind-edge-${v.kind}`}>{v.name} <KindBadge kind={v.kind} mode={v.mode} builtin={v.builtin} /></li>)}</ol>
    </Modal>
  );
}

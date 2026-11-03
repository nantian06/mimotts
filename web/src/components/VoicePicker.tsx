// 音色选择：音色库（含官方预置）或临时设计音色
import { useMemo, useState } from 'react';
import type { VoiceSelector } from '../../../shared/types.ts';
import { GENDER_LABELS, LANG_LABELS } from '../../../shared/presets.ts';
import { truncate } from '../../../shared/text.ts';
import { useVoices, type VoiceItem } from '../lib/hooks.ts';
import { AutoTextarea, Button, KindBadge, Modal, Segmented } from './ui.tsx';
import { WavePlayer } from './Wave.tsx';
import { Icon } from './icons.tsx';

export function voiceStatusText(v: VoiceItem): string {
  if (v.builtin) return [GENDER_LABELS[v.gender] !== '未标注' ? GENDER_LABELS[v.gender] : '', LANG_LABELS[v.lang] !== '未标注' ? LANG_LABELS[v.lang] : ''].filter(Boolean).join('，') || '官方预置';
  if (v.kind === 'preset') return `基于 ${v.presetId}${v.defaultInstruction ? '，带默认指令' : ''}`;
  if (v.kind === 'design') return v.status === 'fixed' ? '已固化，音色稳定' : v.takeCount ? `未固化，${v.takeCount} 条试听` : '未固化，还没有试听';
  return v.refDurationMs ? `参考音频 ${(v.refDurationMs / 1000).toFixed(1)} 秒` : '克隆音色';
}

export function VoiceSlot({ value, onChange, allowAdhoc = true, compact }: { value: VoiceSelector | null; onChange: (v: VoiceSelector) => void; allowAdhoc?: boolean; compact?: boolean }) {
  const { data } = useVoices();
  const [open, setOpen] = useState(false);
  const v = value?.type === 'library' ? data?.find((x) => x.id === value.id) : undefined;
  const kind = value?.type === 'adhoc-design' ? 'design' : v?.kind ?? 'preset';
  return (
    <>
      <button type="button" className={`voice-slot kind-edge-${kind} ${compact ? 'is-compact' : ''}`} onClick={() => setOpen(true)} aria-label="选择音色">
        {value?.type === 'adhoc-design' ? (
          <><span className="voice-slot-name">临时设计音色</span><span className="voice-slot-sub">{truncate(value.description, 40)}</span></>
        ) : v ? (
          <><span className="voice-slot-name">{v.name} <KindBadge kind={v.kind} mode={v.mode} builtin={v.builtin} /></span><span className="voice-slot-sub">{voiceStatusText(v)}</span></>
        ) : value?.type === 'library' ? (
          <><span className="voice-slot-name">音色不存在</span><span className="voice-slot-sub">可能已被删除，重新选一个</span></>
        ) : (
          <><span className="voice-slot-name">选择音色</span><span className="voice-slot-sub">官方预置、设计或克隆音色</span></>
        )}
        <Icon name="chevron" size={16} className="voice-slot-caret" />
      </button>
      {open && <VoicePickerModal value={value} allowAdhoc={allowAdhoc} onClose={() => setOpen(false)} onPick={(s) => { onChange(s); setOpen(false); }} />}
    </>
  );
}

export function VoicePickerModal({ value, onPick, onClose, allowAdhoc = true, title = '选择音色' }: { value: VoiceSelector | null; onPick: (v: VoiceSelector) => void; onClose: () => void; allowAdhoc?: boolean; title?: string }) {
  const { data } = useVoices();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'fav' | 'preset' | 'design' | 'clone'>('all');
  const [desc, setDesc] = useState(value?.type === 'adhoc-design' ? value.description : '');
  const list = useMemo(() => (data ?? []).filter((v) => {
    if (filter === 'fav' && !v.favorite) return false;
    if (filter !== 'all' && filter !== 'fav' && v.kind !== filter) return false;
    if (!q.trim()) return true;
    const k = q.trim().toLowerCase();
    return [v.name, v.notes, v.description ?? '', ...v.tags].some((s) => s.toLowerCase().includes(k));
  }), [data, q, filter]);
  return (
    <Modal title={title} width={720} onClose={onClose} className="picker">
      <div className="row gap wrap">
        <label className="search"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称、标签、描述" data-autofocus /></label>
        <Segmented size="sm" value={filter} onChange={setFilter} ariaLabel="类型"
          options={[{ value: 'all', label: '全部' }, { value: 'fav', label: '收藏' }, { value: 'preset', label: '预置' }, { value: 'design', label: '设计' }, { value: 'clone', label: '克隆' }]} />
      </div>
      <ul className="picker-list">
        {list.map((v) => {
          const selected = value?.type === 'library' && value.id === v.id;
          return (
            <li key={v.id} className={`picker-item kind-edge-${v.kind} ${selected ? 'is-selected' : ''}`}>
              <button type="button" className="picker-main" onClick={() => onPick({ type: 'library', id: v.id })}>
                <span className="picker-name">{v.name} <KindBadge kind={v.kind} mode={v.mode} builtin={v.builtin} />{v.favorite && <Icon name="star" size={13} className="fav-on" />}</span>
                <span className="picker-sub">{voiceStatusText(v)}{v.tags.filter((t) => t !== '官方').length ? `，${v.tags.filter((t) => t !== '官方').slice(0, 4).join('、')}` : ''}</span>
              </button>
              {v.preview ? <WavePlayer size="sm" showTime={false} item={{ id: `pv-${v.id}`, url: v.preview.url, title: v.name, subtitle: '试听', peaks: v.preview.peaks, durationMs: v.preview.durationMs }} /> : <span className="muted small">无试听</span>}
            </li>
          );
        })}
        {!list.length && <li className="muted picker-none">没有匹配的音色</li>}
      </ul>
      {allowAdhoc && (
        <div className="picker-adhoc">
          <p><b>临时设计音色</b>　直接写一段音色描述来合成，不存进音色库。满意的话之后可以把结果存为设计音色。</p>
          <AutoTextarea value={desc} onChange={(e) => setDesc(e.target.value)} minRows={2} placeholder="例如：一位年迈的老先生，带北方口音，语速缓慢而沉稳，嗓音略带沙哑" />
          <Button variant="primary" size="sm" disabled={!desc.trim()} onClick={() => onPick({ type: 'adhoc-design', description: desc.trim() })}>使用这段描述</Button>
        </div>
      )}
    </Modal>
  );
}

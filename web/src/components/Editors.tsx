// 风格指令编辑器（自然语言 / 导演模式）与合成文本编辑器（标签面板、切块预览）
import { useMemo, useRef, useState } from 'react';
import { composeDirector, parseDirector, addLeadingStyle, removeLeadingStyle, parseLeadingTag, wrapInlineTag, chunkText, isSinging, visibleLength, type DirectorParts } from '../../../shared/text.ts';
import { INLINE_TAG_GROUPS, STYLE_TAG_GROUPS } from '../../../shared/presets.ts';
import type { SynthMode } from '../../../shared/types.ts';
import { AutoTextarea, Button, Notice, Segmented } from './ui.tsx';
import { InstructionAssist, TagAssist } from './Assist.tsx';
import { Icon } from './icons.tsx';
import { useSettings } from '../lib/hooks.ts';

export function InstructionEditor({ value, onChange, text, voiceLabel, disabled, disabledReason, placeholder, compact, inheritHint, onBlur, onFocus }: {
  value: string;
  onChange: (v: string) => void;
  text?: string;
  voiceLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  compact?: boolean;
  inheritHint?: string;
  onBlur?: () => void;
  onFocus?: () => void;
}) {
  const parsed = useMemo(() => parseDirector(value), [value]);
  const [mode, setMode] = useState<'natural' | 'director'>(parsed ? 'director' : 'natural');
  const [assist, setAssist] = useState(false);
  const parts: DirectorParts = parsed ?? { role: '', scene: '', guidance: '' };
  const setPart = (k: keyof DirectorParts, v: string) => onChange(composeDirector({ ...parts, [k]: v }));

  if (disabled) {
    return <div className="instruction is-disabled"><Notice kind="info">{disabledReason ?? '当前音色不能使用风格指令'}</Notice></div>;
  }
  return (
    <div className={`instruction ${compact ? 'is-compact' : ''}`}>
      <div className="instruction-bar">
        <Segmented size="sm" value={mode} ariaLabel="指令形式" onChange={(m) => {
          if (m === 'director' && !parsed && value.trim()) onChange(composeDirector({ role: '', scene: '', guidance: value }));
          if (m === 'natural' && parsed) onChange([parsed.role, parsed.scene, parsed.guidance].filter(Boolean).join('\n'));
          setMode(m);
        }} options={[{ value: 'natural', label: '自然语言' }, { value: 'director', label: '导演模式', title: '角色 / 场景 / 指导，像给演员写剧本' }]} />
        <span className="spacer" />
        {text !== undefined && <Button size="sm" variant="quiet" icon="sparkle" onClick={() => setAssist(true)}>帮我写</Button>}
      </div>
      {mode === 'natural' ? (
        <AutoTextarea value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onFocus={onFocus} minRows={compact ? 1 : 2}
          placeholder={placeholder ?? '用一两句话说明想要的语气，例如：用轻快上扬的语调报喜，语速稍快，带着压不住的激动'} aria-label="风格指令" />
      ) : (
        <div className="director-grid">
          <label><span>角色</span><AutoTextarea value={parts.role} onChange={(e) => setPart('role', e.target.value)} onBlur={onBlur} onFocus={onFocus} minRows={1} placeholder="身份、性格底色、外形气质、说话习惯" /></label>
          <label><span>场景</span><AutoTextarea value={parts.scene} onChange={(e) => setPart('scene', e.target.value)} onBlur={onBlur} onFocus={onFocus} minRows={1} placeholder="此刻发生了什么、和谁说话、情绪在什么位置" /></label>
          <label><span>指导</span><AutoTextarea value={parts.guidance} onChange={(e) => setPart('guidance', e.target.value)} onBlur={onBlur} onFocus={onFocus} minRows={2} placeholder={'语速、气息、停顿、重音、音色质感、情绪起伏\n- 可以分条写'} /></label>
        </div>
      )}
      {inheritHint && !value.trim() && <p className="inherit-hint">留空时使用：{inheritHint}</p>}
      {assist && <InstructionAssist text={text ?? ''} voiceLabel={voiceLabel} current={value} onClose={() => setAssist(false)} onApply={(v) => { onChange(v); setMode(parseDirector(v) ? 'director' : 'natural'); onBlur?.(); }} />}
    </div>
  );
}

export function TagPalette({ text, onText, insert, mode }: { text: string; onText: (v: string) => void; insert: (tag: string) => void; mode?: SynthMode }) {
  const [open, setOpen] = useState<'style' | 'inline' | null>(null);
  const lead = parseLeadingTag(text);
  const active = new Set(lead?.items ?? []);
  return (
    <>
      <Button size="sm" variant={open === 'style' ? 'plain' : 'quiet'} aria-expanded={open === 'style'} onClick={() => setOpen(open === 'style' ? null : 'style')}>(风格) 开头标签</Button>
      <Button size="sm" variant={open === 'inline' ? 'plain' : 'quiet'} aria-expanded={open === 'inline'} onClick={() => setOpen(open === 'inline' ? null : 'inline')}>行内音频标签</Button>
      {open && (
        <div className="tag-panel">
          <p className="muted small">
            {open === 'style' ? '加在文本最前面，决定整段的风格；可以组合多个，也可以手写列表外的词。' : '插在光标位置，细粒度控制呼吸、停顿、哭笑、语速。可以组合，如（紧张，深呼吸）。'}
          </p>
          {(open === 'style' ? STYLE_TAG_GROUPS : INLINE_TAG_GROUPS).map((g) => (
            <div className="tag-group" key={g.label}>
              <span className="tag-group-label">{g.label}</span>
              <div className="tag-group-items">
                {g.items.map((t) => {
                  const on = open === 'style' && active.has(t);
                  const disabled = open === 'style' && t === '唱歌' && mode !== undefined && mode !== 'preset';
                  return (
                    <button key={t} type="button" className={`chip ${on ? 'chip-on' : 'chip-ghost'}`} disabled={disabled} aria-pressed={open === 'style' ? on : undefined}
                      title={disabled ? '唱歌只支持预置音色' : undefined}
                      onClick={() => open === 'style' ? onText(on ? removeLeadingStyle(text, t) : addLeadingStyle(text, t)) : insert(t)}>{t}</button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function TextEditor({ value, onChange, mode, placeholder, minRows = 6 }: { value: string; onChange: (v: string) => void; mode?: SynthMode; placeholder?: string; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const { data: s } = useSettings();
  const [assist, setAssist] = useState(false);
  const [showChunks, setShowChunks] = useState(false);
  const chunks = useMemo(() => (s ? chunkText(value, { maxChars: s.mimo.maxChars, carryLeadingTag: s.mimo.carryLeadingTag }) : []), [value, s?.mimo.maxChars, s?.mimo.carryLeadingTag]);
  const insert = (tag: string) => {
    const el = ref.current;
    const t = wrapInlineTag(tag, s?.ui.tagBracket ?? 'full');
    if (!el) { onChange(value + t); return; }
    const a = el.selectionStart ?? value.length;
    const b = el.selectionEnd ?? a;
    onChange(value.slice(0, a) + t + value.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + t.length, a + t.length); });
  };
  const singing = isSinging(value);
  return (
    <div className="text-editor">
      <AutoTextarea innerRef={ref} value={value} onChange={(e) => onChange(e.target.value)} minRows={minRows} aria-label="要合成的文本"
        placeholder={placeholder ?? '输入要合成的文本。开头可以加 (风格) 标签，句中可以插入（叹气）（轻笑）这样的音频标签。'} />
      <div className="text-editor-bar">
        <TagPalette text={value} onText={onChange} insert={insert} mode={mode} />
        <Button size="sm" variant="quiet" icon="sparkle" disabled={!value.trim()} onClick={() => setAssist(true)}>自动打标签</Button>
        <span className="spacer" />
        <span className="count">{visibleLength(value)} 字</span>
        {chunks.length > 1 && (
          <button type="button" className="link-btn" onClick={() => setShowChunks((v) => !v)} aria-expanded={showChunks}>将分 {chunks.length} 段请求</button>
        )}
      </div>
      {singing && mode && mode !== 'preset' && <Notice kind="error">唱歌模式只支持预置音色，换一个预置音色，或去掉开头的 (唱歌) 标签。</Notice>}
      {showChunks && chunks.length > 1 && (
        <ol className="chunk-list">
          {chunks.map((c, i) => <li key={i}><span>{c.text}</span><small>{c.gapAfter === 'paragraph' ? '段落停顿' : c.gapAfter === 'sentence' ? '句间停顿' : ''}</small></li>)}
        </ol>
      )}
      {assist && <TagAssist text={value} onClose={() => setAssist(false)} onApply={onChange} />}
    </div>
  );
}

export function KindIcon({ kind }: { kind: string }) {
  return <Icon name={kind === 'clone' ? 'mic' : kind === 'design' ? 'pen' : 'wave'} size={14} />;
}

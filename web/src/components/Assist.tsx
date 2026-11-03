// 大模型辅助：模型选择、请求查看、指令/标签/音色描述对话框、差异视图
import { useMemo, useState } from 'react';
import type { LlmDebug, LlmModelRef, LlmRunResult, PublicSettings } from '../../../shared/types.ts';
import { composeDirector, parseDirector, type DirectorParts } from '../../../shared/text.ts';
import { diffChars } from '../../../shared/diff.ts';
import { post } from '../lib/api.ts';
import { useSettings } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { lsGet, lsSet } from '../lib/format.ts';
import { toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Field, Modal, Notice, Segmented } from './ui.tsx';
import { Icon } from './icons.tsx';

export function llmReady(s?: PublicSettings): boolean {
  return !!s?.llm.defaultModel;
}

/** 本次使用的模型（默认 = 设置里的默认模型；选择会记住） */
export function useModelChoice(): [LlmModelRef | null, (m: LlmModelRef | null) => void, PublicSettings | undefined] {
  const { data: s } = useSettings();
  const [m, setM] = useState<LlmModelRef | null>(() => lsGet<LlmModelRef | null>('mt.llm.model', null));
  const valid = m && s?.llm.endpoints.some((e) => e.id === m.endpointId && e.models.includes(m.model)) ? m : null;
  return [valid, (v) => { setM(v); lsSet('mt.llm.model', v); }, s];
}

export function ModelSelect({ value, onChange, settings }: { value: LlmModelRef | null; onChange: (m: LlmModelRef | null) => void; settings?: PublicSettings }) {
  if (!settings) return null;
  const def = settings.llm.defaultModel;
  const defEp = settings.llm.endpoints.find((e) => e.id === def?.endpointId);
  const opts = settings.llm.endpoints.flatMap((e) => e.models.map((mo) => ({ key: `${e.id}::${mo}`, label: `${e.name} / ${mo}` })));
  return (
    <label className="model-select">
      <Icon name="sparkle" size={14} />
      <select value={value ? `${value.endpointId}::${value.model}` : ''} onChange={(e) => {
        const v = e.target.value;
        if (!v) onChange(null);
        else { const [endpointId, model] = v.split('::'); onChange({ endpointId, model }); }
      }} aria-label="使用的大模型">
        <option value="">默认：{def ? `${defEp?.name ?? '?'} / ${def.model}` : '未设置'}</option>
        {opts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function NeedLlm() {
  return (
    <Notice kind="warn" action={<Button size="sm" onClick={() => navigate('/settings?tab=llm')}>去设置</Button>}>
      还没有配置辅助大模型。到「设置 → 大模型辅助」添加一个 OpenAI 兼容端点并选择默认模型后就能用。
    </Notice>
  );
}

export function DebugPanel({ debug }: { debug?: LlmDebug | LlmDebug[] }) {
  const list = !debug ? [] : Array.isArray(debug) ? debug : [debug];
  if (!list.length) return null;
  return (
    <details className="debug">
      <summary><Icon name="code" size={14} />查看本次实际发送的请求（{list.length} 次调用，共 {(list.reduce((n, d) => n + d.durationMs, 0) / 1000).toFixed(1)} 秒）</summary>
      {list.map((d, i) => (
        <div key={i} className="debug-item">
          <p><b>POST</b> {d.url}　模型 <b>{d.model}</b>　{(d.durationMs / 1000).toFixed(1)} 秒{d.attempts > 1 ? '（JSON 解析失败后重试过一次）' : ''}</p>
          <pre>{JSON.stringify(d.request, null, 2)}</pre>
          <p className="muted">模型原始输出</p>
          <pre>{d.rawContent}</pre>
          {d.usage ? <p className="muted">用量：{JSON.stringify(d.usage)}</p> : null}
        </div>
      ))}
    </details>
  );
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffChars(before, after), [before, after]);
  return (
    <div className="diff" aria-label="改动对比">
      {parts.map((p, i) => <span key={i} className={`diff-${p.type}`}>{p.text}</span>)}
    </div>
  );
}

async function run<T>(task: string, vars: Record<string, string>, model: LlmModelRef | null): Promise<LlmRunResult<T>> {
  return post<LlmRunResult<T>>('/api/llm/run', { task, vars, model });
}

// ───────────────────────── 风格指令 ─────────────────────────

export function InstructionAssist({ text, voiceLabel, current, onApply, onClose }: {
  text: string; voiceLabel?: string; current: string; onApply: (v: string) => void; onClose: () => void;
}) {
  const [model, setModel, settings] = useModelChoice();
  const [mode, setMode] = useState<'natural' | 'director'>(parseDirector(current) ? 'director' : 'natural');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [natural, setNatural] = useState('');
  const [dir, setDir] = useState<DirectorParts | null>(null);
  const [res, setRes] = useState<LlmRunResult | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const vars = { text, intent, voice: voiceLabel ?? '' };
      if (mode === 'natural') { const r = await run<string>('instruction-natural', vars, model); setNatural(r.output); setRes(r); }
      else { const r = await run<DirectorParts>('instruction-director', vars, model); setDir(r.output); setRes(r); }
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const result = mode === 'natural' ? natural : dir ? composeDirector(dir) : '';
  return (
    <Modal title="用大模型写风格指令" width={680} onClose={onClose}
      footer={<>
        <ModelSelect value={model} onChange={setModel} settings={settings} />
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!result.trim()} onClick={() => { onApply(result); onClose(); }}>采用这条指令</Button>
      </>}>
      {!llmReady(settings) && <NeedLlm />}
      {!text.trim() && <Notice kind="warn">先在文本框里写好要合成的文本，大模型会根据内容写指令。</Notice>}
      <div className="row gap">
        <Segmented value={mode} onChange={(v) => { setMode(v); setRes(null); }} options={[{ value: 'natural', label: '自然语言' }, { value: 'director', label: '导演模式' }]} ariaLabel="指令形式" />
        <span className="muted small">{mode === 'natural' ? '1–3 句话说清情绪、语气、节奏' : '按角色、场景、指导三段刻画，适合角色配音'}</span>
      </div>
      <Field label="你想要的感觉（可选）" hint="例如：深夜电台、压抑着委屈、像在给小朋友讲故事">
        <input value={intent} onChange={(e) => setIntent(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} placeholder="一句话描述你的意图" />
      </Field>
      <Button icon="sparkle" variant="primary" busy={busy} disabled={!text.trim() || !llmReady(settings)} onClick={go}>{res ? '重新生成' : '生成'}</Button>
      {res && mode === 'natural' && (
        <Field label="生成结果（可以直接修改）"><AutoTextarea value={natural} onChange={(e) => setNatural(e.target.value)} minRows={3} /></Field>
      )}
      {res && mode === 'director' && dir && (
        <div className="director-grid">
          <Field label="角色"><AutoTextarea value={dir.role} onChange={(e) => setDir({ ...dir, role: e.target.value })} /></Field>
          <Field label="场景"><AutoTextarea value={dir.scene} onChange={(e) => setDir({ ...dir, scene: e.target.value })} /></Field>
          <Field label="指导"><AutoTextarea value={dir.guidance} onChange={(e) => setDir({ ...dir, guidance: e.target.value })} minRows={4} /></Field>
        </div>
      )}
      {res?.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      <DebugPanel debug={res?.debug} />
    </Modal>
  );
}

// ───────────────────────── 自动打标签 ─────────────────────────

export function TagAssist({ text, onApply, onClose }: { text: string; onApply: (v: string) => void; onClose: () => void }) {
  const [model, setModel, settings] = useModelChoice();
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LlmRunResult<string> | null>(null);
  const go = async () => {
    setBusy(true);
    try { setRes(await run<string>('tags', { text, intent }, model)); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="自动打音频标签" width={720} onClose={onClose}
      footer={<>
        <ModelSelect value={model} onChange={setModel} settings={settings} />
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!res} onClick={() => { if (res) { onApply(res.output); onClose(); } }}>采用改动</Button>
      </>}>
      {!llmReady(settings) && <NeedLlm />}
      <p className="muted small">大模型只会插入开头的 (风格) 标签和行内音频标签，不改原文。绿色是新增的部分。</p>
      <Field label="意图（可选）"><input value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="例如：越说越委屈，最后忍不住哭出来" /></Field>
      <Button icon="sparkle" variant="primary" busy={busy} disabled={!text.trim() || !llmReady(settings)} onClick={go}>{res ? '重新生成' : '生成'}</Button>
      {res && <DiffView before={text} after={res.output} />}
      {res?.warnings.map((w) => <Notice key={w} kind="warn">{w}</Notice>)}
      <DebugPanel debug={res?.debug} />
    </Modal>
  );
}

// ───────────────────────── 音色描述 ─────────────────────────

export function DesignAssist({ draft, onApply, onClose }: { draft: string; onApply: (v: { description: string; previewText: string }) => void; onClose: () => void }) {
  const [model, setModel, settings] = useModelChoice();
  const [text, setText] = useState(draft);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<LlmRunResult<{ description: string; previewText: string }> | null>(null);
  const [out, setOut] = useState({ description: '', previewText: '' });
  const go = async () => {
    setBusy(true);
    try {
      const r = await run<{ description: string; previewText: string }>('design-desc', { draft: text, purpose }, model);
      setRes(r);
      setOut(r.output);
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="润色音色描述" width={680} onClose={onClose}
      footer={<>
        <ModelSelect value={model} onChange={setModel} settings={settings} />
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!out.description} onClick={() => { onApply(out); onClose(); }}>采用</Button>
      </>}>
      {!llmReady(settings) && <NeedLlm />}
      <Field label="你的想法" hint="随便写几个关键词也行：性别年龄、音色质感、情绪、语速、人设">
        <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} placeholder="比如：温柔的大姐姐，声音有点哑，讲睡前故事" />
      </Field>
      <Field label="用途（可选）"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="比如：有声书女主、品牌广告旁白" /></Field>
      <Button icon="sparkle" variant="primary" busy={busy} disabled={!text.trim() || !llmReady(settings)} onClick={go}>{res ? '重新生成' : '生成'}</Button>
      {res && (
        <>
          <Field label="音色描述"><AutoTextarea value={out.description} onChange={(e) => setOut({ ...out, description: e.target.value })} minRows={2} /></Field>
          <Field label="配套试听文本"><AutoTextarea value={out.previewText} onChange={(e) => setOut({ ...out, previewText: e.target.value })} minRows={2} /></Field>
        </>
      )}
      <DebugPanel debug={res?.debug} />
    </Modal>
  );
}

export async function generatePreviewText(description: string, model: LlmModelRef | null): Promise<string | null> {
  try {
    const r = await run<string>('preview-text', { description }, model);
    return r.output;
  } catch (e) { toastError(e); return null; }
}

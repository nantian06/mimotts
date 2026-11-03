// 设置：MiMo 接口、大模型辅助、参考音频预处理、提示词模板、界面与剧本默认值、系统状态
import { useEffect, useState, type ReactNode } from 'react';
import type { LlmModelRef, ProcessParams, ProcessPresetId, PromptTemplate, PublicSettings } from '../../../shared/types.ts';
import { MIMO_BASE_URLS, PROCESS_PRESETS } from '../../../shared/presets.ts';
import { del, post, put } from '../lib/api.ts';
import { useApi } from '../lib/store.ts';
import { useSettings, useStatus } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { play } from '../lib/player.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AutoTextarea, Button, Field, IconButton, Notice, Segmented, Spinner, TagInput, Toggle } from '../components/ui.tsx';
import { ParamsForm } from '../components/CloneEditor.tsx';
import { Icon } from '../components/icons.tsx';

const TABS = [
  { id: 'mimo', label: 'MiMo 接口' },
  { id: 'llm', label: '大模型辅助' },
  { id: 'preprocess', label: '参考音频处理' },
  { id: 'prompts', label: '提示词模板' },
  { id: 'ui', label: '界面与剧本' },
  { id: 'status', label: '系统状态' },
];

export function SettingsPage({ tab }: { tab: string }) {
  const { data: s } = useSettings();
  const cur = TABS.some((t) => t.id === tab) ? tab : 'mimo';
  return (
    <div className="page settings-page">
      <header className="page-head"><h1>设置</h1></header>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="设置分类">
          {TABS.map((t) => (
            <a key={t.id} href={`#/settings?tab=${t.id}`} className={cur === t.id ? 'is-on' : ''} aria-current={cur === t.id ? 'page' : undefined}>{t.label}</a>
          ))}
        </nav>
        <div className="settings-body">
          {!s ? <p className="muted"><Spinner /> 加载中…</p>
            : cur === 'mimo' ? <MimoTab s={s} />
            : cur === 'llm' ? <LlmTab s={s} />
            : cur === 'preprocess' ? <PreprocessTab s={s} />
            : cur === 'prompts' ? <PromptsTab />
            : cur === 'ui' ? <UiTab s={s} />
            : <StatusTab />}
        </div>
      </div>
    </div>
  );
}

function useForm<T>(source: T) {
  const [f, setF] = useState<T>(source);
  const key = JSON.stringify(source);
  useEffect(() => setF(source), [key]);
  const dirty = JSON.stringify(f) !== key;
  return { f, set: (p: Partial<T>) => setF((o) => ({ ...o, ...p })), update: (fn: (o: T) => T) => setF(fn), dirty, reset: () => setF(source) };
}

function SaveBar({ dirty, busy, onSave, onReset, extra }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; extra?: ReactNode }) {
  return (
    <div className="save-bar">
      {extra}
      <span className="spacer" />
      {dirty && <span className="muted small">有未保存的改动</span>}
      <Button variant="ghost" disabled={!dirty || busy} onClick={onReset}>还原</Button>
      <Button variant="primary" busy={busy} disabled={!dirty} onClick={onSave}>保存</Button>
    </div>
  );
}

async function saveSettings(patch: unknown, setBusy: (b: boolean) => void): Promise<boolean> {
  setBusy(true);
  try { await put('/api/settings', patch); toast('已保存'); return true; } catch (e) { toastError(e); return false; } finally { setBusy(false); }
}

const num = (v: string | number) => Number(v);

// ───────────────────────── MiMo ─────────────────────────

function MimoTab({ s }: { s: PublicSettings }) {
  const m = s.mimo;
  const { f, set, dirty, reset } = useForm({
    baseUrl: m.baseUrl, apiKey: '', concurrency: m.concurrency, retries: m.retries, timeoutSec: m.timeoutSec, maxChars: m.maxChars,
    sentenceGapMs: m.sentenceGapMs, paragraphGapMs: m.paragraphGapMs, trimChunkSilence: m.trimChunkSilence, carryLeadingTag: m.carryLeadingTag, streamPreset: m.streamPreset,
  });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const isPreset = MIMO_BASE_URLS.some((u) => u.url === f.baseUrl);
  const keyTp = (f.apiKey || m.apiKeyHint).startsWith('tp-');
  const save = async () => { if (await saveSettings({ mimo: f }, setBusy)) set({ apiKey: '' }); };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await post<{ ms: number; durationMs: number; audio: string }>('/api/settings/test-mimo', { baseUrl: f.baseUrl, apiKey: f.apiKey });
      setTest({ ok: true, text: `连接成功：${(r.ms / 1000).toFixed(1)} 秒返回了 ${(r.durationMs / 1000).toFixed(1)} 秒音频` });
      play({ id: `test-${Date.now()}`, url: r.audio, title: '连接测试', subtitle: '你好，连接成功。', durationMs: r.durationMs });
    } catch (e: any) { setTest({ ok: false, text: e?.message ?? String(e) }); } finally { setTesting(false); }
  };
  return (
    <section className="card settings-card">
      <h2 className="card-title">MiMo 接口</h2>
      <Field label="Base URL" hint="按量付费和 Token Plan 的地址不同；也可以填自建代理">
        <div className="row gap wrap">
          <select value={isPreset ? f.baseUrl : ''} onChange={(e) => { if (e.target.value) set({ baseUrl: e.target.value }); }} aria-label="预设地址">
            {MIMO_BASE_URLS.map((u) => <option key={u.url} value={u.url}>{u.label}</option>)}
            <option value="">自定义</option>
          </select>
          <input className="grow" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} spellCheck={false} />
        </div>
      </Field>
      <Field label="API Key" hint={m.apiKeySet ? `已保存：${m.apiKeyHint}。留空表示不修改` : '还没有填写'}>
        <input type="password" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={m.apiKeySet ? '••••••••（不修改）' : 'sk-…'} autoComplete="off" spellCheck={false} />
      </Field>
      {keyTp && f.baseUrl === MIMO_BASE_URLS[0].url && <Notice kind="warn">看起来是 Token Plan 的 Key（tp- 开头），Base URL 可能要选「Token Plan」。</Notice>}
      <div className="row gap">
        <Button icon="bolt" busy={testing} onClick={runTest}>测试连接</Button>
        {test && <span className={test.ok ? 'ok-text small' : 'err-text small'}>{test.text}</span>}
      </div>
      <h3 className="sub-title">请求</h3>
      <div className="form-grid">
        <Field label="并发数" hint="同时进行的合成请求"><input type="number" min={1} max={16} value={f.concurrency} onChange={(e) => set({ concurrency: num(e.target.value) })} /></Field>
        <Field label="失败重试" hint="429 / 5xx 时指数退避重试"><input type="number" min={0} max={8} value={f.retries} onChange={(e) => set({ retries: num(e.target.value) })} /></Field>
        <Field label="超时"><span className="unit-input"><input type="number" min={10} max={900} value={f.timeoutSec} onChange={(e) => set({ timeoutSec: num(e.target.value) })} /><i>秒</i></span></Field>
        <Field label="单次最大字数" hint="超出按句切分，分多次请求再拼接"><input type="number" min={20} max={4000} step={10} value={f.maxChars} onChange={(e) => set({ maxChars: num(e.target.value) })} /></Field>
        <Field label="句间停顿"><span className="unit-input"><input type="number" min={0} max={3000} step={10} value={f.sentenceGapMs} onChange={(e) => set({ sentenceGapMs: num(e.target.value) })} /><i>ms</i></span></Field>
        <Field label="段落停顿"><span className="unit-input"><input type="number" min={0} max={5000} step={10} value={f.paragraphGapMs} onChange={(e) => set({ paragraphGapMs: num(e.target.value) })} /><i>ms</i></span></Field>
      </div>
      <div className="toggle-list">
        <Toggle checked={f.streamPreset} onChange={(v) => set({ streamPreset: v })} label="预置音色使用流式" hint="快速合成时边生成边播放（设计和克隆模型不支持流式）" />
        <Toggle checked={f.carryLeadingTag} onChange={(v) => set({ carryLeadingTag: v })} label="切分后每段沿用开头的 (风格) 标签" hint="长文本分多次请求时保持风格一致" />
        <Toggle checked={f.trimChunkSilence} onChange={(v) => set({ trimChunkSilence: v })} label="拼接前裁掉每段首尾静音" hint="停顿由上面的句间/段落停顿统一控制" />
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset}
        extra={m.apiKeySet ? <button type="button" className="link-btn danger" onClick={() => saveSettings({ mimo: { clearApiKey: true } }, setBusy)}>清除已保存的 Key</button> : undefined} />
    </section>
  );
}

// ───────────────────────── 大模型 ─────────────────────────

interface EpForm { id: string; name: string; baseUrl: string; apiKey: string; apiKeySet: boolean; apiKeyHint: string; models: string[]; clearApiKey?: boolean }

const EP_PRESETS = [
  { name: 'CPA 本地代理', baseUrl: 'http://host.docker.internal:8317/v1' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1' },
];

const newEpId = () => `ep_${Math.random().toString(36).slice(2, 10)}`;

function LlmTab({ s }: { s: PublicSettings }) {
  const l = s.llm;
  const source = {
    endpoints: l.endpoints.map((e) => ({ ...e, apiKey: '' })) as EpForm[],
    defaultModel: l.defaultModel as LlmModelRef | null,
    temperature: l.temperature, timeoutSec: l.timeoutSec, extraBody: l.extraBody,
  };
  const { f, set, update, dirty, reset } = useForm(source);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState<string | null>(null);
  const setEp = (id: string, p: Partial<EpForm>) => set({ endpoints: f.endpoints.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const addEp = (preset?: { name: string; baseUrl: string }) => set({ endpoints: [...f.endpoints, { id: newEpId(), name: preset?.name ?? '新端点', baseUrl: preset?.baseUrl ?? '', apiKey: '', apiKeySet: false, apiKeyHint: '', models: [] }] });
  const removeEp = (id: string) => set({ endpoints: f.endpoints.filter((e) => e.id !== id), defaultModel: f.defaultModel?.endpointId === id ? null : f.defaultModel });
  const fetchModels = async (e: EpForm) => {
    setFetching(e.id);
    try {
      const saved = l.endpoints.some((x) => x.id === e.id);
      const r = await post<{ models: string[] }>('/api/llm/models', { endpointId: saved ? e.id : undefined, baseUrl: e.baseUrl, apiKey: e.apiKey });
      if (!r.models.length) toast('这个端点没有返回模型列表，可以手动填写', 'info');
      else {
        // 请求期间表单可能又改过（增删端点、改字段），基于最新状态只合并这个端点的模型
        update((o) => ({ ...o, endpoints: o.endpoints.map((x) => (x.id === e.id ? { ...x, models: [...new Set([...x.models, ...r.models])] } : x)) }));
        toast(`获取到 ${r.models.length} 个模型`);
      }
    } catch (err) { toastError(err); } finally { setFetching(null); }
  };
  const extraOk = (() => { if (!f.extraBody.trim()) return true; try { JSON.parse(f.extraBody); return true; } catch { return false; } })();
  const save = () => saveSettings({
    llm: {
      endpoints: f.endpoints.map((e) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, apiKey: e.apiKey, models: e.models, clearApiKey: e.clearApiKey })),
      defaultModel: f.defaultModel, temperature: f.temperature, timeoutSec: f.timeoutSec, extraBody: f.extraBody,
    },
  }, setBusy);
  const allModels = f.endpoints.flatMap((e) => e.models.map((m) => ({ key: `${e.id}::${m}`, label: `${e.name} / ${m}`, ref: { endpointId: e.id, model: m } })));
  return (
    <section className="card settings-card">
      <h2 className="card-title">大模型辅助</h2>
      <p className="muted small">写风格指令、打标签、润色音色描述、拆分剧本、配音推荐都用这里的模型。任何 OpenAI 兼容接口（/chat/completions）都可以。</p>
      {!f.defaultModel && <Notice kind="warn">还没有选择默认模型：添加端点、填好模型名后在下面选一个。</Notice>}
      <ul className="ep-list">
        {f.endpoints.map((e) => (
          <li key={e.id} className="ep card-inner">
            <div className="row gap">
              <input className="ep-name" value={e.name} onChange={(ev) => setEp(e.id, { name: ev.target.value })} aria-label="端点名称" />
              <span className="spacer" />
              <IconButton size="sm" icon="trash" label="删除端点" onClick={() => removeEp(e.id)} />
            </div>
            <Field label="Base URL"><input value={e.baseUrl} onChange={(ev) => setEp(e.id, { baseUrl: ev.target.value })} placeholder="https://…/v1" spellCheck={false} /></Field>
            <Field label="API Key" hint={e.apiKeySet ? `已保存：${e.apiKeyHint}，留空不修改` : '本地服务可以不填'}>
              <div className="row gap">
                <input className="grow" type="password" value={e.apiKey} onChange={(ev) => setEp(e.id, { apiKey: ev.target.value, clearApiKey: false })} placeholder={e.apiKeySet ? '••••••••（不修改）' : ''} autoComplete="off" />
                {e.apiKeySet && <Toggle checked={!!e.clearApiKey} onChange={(v) => setEp(e.id, { clearApiKey: v })} label="清除" />}
              </div>
            </Field>
            <Field label={<>模型 <button type="button" className="link-btn" disabled={!e.baseUrl || fetching === e.id} onClick={() => fetchModels(e)}>{fetching === e.id ? '获取中…' : '从接口获取列表'}</button></>} hint="回车添加；只有这里列出的模型能被选用">
              <TagInput value={e.models} onChange={(models) => setEp(e.id, { models })} placeholder="例如 gpt-4.1-mini，回车添加" />
            </Field>
          </li>
        ))}
      </ul>
      <div className="row gap wrap">
        <Button icon="plus" onClick={() => addEp()}>添加端点</Button>
        <span className="muted small">常用：</span>
        {EP_PRESETS.map((p) => <button key={p.name} type="button" className="chip chip-ghost" onClick={() => addEp(p)} title={p.baseUrl}>{p.name}</button>)}
      </div>
      <h3 className="sub-title">默认与参数</h3>
      <div className="form-grid">
        <Field label="默认模型" hint="各个辅助对话框里可以临时换成别的">
          <select value={f.defaultModel ? `${f.defaultModel.endpointId}::${f.defaultModel.model}` : ''} onChange={(e) => set({ defaultModel: allModels.find((m) => m.key === e.target.value)?.ref ?? null })}>
            <option value="">未选择</option>
            {allModels.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="温度" hint="模板里单独设置的温度优先"><input type="number" min={0} max={2} step={0.1} value={f.temperature} onChange={(e) => set({ temperature: num(e.target.value) })} /></Field>
        <Field label="超时"><span className="unit-input"><input type="number" min={10} max={900} value={f.timeoutSec} onChange={(e) => set({ timeoutSec: num(e.target.value) })} /><i>秒</i></span></Field>
      </div>
      <Field label="额外请求参数（JSON）" hint='合并进每次请求体，例如 {"reasoning_effort":"low"} 或 {"enable_thinking":false}' error={extraOk ? undefined : '不是合法的 JSON'}>
        <AutoTextarea className="mono" value={f.extraBody} onChange={(e) => set({ extraBody: e.target.value })} minRows={2} spellCheck={false} />
      </Field>
      <SaveBar dirty={dirty} busy={busy} onSave={() => { if (extraOk) save(); }} onReset={reset} />
    </section>
  );
}

// ───────────────────────── 预处理 ─────────────────────────

function PreprocessTab({ s }: { s: PublicSettings }) {
  const p = s.preprocess;
  const { data: status } = useStatus();
  const { f, set, dirty, reset } = useForm({ defaultPreset: p.defaultPreset, custom: p.custom, minSec: p.minSec, recommendMaxSec: p.recommendMaxSec, hardMaxSec: p.hardMaxSec, autoPickSec: p.autoPickSec });
  const [busy, setBusy] = useState(false);
  return (
    <section className="card settings-card">
      <h2 className="card-title">克隆参考音频处理</h2>
      <p className="muted small">上传或录制的参考音频会先标准化：转单声道、重采样、高通、降噪（可选）、裁首尾静音、压缩长停顿、BS.1770 响度归一、真峰值限幅，然后给出质量报告。</p>
      <Field label="默认预设" hint="新建克隆音色时默认选中；模型生成的音频（快速合成、设计试听）总是默认用「固化」预设">
        <select value={f.defaultPreset} onChange={(e) => set({ defaultPreset: e.target.value as ProcessPresetId })}>
          {Object.entries(PROCESS_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="custom">自定义（下面的参数）</option>
        </select>
      </Field>
      <p className="muted small">{f.defaultPreset === 'custom' ? '使用下面的自定义参数。' : PROCESS_PRESETS[f.defaultPreset as Exclude<ProcessPresetId, 'custom'>]?.hint}</p>
      <h3 className="sub-title">自定义参数</h3>
      <ParamsForm params={f.custom} onChange={(custom: ProcessParams) => set({ custom })} denoiseOk={!!status?.ffmpeg.denoise} />
      <h3 className="sub-title">时长</h3>
      <div className="form-grid">
        <Field label="短于此提示偏短"><span className="unit-input"><input type="number" min={1} max={60} value={f.minSec} onChange={(e) => set({ minSec: num(e.target.value) })} /><i>秒</i></span></Field>
        <Field label="长于此提示偏长"><span className="unit-input"><input type="number" min={5} max={300} value={f.recommendMaxSec} onChange={(e) => set({ recommendMaxSec: num(e.target.value) })} /><i>秒</i></span></Field>
        <Field label="长于此禁止保存"><span className="unit-input"><input type="number" min={10} max={600} value={f.hardMaxSec} onChange={(e) => set({ hardMaxSec: num(e.target.value) })} /><i>秒</i></span></Field>
        <Field label="自动选取的目标长度" hint="素材偏长时推荐截取的区间"><span className="unit-input"><input type="number" min={3} max={120} value={f.autoPickSec} onChange={(e) => set({ autoPickSec: num(e.target.value) })} /><i>秒</i></span></Field>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={() => saveSettings({ preprocess: f }, setBusy)} onReset={reset} />
    </section>
  );
}

// ───────────────────────── 提示词 ─────────────────────────

function PromptsTab() {
  const { data } = useApi<PromptTemplate[]>('/api/prompts');
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <p className="muted"><Spinner /> 加载中…</p>;
  return (
    <section className="card settings-card">
      <h2 className="card-title">提示词模板</h2>
      <p className="muted small">每个辅助功能用的系统提示和用户提示。改过的保存在数据目录的 prompts/ 下，随时可以恢复默认。用 {'{{变量}}'} 引用变量。</p>
      <ul className="prompt-list">
        {data.map((t) => (
          <li key={t.task} className={open === t.task ? 'is-open' : ''}>
            <button type="button" className="prompt-head" onClick={() => setOpen(open === t.task ? null : t.task)} aria-expanded={open === t.task}>
              <b>{t.title}</b>
              {t.overridden && <span className="chip chip-sm chip-on">已修改</span>}
              <span className="muted small">{t.description}</span>
              <span className="spacer" />
              <span className="muted small">{t.output === 'json' ? 'JSON 输出' : '文本输出'}</span>
              <Icon name="chevron" size={15} />
            </button>
            {open === t.task && <PromptEditor t={t} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PromptEditor({ t }: { t: PromptTemplate }) {
  const { f, set, dirty, reset } = useForm({ system: t.system, user: t.user, temperature: t.temperature === null ? '' : String(t.temperature) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await put(`/api/prompts/${t.task}`, { system: f.system, user: f.user, temperature: f.temperature === '' ? null : Number(f.temperature) }); toast('模板已保存'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true);
    try { await del(`/api/prompts/${t.task}`); toast('已恢复默认'); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="prompt-editor">
      <p className="muted small">可用变量：{t.variables.map((v) => <code key={v}>{`{{${v}}}`}</code>)}</p>
      <Field label="system"><AutoTextarea className="mono" value={f.system} onChange={(e) => set({ system: e.target.value })} minRows={4} spellCheck={false} /></Field>
      <Field label="user"><AutoTextarea className="mono" value={f.user} onChange={(e) => set({ user: e.target.value })} minRows={3} spellCheck={false} /></Field>
      <Field label="温度" hint="留空用全局设置" inline><input type="number" min={0} max={2} step={0.1} value={f.temperature} onChange={(e) => set({ temperature: e.target.value })} style={{ width: 90 }} /></Field>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset}
        extra={t.overridden ? <button type="button" className="link-btn danger" disabled={busy} onClick={restore}>恢复默认</button> : undefined} />
    </div>
  );
}

// ───────────────────────── 界面 ─────────────────────────

function UiTab({ s }: { s: PublicSettings }) {
  const { f, set, dirty, reset } = useForm({ tagBracket: s.ui.tagBracket, previewText: s.ui.previewText, theme: s.ui.theme, defaultGapMs: s.project.defaultGapMs, keepTakes: s.project.keepTakes });
  const [busy, setBusy] = useState(false);
  const save = () => saveSettings({ ui: { tagBracket: f.tagBracket, previewText: f.previewText, theme: f.theme }, project: { defaultGapMs: f.defaultGapMs, keepTakes: f.keepTakes } }, setBusy);
  return (
    <section className="card settings-card">
      <h2 className="card-title">界面</h2>
      <Field label="主题">
        <Segmented value={f.theme} onChange={(theme) => set({ theme })} options={[{ value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} ariaLabel="主题" />
      </Field>
      <Field label="插入行内标签用的括号">
        <Segmented value={f.tagBracket} onChange={(tagBracket) => set({ tagBracket })} options={[{ value: 'full', label: '（全角）' }, { value: 'half', label: '(半角)' }, { value: 'square', label: '[方括号]' }]} ariaLabel="括号" />
      </Field>
      <Field label="标准试听文本" hint="音色库的标准试听和对比试听都用这段，改了之后旧试听会提示刷新">
        <AutoTextarea value={f.previewText} onChange={(e) => set({ previewText: e.target.value })} minRows={2} />
      </Field>
      <h3 className="sub-title">新建剧本的默认值</h3>
      <div className="form-grid">
        <Field label="段间停顿"><span className="unit-input"><input type="number" min={0} max={10000} step={50} value={f.defaultGapMs} onChange={(e) => set({ defaultGapMs: num(e.target.value) })} /><i>ms</i></span></Field>
        <Field label="每段保留版本数" hint="收藏的版本不计入"><input type="number" min={1} max={50} value={f.keepTakes} onChange={(e) => set({ keepTakes: num(e.target.value) })} /></Field>
      </div>
      <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={reset} />
    </section>
  );
}

// ───────────────────────── 状态 ─────────────────────────

function StatusTab() {
  const { data: st, reload } = useStatus();
  if (!st) return <p className="muted"><Spinner /> 加载中…</p>;
  const Ok = ({ ok }: { ok: boolean }) => <Icon name={ok ? 'check' : 'warn'} size={15} className={ok ? 'ok-text' : 'warn-text'} />;
  return (
    <section className="card settings-card">
      <div className="section-head"><h2 className="card-title">系统状态</h2><span className="spacer" /><IconButton size="sm" icon="refresh" label="刷新" onClick={() => reload()} /></div>
      <dl className="kv">
        <dt>版本</dt><dd>{st.version}</dd>
        <dt>数据目录</dt><dd><code>{st.dataDir}</code></dd>
        <dt>MiMo Key</dt><dd><Ok ok={st.mimoConfigured} /> {st.mimoConfigured ? '已配置' : <a href="#/settings?tab=mimo" onClick={(e) => { e.preventDefault(); navigate('/settings?tab=mimo'); }}>未配置</a>}</dd>
        <dt>辅助大模型</dt><dd><Ok ok={st.llmConfigured} /> {st.llmConfigured ? '已选择默认模型' : '未配置（辅助功能不可用）'}</dd>
        <dt>ffmpeg</dt><dd><Ok ok={st.ffmpeg.ok} /> {st.ffmpeg.ok ? <><code>{st.ffmpeg.path}</code> {st.ffmpeg.version}</> : '未找到：参考音频处理和 MP3 导出不可用'}</dd>
        <dt>降噪（afftdn）</dt><dd><Ok ok={st.ffmpeg.denoise} /> {st.ffmpeg.denoise ? '可用' : '不可用'}</dd>
        <dt>MP3 编码</dt><dd><Ok ok={st.ffmpeg.mp3} /> {st.ffmpeg.mp3 ? '可用' : '不可用'}</dd>
        <dt>访问口令</dt><dd>{st.accessToken ? '已启用' : '未启用（局域网内任何人都能访问）'}</dd>
      </dl>
    </section>
  );
}

import { defaultSettings, PROCESS_PRESETS } from '../../shared/presets.ts';
import type { LlmEndpoint, PublicSettings, Settings } from '../../shared/types.ts';
import { paths } from '../config.ts';
import { readJson, writeJson } from '../util/fs.ts';
import { newId } from '../util/id.ts';
import { emitChange } from '../events.ts';

let current: Settings = defaultSettings();

function deepMerge<T>(base: T, patch: any): T {
  if (patch === undefined || patch === null || typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    const b = (base as any)[k];
    const p = patch[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && p && typeof p === 'object' && !Array.isArray(p) ? deepMerge(b, p) : p;
  }
  return out;
}

export async function loadSettings(): Promise<void> {
  const saved = await readJson<Partial<Settings>>(paths.settings(), {});
  current = deepMerge(defaultSettings(), saved);
  let dirty = false;
  // 首次启动时用环境变量初始化
  if (!current.mimo.apiKey && process.env.MIMO_API_KEY) { current.mimo.apiKey = process.env.MIMO_API_KEY; dirty = true; }
  if (process.env.MIMO_BASE_URL && !saved.mimo?.baseUrl) { current.mimo.baseUrl = process.env.MIMO_BASE_URL; dirty = true; }
  if (!current.llm.endpoints.length && process.env.LLM_BASE_URL) {
    const ep: LlmEndpoint = {
      id: newId('ep'), name: process.env.LLM_NAME || '默认端点', baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY ?? '', models: process.env.LLM_MODEL ? [process.env.LLM_MODEL] : [],
    };
    current.llm.endpoints.push(ep);
    if (process.env.LLM_MODEL) current.llm.defaultModel = { endpointId: ep.id, model: process.env.LLM_MODEL };
    dirty = true;
  }
  if (dirty) await writeJson(paths.settings(), current);
}

export function getSettings(): Settings {
  return current;
}

function hint(key: string): string {
  return key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '';
}

export function publicSettings(): PublicSettings {
  const s = current;
  const { apiKey, ...mimo } = s.mimo;
  return {
    ...s,
    mimo: { ...mimo, apiKeySet: !!apiKey, apiKeyHint: hint(apiKey) },
    llm: {
      ...s.llm,
      endpoints: s.llm.endpoints.map(({ apiKey: k, ...e }) => ({ ...e, apiKeySet: !!k, apiKeyHint: hint(k) })),
    },
  };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/** 更新设置：apiKey 留空表示不修改；endpoints 整体替换（按 id 保留旧 Key） */
export async function updateSettings(patch: any): Promise<Settings> {
  const next = structuredClone(current);
  if (patch.mimo) {
    const m = patch.mimo;
    if (typeof m.baseUrl === 'string' && m.baseUrl.trim()) next.mimo.baseUrl = m.baseUrl.trim();
    if (typeof m.apiKey === 'string' && m.apiKey.trim()) next.mimo.apiKey = m.apiKey.trim();
    if (m.clearApiKey) next.mimo.apiKey = '';
    next.mimo.concurrency = clamp(m.concurrency ?? next.mimo.concurrency, 1, 16, 2);
    next.mimo.retries = clamp(m.retries ?? next.mimo.retries, 0, 8, 3);
    next.mimo.timeoutSec = clamp(m.timeoutSec ?? next.mimo.timeoutSec, 10, 900, 180);
    next.mimo.maxChars = clamp(m.maxChars ?? next.mimo.maxChars, 20, 4000, 300);
    next.mimo.sentenceGapMs = clamp(m.sentenceGapMs ?? next.mimo.sentenceGapMs, 0, 3000, 150);
    next.mimo.paragraphGapMs = clamp(m.paragraphGapMs ?? next.mimo.paragraphGapMs, 0, 5000, 450);
    for (const k of ['trimChunkSilence', 'carryLeadingTag', 'streamPreset'] as const) if (typeof m[k] === 'boolean') next.mimo[k] = m[k];
  }
  if (patch.llm) {
    const l = patch.llm;
    if (Array.isArray(l.endpoints)) {
      next.llm.endpoints = l.endpoints.map((e: any) => {
        const old = current.llm.endpoints.find((o) => o.id === e.id);
        return {
          id: old?.id ?? (typeof e.id === 'string' && e.id ? e.id : newId('ep')),
          name: String(e.name ?? '').trim() || '未命名端点',
          baseUrl: String(e.baseUrl ?? '').trim(),
          apiKey: typeof e.apiKey === 'string' && e.apiKey.trim() ? e.apiKey.trim() : e.clearApiKey ? '' : old?.apiKey ?? '',
          models: Array.isArray(e.models) ? [...new Set(e.models.map((x: any) => String(x).trim()).filter(Boolean))] as string[] : old?.models ?? [],
        };
      });
    }
    if ('defaultModel' in l) next.llm.defaultModel = l.defaultModel && l.defaultModel.endpointId && l.defaultModel.model ? { endpointId: String(l.defaultModel.endpointId), model: String(l.defaultModel.model) } : null;
    if (next.llm.defaultModel && !next.llm.endpoints.some((e) => e.id === next.llm.defaultModel!.endpointId)) next.llm.defaultModel = null;
    next.llm.temperature = clamp(l.temperature ?? next.llm.temperature, 0, 2, 0.7);
    next.llm.timeoutSec = clamp(l.timeoutSec ?? next.llm.timeoutSec, 10, 900, 120);
    if (typeof l.extraBody === 'string') {
      if (l.extraBody.trim()) { try { JSON.parse(l.extraBody); } catch { throw new Error('额外请求参数不是合法 JSON'); } }
      next.llm.extraBody = l.extraBody;
    }
  }
  if (patch.preprocess) {
    const p = patch.preprocess;
    if (typeof p.defaultPreset === 'string' && (p.defaultPreset === 'custom' || p.defaultPreset in PROCESS_PRESETS)) next.preprocess.defaultPreset = p.defaultPreset;
    if (p.custom && typeof p.custom === 'object') next.preprocess.custom = { ...next.preprocess.custom, ...p.custom };
    next.preprocess.minSec = clamp(p.minSec ?? next.preprocess.minSec, 1, 60, 4);
    next.preprocess.recommendMaxSec = clamp(p.recommendMaxSec ?? next.preprocess.recommendMaxSec, 5, 300, 30);
    next.preprocess.hardMaxSec = clamp(p.hardMaxSec ?? next.preprocess.hardMaxSec, 10, 600, 90);
    next.preprocess.autoPickSec = clamp(p.autoPickSec ?? next.preprocess.autoPickSec, 3, 120, 15);
  }
  if (patch.ui) {
    const u = patch.ui;
    if (['full', 'half', 'square'].includes(u.tagBracket)) next.ui.tagBracket = u.tagBracket;
    if (typeof u.previewText === 'string' && u.previewText.trim()) next.ui.previewText = u.previewText.trim();
    if (['auto', 'light', 'dark'].includes(u.theme)) next.ui.theme = u.theme;
  }
  if (patch.project) {
    next.project.defaultGapMs = clamp(patch.project.defaultGapMs ?? next.project.defaultGapMs, 0, 10000, 400);
    next.project.keepTakes = clamp(patch.project.keepTakes ?? next.project.keepTakes, 1, 50, 5);
  }
  if (Array.isArray(patch.builtinFavorites)) next.builtinFavorites = patch.builtinFavorites.map(String);
  current = next;
  await writeJson(paths.settings(), current);
  emitChange({ topic: 'settings' });
  return current;
}

export async function setBuiltinFavorite(id: string, fav: boolean): Promise<void> {
  const set = new Set(current.builtinFavorites);
  if (fav) set.add(id); else set.delete(id);
  current = { ...current, builtinFavorites: [...set] };
  await writeJson(paths.settings(), current);
}

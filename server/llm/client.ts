// OpenAI 兼容的大模型调用（/chat/completions、/models）
import type { LlmDebug, LlmEndpoint, LlmModelRef } from '../../shared/types.ts';
import { getSettings } from '../store/settings.ts';
import { HttpError } from '../http.ts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

function base(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

export function resolveModel(ref?: LlmModelRef | null): { endpoint: LlmEndpoint; model: string } {
  const s = getSettings().llm;
  const r = ref && ref.endpointId && ref.model ? ref : s.defaultModel;
  if (!r) throw new HttpError(400, '还没有配置辅助大模型：请到「设置 → 大模型辅助」添加端点并选择默认模型', 'llm-not-configured');
  const endpoint = s.endpoints.find((e) => e.id === r.endpointId);
  if (!endpoint) throw new HttpError(400, '所选大模型端点不存在，请重新选择', 'llm-not-configured');
  if (!endpoint.baseUrl) throw new HttpError(400, `端点「${endpoint.name}」没有填写 Base URL`, 'llm-not-configured');
  return { endpoint, model: r.model };
}

/** 去掉推理模型的 <think> 段与代码围栏 */
export function cleanContent(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

export async function chat(
  messages: ChatMessage[],
  opts: { model?: LlmModelRef | null; temperature?: number | null; signal?: AbortSignal } = {},
): Promise<{ content: string; debug: LlmDebug }> {
  const s = getSettings().llm;
  const { endpoint, model } = resolveModel(opts.model);
  let extra: Record<string, unknown> = {};
  if (s.extraBody.trim()) { try { extra = JSON.parse(s.extraBody); } catch { /* 设置时已校验 */ } }
  const body = { model, messages, temperature: opts.temperature ?? s.temperature, stream: false, ...extra };
  const url = `${base(endpoint.baseUrl)}/chat/completions`;
  const t0 = Date.now();
  const signals = [AbortSignal.timeout(s.timeoutSec * 1000)];
  if (opts.signal) signals.push(opts.signal);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new HttpError(504, `大模型请求超时（${s.timeoutSec} 秒）`);
    throw new HttpError(502, `无法连接大模型端点「${endpoint.name}」：${e?.cause?.message ?? e?.message ?? e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.message ?? msg; } catch { /* 原文 */ }
    throw new HttpError(502, `大模型返回错误（${res.status}）：${msg}`);
  }
  let j: any;
  try { j = JSON.parse(text); } catch { throw new HttpError(502, `大模型返回的不是 JSON：${text.slice(0, 200)}`); }
  const raw = j?.choices?.[0]?.message?.content;
  const content = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: any) => p?.text ?? '').join('') : '';
  if (!content.trim()) throw new HttpError(502, `大模型没有返回内容：${text.slice(0, 200)}`);
  return {
    content,
    debug: { url, model, request: body, rawContent: content, durationMs: Date.now() - t0, usage: j?.usage, attempts: 1 },
  };
}

export async function listModels(endpoint: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const url = `${base(endpoint.baseUrl)}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}, signal: AbortSignal.timeout(20000) });
  } catch (e: any) {
    throw new HttpError(502, `无法连接：${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (!res.ok) throw new HttpError(502, `获取模型列表失败（${res.status}）：${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json().catch(() => ({}));
  const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
  return list.map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean).sort();
}

/** 从模型输出里提取 JSON（容忍围栏、前后说明文字） */
export function extractJson(content: string): unknown {
  const c = cleanContent(content);
  try { return JSON.parse(c); } catch { /* 继续尝试 */ }
  const starts = [c.indexOf('{'), c.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('输出中没有 JSON');
  const start = Math.min(...starts);
  const open = c[start];
  const close = open === '{' ? '}' : ']';
  const end = c.lastIndexOf(close);
  if (end <= start) throw new Error('JSON 不完整');
  return JSON.parse(c.slice(start, end + 1));
}

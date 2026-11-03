// MiMo 开放平台调用：非流式（wav）与流式（SSE + pcm16）
import { MIMO_SAMPLE_RATE } from '../../shared/presets.ts';
import { decodeWav, pcm16ToFloat } from '../audio/wav.ts';
import type { MimoBody } from './request.ts';

export interface MimoConfig {
  baseUrl: string;
  apiKey: string;
  timeoutSec: number;
}

export class MimoError extends Error {
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MimoAudio {
  samples: Float32Array;
  sampleRate: number;
  /** 接口返回的文字内容（例如设计音色开启润色后的实际朗读文本） */
  content?: string;
  requestId?: string;
}

function endpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

function friendly(status: number, msg: string): string {
  if (status === 401 || status === 403) return `鉴权失败（${status}）：请检查 MiMo API Key 与 Base URL 是否匹配（按量付费 Key 与 Token Plan Key 的地址不同）。${msg}`;
  if (status === 429) return `请求过于频繁或超出并发上限（429）。${msg}`;
  if (status === 413) return `请求体过大（413），参考音频可能超过 10MB 上限。${msg}`;
  return `MiMo 接口错误（${status}）：${msg}`;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.message ?? j?.msg ?? text.slice(0, 400);
  } catch {
    return text.slice(0, 400) || res.statusText;
  }
}

function retryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (isFinite(n)) return n * 1000;
  const t = Date.parse(v);
  return isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

function decodeAudioPayload(b64: string): { samples: Float32Array; sampleRate: number } {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const w = decodeWav(buf);
    return { samples: w.samples, sampleRate: w.sampleRate };
  }
  // 没有 RIFF 头时按 24kHz pcm16 处理
  return { samples: pcm16ToFloat(buf), sampleRate: MIMO_SAMPLE_RATE };
}

export async function callMimo(
  cfg: MimoConfig,
  body: MimoBody,
  opts: { signal?: AbortSignal; onPcm?: (pcm: Buffer) => void } = {},
): Promise<MimoAudio> {
  if (!cfg.apiKey) throw new MimoError('还没有配置 MiMo API Key（设置 → MiMo）', 400, false);
  const signals = [AbortSignal.timeout(cfg.timeoutSec * 1000)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);
  let res: Response;
  try {
    res = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        'api-key': cfg.apiKey,
        Accept: body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    if (opts.signal?.aborted) throw new MimoError('已取消', 499, false);
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new MimoError(`请求超时（${cfg.timeoutSec} 秒）`, 504, true);
    throw new MimoError(`无法连接 MiMo 接口：${e?.cause?.message ?? e?.message ?? e}`, 502, true);
  }
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (!res.ok) {
    const msg = await readError(res);
    throw new MimoError(friendly(res.status, msg), res.status, res.status === 429 || res.status >= 500, retryAfter(res));
  }

  const ctype = res.headers.get('content-type') ?? '';
  try {
    if (!body.stream || ctype.includes('application/json')) {
      const j: any = await res.json();
      const msg = j?.choices?.[0]?.message;
      const data = msg?.audio?.data;
      if (!data) throw new MimoError(`接口没有返回音频：${JSON.stringify(j).slice(0, 300)}`, 502, true);
      const a = decodeAudioPayload(data);
      const content = typeof msg?.content === 'string' && msg.content.trim() ? msg.content : msg?.audio?.transcript;
      return { ...a, content: content || undefined, requestId };
    }

    // SSE 流式
    const parts: Float32Array[] = [];
    let content = '';
    let sampleRate = MIMO_SAMPLE_RATE;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { done = true; return; }
      let j: any;
      try { j = JSON.parse(payload); } catch { return; }
      if (j?.error) throw new MimoError(friendly(502, j.error.message ?? JSON.stringify(j.error)), 502, true);
      const delta = j?.choices?.[0]?.delta ?? j?.choices?.[0]?.message;
      const data = delta?.audio?.data;
      if (data) {
        const raw = Buffer.from(data, 'base64');
        if (raw.length >= 12 && raw.toString('ascii', 0, 4) === 'RIFF') {
          const w = decodeWav(raw);
          sampleRate = w.sampleRate;
          parts.push(w.samples);
        } else {
          opts.onPcm?.(raw);
          parts.push(pcm16ToFloat(raw));
        }
      }
      if (typeof delta?.content === 'string') content += delta.content;
    };
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        handle(line);
        if (done) break;
      }
    }
    if (buf.trim()) handle(buf.trim());
    try { await reader.cancel(); } catch { /* ignore */ }
    const total = parts.reduce((n, p) => n + p.length, 0);
    if (!total) throw new MimoError('流式接口没有返回音频', 502, true);
    const samples = new Float32Array(total);
    let o = 0;
    for (const p of parts) { samples.set(p, o); o += p.length; }
    return { samples, sampleRate, content: content.trim() || undefined, requestId };
  } catch (e: any) {
    if (e instanceof MimoError) throw e;
    if (opts.signal?.aborted) throw new MimoError('已取消', 499, false);
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new MimoError(`请求超时（${cfg.timeoutSec} 秒）`, 504, true);
    throw new MimoError(`读取 MiMo 响应失败：${e?.message ?? e}`, 502, true);
  }
}

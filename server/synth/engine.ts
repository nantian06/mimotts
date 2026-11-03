// 合成引擎：长文本切块 → 逐块调用 MiMo（带重试）→ 裁静音 → 按停顿拼接
import type { ChunkTiming, MimoSettings } from '../../shared/types.ts';
import { chunkText } from '../../shared/text.ts';
import { buildMimoBody, redactBody, type MimoBody, type ResolvedVoice } from '../mimo/request.ts';
import { callMimo, MimoError } from '../mimo/client.ts';
import { trimSilence } from '../audio/dsp.ts';
import { concatFloat, silence } from '../audio/wav.ts';

export interface SynthRequest {
  resolved: ResolvedVoice;
  text: string;
  instruction: string;
  stream?: boolean;
  optimizeTextPreview?: boolean;
  /** 不切块（音色设计试听） */
  noChunk?: boolean;
  signal?: AbortSignal;
  onPcm?: (pcm: Buffer, chunkIndex: number) => void;
  onProgress?: (done: number, total: number, note?: string) => void;
  onRetry?: (attempt: number, error: MimoError, chunkIndex: number) => void;
}

export interface SynthOutput {
  samples: Float32Array;
  sampleRate: number;
  chunks: ChunkTiming[];
  model: string;
  warnings: string[];
  actualText?: string;
  requests: MimoBody[];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new MimoError('已取消', 499, false)); }, { once: true });
  });

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  retries: number,
  signal: AbortSignal | undefined,
  onRetry?: (attempt: number, e: MimoError) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = e instanceof MimoError ? e : new MimoError(String((e as any)?.message ?? e), 500, false);
      if (!err.retryable || attempt > retries || signal?.aborted) throw err;
      onRetry?.(attempt, err);
      const base = err.status === 429 ? 3000 : 1000;
      const wait = err.retryAfterMs ?? Math.min(30000, base * 2 ** (attempt - 1) * (1 + Math.random() * 0.3));
      await sleep(wait, signal);
    }
  }
}

/** 线性重采样（只在接口返回了非 24k 音频时兜底使用） */
function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const a = Math.floor(p);
    const t = p - a;
    y[i] = (x[a] ?? 0) * (1 - t) + (x[a + 1] ?? x[a] ?? 0) * t;
  }
  return y;
}

export async function synthesize(cfg: MimoSettings, req: SynthRequest): Promise<SynthOutput> {
  const warnings: string[] = [];
  const pieces = req.noChunk || (req.resolved.mode === 'design' && !req.text.trim())
    ? [{ text: req.text.trim(), gapAfter: 'none' as const }]
    : chunkText(req.text, { maxChars: cfg.maxChars, carryLeadingTag: cfg.carryLeadingTag });
  if (!pieces.length) throw new MimoError('合成文本不能为空', 400, false);
  if (pieces.length > 1 && req.resolved.mode === 'design') {
    warnings.push(`文本被切成 ${pieces.length} 段；未固化的设计音色每段的音色可能不一致，建议先固化`);
  }
  const stream = !!req.stream && req.resolved.mode === 'preset';
  const parts: Float32Array[] = [];
  const chunks: ChunkTiming[] = [];
  const requests: MimoBody[] = [];
  let sampleRate = 0;
  let model = '';
  let actualText: string | undefined;
  let cursor = 0;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const { body, warnings: w } = buildMimoBody(req.resolved, {
      text: piece.text,
      instruction: req.instruction,
      stream,
      optimizeTextPreview: req.optimizeTextPreview,
    });
    if (i === 0) warnings.push(...w);
    model = body.model;
    requests.push(redactBody(body));
    req.onProgress?.(i, pieces.length, pieces.length > 1 ? `第 ${i + 1}/${pieces.length} 段` : undefined);
    const audio = await withRetry(
      () => callMimo(cfg, body, { signal: req.signal, onPcm: req.onPcm ? (p) => req.onPcm!(p, i) : undefined }),
      cfg.retries,
      req.signal,
      (attempt, e) => req.onRetry?.(attempt, e, i),
    );
    if (!sampleRate) sampleRate = audio.sampleRate;
    let x = resampleLinear(audio.samples, audio.sampleRate, sampleRate);
    if (cfg.trimChunkSilence) x = trimSilence(x, sampleRate);
    if (audio.content && req.resolved.mode === 'design') actualText = audio.content;
    const startMs = Math.round((cursor / sampleRate) * 1000);
    parts.push(x);
    cursor += x.length;
    chunks.push({ text: piece.text, startMs, endMs: Math.round((cursor / sampleRate) * 1000) });
    if (piece.gapAfter !== 'none') {
      const gap = silence(piece.gapAfter === 'paragraph' ? cfg.paragraphGapMs : cfg.sentenceGapMs, sampleRate);
      parts.push(gap);
      cursor += gap.length;
    }
  }
  req.onProgress?.(pieces.length, pieces.length);
  return { samples: concatFloat(parts), sampleRate, chunks, model, warnings, actualText, requests };
}

// 数字信号处理：滤波、BS.1770 响度、真峰值、语音活动检测、静音裁剪、停顿压缩、限幅
import type { AudioMetrics, Region } from '../../shared/types.ts';

// ───────────────────────── 双二阶滤波器 ─────────────────────────

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

export function applyBiquad(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = f.b0 * xi + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

function rbjHighpass(fc: number, fs: number, q: number): Biquad {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** 4 阶巴特沃斯高通（24 dB/oct），去掉低频轰鸣与直流偏移 */
export function highpass(x: Float32Array, fs: number, fc: number): Float32Array {
  if (fc <= 0 || fc >= fs / 2) return x;
  return applyBiquad(applyBiquad(x, rbjHighpass(fc, fs, 0.5411961)), rbjHighpass(fc, fs, 1.3065630));
}

// ───────────────────────── 响度（ITU-R BS.1770-4） ─────────────────────────

/** K 计权滤波器系数（与 libebur128 相同的任意采样率公式） */
function kWeighting(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  const d = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / d, a2: (1 - K / Q + K * K) / d };
  return [shelf, hp];
}

/** 整合响度（LUFS，单声道，带绝对/相对门限）；不足 400ms 返回 null */
export function integratedLoudness(x: Float32Array, fs: number): number | null {
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  if (x.length < block) return null;
  const [s, h] = kWeighting(fs);
  const k = applyBiquad(applyBiquad(x, s), h);
  // 前缀平方和，快速求每个 400ms 块的均方
  const cum = new Float64Array(k.length + 1);
  for (let i = 0; i < k.length; i++) cum[i + 1] = cum[i] + k[i] * k[i];
  const z: number[] = [];
  for (let st = 0; st + block <= k.length; st += step) z.push((cum[st + block] - cum[st]) / block);
  const lk = (ms: number) => -0.691 + 10 * Math.log10(ms);
  const abs = z.filter((v) => v > 0 && lk(v) > -70);
  if (!abs.length) return -70;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => lk(v) > rel);
  if (!gated.length) return lk(abs.reduce((a, b) => a + b, 0) / abs.length);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}

// ───────────────────────── 峰值 ─────────────────────────

const TP_PHASES = 4;
const TP_HALF = 8;
const TP_KERNELS: Float64Array[] = (() => {
  const ks: Float64Array[] = [];
  for (let p = 1; p < TP_PHASES; p++) {
    const t = p / TP_PHASES;
    const k = new Float64Array(TP_HALF * 2);
    for (let m = -TP_HALF + 1; m <= TP_HALF; m++) {
      const d = t - m;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (TP_HALF + 0.5)); // Hann 窗
      k[m + TP_HALF - 1] = sinc * w;
    }
    ks.push(k);
  }
  return ks;
})();

export function samplePeak(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > m) m = v; }
  return m;
}

/** 4 倍过采样估算真峰值（线性值） */
export function truePeak(x: Float32Array): number {
  let m = samplePeak(x);
  const n = x.length;
  for (let i = 0; i < n - 1; i++) {
    // 只在相邻样本足够大时才插值，节省计算
    if (Math.abs(x[i]) < m * 0.5 && Math.abs(x[i + 1]) < m * 0.5) continue;
    for (const k of TP_KERNELS) {
      let acc = 0;
      for (let j = 0; j < k.length; j++) {
        const idx = i + j - TP_HALF + 1;
        if (idx >= 0 && idx < n) acc += x[idx] * k[j];
      }
      const v = Math.abs(acc);
      if (v > m) m = v;
    }
  }
  return m;
}

export const toDb = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -120);
export const fromDb = (db: number) => Math.pow(10, db / 20);

/** 削波事件：连续 ≥3 个样本贴近满幅 */
export function countClipEvents(x: Float32Array, threshold = 0.985): number {
  let events = 0;
  let run = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) >= threshold) {
      run++;
      if (run === 3) events++;
    } else run = 0;
  }
  return events;
}

// ───────────────────────── 语音活动检测 ─────────────────────────

export interface FrameAnalysis {
  hop: number;
  win: number;
  db: Float32Array;
  mask: Uint8Array;
  noiseFloorDb: number;
  speechLevelDb: number;
  thresholdDb: number;
}

function percentile(arr: Float32Array, p: number): number {
  if (!arr.length) return -100;
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** 20ms 窗 / 10ms 步长的能量分析与语音掩码 */
export function analyzeFrames(x: Float32Array, fs: number): FrameAnalysis {
  const win = Math.max(1, Math.round(0.02 * fs));
  const hop = Math.max(1, Math.round(0.01 * fs));
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const o = f * hop;
    for (let i = 0; i < win; i++) acc += x[o + i] * x[o + i];
    db[f] = Math.max(-100, 10 * Math.log10(acc / win + 1e-12));
  }
  const noise = percentile(db, 0.1);
  const speech = percentile(db, 0.95);
  const threshold = Math.min(Math.max(noise + 9, -65), speech - 15);
  const mask = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) mask[f] = db[f] > threshold ? 1 : 0;
  // 去掉 <40ms 的孤立能量尖刺
  fillRuns(mask, 1, 4, 0);
  // 句内短停顿（<120ms）视为语音（拖尾）
  fillRuns(mask, 0, 12, 1, true);
  return { hop, win, db, mask, noiseFloorDb: noise, speechLevelDb: speech, thresholdDb: threshold };
}

/** 把长度 < minLen 的 value 连续段改成 to；interior 为 true 时只处理两侧都有其他值的段 */
function fillRuns(mask: Uint8Array, value: number, minLen: number, to: number, interior = false): void {
  let i = 0;
  while (i < mask.length) {
    if (mask[i] !== value) { i++; continue; }
    let j = i;
    while (j < mask.length && mask[j] === value) j++;
    const isInterior = i > 0 && j < mask.length;
    if (j - i < minLen && (!interior || isInterior)) for (let k = i; k < j; k++) mask[k] = to;
    i = j;
  }
}

export function speechBounds(a: FrameAnalysis): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let f = 0; f < a.mask.length; f++) if (a.mask[f]) { if (first < 0) first = f; last = f; }
  return first < 0 ? null : { first, last };
}

export function longestInteriorPause(a: FrameAnalysis): number {
  const b = speechBounds(a);
  if (!b) return 0;
  let best = 0;
  let run = 0;
  for (let f = b.first; f <= b.last; f++) {
    if (!a.mask[f]) { run++; if (run > best) best = run; } else run = 0;
  }
  return (best * a.hop) / 1;
}

// ───────────────────────── 编辑操作 ─────────────────────────

export interface TrimResult { samples: Float32Array; removedHead: number; removedTail: number }

/** 根据语音掩码裁掉首尾静音，两侧保留 padMs */
export function trimEdges(x: Float32Array, fs: number, a: FrameAnalysis, padMs: number): TrimResult {
  const b = speechBounds(a);
  if (!b) return { samples: x, removedHead: 0, removedTail: 0 };
  const pad = Math.round((padMs / 1000) * fs);
  const start = Math.max(0, b.first * a.hop - pad);
  const end = Math.min(x.length, b.last * a.hop + a.win + pad);
  return { samples: x.slice(start, end), removedHead: start, removedTail: x.length - end };
}

export interface PauseResult { samples: Float32Array; count: number; removed: number }

/** 把超过 maxMs 的句间停顿压缩到 keepMs（在静音段中间剪开并交叉淡化） */
export function compressPauses(x: Float32Array, fs: number, a: FrameAnalysis, maxMs: number, keepMs: number): PauseResult {
  const b = speechBounds(a);
  if (!b) return { samples: x, count: 0, removed: 0 };
  const maxS = Math.round((maxMs / 1000) * fs);
  const keepS = Math.round((Math.min(keepMs, maxMs) / 1000) * fs);
  const cuts: [number, number][] = [];
  let f = b.first;
  while (f <= b.last) {
    if (a.mask[f]) { f++; continue; }
    let g = f;
    while (g <= b.last && !a.mask[g]) g++;
    // 停顿区间：前一语音帧窗口结束 → 下一语音帧开始
    const s0 = (f - 1) * a.hop + a.win;
    const s1 = g * a.hop;
    if (s1 - s0 > maxS) cuts.push([s0 + Math.floor(keepS / 2), s1 - Math.ceil(keepS / 2)]);
    f = g;
  }
  if (!cuts.length) return { samples: x, count: 0, removed: 0 };
  const xf = Math.round(0.01 * fs);
  const pieces: Float32Array[] = [];
  let pos = 0;
  let removed = 0;
  for (const [c0, c1] of cuts) {
    pieces.push(x.slice(pos, c0 + xf));
    pos = c1 - xf;
    removed += c1 - c0;
  }
  pieces.push(x.slice(pos));
  // 交叉淡化拼接
  const total = pieces.reduce((n, p) => n + p.length, 0) - xf * (pieces.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  pieces.forEach((p, i) => {
    if (i === 0) { out.set(p, 0); o = p.length - xf; return; }
    for (let k = 0; k < xf && k < p.length; k++) {
      const t = (k + 0.5) / xf;
      out[o + k] = out[o + k] * (1 - t) + p[k] * t;
    }
    out.set(p.subarray(xf), o + xf);
    o += p.length - xf;
  });
  return { samples: out, count: cuts.length, removed };
}

export function applyGain(x: Float32Array, db: number): Float32Array {
  const g = fromDb(db);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  return y;
}

/**
 * 前瞻限幅：增益包络 = 窗口内最小目标增益再做滑动平均，保证每个样本都不超过上限。
 * 返回处理后信号与最大增益衰减（dB，负数）。
 */
export function limit(x: Float32Array, fs: number, ceilingLin: number): { samples: Float32Array; maxReductionDb: number; events: number } {
  const n = x.length;
  const L = Math.max(1, Math.round(0.003 * fs));
  const tgt = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(x[i]);
    tgt[i] = v > ceilingLin ? ceilingLin / v : 1;
    if (tgt[i] < 1) any = true;
  }
  if (!any) return { samples: x, maxReductionDb: 0, events: 0 };
  const g2 = slidingMin(tgt, L);
  // 滑动平均（窗口 2L+1）
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + g2[i];
  const y = new Float32Array(n);
  let minG = 1;
  let events = 0;
  let inEvent = false;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - L);
    const b = Math.min(n, i + L + 1);
    const g = (cum[b] - cum[a]) / (b - a);
    const gg = Math.min(g, tgt[i]);
    y[i] = x[i] * gg;
    if (gg < minG) minG = gg;
    if (gg < 0.999) { if (!inEvent) { events++; inEvent = true; } } else inEvent = false;
  }
  return { samples: y, maxReductionDb: toDb(minG), events };
}

function slidingMin(a: Float32Array, L: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  const dq: number[] = [];
  let head = 0;
  // 窗口 [i-L, i+L]
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + L);
    while (next <= hi) {
      while (dq.length > head && a[dq[dq.length - 1]] >= a[next]) dq.pop();
      dq.push(next);
      next++;
    }
    while (dq[head] < i - L) head++;
    out[i] = a[dq[head]];
  }
  return out;
}

export function fade(x: Float32Array, fs: number, ms: number): Float32Array {
  const n = Math.min(Math.floor(x.length / 2), Math.round((ms / 1000) * fs));
  if (n <= 0) return x;
  const y = x.slice();
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
  return y;
}

/** 合成结果拼接前裁掉首尾静音（简单阈值，模型输出很干净） */
export function trimSilence(x: Float32Array, fs: number, thresholdDb = -48, keepMs = 60): Float32Array {
  const thr = fromDb(thresholdDb);
  const win = Math.max(1, Math.round(0.01 * fs));
  let start = 0;
  let end = x.length;
  const rms = (o: number) => {
    let acc = 0;
    const e = Math.min(x.length, o + win);
    for (let i = o; i < e; i++) acc += x[i] * x[i];
    return Math.sqrt(acc / Math.max(1, e - o));
  };
  while (start < x.length && rms(start) < thr) start += win;
  while (end > start && rms(Math.max(start, end - win)) < thr) end -= win;
  if (start >= end) return x;
  const keep = Math.round((keepMs / 1000) * fs);
  return fade(x.slice(Math.max(0, start - keep), Math.min(x.length, end + keep)), fs, 4);
}

export function dcOffset(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

// ───────────────────────── 指标与推荐区间 ─────────────────────────

export function measure(x: Float32Array, fs: number, clipSource?: Float32Array): AudioMetrics {
  const a = analyzeFrames(x, fs);
  const speechFrames = a.mask.reduce((n, v) => n + v, 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const lufs = integratedLoudness(x, fs);
  return {
    durationSec: Math.round((x.length / fs) * 100) / 100,
    lufs: lufs === null ? null : r1(lufs),
    truePeakDb: r1(toDb(truePeak(x))),
    samplePeakDb: r1(toDb(samplePeak(x))),
    noiseFloorDb: r1(a.noiseFloorDb),
    speechLevelDb: r1(a.speechLevelDb),
    snrDb: r1(a.speechLevelDb - a.noiseFloorDb),
    speechRatio: a.mask.length ? Math.round((speechFrames / a.mask.length) * 100) / 100 : 0,
    clipEvents: countClipEvents(clipSource ?? x),
    longestPauseSec: Math.round((longestInteriorPause(a) / fs) * 100) / 100,
    dcOffset: Math.round(dcOffset(x) * 10000) / 10000,
  };
}

/** 素材偏长时，找一段语音最密集、没有削波的区间，并尽量对齐到停顿处 */
export function suggestRegion(x: Float32Array, fs: number, targetSec: number): Region | null {
  const total = x.length / fs;
  if (total <= targetSec * 1.4) return null;
  const a = analyzeFrames(x, fs);
  const W = Math.round((targetSec * fs) / a.hop);
  if (W >= a.mask.length) return null;
  const clipFrame = new Uint8Array(a.mask.length);
  for (let f = 0; f < a.mask.length; f++) {
    const o = f * a.hop;
    for (let i = 0; i < a.hop && o + i < x.length; i++) if (Math.abs(x[o + i]) >= 0.985) { clipFrame[f] = 1; break; }
  }
  let score = 0;
  for (let f = 0; f < W; f++) score += a.mask[f] - 6 * clipFrame[f];
  let best = score;
  let bestStart = 0;
  for (let s = 1; s + W <= a.mask.length; s++) {
    score += a.mask[s + W - 1] - 6 * clipFrame[s + W - 1] - (a.mask[s - 1] - 6 * clipFrame[s - 1]);
    if (score > best) { best = score; bestStart = s; }
  }
  // 起点向前、终点向后找最近的停顿（最多 1.5 秒）
  const reach = Math.round((1.5 * fs) / a.hop);
  let s = bestStart;
  for (let k = 0; k < reach && s > 0; k++, s--) if (!a.mask[s]) break;
  let e = bestStart + W;
  for (let k = 0; k < reach && e < a.mask.length - 1; k++, e++) if (!a.mask[e]) break;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { start: r2((s * a.hop) / fs), end: r2(Math.min(total, (e * a.hop + a.win) / fs)) };
}

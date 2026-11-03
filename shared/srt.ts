// SRT 字幕：按每段实际时长算时间轴，长段按块/句细分
import type { ChunkTiming } from './types.ts';
import { splitSentences, stripTags } from './text.ts';

export interface TimelineItem {
  text: string;
  roleName: string;
  startMs: number;
  durationMs: number;
  /** 片段内部的分块时间（相对片段开头） */
  chunks: ChunkTiming[];
}

export interface SrtOptions {
  includeRole: boolean;
  /** 长段按句子细分字幕 */
  splitSentences: boolean;
  /** 单条字幕的最大字数（细分时使用） */
  maxCueChars: number;
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

function cleanText(t: string): string {
  return stripTags(t).replace(/\s+/g, ' ').trim();
}

/** 把一段时长按字数比例分给若干句子 */
function distribute(text: string, startMs: number, endMs: number, maxChars: number): Cue[] {
  const sentences = splitSentences(cleanText(text)).filter((s) => s.trim());
  // 合并太短的句子，避免字幕闪烁
  const groups: string[] = [];
  for (const s of sentences) {
    const last = groups[groups.length - 1];
    if (last !== undefined && Array.from(last).length + Array.from(s).length <= maxChars && Array.from(last).length < maxChars * 0.4) {
      groups[groups.length - 1] = last + s;
    } else groups.push(s);
  }
  if (!groups.length) return [];
  const total = groups.reduce((n, g) => n + Math.max(1, Array.from(g).length), 0);
  const span = endMs - startMs;
  const cues: Cue[] = [];
  let t = startMs;
  groups.forEach((g, i) => {
    const d = i === groups.length - 1 ? endMs - t : Math.round((span * Math.max(1, Array.from(g).length)) / total);
    cues.push({ startMs: t, endMs: t + d, text: g });
    t += d;
  });
  return cues;
}

export function buildCues(items: TimelineItem[], opts: SrtOptions): Cue[] {
  const cues: Cue[] = [];
  for (const it of items) {
    const prefix = opts.includeRole && it.roleName ? `${it.roleName}：` : '';
    const end = it.startMs + it.durationMs;
    let parts: Cue[];
    if (!opts.splitSentences) {
      parts = [{ startMs: it.startMs, endMs: end, text: cleanText(it.text) }];
    } else if (it.chunks.length > 1) {
      parts = it.chunks.flatMap((c) => distribute(c.text, it.startMs + c.startMs, it.startMs + c.endMs, opts.maxCueChars));
    } else {
      parts = distribute(it.text, it.startMs, end, opts.maxCueChars);
    }
    for (const p of parts) if (p.text) cues.push({ ...p, text: prefix + p.text });
  }
  return cues;
}

function ts(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const r = v % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.startMs)} --> ${ts(c.endMs)}\n${c.text}\n`).join('\n');
}

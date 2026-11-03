// 文本相关的纯函数：风格标签解析、长文本切块、导演模式拼装、简单哈希

/** 开头整体风格标签：(风格) / （风格） / [风格] */
const LEADING_TAG_RE = /^\s*([(（\[])([^()（）\[\]\n]{1,60})([)）\]])/;
/** 行内标签（括号里不超过 40 个字、不跨行） */
const ANY_TAG_RE = /[(（\[][^()（）\[\]\n]{1,40}[)）\]]/g;

export interface LeadingTag {
  /** 完整标签原文，如 "(开心 温柔)" */
  raw: string;
  /** 括号内的内容 */
  inner: string;
  /** 拆分后的风格项 */
  items: string[];
  /** 去掉标签后的正文 */
  rest: string;
}

export function splitTagItems(inner: string): string[] {
  return inner.split(/[\s,，、/|;；]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseLeadingTag(text: string): LeadingTag | null {
  const m = LEADING_TAG_RE.exec(text);
  if (!m) return null;
  return { raw: m[0].trim(), inner: m[2], items: splitTagItems(m[2]), rest: text.slice(m[0].length) };
}

const SING_WORDS = new Set(['唱歌', 'sing', 'singing']);

/** 是否为唱歌模式（开头标签含 唱歌 / sing / singing） */
export function isSinging(text: string): boolean {
  const t = parseLeadingTag(text);
  return !!t && t.items.some((i) => SING_WORDS.has(i.toLowerCase()));
}

/** 去掉所有括号标签，得到实际朗读的文字（用于字幕、校验大模型有没有改原文） */
export function stripTags(text: string): string {
  return text.replace(ANY_TAG_RE, '');
}

/** 比较用的归一化：去标签、去空白、统一全半角标点 */
export function normalizeForCompare(text: string): string {
  return stripTags(text)
    .replace(/\s+/g, '')
    .replace(/[，]/g, ',').replace(/[。]/g, '.').replace(/[！]/g, '!').replace(/[？]/g, '?')
    .replace(/[：]/g, ':').replace(/[；]/g, ';').replace(/[“”"]/g, '"').replace(/[‘’']/g, "'")
    .replace(/[（]/g, '(').replace(/[）]/g, ')');
}

/** 可见长度（不含标签） */
export function visibleLength(text: string): number {
  return stripTags(text).replace(/\s+/g, '').length;
}

/** 往开头风格标签里加一项（没有就新建） */
export function addLeadingStyle(text: string, item: string): string {
  const t = parseLeadingTag(text);
  if (!t) return `(${item})${text.replace(/^\s+/, '')}`;
  if (t.items.includes(item)) return text;
  return `(${[...t.items, item].join(' ')})${t.rest}`;
}

export function removeLeadingStyle(text: string, item: string): string {
  const t = parseLeadingTag(text);
  if (!t) return text;
  const items = t.items.filter((i) => i !== item);
  return items.length ? `(${items.join(' ')})${t.rest}` : t.rest.replace(/^\s+/, '');
}

export function wrapInlineTag(item: string, bracket: 'full' | 'half' | 'square'): string {
  if (bracket === 'half') return `(${item})`;
  if (bracket === 'square') return `[${item}]`;
  return `（${item}）`;
}

// ───────────────────────── 切块 ─────────────────────────

export type GapKind = 'sentence' | 'paragraph' | 'none';

export interface TextChunk {
  /** 实际发送的文本（已按需带上开头风格标签） */
  text: string;
  /** 这一块之后的停顿类型 */
  gapAfter: GapKind;
}

const TERMINALS = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);
const CLOSERS = new Set(['”', '’', '」', '』', '"', "'", ')', '）', '】', '》']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '—']);

/** 把一段文字切成句子（保留标点与右引号；行内标签留在所在句） */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\n') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
    let terminal = TERMINALS.has(c);
    if (c === '.') {
      const next = chars[i + 1];
      const prev = chars[i - 1] ?? '';
      terminal = (next === undefined || /\s/.test(next)) && /[A-Za-z)\]"']/.test(prev);
    }
    if (terminal) {
      // 吞掉后面连续的终止符和右引号/右括号
      while (i + 1 < chars.length && (TERMINALS.has(chars[i + 1]) || CLOSERS.has(chars[i + 1]) || chars[i + 1] === '.')) {
        buf += chars[++i];
      }
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 句子仍超长时按逗号等软断点再切，最后硬切 */
function splitLong(sentence: string, max: number): string[] {
  if (visibleLength(sentence) <= max) return [sentence];
  const parts: string[] = [];
  let buf = '';
  for (const c of Array.from(sentence)) {
    buf += c;
    if (SOFT_BREAKS.has(c) && visibleLength(buf) >= max * 0.5) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf) parts.push(buf);
  const out: string[] = [];
  for (const p of parts) {
    if (visibleLength(p) <= max) { out.push(p); continue; }
    const cs = Array.from(p);
    for (let i = 0; i < cs.length; i += max) out.push(cs.slice(i, i + max).join(''));
  }
  // 合并过短的碎片
  const merged: string[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last !== undefined && visibleLength(last) + visibleLength(p) <= max) merged[merged.length - 1] = last + p;
    else merged.push(p);
  }
  return merged;
}

export interface ChunkOptions {
  maxChars: number;
  carryLeadingTag: boolean;
}

/**
 * 长文本切块：按段落 → 句子 → 软断点贪心打包，每块不超过 maxChars 个可见字。
 * 开头的 (风格) 标签按设置带到每一块，唱歌标签总是带上。
 */
export function chunkText(input: string, opts: ChunkOptions): TextChunk[] {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lead = parseLeadingTag(text);
  const body = lead ? lead.rest.replace(/^\s+/, '') : text;
  const carry = lead && (opts.carryLeadingTag || isSinging(text)) ? lead.raw : '';
  const max = Math.max(20, opts.maxChars);

  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: { text: string; endsParagraph: boolean }[] = [];
  for (const para of paragraphs) {
    const sentences = splitSentences(para).flatMap((s) => splitLong(s, max));
    let buf = '';
    const flush = (endsParagraph: boolean) => {
      if (buf.trim()) pieces.push({ text: buf.trim(), endsParagraph });
      buf = '';
    };
    for (const s of sentences) {
      if (buf && visibleLength(buf) + visibleLength(s) > max) flush(false);
      buf += s;
    }
    flush(true);
  }
  if (!pieces.length && lead) pieces.push({ text: '', endsParagraph: true });

  return pieces.map((p, i) => {
    const prefix = i === 0 ? (lead ? lead.raw : '') : carry;
    const isLast = i === pieces.length - 1;
    return { text: prefix + p.text, gapAfter: isLast ? 'none' : p.endsParagraph ? 'paragraph' : 'sentence' };
  });
}

// ───────────────────────── 导演模式 ─────────────────────────

export interface DirectorParts {
  role: string;
  scene: string;
  guidance: string;
}

export function composeDirector(p: DirectorParts): string {
  const blocks: string[] = [];
  if (p.role.trim()) blocks.push(`角色：${p.role.trim()}`);
  if (p.scene.trim()) blocks.push(`场景：${p.scene.trim()}`);
  if (p.guidance.trim()) blocks.push(`指导：\n${p.guidance.trim()}`);
  return blocks.join('\n\n');
}

/** 识别导演模式文本（至少包含两个段落标题） */
export function parseDirector(text: string): DirectorParts | null {
  const re = /^\s*(角色|场景|指导)\s*[：:]/gm;
  const marks: { key: string; index: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ key: m[1], index: m.index, len: m[0].length });
  if (new Set(marks.map((x) => x.key)).size < 2) return null;
  const out: DirectorParts = { role: '', scene: '', guidance: '' };
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const val = text.slice(mk.index + mk.len, end).trim();
    if (mk.key === '角色') out.role = val;
    else if (mk.key === '场景') out.scene = val;
    else out.guidance = val;
  });
  return out;
}

// ───────────────────────── 杂项 ─────────────────────────

/** FNV-1a 32 位哈希，返回 8 位十六进制 */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function truncate(s: string, n: number): string {
  const cs = Array.from(s);
  return cs.length > n ? cs.slice(0, n).join('') + '…' : s;
}

export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

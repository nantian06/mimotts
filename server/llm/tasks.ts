// 大模型辅助任务：渲染模板 → 调用 → 解析/校验
import type { CastSuggestion, LlmDebug, LlmModelRef, LlmRunResult, LlmTask, SplitPreview, VoiceSummary } from '../../shared/types.ts';
import { INLINE_TAG_GROUPS, STYLE_TAG_GROUPS, GENDER_LABELS, LANG_LABELS, KIND_LABELS } from '../../shared/presets.ts';
import { normalizeForCompare } from '../../shared/text.ts';
import { diffChars } from '../../shared/diff.ts';
import { chat, cleanContent, extractJson, type ChatMessage } from './client.ts';
import { getTemplate, render } from './templates.ts';
import { getSettings } from '../store/settings.ts';
import { bad } from '../http.ts';

interface RunOpts { model?: LlmModelRef | null; signal?: AbortSignal }

async function runTemplate(task: LlmTask, vars: Record<string, string>, opts: RunOpts): Promise<{ content: string; parsed: unknown; debug: LlmDebug }> {
  const t = await getTemplate(task);
  const messages: ChatMessage[] = [];
  const system = render(t.system, vars);
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: render(t.user, vars) });
  const r = await chat(messages, { model: opts.model, temperature: t.temperature, signal: opts.signal });
  if (t.output !== 'json') return { content: cleanContent(r.content), parsed: null, debug: r.debug };
  try {
    return { content: r.content, parsed: extractJson(r.content), debug: r.debug };
  } catch {
    // 自动重试一次，要求只输出 JSON
    const retry = await chat(
      [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: '上一次的输出不是合法 JSON。请严格按要求的结构只输出 JSON，不要任何其他文字或代码块。' }],
      { model: opts.model, temperature: 0.2, signal: opts.signal },
    );
    const debug = { ...retry.debug, attempts: 2 };
    try {
      return { content: retry.content, parsed: extractJson(retry.content), debug };
    } catch {
      const err: any = bad(`大模型两次都没有输出合法 JSON，原文：${cleanContent(retry.content).slice(0, 300)}`);
      err.raw = retry.content;
      throw err;
    }
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function tagVars(): Record<string, string> {
  const b = getSettings().ui.tagBracket;
  const [open, close] = b === 'half' ? ['(', ')'] : b === 'square' ? ['[', ']'] : ['（', '）'];
  return {
    styleTags: STYLE_TAG_GROUPS.filter((g) => !g.label.startsWith('唱歌')).flatMap((g) => g.items).join('、'),
    inlineTags: INLINE_TAG_GROUPS.flatMap((g) => g.items).join('、'),
    open,
    close,
  };
}

function textChanged(before: string, after: string): boolean {
  return normalizeForCompare(before) !== normalizeForCompare(after);
}

/** 单次任务（指令、标签、描述、试听文本） */
export async function runSimpleTask(task: string, vars: Record<string, string>, opts: RunOpts): Promise<LlmRunResult> {
  const warnings: string[] = [];
  const v = Object.fromEntries(Object.entries(vars ?? {}).map(([k, x]) => [k, String(x ?? '')]));
  switch (task) {
    case 'instruction-natural': {
      if (!v.text?.trim()) throw bad('请先填写要合成的文本');
      const r = await runTemplate(task, v, opts);
      return { output: r.content.replace(/^["“「]|["”」]$/g, '').trim(), raw: r.content, warnings, debug: r.debug };
    }
    case 'instruction-director': {
      if (!v.text?.trim()) throw bad('请先填写要合成的文本');
      const r = await runTemplate(task, v, opts);
      const o: any = r.parsed ?? {};
      return { output: { role: str(o.role), scene: str(o.scene), guidance: str(o.guidance) }, raw: r.content, warnings, debug: r.debug };
    }
    case 'tags': {
      if (!v.text?.trim()) throw bad('请先填写要合成的文本');
      const r = await runTemplate(task, { ...tagVars(), ...v }, opts);
      if (textChanged(v.text, r.content)) warnings.push('模型改动了原文文字（不只是加标签），请在差异里核对后再采用');
      return { output: r.content, raw: r.content, warnings, debug: r.debug };
    }
    case 'design-desc': {
      if (!v.draft?.trim()) throw bad('请先写一点对音色的想法');
      const r = await runTemplate(task, v, opts);
      const o: any = r.parsed ?? {};
      return { output: { description: str(o.description), previewText: str(o.previewText) }, raw: r.content, warnings, debug: r.debug };
    }
    case 'preview-text': {
      if (!v.description?.trim()) throw bad('请先填写音色描述');
      const r = await runTemplate(task, v, opts);
      return { output: r.content.replace(/^["“「]|["”」]$/g, '').trim(), raw: r.content, warnings, debug: r.debug };
    }
    default:
      throw bad('未知的辅助任务');
  }
}

// ───────────────────────── 剧本拆分 ─────────────────────────

function splitForLlm(text: string, max = 2500): string[] {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n+/);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length > max) { out.push(buf); buf = ''; }
    if (p.length > max) {
      // 超长段落在句号处硬切
      let rest = p;
      while (rest.length > max) {
        let cut = Math.max(rest.lastIndexOf('。', max), rest.lastIndexOf('！', max), rest.lastIndexOf('？', max));
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
      }
      buf = rest;
    } else buf += (buf ? '\n' : '') + p;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** 原文有多少字按顺序出现在拆分结果里（返回 [相同字数, 原文字数]） */
function coverageCounts(original: string, segs: string[]): [number, number] {
  // 剧本格式的「角色名：」行首标签被去掉是正常的，不算遗漏
  const cleaned = original.replace(/^[ \t]*[^\s：:“”「」"]{1,10}[：:][ \t]*(?=[“「"])/gm, '').replace(/[“”「」『』]/g, '');
  const a = normalizeForCompare(cleaned);
  const b = normalizeForCompare(segs.join(''));
  let same = 0;
  for (const part of diffChars(a, b)) if (part.type === 'same') same += Array.from(part.text).length;
  return [same, Array.from(a).length];
}

export async function splitScript(
  input: { text: string; knownRoles: string[]; rewrite: boolean; withInstruction: boolean; targetLen: number },
  opts: RunOpts & { onProgress?: (done: number, total: number) => void },
): Promise<SplitPreview> {
  const text = input.text.trim();
  if (!text) throw bad('请粘贴要拆分的文本');
  const parts = splitForLlm(text);
  const roles = new Map<string, { name: string; description: string; instruction: string }>();
  for (const n of input.knownRoles) roles.set(n, { name: n, description: '', instruction: '' });
  if (!roles.has('旁白')) roles.set('旁白', { name: '旁白', description: '叙述者', instruction: '' });
  const segments: SplitPreview['segments'] = [];
  const debug: LlmDebug[] = [];
  const warnings: string[] = [];
  let covSame = 0;
  let covTotal = 0;
  for (let i = 0; i < parts.length; i++) {
    const before = segments.length;
    opts.onProgress?.(i, parts.length);
    const r = await runTemplate('split-script', {
      text: parts[i],
      knownRoles: [...roles.keys()].join('、') || '（暂无）',
      rewriteRule: input.rewrite ? '可以把书面语稍作调整，使其更适合朗读，但不要删减情节。' : '必须逐字保留原文（除了去掉对白外层引号），不得改写、删减或添加任何内容。',
      instructionRule: input.withInstruction ? '为每个片段写一条 1–2 句的风格指令（情绪、语气、语速节奏），贴合上下文。' : 'instruction 字段一律留空字符串。',
      targetLen: String(input.targetLen || 120),
    }, opts);
    debug.push(r.debug);
    const o: any = r.parsed ?? {};
    for (const role of Array.isArray(o.roles) ? o.roles : []) {
      const name = str(role?.name);
      if (!name) continue;
      const cur = roles.get(name);
      if (cur) {
        if (!cur.description && str(role.description)) cur.description = str(role.description);
        if (!cur.instruction && str(role.instruction)) cur.instruction = str(role.instruction);
      } else roles.set(name, { name, description: str(role.description), instruction: str(role.instruction) });
    }
    for (const s of Array.isArray(o.segments) ? o.segments : []) {
      const t = str(s?.text);
      if (!t) continue;
      const role = str(s?.role) || '旁白';
      if (!roles.has(role)) roles.set(role, { name: role, description: '', instruction: '' });
      segments.push({ role, text: t, instruction: input.withInstruction ? str(s?.instruction) : '' });
    }
    const [sm, tot] = coverageCounts(parts[i], segments.slice(before).map((s) => s.text));
    covSame += sm;
    covTotal += tot;
  }
  opts.onProgress?.(parts.length, parts.length);
  if (!segments.length) throw bad('大模型没有返回任何片段');
  // 去掉没有台词的角色（已知角色保留）
  const used = new Set(segments.map((s) => s.role));
  const roleList = [...roles.values()].filter((r) => used.has(r.name) || input.knownRoles.includes(r.name));
  const cov = covTotal ? Math.min(1, covSame / covTotal) : 1;
  if (!input.rewrite && cov < 0.97) warnings.push(`拆分结果只覆盖了原文约 ${Math.round(cov * 100)}%，可能有内容被遗漏或改写，请检查`);
  return { roles: roleList, segments, coverage: Math.round(cov * 1000) / 1000, warnings, debug };
}

// ───────────────────────── 配音推荐与批量 ─────────────────────────

export function voiceCatalog(voices: VoiceSummary[]): string {
  return JSON.stringify(voices.filter((v) => !v.trashed).map((v) => ({
    id: v.id,
    name: v.name,
    type: KIND_LABELS[v.kind],
    gender: GENDER_LABELS[v.gender],
    lang: LANG_LABELS[v.lang],
    tags: v.tags,
    description: v.description ?? undefined,
    notes: v.notes || undefined,
    defaultInstruction: v.defaultInstruction || undefined,
  })), null, 1);
}

export async function castRoles(roles: { name: string; description: string }[], voices: VoiceSummary[], opts: RunOpts): Promise<{ suggestions: CastSuggestion[]; debug: LlmDebug; warnings: string[] }> {
  if (!roles.length) throw bad('项目里还没有角色');
  const r = await runTemplate('cast', { roles: JSON.stringify(roles, null, 1), voices: voiceCatalog(voices) }, opts);
  const byId = new Map(voices.map((v) => [v.id, v]));
  const warnings: string[] = [];
  const suggestions: CastSuggestion[] = [];
  for (const s of Array.isArray(r.parsed) ? r.parsed : []) {
    const v = byId.get(str((s as any)?.voiceId));
    const role = str((s as any)?.role);
    if (!role) continue;
    if (!v) { warnings.push(`「${role}」推荐了不存在的音色 ${str((s as any)?.voiceId)}`); continue; }
    suggestions.push({ role, voiceId: v.id, voiceName: v.name, reason: str((s as any)?.reason) });
  }
  return { suggestions, debug: r.debug, warnings };
}

export async function batchSegments(
  task: 'batch-instruction' | 'batch-tags',
  items: { id: string; role: string; text: string; instruction?: string }[],
  rolesDesc: string,
  intent: string,
  opts: RunOpts,
): Promise<{ values: { id: string; text?: string; instruction?: string }[]; warnings: string[]; debug: LlmDebug[] }> {
  if (!items.length) throw bad('请先选择片段');
  const warnings: string[] = [];
  const debug: LlmDebug[] = [];
  const values: { id: string; text?: string; instruction?: string }[] = [];
  const batchSize = 30;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const r = await runTemplate(task, { ...tagVars(), items: JSON.stringify(batch, null, 1), roles: rolesDesc, intent }, opts);
    debug.push(r.debug);
    const ids = new Set(batch.map((b) => b.id));
    for (const o of Array.isArray(r.parsed) ? r.parsed : []) {
      const id = str((o as any)?.id);
      if (!ids.has(id)) continue;
      if (task === 'batch-instruction') values.push({ id, instruction: str((o as any)?.instruction) });
      else {
        const t = str((o as any)?.text);
        const orig = batch.find((b) => b.id === id)!;
        if (!t) continue;
        if (textChanged(orig.text, t)) warnings.push(`片段「${orig.text.slice(0, 12)}…」的文字被模型改动了，请核对`);
        values.push({ id, text: t });
      }
    }
  }
  const missing = items.length - values.length;
  if (missing > 0) warnings.push(`有 ${missing} 段没有拿到结果`);
  return { values, warnings, debug };
}

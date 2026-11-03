// 提示词模板：内置默认在 server/llm/prompts/*.md，用户修改后保存到 data/prompts/*.md
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LlmTask, PromptTemplate } from '../../shared/types.ts';
import { paths } from '../config.ts';
import { ensureDir, removePath, writeFileAtomic } from '../util/fs.ts';
import { bad } from '../http.ts';
import { emitChange } from '../events.ts';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

export const TASKS: LlmTask[] = [
  'instruction-natural', 'instruction-director', 'tags', 'design-desc', 'preview-text', 'split-script', 'cast', 'batch-instruction', 'batch-tags',
];

interface Parsed { meta: Record<string, string>; system: string; user: string }

function parse(src: string): Parsed {
  const meta: Record<string, string> = {};
  let body = src.replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = body.slice(fm[0].length);
  }
  const sys = /^##\s*system\s*$/im.exec(body);
  const usr = /^##\s*user\s*$/im.exec(body);
  if (!sys || !usr || usr.index < sys.index) return { meta, system: '', user: body.trim() };
  return { meta, system: body.slice(sys.index + sys[0].length, usr.index).trim(), user: body.slice(usr.index + usr[0].length).trim() };
}

function serialize(t: Pick<PromptTemplate, 'title' | 'description' | 'output' | 'variables' | 'temperature' | 'system' | 'user'>): string {
  return [
    '---',
    `title: ${t.title}`,
    `description: ${t.description}`,
    `output: ${t.output}`,
    `variables: ${t.variables.join(', ')}`,
    `temperature: ${t.temperature ?? ''}`,
    '---',
    '## system',
    t.system,
    '',
    '## user',
    t.user,
    '',
  ].join('\n');
}

function toTemplate(task: LlmTask, p: Parsed, overridden: boolean): PromptTemplate {
  const temp = p.meta.temperature === undefined || p.meta.temperature === '' ? null : Number(p.meta.temperature);
  return {
    task,
    title: p.meta.title ?? task,
    description: p.meta.description ?? '',
    output: p.meta.output === 'json' ? 'json' : 'text',
    variables: (p.meta.variables ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    temperature: temp === null || !isFinite(temp) ? null : temp,
    system: p.system,
    user: p.user,
    overridden,
  };
}

function assertTask(task: string): asserts task is LlmTask {
  if (!TASKS.includes(task as LlmTask)) throw bad('未知的提示词任务');
}

export async function getDefaultTemplate(task: LlmTask): Promise<PromptTemplate> {
  return toTemplate(task, parse(await fsp.readFile(path.join(DEFAULT_DIR, `${task}.md`), 'utf8')), false);
}

export async function getTemplate(task: string): Promise<PromptTemplate> {
  assertTask(task);
  const def = await getDefaultTemplate(task);
  try {
    const p = parse(await fsp.readFile(path.join(paths.prompts(), `${task}.md`), 'utf8'));
    const t = toTemplate(task, p, true);
    // 变量列表与输出格式以内置为准（由代码决定）
    return { ...t, title: def.title, description: def.description, output: def.output, variables: def.variables };
  } catch {
    return def;
  }
}

export async function listTemplates(): Promise<PromptTemplate[]> {
  return Promise.all(TASKS.map((t) => getTemplate(t)));
}

export async function saveTemplate(task: string, patch: { system?: string; user?: string; temperature?: number | null }): Promise<PromptTemplate> {
  assertTask(task);
  const cur = await getTemplate(task);
  const next = {
    ...cur,
    system: typeof patch.system === 'string' ? patch.system : cur.system,
    user: typeof patch.user === 'string' ? patch.user : cur.user,
    temperature: patch.temperature === undefined ? cur.temperature : patch.temperature,
  };
  if (!next.user.trim()) throw bad('user 部分不能为空');
  await ensureDir(paths.prompts());
  await writeFileAtomic(path.join(paths.prompts(), `${task}.md`), serialize(next));
  emitChange({ topic: 'prompts' });
  return { ...next, overridden: true };
}

export async function resetTemplate(task: string): Promise<PromptTemplate> {
  assertTask(task);
  await removePath(path.join(paths.prompts(), `${task}.md`));
  emitChange({ topic: 'prompts' });
  return getDefaultTemplate(task);
}

/** {{var}} 替换；{{#var}}…{{/var}} 仅在变量非空时保留 */
export function render(tpl: string, vars: Record<string, string>): string {
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k: string, inner: string) => (vars[k]?.trim() ? inner : ''));
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

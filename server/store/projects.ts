// 剧本项目：projects/<id>/project.json + takes/<segId>/<takeId>.wav + exports/
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { ChunkTiming, Project, ProjectSummary, Role, Segment, SegmentTake } from '../../shared/types.ts';
import { ROLE_COLORS } from '../../shared/presets.ts';
import { activeTake } from '../../shared/effective.ts';
import { fileUrl, paths } from '../config.ts';
import { ensureDir, KeyedMutex, listDirs, movePath, readJson, removePath, within, writeJson } from '../util/fs.ts';
import { isSafeId, newId } from '../util/id.ts';
import { bad, notFound } from '../http.ts';
import { emitChange } from '../events.ts';
import { computePeaks, encodeWav } from '../audio/wav.ts';
import { getSettings } from './settings.ts';
import { createZip, readZip } from '../util/zip.ts';

interface Entry { p: Project; dir: string }
const projects = new Map<string, Entry>();
const lock = new KeyedMutex();

export async function loadProjects(): Promise<void> {
  projects.clear();
  for (const [root, trashed] of [[paths.projects(), false], [paths.trash('projects'), true]] as const) {
    for (const id of await listDirs(root)) {
      const dir = path.join(root, id);
      const p = await readJson<Project | null>(path.join(dir, 'project.json'), null);
      if (!p || p.id !== id) continue;
      if (trashed && !p.trashedAt) p.trashedAt = Date.now();
      if (!trashed) delete p.trashedAt;
      projects.set(id, { p, dir });
    }
  }
}

function entry(id: string): Entry {
  const e = projects.get(id);
  if (!e) throw notFound('项目不存在');
  return e;
}

async function save(e: Entry): Promise<void> {
  e.p.updatedAt = Date.now();
  await writeJson(path.join(e.dir, 'project.json'), e.p);
  emitChange({ topic: 'project', id: e.p.id });
}

function mutate<T>(id: string, fn: (e: Entry) => Promise<T> | T): Promise<T> {
  return lock.run(id, async () => {
    const e = entry(id);
    const r = await fn(e);
    await save(e);
    return r;
  });
}

export interface ProjectView extends Project {
  filesBase: string;
}

export function viewProject(id: string): ProjectView {
  const e = entry(id);
  return { ...e.p, filesBase: fileUrl(e.dir) + '/' };
}

export function getProject(id: string): Project {
  return entry(id).p;
}

export function projectDir(id: string): string {
  return entry(id).dir;
}

export function allProjects(): Project[] {
  return [...projects.values()].map((e) => e.p);
}

export function summarizeProject(p: Project): ProjectSummary {
  let done = 0;
  let dur = 0;
  for (const s of p.segments) {
    const t = activeTake(s);
    if (t) { done++; dur += t.durationMs + (s.pauseAfterMs ?? p.settings.defaultGapMs); }
  }
  return {
    id: p.id, name: p.name, notes: p.notes, roleCount: p.roles.length, segmentCount: p.segments.length, doneCount: done,
    durationMs: dur, createdAt: p.createdAt, updatedAt: p.updatedAt, trashed: !!p.trashedAt,
  };
}

export function listProjects(trash = false): ProjectSummary[] {
  return [...projects.values()].filter((e) => !!e.p.trashedAt === trash).map((e) => summarizeProject(e.p)).sort((a, b) => b.updatedAt - a.updatedAt);
}

function newRole(name: string, index: number, voiceId: string | null = null): Role {
  return { id: newId('r'), name, color: ROLE_COLORS[index % ROLE_COLORS.length], voiceId, instruction: '', notes: '' };
}

function newSegment(roleId: string | null, text: string, instruction = ''): Segment {
  return { id: newId('s'), roleId, text, instruction, pauseAfterMs: null, locked: false, note: '', takes: [], activeTakeId: null };
}

export async function createProject(input: { name?: string; notes?: string }): Promise<Project> {
  const now = Date.now();
  const narrator = newRole('旁白', 0);
  const p: Project = {
    id: newId('p'), name: (input.name ?? '').trim() || '未命名项目', notes: input.notes ?? '',
    roles: [narrator], segments: [], settings: { ...getSettings().project }, createdAt: now, updatedAt: now,
  };
  const dir = paths.project(p.id);
  await ensureDir(dir);
  const e = { p, dir };
  projects.set(p.id, e);
  await save(e);
  emitChange({ topic: 'projects' });
  return p;
}

export function updateProject(id: string, patch: { name?: string; notes?: string; settings?: Partial<Project['settings']> }) {
  return mutate(id, (e) => {
    if (typeof patch.name === 'string') e.p.name = patch.name.trim().slice(0, 100) || e.p.name;
    if (typeof patch.notes === 'string') e.p.notes = patch.notes.slice(0, 10000);
    if (patch.settings) {
      const s = patch.settings;
      if (s.defaultGapMs !== undefined) e.p.settings.defaultGapMs = Math.max(0, Math.min(10000, Number(s.defaultGapMs) || 0));
      if (s.keepTakes !== undefined) e.p.settings.keepTakes = Math.max(1, Math.min(50, Number(s.keepTakes) || 5));
    }
    emitChange({ topic: 'projects' });
    return e.p;
  });
}

// ───────────────────────── 角色 ─────────────────────────

export function addRole(id: string, input: { name?: string; voiceId?: string | null; instruction?: string }) {
  return mutate(id, (e) => {
    const name = (input.name ?? '').trim() || `角色${e.p.roles.length + 1}`;
    if (e.p.roles.some((r) => r.name === name)) throw bad(`已有同名角色「${name}」`);
    const r = newRole(name, e.p.roles.length, input.voiceId ?? null);
    r.instruction = input.instruction ?? '';
    e.p.roles.push(r);
    return r;
  });
}

export function updateRole(id: string, roleId: string, patch: Partial<Pick<Role, 'name' | 'color' | 'voiceId' | 'instruction' | 'notes'>>) {
  return mutate(id, (e) => {
    const r = e.p.roles.find((x) => x.id === roleId);
    if (!r) throw notFound('角色不存在');
    if (typeof patch.name === 'string') {
      const n = patch.name.trim();
      if (!n) throw bad('角色名不能为空');
      if (e.p.roles.some((x) => x.id !== roleId && x.name === n)) throw bad(`已有同名角色「${n}」`);
      r.name = n.slice(0, 40);
    }
    if (typeof patch.color === 'string') r.color = patch.color;
    if (patch.voiceId !== undefined) r.voiceId = patch.voiceId || null;
    if (typeof patch.instruction === 'string') r.instruction = patch.instruction.slice(0, 4000);
    if (typeof patch.notes === 'string') r.notes = patch.notes.slice(0, 2000);
    return r;
  });
}

export function deleteRole(id: string, roleId: string, reassignTo: string | null) {
  return mutate(id, (e) => {
    e.p.roles = e.p.roles.filter((r) => r.id !== roleId);
    const target = reassignTo && e.p.roles.some((r) => r.id === reassignTo) ? reassignTo : null;
    for (const s of e.p.segments) if (s.roleId === roleId) s.roleId = target;
  });
}

/** 按名字找角色，没有就新建（剧本拆分导入用） */
export function ensureRoles(id: string, names: { name: string; instruction?: string }[]) {
  return mutate(id, (e) => {
    const map: Record<string, string> = {};
    for (const n of names) {
      const name = n.name.trim() || '旁白';
      let r = e.p.roles.find((x) => x.name === name);
      if (!r) {
        r = newRole(name, e.p.roles.length);
        r.instruction = n.instruction ?? '';
        e.p.roles.push(r);
      }
      map[name] = r.id;
    }
    return map;
  });
}

// ───────────────────────── 片段 ─────────────────────────

export function insertSegments(id: string, input: { afterId?: string | null; replaceAll?: boolean; items: { roleId?: string | null; text: string; instruction?: string }[] }) {
  return mutate(id, async (e) => {
    const roleIds = new Set(e.p.roles.map((r) => r.id));
    const segs = input.items.filter((it) => String(it.text ?? '').trim()).map((it) =>
      // roleId 显式为 null 表示「不指定角色」；省略或无效时归给第一个角色
      newSegment(it.roleId === null ? null : it.roleId && roleIds.has(it.roleId) ? it.roleId : e.p.roles[0]?.id ?? null, String(it.text).trim(), String(it.instruction ?? '').trim()),
    );
    if (input.replaceAll) {
      for (const s of e.p.segments) await removePath(path.join(e.dir, 'takes', s.id));
      e.p.segments = segs;
      return segs;
    }
    let idx = e.p.segments.length;
    if (input.afterId === null) idx = 0;
    else if (input.afterId) {
      const i = e.p.segments.findIndex((s) => s.id === input.afterId);
      if (i >= 0) idx = i + 1;
    }
    e.p.segments.splice(idx, 0, ...segs);
    return segs;
  });
}

function seg(e: Entry, segId: string): Segment {
  const s = e.p.segments.find((x) => x.id === segId);
  if (!s) throw notFound('片段不存在');
  return s;
}

type SegPatch = Partial<Pick<Segment, 'roleId' | 'text' | 'instruction' | 'pauseAfterMs' | 'locked' | 'note' | 'activeTakeId'>>;

function applySegPatch(e: Entry, s: Segment, patch: SegPatch): void {
  const editing = patch.text !== undefined || patch.instruction !== undefined || patch.roleId !== undefined;
  if (s.locked && editing && patch.locked !== false) throw bad('片段已锁定，先解锁再修改');
  if (patch.roleId !== undefined) {
    if (patch.roleId && !e.p.roles.some((r) => r.id === patch.roleId)) throw bad('角色不存在');
    s.roleId = patch.roleId || null;
  }
  if (typeof patch.text === 'string') s.text = patch.text.slice(0, 20000);
  if (typeof patch.instruction === 'string') s.instruction = patch.instruction.slice(0, 4000);
  if (patch.pauseAfterMs !== undefined) s.pauseAfterMs = patch.pauseAfterMs === null ? null : Math.max(0, Math.min(20000, Number(patch.pauseAfterMs) || 0));
  if (typeof patch.locked === 'boolean') s.locked = patch.locked;
  if (typeof patch.note === 'string') s.note = patch.note.slice(0, 2000);
  if (patch.activeTakeId !== undefined) {
    if (patch.activeTakeId && !s.takes.some((t) => t.id === patch.activeTakeId)) throw bad('版本不存在');
    s.activeTakeId = patch.activeTakeId;
  }
}

export function updateSegment(id: string, segId: string, patch: SegPatch) {
  return mutate(id, (e) => {
    const s = seg(e, segId);
    applySegPatch(e, s, patch);
    return s;
  });
}

export function batchUpdateSegments(id: string, ids: string[], patch: SegPatch) {
  return mutate(id, (e) => {
    const set = new Set(ids);
    for (const s of e.p.segments) if (set.has(s.id)) {
      if (s.locked && patch.locked === undefined && (patch.roleId !== undefined || patch.instruction !== undefined || patch.text !== undefined)) continue;
      applySegPatch(e, s, patch);
    }
  });
}

/** 批量写入每段不同的值（大模型补指令/打标签后采用） */
export function applySegmentValues(id: string, values: { id: string; text?: string; instruction?: string }[]) {
  return mutate(id, (e) => {
    let n = 0;
    for (const v of values) {
      const s = e.p.segments.find((x) => x.id === v.id);
      if (!s || s.locked) continue;
      if (typeof v.text === 'string' && v.text.trim()) s.text = v.text.trim();
      if (typeof v.instruction === 'string') s.instruction = v.instruction.trim();
      n++;
    }
    return n;
  });
}

export function deleteSegments(id: string, ids: string[]) {
  return mutate(id, async (e) => {
    const set = new Set(ids);
    for (const s of e.p.segments) if (set.has(s.id)) await removePath(path.join(e.dir, 'takes', s.id));
    e.p.segments = e.p.segments.filter((s) => !set.has(s.id));
  });
}

export function reorderSegments(id: string, orderedIds: string[]) {
  return mutate(id, (e) => {
    const map = new Map(e.p.segments.map((s) => [s.id, s]));
    const out: Segment[] = [];
    for (const sid of orderedIds) { const s = map.get(sid); if (s) { out.push(s); map.delete(sid); } }
    e.p.segments = [...out, ...map.values()];
  });
}

export function splitSegment(id: string, segId: string, at: number) {
  return mutate(id, (e) => {
    const i = e.p.segments.findIndex((s) => s.id === segId);
    if (i < 0) throw notFound('片段不存在');
    const s = e.p.segments[i];
    if (s.locked) throw bad('片段已锁定');
    const chars = Array.from(s.text);
    const pos = Math.max(1, Math.min(chars.length - 1, Math.round(at)));
    const a = chars.slice(0, pos).join('').trim();
    const b = chars.slice(pos).join('').trim();
    if (!a || !b) throw bad('拆分位置不合适');
    s.text = a;
    const n = newSegment(s.roleId, b, s.instruction);
    n.pauseAfterMs = s.pauseAfterMs;
    s.pauseAfterMs = null;
    e.p.segments.splice(i + 1, 0, n);
    return n;
  });
}

export function mergeSegments(id: string, ids: string[]) {
  return mutate(id, async (e) => {
    const idx = ids.map((sid) => e.p.segments.findIndex((s) => s.id === sid)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (idx.length < 2) throw bad('至少选择两段');
    const first = e.p.segments[idx[0]];
    const rest = idx.slice(1).map((i) => e.p.segments[i]);
    if ([first, ...rest].some((s) => s.locked)) throw bad('有片段已锁定');
    first.text = [first.text, ...rest.map((s) => s.text)].join('');
    first.pauseAfterMs = rest[rest.length - 1].pauseAfterMs;
    for (const s of rest) await removePath(path.join(e.dir, 'takes', s.id));
    const drop = new Set(rest.map((s) => s.id));
    e.p.segments = e.p.segments.filter((s) => !drop.has(s.id));
    return first;
  });
}

export interface TakeInput {
  samples: Float32Array;
  sampleRate: number;
  voiceId: string;
  voiceName: string;
  voiceVersion: string;
  model: string;
  instruction: string;
  text: string;
  chunks: ChunkTiming[];
  warnings: string[];
}

export function addSegmentTake(id: string, segId: string, t: TakeInput) {
  return mutate(id, async (e) => {
    const s = seg(e, segId);
    const take: SegmentTake = {
      id: newId('t'), file: '', createdAt: Date.now(), durationMs: Math.round((t.samples.length / t.sampleRate) * 1000),
      peaks: computePeaks(t.samples), voiceId: t.voiceId, voiceName: t.voiceName, voiceVersion: t.voiceVersion, model: t.model,
      instruction: t.instruction, text: t.text, chunks: t.chunks, warnings: t.warnings, starred: false,
    };
    take.file = `takes/${s.id}/${take.id}.wav`;
    await ensureDir(path.join(e.dir, 'takes', s.id));
    await fsp.writeFile(path.join(e.dir, take.file), encodeWav(t.samples, t.sampleRate));
    s.takes.unshift(take);
    s.activeTakeId = take.id;
    delete s.lastError;
    // 超出保留数量的旧版本（未收藏、非当前）删掉
    const keep = e.p.settings.keepTakes;
    const removable = s.takes.filter((x) => !x.starred && x.id !== s.activeTakeId);
    const over = s.takes.length - keep;
    if (over > 0) {
      const drop = new Set(removable.slice(-over).map((x) => x.id));
      for (const x of s.takes) if (drop.has(x.id)) await removePath(path.join(e.dir, x.file));
      s.takes = s.takes.filter((x) => !drop.has(x.id));
    }
    return take;
  });
}

export function addSegmentTakeFromFile(id: string, segId: string, file: string, meta: Omit<SegmentTake, 'id' | 'file' | 'createdAt' | 'starred'>) {
  return mutate(id, async (e) => {
    const s = seg(e, segId);
    const take: SegmentTake = { ...meta, id: newId('t'), file: '', createdAt: Date.now(), starred: false };
    take.file = `takes/${s.id}/${take.id}.wav`;
    await ensureDir(path.join(e.dir, 'takes', s.id));
    await fsp.copyFile(file, path.join(e.dir, take.file));
    s.takes.unshift(take);
    s.activeTakeId = take.id;
    return take;
  });
}

export function updateSegmentTake(id: string, segId: string, takeId: string, patch: { starred?: boolean }) {
  return mutate(id, (e) => {
    const t = seg(e, segId).takes.find((x) => x.id === takeId);
    if (!t) throw notFound('版本不存在');
    if (typeof patch.starred === 'boolean') t.starred = patch.starred;
    return t;
  });
}

export function deleteSegmentTake(id: string, segId: string, takeId: string) {
  return mutate(id, async (e) => {
    const s = seg(e, segId);
    const t = s.takes.find((x) => x.id === takeId);
    if (!t) return;
    await removePath(path.join(e.dir, t.file));
    s.takes = s.takes.filter((x) => x.id !== takeId);
    if (s.activeTakeId === takeId) s.activeTakeId = s.takes[0]?.id ?? null;
  });
}

export function setSegmentError(id: string, segId: string, msg: string | undefined) {
  return mutate(id, (e) => {
    const s = e.p.segments.find((x) => x.id === segId);
    if (!s) return;
    if (msg) s.lastError = msg; else delete s.lastError;
  });
}

export function segmentTakeFile(id: string, segId: string, takeId: string): { file: string; take: SegmentTake; segment: Segment } {
  const e = entry(id);
  const s = seg(e, segId);
  const t = s.takes.find((x) => x.id === takeId);
  if (!t) throw notFound('版本不存在');
  return { file: path.join(e.dir, t.file), take: t, segment: s };
}

// ───────────────────────── 项目级 ─────────────────────────

export async function duplicateProject(id: string): Promise<Project> {
  const src = entry(id);
  const p: Project = structuredClone(src.p);
  p.id = newId('p');
  p.name = `${src.p.name} 副本`;
  p.createdAt = p.updatedAt = Date.now();
  delete p.trashedAt;
  const dir = paths.project(p.id);
  await fsp.cp(src.dir, dir, { recursive: true });
  await removePath(path.join(dir, 'exports'));
  const e = { p, dir };
  projects.set(p.id, e);
  await save(e);
  emitChange({ topic: 'projects' });
  return p;
}

export async function trashProject(id: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    if (e.p.trashedAt) return;
    const to = path.join(paths.trash('projects'), id);
    await movePath(e.dir, to);
    e.dir = to;
    e.p.trashedAt = Date.now();
    await save(e);
    emitChange({ topic: 'projects' });
  });
}

export async function restoreProject(id: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    if (!e.p.trashedAt) return;
    const to = paths.project(id);
    await movePath(e.dir, to);
    e.dir = to;
    delete e.p.trashedAt;
    await save(e);
    emitChange({ topic: 'projects' });
  });
}

export async function destroyProject(id: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    if (!e.p.trashedAt) throw bad('请先移入回收站');
    await removePath(e.dir);
    projects.delete(id);
    emitChange({ topic: 'projects' });
  });
}

/** 项目包：project.json + 全部版本音频 */
export async function exportProjectPackage(id: string): Promise<Buffer> {
  const e = entry(id);
  const entries: { name: string; data: Buffer | string }[] = [{ name: 'project.json', data: JSON.stringify(e.p, null, 2) }];
  for (const s of e.p.segments) for (const t of s.takes) {
    try { entries.push({ name: t.file, data: await fsp.readFile(path.join(e.dir, t.file)) }); } catch { /* 文件丢失就跳过 */ }
  }
  return createZip(entries);
}

export async function importProjectPackage(zip: Buffer): Promise<Project> {
  const files = readZip(zip);
  const pj = files.find((f) => f.name === 'project.json' || f.name.endsWith('/project.json'));
  if (!pj) throw bad('ZIP 里没有 project.json');
  const prefix = pj.name.slice(0, pj.name.length - 'project.json'.length);
  let p: Project;
  try { p = JSON.parse(pj.data.toString('utf8')); } catch { throw bad('project.json 格式错误'); }
  if (!Array.isArray(p?.segments) || !Array.isArray(p?.roles)) throw bad('project.json 格式错误');
  p.id = newId('p');
  p.name = `${p.name || '导入项目'}`;
  p.createdAt = p.updatedAt = Date.now();
  p.settings = { ...getSettings().project, ...(p.settings ?? {}) };
  delete p.trashedAt;
  const dir = paths.project(p.id);
  await ensureDir(dir);
  for (const f of files) {
    if (!f.name.startsWith(prefix) || f.name === pj.name) continue;
    const rel = f.name.slice(prefix.length);
    if (!rel.startsWith('takes/')) continue;
    const target = path.join(dir, rel);
    if (!within(dir, target)) continue;
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, f.data);
  }
  const e = { p, dir };
  projects.set(p.id, e);
  await save(e);
  emitChange({ topic: 'projects' });
  return p;
}

export function exportsDir(id: string): string {
  return path.join(entry(id).dir, 'exports');
}

export async function listExports(id: string): Promise<{ name: string; url: string; bytes: number; createdAt: number }[]> {
  const dir = exportsDir(id);
  try {
    const names = await fsp.readdir(dir);
    const out = [];
    for (const n of names) {
      if (n.endsWith('.tmp')) continue;
      const st = await fsp.stat(path.join(dir, n));
      out.push({ name: n, url: fileUrl(path.join(dir, n)), bytes: st.size, createdAt: st.mtimeMs });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

export async function deleteExport(id: string, name: string): Promise<void> {
  const dir = exportsDir(id);
  const target = path.join(dir, name);
  if (!within(dir, target)) throw bad('文件名无效');
  await removePath(target);
  emitChange({ topic: 'project', id });
}

export function validProjectId(id: string): boolean { return isSafeId(id); }

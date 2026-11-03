// 音色库：一个音色一个文件夹（voices/<id>/voice.json + 音频），回收站在 trash/voices/
import path from 'node:path';
import fsp from 'node:fs/promises';
import type {
  DesignTake, ProcessParams, ProcessPresetId, Region, RefVersion, SynthMode, VoiceGender, VoiceKind, VoiceLang,
  VoiceOrigin, VoicePreview, VoiceRecord, VoiceSnapshot, VoiceSummary,
} from '../../shared/types.ts';
import { BUILTIN_VOICES, builtinById, PROCESS_PRESETS } from '../../shared/presets.ts';
import { hash32 } from '../../shared/text.ts';
import { fileUrl, paths } from '../config.ts';
import { ensureDir, KeyedMutex, listDirs, movePath, readJson, removePath, within, writeJson } from '../util/fs.ts';
import { isSafeId, newId } from '../util/id.ts';
import { bad, HttpError, notFound } from '../http.ts';
import { emitChange } from '../events.ts';
import { encodeWav } from '../audio/wav.ts';
import { computePeaks } from '../audio/wav.ts';
import { createUploadFromFile, deleteUpload, getUpload, normalizeRegion, paramsHash, processUpload, uploadDir } from './uploads.ts';
import { getSettings, setBuiltinFavorite } from './settings.ts';
import type { ResolvedVoice } from '../mimo/request.ts';
import { createZip, readZip } from '../util/zip.ts';

interface Entry { rec: VoiceRecord; dir: string }

const voices = new Map<string, Entry>();
const lock = new KeyedMutex();

const LANGS: VoiceLang[] = ['', 'zh', 'en', 'mixed', 'other'];
const GENDERS: VoiceGender[] = ['', 'female', 'male', 'other'];

export async function loadVoices(): Promise<void> {
  voices.clear();
  for (const [root, trashed] of [[paths.voices(), false], [paths.trash('voices'), true]] as const) {
    for (const id of await listDirs(root)) {
      const dir = path.join(root, id);
      const rec = await readJson<VoiceRecord | null>(path.join(dir, 'voice.json'), null);
      if (!rec || rec.id !== id) continue;
      if (trashed && !rec.trashedAt) rec.trashedAt = Date.now();
      if (!trashed) delete rec.trashedAt;
      rec.refs ??= [];
      rec.tags ??= [];
      voices.set(id, { rec, dir });
    }
  }
}

function entry(id: string): Entry {
  const e = voices.get(id);
  if (!e) throw notFound('音色不存在');
  return e;
}

async function save(e: Entry): Promise<void> {
  e.rec.updatedAt = Date.now();
  await writeJson(path.join(e.dir, 'voice.json'), e.rec);
}

function changed(id?: string) { emitChange({ topic: 'voices', id }); }

export function isBuiltin(id: string): boolean {
  return id.startsWith('builtin-');
}

function builtinRecord(id: string): VoiceRecord {
  const b = builtinById(id);
  if (!b) throw notFound('预置音色不存在');
  return {
    id: b.id, kind: 'preset', name: b.name, tags: ['官方'], lang: b.lang, gender: b.gender, notes: b.notes,
    favorite: getSettings().builtinFavorites.includes(b.id), defaultInstruction: '', presetId: b.presetId,
    refs: [], currentRef: null, createdAt: 0, updatedAt: 0,
  };
}

export function currentRef(rec: VoiceRecord): RefVersion | null {
  if (rec.currentRef == null) return null;
  return rec.refs.find((r) => r.version === rec.currentRef) ?? null;
}

export function voiceMode(rec: VoiceRecord): SynthMode {
  if (rec.kind === 'preset') return 'preset';
  if (rec.kind === 'design') return rec.currentRef != null ? 'clone' : 'design';
  return 'clone';
}

export function voiceVersion(rec: VoiceRecord): string {
  if (rec.kind === 'preset') return `preset:${rec.presetId}`;
  if (rec.kind === 'design' && rec.currentRef == null) return `desc:${hash32(rec.description ?? '')}`;
  return `ref:v${rec.currentRef}`;
}

function summarize(rec: VoiceRecord, dir: string | null, builtin: boolean, preview?: VoicePreview & { dir: string }): VoiceSummary {
  const ref = currentRef(rec);
  let status: VoiceSummary['status'] = 'ready';
  if (builtin) status = 'builtin';
  else if (rec.kind === 'design') status = rec.currentRef != null ? 'fixed' : rec.takes?.length ? 'drafting' : 'draft';
  const pv = preview ?? (rec.preview && dir ? { ...rec.preview, dir } : undefined);
  return {
    id: rec.id, kind: rec.kind, builtin, name: rec.name, tags: rec.tags, lang: rec.lang, gender: rec.gender, notes: rec.notes,
    favorite: rec.favorite, defaultInstruction: rec.defaultInstruction, presetId: rec.presetId, description: rec.description,
    mode: voiceMode(rec), version: voiceVersion(rec), status, takeCount: rec.takes?.length ?? 0,
    grade: ref?.report.grade, refDurationMs: ref?.processedDurationMs,
    preview: pv ? { url: fileUrl(path.join(pv.dir, pv.file)), text: pv.text, voiceVersion: pv.voiceVersion, durationMs: pv.durationMs, peaks: pv.peaks } : undefined,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt, trashed: !!rec.trashedAt,
  };
}

const builtinPreviews = new Map<string, VoicePreview>();

export async function loadBuiltinPreviews(): Promise<void> {
  for (const b of BUILTIN_VOICES) {
    const p = await readJson<VoicePreview | null>(path.join(paths.presets(), b.id, 'preview.json'), null);
    if (p) builtinPreviews.set(b.id, p);
  }
}

export function listVoices(opts: { trash?: boolean } = {}): VoiceSummary[] {
  const out: VoiceSummary[] = [];
  if (!opts.trash) {
    for (const b of BUILTIN_VOICES) {
      const pv = builtinPreviews.get(b.id);
      out.push(summarize(builtinRecord(b.id), null, true, pv ? { ...pv, dir: path.join(paths.presets(), b.id) } : undefined));
    }
  }
  const users = [...voices.values()].filter((e) => !!e.rec.trashedAt === !!opts.trash).sort((a, b) => b.rec.updatedAt - a.rec.updatedAt);
  for (const e of users) out.push(summarize(e.rec, e.dir, false));
  return out;
}

export function summaryOf(id: string): VoiceSummary | null {
  if (isBuiltin(id)) {
    if (!builtinById(id)) return null;
    const pv = builtinPreviews.get(id);
    return summarize(builtinRecord(id), null, true, pv ? { ...pv, dir: path.join(paths.presets(), id) } : undefined);
  }
  const e = voices.get(id);
  return e ? summarize(e.rec, e.dir, false) : null;
}

export function allSummaries(): Map<string, VoiceSummary> {
  const m = new Map<string, VoiceSummary>();
  for (const s of [...listVoices(), ...listVoices({ trash: true })]) m.set(s.id, s);
  return m;
}

export interface VoiceDetail extends VoiceRecord {
  builtin: boolean;
  summary: VoiceSummary;
  urls: { takes: Record<string, string>; refs: Record<number, { original: string; source: string; processed: string }> };
}

export function getVoiceDetail(id: string): VoiceDetail {
  if (isBuiltin(id)) {
    const rec = builtinRecord(id);
    return { ...rec, builtin: true, summary: summaryOf(id)!, urls: { takes: {}, refs: {} } };
  }
  const e = entry(id);
  const takes: Record<string, string> = {};
  for (const t of e.rec.takes ?? []) takes[t.id] = fileUrl(path.join(e.dir, t.file));
  const refs: VoiceDetail['urls']['refs'] = {};
  for (const r of e.rec.refs) {
    const base = path.join(e.dir, 'refs', `v${r.version}`);
    refs[r.version] = { original: fileUrl(path.join(base, r.original.file)), source: fileUrl(path.join(base, r.sourceFile)), processed: fileUrl(path.join(base, r.processedFile)) };
  }
  return { ...e.rec, builtin: false, summary: summarize(e.rec, e.dir, false), urls: { takes, refs } };
}

export function getRecord(id: string): VoiceRecord {
  return isBuiltin(id) ? builtinRecord(id) : entry(id).rec;
}

export function voiceDir(id: string): string {
  return entry(id).dir;
}

// ───────────────────────── 创建与修改 ─────────────────────────

interface CommonInput {
  name?: string; tags?: string[]; lang?: string; gender?: string; notes?: string; favorite?: boolean; defaultInstruction?: string;
}

function applyCommon(rec: VoiceRecord, p: CommonInput): void {
  if (typeof p.name === 'string') {
    const n = p.name.trim();
    if (!n) throw bad('名称不能为空');
    rec.name = n.slice(0, 60);
  }
  if (Array.isArray(p.tags)) rec.tags = [...new Set(p.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 30);
  if (typeof p.lang === 'string' && LANGS.includes(p.lang as VoiceLang)) rec.lang = p.lang as VoiceLang;
  if (typeof p.gender === 'string' && GENDERS.includes(p.gender as VoiceGender)) rec.gender = p.gender as VoiceGender;
  if (typeof p.notes === 'string') rec.notes = p.notes.slice(0, 4000);
  if (typeof p.favorite === 'boolean') rec.favorite = p.favorite;
  if (typeof p.defaultInstruction === 'string') rec.defaultInstruction = p.defaultInstruction.slice(0, 4000);
}

function blank(kind: VoiceKind, name: string): VoiceRecord {
  const now = Date.now();
  return { id: newId('v'), kind, name, tags: [], lang: '', gender: '', notes: '', favorite: false, defaultInstruction: '', refs: [], currentRef: null, createdAt: now, updatedAt: now };
}

async function insert(rec: VoiceRecord): Promise<Entry> {
  const dir = paths.voice(rec.id);
  await ensureDir(dir);
  const e = { rec, dir };
  voices.set(rec.id, e);
  await save(e);
  changed(rec.id);
  return e;
}

export async function createPresetVariant(input: CommonInput & { presetId: string }): Promise<VoiceRecord> {
  const b = BUILTIN_VOICES.find((v) => v.presetId === input.presetId);
  if (!b) throw bad('未知的预置音色');
  const rec = blank('preset', `${b.name}·变体`);
  rec.presetId = b.presetId;
  rec.lang = b.lang;
  rec.gender = b.gender;
  applyCommon(rec, input);
  return (await insert(rec)).rec;
}

export async function createDesign(input: CommonInput & { description: string; origin?: VoiceOrigin }): Promise<VoiceRecord> {
  const desc = String(input.description ?? '').trim();
  if (!desc) throw bad('音色描述不能为空');
  const rec = blank('design', '新设计音色');
  rec.description = desc.slice(0, 2000);
  rec.takes = [];
  if (input.origin) rec.origin = input.origin;
  applyCommon(rec, input);
  return (await insert(rec)).rec;
}

export interface RefInput {
  uploadId: string;
  region: Region | null;
  params: ProcessParams;
  preset: ProcessPresetId;
}

async function refFromUpload(e: Entry, input: RefInput): Promise<RefVersion> {
  const up = await getUpload(input.uploadId);
  const reg = normalizeRegion(input.region, up.sourceDurationSec);
  const result = await processUpload(up.id, reg, input.params);
  if (!result.report.usable) {
    throw new HttpError(422, `参考音频不可用：${result.report.warnings.filter((w) => w.level === 'error').map((w) => w.message).join('；')}`);
  }
  const version = (e.rec.refs.reduce((m, r) => Math.max(m, r.version), 0) || 0) + 1;
  const vdir = path.join(e.dir, 'refs', `v${version}`);
  await ensureDir(vdir);
  const udir = uploadDir(up.id);
  const originalName = `original${path.extname(up.originalFile)}`;
  await fsp.copyFile(path.join(udir, up.originalFile), path.join(vdir, originalName));
  await fsp.copyFile(path.join(udir, 'source.wav'), path.join(vdir, 'source.wav'));
  const hash = paramsHash(reg, input.params);
  const processed = (await getUpload(up.id)).processed[hash];
  await fsp.copyFile(path.join(udir, processed.file), path.join(vdir, 'processed.wav'));
  const st = await fsp.stat(path.join(vdir, 'processed.wav'));
  return {
    version,
    createdAt: Date.now(),
    source: up.source,
    sourceLabel: up.sourceLabel,
    takeId: up.takeId,
    original: { file: originalName, name: up.name, mime: up.mime, bytes: up.bytes, info: up.info },
    sourceFile: 'source.wav',
    processedFile: 'processed.wav',
    region: reg,
    params: input.params,
    preset: input.preset,
    report: result.report,
    processedDurationMs: result.durationMs,
    processedBytes: st.size,
    peaks: result.peaks,
  };
}

export async function createClone(input: CommonInput & { ref: RefInput; origin?: VoiceOrigin }): Promise<VoiceRecord> {
  const rec = blank('clone', '新克隆音色');
  applyCommon(rec, input);
  if (input.origin) rec.origin = input.origin;
  const dir = paths.voice(rec.id);
  await ensureDir(dir);
  const e: Entry = { rec, dir };
  try {
    const ref = await refFromUpload(e, input.ref);
    rec.refs = [ref];
    rec.currentRef = ref.version;
  } catch (err) {
    await removePath(dir);
    throw err;
  }
  voices.set(rec.id, e);
  await save(e);
  changed(rec.id);
  return rec;
}

/** 给克隆音色（或设计音色）新增一个参考音频版本并启用 */
export async function addRef(id: string, input: RefInput): Promise<VoiceRecord> {
  return lock.run(id, async () => {
    const e = entry(id);
    if (e.rec.kind === 'preset') throw bad('预置音色没有参考音频');
    const ref = await refFromUpload(e, input);
    e.rec.refs.push(ref);
    e.rec.currentRef = ref.version;
    await save(e);
    changed(id);
    return e.rec;
  });
}

export async function activateRef(id: string, version: number | null): Promise<VoiceRecord> {
  return lock.run(id, async () => {
    const e = entry(id);
    if (version === null) {
      if (e.rec.kind !== 'design') throw bad('克隆音色必须有一个参考音频');
      e.rec.currentRef = null;
    } else {
      if (!e.rec.refs.some((r) => r.version === version)) throw notFound('参考音频版本不存在');
      e.rec.currentRef = version;
    }
    await save(e);
    changed(id);
    return e.rec;
  });
}

export async function deleteRef(id: string, version: number): Promise<VoiceRecord> {
  return lock.run(id, async () => {
    const e = entry(id);
    if (e.rec.currentRef === version) throw bad('不能删除正在使用的版本，请先切换到其他版本');
    e.rec.refs = e.rec.refs.filter((r) => r.version !== version);
    await removePath(path.join(e.dir, 'refs', `v${version}`));
    await save(e);
    changed(id);
    return e.rec;
  });
}

export async function updateVoice(id: string, patch: CommonInput & { description?: string; presetId?: string }): Promise<VoiceRecord> {
  if (isBuiltin(id)) {
    if (typeof patch.favorite === 'boolean') { await setBuiltinFavorite(id, patch.favorite); changed(id); }
    return builtinRecord(id);
  }
  return lock.run(id, async () => {
    const e = entry(id);
    applyCommon(e.rec, patch);
    if (typeof patch.description === 'string' && e.rec.kind === 'design') {
      const d = patch.description.trim();
      if (!d) throw bad('音色描述不能为空');
      e.rec.description = d.slice(0, 2000);
    }
    if (typeof patch.presetId === 'string' && e.rec.kind === 'preset') {
      if (!BUILTIN_VOICES.some((b) => b.presetId === patch.presetId)) throw bad('未知的预置音色');
      e.rec.presetId = patch.presetId;
    }
    await save(e);
    changed(id);
    return e.rec;
  });
}

export async function duplicateVoice(id: string): Promise<VoiceRecord> {
  if (isBuiltin(id)) {
    const b = builtinById(id)!;
    return createPresetVariant({ presetId: b.presetId, name: `${b.name}·变体` });
  }
  const src = entry(id);
  const rec: VoiceRecord = structuredClone(src.rec);
  rec.id = newId('v');
  rec.name = `${src.rec.name} 副本`;
  rec.createdAt = rec.updatedAt = Date.now();
  rec.origin = { type: 'duplicate', voiceId: src.rec.id, voiceName: src.rec.name };
  delete rec.trashedAt;
  const dir = paths.voice(rec.id);
  await fsp.cp(src.dir, dir, { recursive: true });
  const e = { rec, dir };
  voices.set(rec.id, e);
  await save(e);
  changed(rec.id);
  return rec;
}

export async function trashVoice(id: string): Promise<void> {
  if (isBuiltin(id)) throw bad('预置音色不能删除');
  await lock.run(id, async () => {
    const e = entry(id);
    if (e.rec.trashedAt) return;
    const to = path.join(paths.trash('voices'), id);
    await movePath(e.dir, to);
    e.dir = to;
    e.rec.trashedAt = Date.now();
    await save(e);
    changed(id);
  });
}

export async function restoreVoice(id: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    if (!e.rec.trashedAt) return;
    const to = paths.voice(id);
    await movePath(e.dir, to);
    e.dir = to;
    delete e.rec.trashedAt;
    await save(e);
    changed(id);
  });
}

export async function destroyVoice(id: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    if (!e.rec.trashedAt) throw bad('请先移入回收站');
    await removePath(e.dir);
    voices.delete(id);
    changed(id);
  });
}

// ───────────────────────── 设计音色：抽卡与固化 ─────────────────────────

export async function addDesignTake(
  id: string,
  t: { samples: Float32Array; sampleRate: number; text: string; description: string; optimizeTextPreview: boolean; actualText?: string },
): Promise<DesignTake> {
  return lock.run(id, async () => {
    const e = entry(id);
    if (e.rec.kind !== 'design') throw bad('只有设计音色有试听记录');
    const take: DesignTake = {
      id: newId('t'),
      file: '',
      createdAt: Date.now(),
      description: t.description,
      text: t.text,
      actualText: t.actualText,
      optimizeTextPreview: t.optimizeTextPreview,
      durationMs: Math.round((t.samples.length / t.sampleRate) * 1000),
      peaks: computePeaks(t.samples),
      starred: false,
      note: '',
    };
    take.file = `takes/${take.id}.wav`;
    await ensureDir(path.join(e.dir, 'takes'));
    await fsp.writeFile(path.join(e.dir, take.file), encodeWav(t.samples, t.sampleRate));
    e.rec.takes = [take, ...(e.rec.takes ?? [])];
    await save(e);
    changed(id);
    return take;
  });
}

export async function addDesignTakeFromFile(id: string, file: string, meta: { text: string; description: string; durationMs: number; peaks: number[] }): Promise<DesignTake> {
  return lock.run(id, async () => {
    const e = entry(id);
    const take: DesignTake = {
      id: newId('t'), file: '', createdAt: Date.now(), description: meta.description, text: meta.text,
      optimizeTextPreview: false, durationMs: meta.durationMs, peaks: meta.peaks, starred: false, note: '',
    };
    take.file = `takes/${take.id}.wav`;
    await ensureDir(path.join(e.dir, 'takes'));
    await fsp.copyFile(file, path.join(e.dir, take.file));
    e.rec.takes = [take, ...(e.rec.takes ?? [])];
    await save(e);
    changed(id);
    return take;
  });
}

export async function updateTake(id: string, takeId: string, patch: { starred?: boolean; note?: string }): Promise<DesignTake> {
  return lock.run(id, async () => {
    const e = entry(id);
    const t = e.rec.takes?.find((x) => x.id === takeId);
    if (!t) throw notFound('试听记录不存在');
    if (typeof patch.starred === 'boolean') t.starred = patch.starred;
    if (typeof patch.note === 'string') t.note = patch.note.slice(0, 500);
    await save(e);
    changed(id);
    return t;
  });
}

export async function deleteTake(id: string, takeId: string): Promise<void> {
  await lock.run(id, async () => {
    const e = entry(id);
    const t = e.rec.takes?.find((x) => x.id === takeId);
    if (!t) return;
    e.rec.takes = e.rec.takes!.filter((x) => x.id !== takeId);
    // 已固化的参考音频是独立拷贝，删除试听不影响
    await removePath(path.join(e.dir, t.file));
    await save(e);
    changed(id);
  });
}

export function takeFile(id: string, takeId: string): { file: string; take: DesignTake } {
  const e = entry(id);
  const t = e.rec.takes?.find((x) => x.id === takeId);
  if (!t) throw notFound('试听记录不存在');
  return { file: path.join(e.dir, t.file), take: t };
}

/** 固化：把某条试听作为参考音频（经「固化」预设标准化），之后合成走 voiceclone */
export async function fixDesign(id: string, takeId: string): Promise<VoiceRecord> {
  const e = entry(id);
  if (e.rec.kind !== 'design') throw bad('只有设计音色可以固化');
  const existing = e.rec.refs.find((r) => r.takeId === takeId);
  if (existing) return activateRef(id, existing.version);
  const { file, take } = takeFile(id, takeId);
  const up = await createUploadFromFile(file, { name: `${e.rec.name}-试听.wav`, mime: 'audio/wav', source: 'design-take', sourceLabel: `试听 ${new Date(take.createdAt).toLocaleString('zh-CN')}`, takeId });
  try {
    return await addRef(id, { uploadId: up.id, region: null, params: PROCESS_PRESETS.fix.params, preset: 'fix' });
  } finally {
    await deleteUpload(up.id);
  }
}

// ───────────────────────── 标准试听 ─────────────────────────

export async function setPreview(id: string, samples: Float32Array, sampleRate: number, text: string, version: string): Promise<VoicePreview> {
  const wav = encodeWav(samples, sampleRate);
  const pv: VoicePreview = { file: `preview-${Date.now().toString(36)}.wav`, text, voiceVersion: version, createdAt: Date.now(), durationMs: Math.round((samples.length / sampleRate) * 1000), peaks: computePeaks(samples) };
  if (isBuiltin(id)) {
    const dir = path.join(paths.presets(), id);
    await ensureDir(dir);
    const old = builtinPreviews.get(id);
    await fsp.writeFile(path.join(dir, pv.file), wav);
    await writeJson(path.join(dir, 'preview.json'), pv);
    builtinPreviews.set(id, pv);
    if (old) await removePath(path.join(dir, old.file));
    changed(id);
    return pv;
  }
  return lock.run(id, async () => {
    const e = entry(id);
    const old = e.rec.preview;
    await fsp.writeFile(path.join(e.dir, pv.file), wav);
    e.rec.preview = pv;
    await save(e);
    if (old && old.file !== pv.file) await removePath(path.join(e.dir, old.file));
    changed(id);
    return pv;
  });
}

// ───────────────────────── 合成用 ─────────────────────────

const uriCache = new Map<string, { mtime: number; uri: string }>();

async function refDataUri(file: string): Promise<string> {
  const st = await fsp.stat(file);
  const hit = uriCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.uri;
  const uri = `data:audio/wav;base64,${(await fsp.readFile(file)).toString('base64')}`;
  uriCache.set(file, { mtime: st.mtimeMs, uri });
  if (uriCache.size > 24) uriCache.delete(uriCache.keys().next().value!);
  return uri;
}

export interface ResolvedForSynth {
  resolved: ResolvedVoice;
  snapshot: VoiceSnapshot;
  defaultInstruction: string;
}

export async function resolveVoice(id: string): Promise<ResolvedForSynth> {
  const rec = getRecord(id);
  if (rec.trashedAt) throw bad(`音色「${rec.name}」在回收站中`);
  const snapshot: VoiceSnapshot = { type: 'library', id: rec.id, name: rec.name, kind: rec.kind, mode: voiceMode(rec), version: voiceVersion(rec) };
  if (rec.kind === 'preset') return { resolved: { mode: 'preset', presetId: rec.presetId! }, snapshot, defaultInstruction: rec.defaultInstruction };
  const ref = currentRef(rec);
  if (ref) {
    const file = path.join(entry(id).dir, 'refs', `v${ref.version}`, ref.processedFile);
    return { resolved: { mode: 'clone', refDataUri: await refDataUri(file) }, snapshot, defaultInstruction: rec.defaultInstruction };
  }
  if (rec.kind === 'design') {
    return { resolved: { mode: 'design', description: rec.description ?? '' }, snapshot: { ...snapshot, description: rec.description }, defaultInstruction: '' };
  }
  throw bad(`克隆音色「${rec.name}」缺少参考音频`);
}

// ───────────────────────── 导入导出 ─────────────────────────

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), rel)));
    else if (!ent.name.endsWith('.mp3') && !ent.name.endsWith('.tmp')) out.push(rel);
  }
  return out;
}

export async function exportVoices(ids: string[]): Promise<Buffer> {
  const entries: { name: string; data: Buffer | string }[] = [];
  const list: { id: string; name: string; kind: VoiceKind }[] = [];
  for (const id of ids) {
    if (isBuiltin(id)) continue;
    const e = entry(id);
    list.push({ id, name: e.rec.name, kind: e.rec.kind });
    for (const rel of await walk(e.dir)) entries.push({ name: `${id}/${rel}`, data: await fsp.readFile(path.join(e.dir, rel)) });
  }
  if (!list.length) throw bad('没有可导出的音色（预置音色无需导出）');
  entries.unshift({ name: 'mimotts-voices.json', data: JSON.stringify({ format: 'mimotts-voices', version: 1, exportedAt: new Date().toISOString(), voices: list }, null, 2) });
  return createZip(entries);
}

export async function importVoices(zip: Buffer): Promise<VoiceRecord[]> {
  const files = readZip(zip);
  const groups = new Map<string, { name: string; data: Buffer }[]>();
  for (const f of files) {
    const parts = f.name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length < 2 || parts.some((p) => p === '..' || p === '.')) continue;
    const [top, ...rest] = parts;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top)!.push({ name: rest.join('/'), data: f.data });
  }
  const imported: VoiceRecord[] = [];
  for (const [, items] of groups) {
    const vj = items.find((i) => i.name === 'voice.json');
    if (!vj) continue;
    let rec: VoiceRecord;
    try { rec = JSON.parse(vj.data.toString('utf8')); } catch { continue; }
    if (!rec || !['preset', 'design', 'clone'].includes(rec.kind)) continue;
    const oldId = rec.id;
    if (!isSafeId(String(oldId)) || voices.has(oldId)) rec.id = newId('v');
    delete rec.trashedAt;
    rec.origin = rec.origin ?? { type: 'import', label: '导入' };
    rec.refs ??= [];
    rec.tags ??= [];
    const dir = paths.voice(rec.id);
    await ensureDir(dir);
    for (const it of items) {
      if (it.name === 'voice.json') continue;
      const target = path.join(dir, it.name);
      if (!within(dir, target)) continue;
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, it.data);
    }
    const e = { rec, dir };
    voices.set(rec.id, e);
    await save(e);
    imported.push(rec);
  }
  if (!imported.length) throw bad('ZIP 里没有找到音色（需要 <id>/voice.json）');
  changed();
  return imported;
}

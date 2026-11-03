// 业务编排：快速合成、流式合成、设计抽卡、标准试听、剧本片段生成与导出
import path from 'node:path';
import fsp from 'node:fs/promises';
import type http from 'node:http';
import type { JobInfo, Project, QuickResult, VoiceSelector, VoiceSnapshot } from '../../shared/types.ts';
import { MIMO_SAMPLE_RATE } from '../../shared/presets.ts';
import { hash32, truncate } from '../../shared/text.ts';
import { activeTake, effectiveSegment, segmentPause, staleReasons } from '../../shared/effective.ts';
import { buildCues, toSrt, type SrtOptions, type TimelineItem } from '../../shared/srt.ts';
import { getSettings } from '../store/settings.ts';
import { JobQueue } from './queue.ts';
import { synthesize } from './engine.ts';
import { MimoError } from '../mimo/client.ts';
import { buildMimoBody, SynthInputError, type ResolvedVoice } from '../mimo/request.ts';
import * as voices from '../store/voices.ts';
import * as quick from '../store/quick.ts';
import * as projects from '../store/projects.ts';
import { computePeaks, concatFloat, decodeWav, encodeWav, silence } from '../audio/wav.ts';
import { newId } from '../util/id.ts';
import { bad, HttpError } from '../http.ts';
import { ensureDir, safeFileName } from '../util/fs.ts';
import { wavToMp3 } from '../audio/ffmpeg.ts';
import { createZip } from '../util/zip.ts';
import { fileUrl } from '../config.ts';

export const ttsQueue = new JobQueue(() => getSettings().mimo.concurrency);
export const llmQueue = new JobQueue(() => 2);

function asHttp(e: unknown): never {
  if (e instanceof SynthInputError) throw bad(e.message);
  if (e instanceof MimoError) throw new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
  throw e;
}

interface Resolved { resolved: ResolvedVoice; snapshot: VoiceSnapshot; defaultInstruction: string }

async function resolveSelector(sel: VoiceSelector): Promise<Resolved> {
  if (!sel || typeof sel !== 'object') throw bad('请选择音色');
  if (sel.type === 'adhoc-design') {
    const d = String(sel.description ?? '').trim();
    if (!d) throw bad('请填写音色描述');
    return {
      resolved: { mode: 'design', description: d },
      snapshot: { type: 'adhoc-design', name: '临时设计音色', mode: 'design', version: `desc:${hash32(d)}`, description: d },
      defaultInstruction: '',
    };
  }
  if (sel.type === 'library') return voices.resolveVoice(String(sel.id));
  throw bad('未知的音色类型');
}

export interface QuickInput {
  voice: VoiceSelector;
  text: string;
  instruction?: string;
  useDefaultInstruction?: boolean;
  optimizeTextPreview?: boolean;
}

function effectiveInstruction(r: Resolved, input: QuickInput): { instruction: string; ignored: boolean } {
  const explicit = (input.instruction ?? '').trim();
  const ins = explicit || (input.useDefaultInstruction !== false ? r.defaultInstruction.trim() : '');
  if (r.resolved.mode === 'design' && ins) return { instruction: '', ignored: true };
  return { instruction: ins, ignored: false };
}

async function saveQuick(r: Resolved, input: QuickInput, ins: { instruction: string; ignored: boolean }, out: Awaited<ReturnType<typeof synthesize>>, t0: number) {
  const id = newId('q');
  const result: QuickResult = {
    id,
    createdAt: Date.now(),
    voice: r.snapshot,
    text: input.text.trim(),
    instruction: ins.instruction,
    instructionIgnored: ins.ignored,
    model: out.model,
    chunks: out.chunks,
    durationMs: Math.round((out.samples.length / out.sampleRate) * 1000),
    file: `audio/${id}.wav`,
    peaks: computePeaks(out.samples),
    warnings: out.warnings,
    starred: false,
    actualText: out.actualText,
    elapsedMs: Date.now() - t0,
  };
  await quick.addQuick(result, encodeWav(out.samples, out.sampleRate));
  return quick.withUrl(result);
}

/** 入队前先按规则构造一次请求，参数问题（如非预置音色唱歌）直接返回 400 */
function precheck(r: Resolved, text: string, instruction: string, optimize?: boolean): void {
  try {
    buildMimoBody(r.resolved, { text, instruction, optimizeTextPreview: optimize });
  } catch (e) { asHttp(e); }
}

/** 快速合成（排队，非流式） */
export async function quickSynth(input: QuickInput): Promise<JobInfo> {
  const r = await resolveSelector(input.voice);
  if (!String(input.text ?? '').trim() && !(r.resolved.mode === 'design' && input.optimizeTextPreview)) throw bad('请填写要合成的文本');
  const ins = effectiveInstruction(r, input);
  precheck(r, String(input.text ?? ''), ins.instruction, input.optimizeTextPreview);
  const { job } = ttsQueue.add({ kind: 'quick', label: `${r.snapshot.name}：${truncate(input.text.trim(), 24)}`, group: 'quick' }, async (ctx) => {
    const t0 = Date.now();
    const out = await synthesize(getSettings().mimo, {
      resolved: r.resolved, text: input.text, instruction: ins.instruction, optimizeTextPreview: input.optimizeTextPreview,
      signal: ctx.signal, onProgress: ctx.progress, onRetry: (a, e) => ctx.retrying(a, e.message),
    });
    const saved = await saveQuick(r, input, ins, out, t0);
    return { jobResult: { resultId: saved.id } };
  });
  return job;
}

/** 流式快速合成（只有预置音色是真流式）：NDJSON 推送 pcm16 分片，结束后写入历史 */
export async function quickSynthStream(input: QuickInput, res: http.ServerResponse): Promise<void> {
  let r: Resolved;
  try {
    r = await resolveSelector(input.voice);
  } catch (e) { asHttp(e); }
  if (r!.resolved.mode !== 'preset') throw bad('只有预置音色支持流式合成');
  if (!String(input.text ?? '').trim()) throw bad('请填写要合成的文本');
  const ins = effectiveInstruction(r!, input);
  precheck(r!, String(input.text), ins.instruction);
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (o: unknown) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* 客户端断开 */ } };
  send({ type: 'start', sampleRate: MIMO_SAMPLE_RATE });
  try {
    const t0 = Date.now();
    const out = await synthesize(getSettings().mimo, {
      resolved: r!.resolved, text: input.text, instruction: ins.instruction, stream: true, signal: ctrl.signal,
      onPcm: (pcm, i) => send({ type: 'audio', chunk: i, data: pcm.toString('base64') }),
      onProgress: (done, total) => send({ type: 'progress', done, total }),
      onRetry: (attempt, e, i) => send({ type: 'retry', chunk: i, attempt, message: e.message }),
    });
    const saved = await saveQuick(r!, input, ins, out, t0);
    send({ type: 'done', result: saved });
  } catch (e: any) {
    send({ type: 'error', message: e?.message ?? String(e) });
  }
  res.end();
}

// ───────────────────────── 设计音色抽卡 ─────────────────────────

export async function designTakes(voiceId: string, input: { count?: number; text?: string; optimizeTextPreview?: boolean; description?: string }): Promise<JobInfo[]> {
  const rec = voices.getRecord(voiceId);
  if (rec.kind !== 'design') throw bad('只有设计音色可以抽卡试听');
  const description = (input.description ?? rec.description ?? '').trim();
  if (!description) throw bad('请先填写音色描述');
  const text = String(input.text ?? '').trim() || getSettings().ui.previewText;
  const optimize = !!input.optimizeTextPreview;
  const count = Math.max(1, Math.min(6, Number(input.count) || 1));
  const jobs: JobInfo[] = [];
  for (let i = 0; i < count; i++) {
    const { job } = ttsQueue.add({ kind: 'design-take', label: `${rec.name}：试听 ${i + 1}/${count}`, voiceId, group: `design:${voiceId}` }, async (ctx) => {
      const out = await synthesize(getSettings().mimo, {
        resolved: { mode: 'design', description }, text, instruction: '', optimizeTextPreview: optimize, noChunk: true,
        signal: ctx.signal, onRetry: (a, e) => ctx.retrying(a, e.message),
      });
      const take = await voices.addDesignTake(voiceId, { samples: out.samples, sampleRate: out.sampleRate, text, description, optimizeTextPreview: optimize, actualText: out.actualText });
      return { jobResult: { takeId: take.id } };
    });
    jobs.push(job);
  }
  return jobs;
}

// ───────────────────────── 标准试听 / 对比 ─────────────────────────

export async function previewVoice(voiceId: string, text?: string): Promise<JobInfo> {
  const r = await voices.resolveVoice(voiceId).catch(asHttp);
  const t = String(text ?? '').trim() || getSettings().ui.previewText;
  const existing = ttsQueue.active().find((j) => j.kind === 'preview' && j.voiceId === voiceId);
  if (existing) return existing;
  const { job } = ttsQueue.add({ kind: 'preview', label: `${r.snapshot.name}：标准试听`, voiceId, group: 'preview' }, async (ctx) => {
    const out = await synthesize(getSettings().mimo, {
      resolved: r.resolved, text: t, instruction: r.resolved.mode === 'design' ? '' : r.defaultInstruction, noChunk: true,
      signal: ctx.signal, onRetry: (a, e) => ctx.retrying(a, e.message),
    });
    await voices.setPreview(voiceId, out.samples, out.sampleRate, t, r.snapshot.version);
    return { jobResult: { voiceId } };
  });
  return job;
}

// ───────────────────────── 剧本片段 ─────────────────────────

export type GenerateMode = 'missing' | 'stale' | 'all' | 'selected';

export function generateSegments(projectId: string, mode: GenerateMode, ids?: string[]): { jobs: JobInfo[]; skipped: { id: string; reason: string }[] } {
  const p = projects.getProject(projectId);
  const vmap = voices.allSummaries();
  const pick = new Set(ids ?? []);
  const jobs: JobInfo[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const s of p.segments) {
    if (mode === 'selected' && !pick.has(s.id)) continue;
    const eff = effectiveSegment(p, s, vmap);
    const take = activeTake(s);
    if (mode === 'missing' && take) continue;
    if (mode === 'stale' && (!take || !staleReasons(s, eff).length)) continue;
    if (s.locked) { skipped.push({ id: s.id, reason: '已锁定' }); continue; }
    if (eff.problems.length) { skipped.push({ id: s.id, reason: eff.problems.join('；') }); continue; }
    if (ttsQueue.isActive((j) => j.segmentId === s.id)) { skipped.push({ id: s.id, reason: '已在队列中' }); continue; }
    jobs.push(enqueueSegment(projectId, s.id, `${eff.roleName}：${truncate(s.text, 20)}`));
  }
  return { jobs, skipped };
}

function enqueueSegment(projectId: string, segId: string, label: string): JobInfo {
  const { job } = ttsQueue.add({ kind: 'segment', label, projectId, segmentId: segId, group: `project:${projectId}` }, async (ctx) => {
    try {
      // 运行时再取一次配置：排队期间可能改过文本/音色
      const p = projects.getProject(projectId);
      const s = p.segments.find((x) => x.id === segId);
      if (!s) throw new Error('片段已删除');
      const eff = effectiveSegment(p, s, voices.allSummaries());
      if (eff.problems.length) throw new Error(eff.problems.join('；'));
      const r = await voices.resolveVoice(eff.voiceId!);
      const out = await synthesize(getSettings().mimo, {
        resolved: r.resolved, text: eff.text, instruction: eff.instruction,
        signal: ctx.signal, onProgress: ctx.progress, onRetry: (a, e) => ctx.retrying(a, e.message),
      });
      const take = await projects.addSegmentTake(projectId, segId, {
        samples: out.samples, sampleRate: out.sampleRate, voiceId: eff.voiceId!, voiceName: r.snapshot.name, voiceVersion: r.snapshot.version,
        model: out.model, instruction: eff.instruction, text: eff.text, chunks: out.chunks, warnings: out.warnings,
      });
      return { jobResult: { takeId: take.id } };
    } catch (e: any) {
      if (!ctx.signal.aborted) await projects.setSegmentError(projectId, segId, e?.message ?? String(e)).catch(() => undefined);
      throw e;
    }
  });
  return job;
}

// ───────────────────────── 导出 ─────────────────────────

interface TimelineBuild { items: (TimelineItem & { file: string; segId: string; index: number })[]; missing: number; totalMs: number }

function buildTimeline(p: Project): TimelineBuild {
  const dir = projects.projectDir(p.id);
  let t = 0;
  let missing = 0;
  const items: TimelineBuild['items'] = [];
  p.segments.forEach((s, index) => {
    const take = activeTake(s);
    if (!take) { missing++; return; }
    const role = p.roles.find((r) => r.id === s.roleId);
    items.push({ text: take.text || s.text, roleName: role?.name ?? '', startMs: t, durationMs: take.durationMs, chunks: take.chunks, file: path.join(dir, take.file), segId: s.id, index });
    t += take.durationMs + segmentPause(p, s);
  });
  const last = items[items.length - 1];
  return { items, missing, totalMs: last ? last.startMs + last.durationMs : 0 };
}

export interface ExportOptions extends Partial<SrtOptions> { format: 'wav' | 'mp3' | 'srt' | 'zip' | 'package' }

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function mixTimeline(p: Project, tl: TimelineBuild): Promise<Buffer> {
  const parts: Float32Array[] = [];
  let sr = 0;
  for (let i = 0; i < tl.items.length; i++) {
    const it = tl.items[i];
    const w = decodeWav(await fsp.readFile(it.file));
    if (!sr) sr = w.sampleRate;
    if (w.sampleRate !== sr) throw new Error('片段采样率不一致，无法拼接');
    parts.push(w.samples);
    if (i < tl.items.length - 1) {
      const next = tl.items[i + 1];
      const gap = next.startMs - (it.startMs + it.durationMs);
      parts.push(silence(Math.max(0, gap), sr));
    }
  }
  return encodeWav(concatFloat(parts), sr || MIMO_SAMPLE_RATE);
}

export async function exportProject(projectId: string, opts: ExportOptions): Promise<{ name: string; url: string; missing: number }> {
  const p = projects.getProject(projectId);
  const tl = buildTimeline(p);
  if (!tl.items.length && opts.format !== 'package') throw bad('还没有任何已生成的片段');
  const dir = projects.exportsDir(projectId);
  await ensureDir(dir);
  const base = `${safeFileName(p.name, 'project')}-${stamp()}`;
  const srtOpts: SrtOptions = { includeRole: opts.includeRole ?? false, splitSentences: opts.splitSentences ?? true, maxCueChars: opts.maxCueChars ?? 28 };
  let name: string;
  if (opts.format === 'wav' || opts.format === 'mp3') {
    name = `${base}.wav`;
    await fsp.writeFile(path.join(dir, name), await mixTimeline(p, tl));
    if (opts.format === 'mp3') {
      const mp3 = await wavToMp3(path.join(dir, name));
      await fsp.rm(path.join(dir, name), { force: true });
      name = path.basename(mp3);
    }
  } else if (opts.format === 'srt') {
    name = `${base}.srt`;
    await fsp.writeFile(path.join(dir, name), toSrt(buildCues(tl.items, srtOpts)));
  } else if (opts.format === 'zip') {
    name = `${base}-分段.zip`;
    const entries: { name: string; data: Buffer | string }[] = [];
    for (const it of tl.items) {
      const label = safeFileName(`${String(it.index + 1).padStart(3, '0')}_${it.roleName || '未分配'}_${truncate(it.text.replace(/[(（\[][^)）\]]*[)）\]]/g, ''), 10).replace('…', '')}`);
      entries.push({ name: `${label}.wav`, data: await fsp.readFile(it.file) });
    }
    entries.push({ name: `${base}.srt`, data: toSrt(buildCues(tl.items, srtOpts)) });
    entries.push({ name: 'project.json', data: JSON.stringify(p, null, 2) });
    await fsp.writeFile(path.join(dir, name), createZip(entries));
  } else {
    name = `${base}-项目包.zip`;
    await fsp.writeFile(path.join(dir, name), await projects.exportProjectPackage(projectId));
  }
  return { name, url: fileUrl(path.join(dir, name)), missing: tl.missing };
}

export function timelineForPlayback(projectId: string) {
  const p = projects.getProject(projectId);
  return buildTimeline(p);
}

/** 把任意已有音频复制成剧本片段（快速合成「送入项目」） */
export async function quickToProject(resultId: string, projectId: string, roleId: string | null): Promise<void> {
  const r = quick.getQuick(resultId);
  const p = projects.getProject(projectId);
  // 设计音色「智能润色」且文本留空时，模型自己写的文本在 actualText 里
  const text = (r.text || r.actualText || '').trim();
  if (!text) throw bad('这条结果没有可用的文本，无法送入剧本');
  let rid = roleId && p.roles.some((x) => x.id === roleId) ? roleId : null;
  if (!rid && r.voice.type === 'library' && r.voice.id) rid = p.roles.find((x) => x.voiceId === r.voice.id)?.id ?? null;
  if (!rid) {
    const role = await projects.addRole(projectId, { name: uniqueRoleName(p, r.voice.name), voiceId: r.voice.type === 'library' ? r.voice.id ?? null : null });
    rid = role.id;
  }
  const [seg] = await projects.insertSegments(projectId, { items: [{ roleId: rid, text, instruction: r.instruction }] });
  await projects.addSegmentTakeFromFile(projectId, seg.id, quick.quickAudioPath(r), {
    durationMs: r.durationMs, peaks: r.peaks, voiceId: r.voice.id ?? '', voiceName: r.voice.name, voiceVersion: r.voice.version,
    model: r.model, instruction: r.instruction, text, chunks: r.chunks, warnings: r.warnings,
  });
}

function uniqueRoleName(p: Project, base: string): string {
  let n = base || '角色';
  let i = 2;
  while (p.roles.some((r) => r.name === n)) n = `${base}${i++}`;
  return n;
}

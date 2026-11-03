// 所有 HTTP 接口
import path from 'node:path';
import type { LlmModelRef, ProcessParams, ProcessPresetId, Region, SystemStatus, VoiceSummary } from '../shared/types.ts';
import { PROCESS_PRESETS } from '../shared/presets.ts';
import { bad, notFound, Router, sendBuffer, sendFile, STREAMED, type Ctx } from './http.ts';
import { config } from './config.ts';
import { getSettings, publicSettings, updateSettings } from './store/settings.ts';
import * as voices from './store/voices.ts';
import * as uploads from './store/uploads.ts';
import * as quick from './store/quick.ts';
import * as projects from './store/projects.ts';
import * as svc from './synth/service.ts';
import { ttsQueue, llmQueue } from './synth/service.ts';
import { addClient, emitChange } from './events.ts';
import { ffmpegStatus } from './audio/ffmpeg.ts';
import { callMimo } from './mimo/client.ts';
import { buildMimoBody } from './mimo/request.ts';
import { encodeWav } from './audio/wav.ts';
import { listModels } from './llm/client.ts';
import { batchSegments, castRoles, runSimpleTask, splitScript } from './llm/tasks.ts';
import { listTemplates, resetTemplate, saveTemplate } from './llm/templates.ts';

const PARAM_KEYS: (keyof ProcessParams)[] = ['sampleRate', 'highpassHz', 'denoise', 'trimEdges', 'edgePadMs', 'compressPauses', 'maxPauseMs', 'keepPauseMs', 'normalize', 'targetLufs', 'ceilingDb', 'fadeMs'];

function parseParams(input: any): { params: ProcessParams; preset: ProcessPresetId } {
  const preset: ProcessPresetId = input?.preset && (input.preset === 'custom' || input.preset in PROCESS_PRESETS) ? input.preset : 'standard';
  const base = preset === 'custom' ? getSettings().preprocess.custom : PROCESS_PRESETS[preset].params;
  const p: any = { ...base };
  const src = input?.params ?? {};
  if (preset === 'custom') for (const k of PARAM_KEYS) if (src[k] !== undefined) p[k] = src[k];
  const num = (v: any, lo: number, hi: number, d: number) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const params: ProcessParams = {
    sampleRate: [16000, 22050, 24000, 44100, 48000].includes(Number(p.sampleRate)) ? Number(p.sampleRate) : 24000,
    highpassHz: num(p.highpassHz, 0, 300, 70),
    denoise: ['off', 'light', 'medium', 'strong'].includes(p.denoise) ? p.denoise : 'off',
    trimEdges: !!p.trimEdges,
    edgePadMs: num(p.edgePadMs, 0, 2000, 150),
    compressPauses: !!p.compressPauses,
    maxPauseMs: num(p.maxPauseMs, 200, 5000, 700),
    keepPauseMs: num(p.keepPauseMs, 50, 3000, 350),
    normalize: !!p.normalize,
    targetLufs: num(p.targetLufs, -36, -10, -20),
    ceilingDb: num(p.ceilingDb, -6, -0.1, -1.5),
    fadeMs: num(p.fadeMs, 0, 200, 10),
  };
  if (params.denoise !== 'off' && !ffmpegStatus().denoise) params.denoise = 'off';
  return { params, preset };
}

function parseRegion(r: any): Region | null {
  if (!r || typeof r !== 'object') return null;
  const start = Number(r.start);
  const end = Number(r.end);
  return isFinite(start) && isFinite(end) && end > start ? { start, end } : null;
}

function modelRef(m: any): LlmModelRef | null {
  return m && typeof m === 'object' && m.endpointId && m.model ? { endpointId: String(m.endpointId), model: String(m.model) } : null;
}

function references(voiceId: string) {
  return projects.allProjects()
    .filter((p) => !p.trashedAt)
    .map((p) => ({ projectId: p.id, projectName: p.name, roles: p.roles.filter((r) => r.voiceId === voiceId).map((r) => r.name) }))
    .filter((x) => x.roles.length);
}

function status(): SystemStatus {
  const s = getSettings();
  const f = ffmpegStatus();
  return {
    version: config.version,
    dataDir: config.dataDir,
    ffmpeg: f,
    mimoConfigured: !!s.mimo.apiKey,
    llmConfigured: !!s.llm.defaultModel,
    accessToken: !!config.accessToken,
  };
}

export function registerRoutes(r: Router): void {
  // ───────── 系统 ─────────
  r.get('/api/health', () => ({ ok: true }));
  r.get('/api/status', () => status());
  r.get('/api/events', (c) => { addClient(c.res); return STREAMED; });
  r.get('/api/settings', () => publicSettings());
  r.put('/api/settings', async (c) => {
    try { await updateSettings(await c.json()); } catch (e: any) { throw bad(e?.message ?? String(e)); }
    ttsQueue.kick();
    return publicSettings();
  });
  r.post('/api/settings/test-mimo', async (c) => {
    const body = await c.json();
    const s = getSettings().mimo;
    const cfg = { baseUrl: String(body.baseUrl || s.baseUrl), apiKey: String(body.apiKey || s.apiKey), timeoutSec: Math.min(60, s.timeoutSec) };
    const t0 = Date.now();
    const { body: req } = buildMimoBody({ mode: 'preset', presetId: 'mimo_default' }, { text: '你好，连接成功。' });
    const a = await callMimo(cfg, req);
    return { ok: true, ms: Date.now() - t0, durationMs: Math.round((a.samples.length / a.sampleRate) * 1000), audio: `data:audio/wav;base64,${encodeWav(a.samples, a.sampleRate).toString('base64')}` };
  });

  // ───────── 音色库 ─────────
  r.get('/api/voices', (c) => listVoicesWithRefs(c.query.get('trash') === '1'));
  r.get('/api/voices/:id', (c) => ({ ...voices.getVoiceDetail(c.params.id), references: references(c.params.id) }));
  r.post('/api/voices', async (c) => {
    const b = await c.json();
    if (b.kind === 'preset') return voices.createPresetVariant(b);
    if (b.kind === 'design') return voices.createDesign(b);
    if (b.kind === 'clone') {
      if (!b.ref?.uploadId) throw bad('缺少参考音频');
      const { params, preset } = parseParams(b.ref);
      return voices.createClone({ ...b, ref: { uploadId: String(b.ref.uploadId), region: parseRegion(b.ref.region), params, preset } });
    }
    throw bad('未知的音色类型');
  });
  r.patch('/api/voices/:id', async (c) => voices.updateVoice(c.params.id, await c.json()));
  r.post('/api/voices/:id/duplicate', (c) => voices.duplicateVoice(c.params.id));
  r.post('/api/voices/:id/trash', async (c) => { await voices.trashVoice(c.params.id); return { ok: true }; });
  r.post('/api/voices/:id/restore', async (c) => { await voices.restoreVoice(c.params.id); return { ok: true }; });
  r.delete('/api/voices/:id', async (c) => { await voices.destroyVoice(c.params.id); return { ok: true }; });
  r.post('/api/voices/:id/refs', async (c) => {
    const b = await c.json();
    if (!b.uploadId) throw bad('缺少参考音频');
    const { params, preset } = parseParams(b);
    return voices.addRef(c.params.id, { uploadId: String(b.uploadId), region: parseRegion(b.region), params, preset });
  });
  r.post('/api/voices/:id/refs/:version/activate', (c) => voices.activateRef(c.params.id, Number(c.params.version)));
  r.delete('/api/voices/:id/refs/:version', (c) => voices.deleteRef(c.params.id, Number(c.params.version)));
  r.post('/api/voices/:id/takes', async (c) => ({ jobs: await svc.designTakes(c.params.id, await c.json()) }));
  r.patch('/api/voices/:id/takes/:takeId', async (c) => voices.updateTake(c.params.id, c.params.takeId, await c.json()));
  r.delete('/api/voices/:id/takes/:takeId', async (c) => { await voices.deleteTake(c.params.id, c.params.takeId); return { ok: true }; });
  r.post('/api/voices/:id/fix', async (c) => voices.fixDesign(c.params.id, String((await c.json()).takeId ?? '')));
  r.post('/api/voices/:id/unfix', (c) => voices.activateRef(c.params.id, null));
  r.post('/api/voices/:id/preview', async (c) => ({ job: await svc.previewVoice(c.params.id, (await c.json()).text) }));
  r.post('/api/voices/compare', async (c) => {
    const b = await c.json();
    const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (ids.length < 1) throw bad('请选择要对比的音色');
    const text = String(b.text ?? '').trim() || getSettings().ui.previewText;
    const out: { voiceId: string; job?: unknown; cached?: boolean }[] = [];
    for (const id of ids) {
      const s = voices.summaryOf(id);
      if (!s) continue;
      if (!b.force && s.preview && s.preview.text === text && s.preview.voiceVersion === s.version) out.push({ voiceId: id, cached: true });
      else out.push({ voiceId: id, job: await svc.previewVoice(id, text) });
    }
    return { text, items: out };
  });
  r.get('/api/voices/:id/export', async (c) => {
    const rec = voices.getRecord(c.params.id);
    sendBuffer(c.res, await voices.exportVoices([c.params.id]), 'application/zip', `音色-${rec.name}.zip`);
    return STREAMED;
  });
  r.post('/api/voices/export', async (c) => {
    const b = await c.json();
    const ids: string[] = Array.isArray(b.ids) && b.ids.length ? b.ids : voices.listVoices().filter((v) => !v.builtin).map((v) => v.id);
    sendBuffer(c.res, await voices.exportVoices(ids), 'application/zip', `mimotts-音色库-${new Date().toISOString().slice(0, 10)}.zip`);
    return STREAMED;
  });
  r.post('/api/voices/import', async (c) => {
    const list = await voices.importVoices(await c.raw(1024 * 1024 * 1024));
    return { imported: list.map((v) => ({ id: v.id, name: v.name, kind: v.kind })) };
  });
  r.post('/api/voices/from-quick', async (c) => {
    const b = await c.json();
    const res = quick.getQuick(String(b.resultId));
    if (res.voice.type !== 'adhoc-design' || !res.voice.description) throw bad('只有「临时设计」的结果可以存为设计音色；其他结果请用「存为克隆音色」');
    const rec = await voices.createDesign({ name: String(b.name || '新设计音色'), description: res.voice.description, origin: { type: 'adhoc-design', resultId: res.id } });
    await voices.addDesignTakeFromFile(rec.id, quick.quickAudioPath(res), { text: res.text, description: res.voice.description, durationMs: res.durationMs, peaks: res.peaks });
    return voices.getRecord(rec.id);
  });

  // ───────── 上传与预处理 ─────────
  r.post('/api/uploads', async (c) => {
    const name = c.query.get('name') ?? 'audio';
    const source = c.query.get('source') === 'record' ? 'record' : 'upload';
    const data = await c.raw(300 * 1024 * 1024);
    const m = await uploads.createUpload(data, { name, mime: String(c.req.headers['content-type'] ?? ''), source, sourceLabel: source === 'record' ? '浏览器录音' : name });
    return uploads.publicUpload(m);
  });
  r.post('/api/uploads/from', async (c) => {
    const b = await c.json();
    let file: string;
    let label: string;
    let source: 'quick' | 'design-take' | 'segment-take' | 'voice-ref';
    let takeId: string | undefined;
    if (b.type === 'quick') {
      const q = quick.getQuick(String(b.id));
      file = quick.quickAudioPath(q); label = `快速合成：${q.voice.name}`; source = 'quick';
    } else if (b.type === 'design-take') {
      const t = voices.takeFile(String(b.voiceId), String(b.takeId));
      file = t.file; label = `设计试听：${voices.getRecord(String(b.voiceId)).name}`; source = 'design-take'; takeId = t.take.id;
    } else if (b.type === 'segment-take') {
      const t = projects.segmentTakeFile(String(b.projectId), String(b.segmentId), String(b.takeId));
      file = t.file; label = `剧本片段：${t.take.voiceName}`; source = 'segment-take';
    } else if (b.type === 'voice-ref') {
      const rec = voices.getRecord(String(b.voiceId));
      const ref = rec.refs.find((x) => x.version === Number(b.version));
      if (!ref) throw notFound('参考音频版本不存在');
      file = path.join(voices.voiceDir(rec.id), 'refs', `v${ref.version}`, ref.original.file);
      label = `${rec.name} v${ref.version} 原始音频`; source = 'voice-ref';
      const m = await uploads.createUploadFromFile(file, { name: ref.original.name, mime: ref.original.mime, source, sourceLabel: label, takeId: ref.takeId });
      return uploads.publicUpload(m);
    } else throw bad('未知的来源');
    const m = await uploads.createUploadFromFile(file, { name: `${label}.wav`, mime: 'audio/wav', source, sourceLabel: label, takeId });
    return uploads.publicUpload(m);
  });
  r.get('/api/uploads/:id', async (c) => uploads.publicUpload(await uploads.getUpload(c.params.id)));
  r.post('/api/uploads/:id/process', async (c) => {
    const b = await c.json();
    const { params } = parseParams(b);
    return uploads.processUpload(c.params.id, parseRegion(b.region), params);
  });

  // ───────── 快速合成 ─────────
  r.post('/api/synth', async (c) => ({ job: await svc.quickSynth(await c.json()) }));
  r.post('/api/synth/stream', async (c) => { await svc.quickSynthStream(await c.json(), c.res); return STREAMED; });
  r.get('/api/quick', (c) => quick.listQuick(Number(c.query.get('limit') ?? 100), Number(c.query.get('before')) || undefined));
  r.patch('/api/quick/:id', async (c) => quick.updateQuick(c.params.id, await c.json()));
  r.delete('/api/quick/:id', async (c) => ({ deleted: await quick.deleteQuick([c.params.id]) }));
  r.post('/api/quick/clear', async () => ({ deleted: await quick.deleteQuick('unstarred') }));
  r.post('/api/quick/:id/to-project', async (c) => {
    const b = await c.json();
    await svc.quickToProject(c.params.id, String(b.projectId), b.roleId ? String(b.roleId) : null);
    return { ok: true };
  });

  // ───────── 任务 ─────────
  r.get('/api/jobs', () => [...ttsQueue.list(), ...llmQueue.list()].sort((a, b) => b.createdAt - a.createdAt));
  r.delete('/api/jobs/:id', (c) => ({ ok: ttsQueue.cancel(c.params.id) || llmQueue.cancel(c.params.id) }));
  r.post('/api/jobs/cancel', async (c) => {
    const b = await c.json();
    const n = ttsQueue.cancelWhere((j) => (b.group ? j.group === b.group : true) && (b.projectId ? j.projectId === b.projectId : true));
    return { canceled: n };
  });

  // ───────── 剧本项目 ─────────
  r.get('/api/projects', (c) => projects.listProjects(c.query.get('trash') === '1'));
  r.post('/api/projects', async (c) => projects.createProject(await c.json()));
  r.post('/api/projects/import', async (c) => projects.importProjectPackage(await c.raw(2 * 1024 * 1024 * 1024)));
  r.get('/api/projects/:id', (c) => projects.viewProject(c.params.id));
  r.patch('/api/projects/:id', async (c) => projects.updateProject(c.params.id, await c.json()));
  r.post('/api/projects/:id/duplicate', (c) => projects.duplicateProject(c.params.id));
  r.post('/api/projects/:id/trash', async (c) => { ttsQueue.cancelWhere((j) => j.projectId === c.params.id); await projects.trashProject(c.params.id); return { ok: true }; });
  r.post('/api/projects/:id/restore', async (c) => { await projects.restoreProject(c.params.id); return { ok: true }; });
  r.delete('/api/projects/:id', async (c) => { await projects.destroyProject(c.params.id); return { ok: true }; });

  r.post('/api/projects/:id/roles', async (c) => projects.addRole(c.params.id, await c.json()));
  r.patch('/api/projects/:id/roles/:rid', async (c) => projects.updateRole(c.params.id, c.params.rid, await c.json()));
  r.delete('/api/projects/:id/roles/:rid', async (c) => { await projects.deleteRole(c.params.id, c.params.rid, c.query.get('reassign')); return { ok: true }; });

  r.post('/api/projects/:id/segments', async (c) => projects.insertSegments(c.params.id, await c.json()));
  r.post('/api/projects/:id/segments/batch', async (c) => { const b = await c.json(); await projects.batchUpdateSegments(c.params.id, b.ids ?? [], b.patch ?? {}); return { ok: true }; });
  r.post('/api/projects/:id/segments/values', async (c) => ({ updated: await projects.applySegmentValues(c.params.id, (await c.json()).values ?? []) }));
  r.post('/api/projects/:id/segments/delete', async (c) => {
    const ids: string[] = (await c.json()).ids ?? [];
    ttsQueue.cancelWhere((j) => !!j.segmentId && ids.includes(j.segmentId));
    await projects.deleteSegments(c.params.id, ids);
    return { ok: true };
  });
  r.post('/api/projects/:id/segments/reorder', async (c) => { await projects.reorderSegments(c.params.id, (await c.json()).ids ?? []); return { ok: true }; });
  r.post('/api/projects/:id/segments/merge', async (c) => projects.mergeSegments(c.params.id, (await c.json()).ids ?? []));
  r.patch('/api/projects/:id/segments/:sid', async (c) => projects.updateSegment(c.params.id, c.params.sid, await c.json()));
  r.post('/api/projects/:id/segments/:sid/split', async (c) => projects.splitSegment(c.params.id, c.params.sid, Number((await c.json()).at)));
  r.patch('/api/projects/:id/segments/:sid/takes/:tid', async (c) => projects.updateSegmentTake(c.params.id, c.params.sid, c.params.tid, await c.json()));
  r.delete('/api/projects/:id/segments/:sid/takes/:tid', async (c) => { await projects.deleteSegmentTake(c.params.id, c.params.sid, c.params.tid); return { ok: true }; });

  r.post('/api/projects/:id/generate', async (c) => {
    const b = await c.json();
    const mode = ['missing', 'stale', 'all', 'selected'].includes(b.mode) ? b.mode : 'missing';
    return svc.generateSegments(c.params.id, mode, Array.isArray(b.ids) ? b.ids : undefined);
  });
  r.post('/api/projects/:id/cancel', (c) => ({ canceled: ttsQueue.cancelWhere((j) => j.projectId === c.params.id) }));
  r.post('/api/projects/:id/export', async (c) => {
    const b = await c.json();
    if (!['wav', 'mp3', 'srt', 'zip', 'package'].includes(b.format)) throw bad('未知的导出格式');
    const out = await svc.exportProject(c.params.id, b);
    emitChange({ topic: 'project', id: c.params.id });
    return out;
  });
  r.get('/api/projects/:id/exports', (c) => projects.listExports(c.params.id));
  r.delete('/api/projects/:id/exports/:name', async (c) => { await projects.deleteExport(c.params.id, c.params.name); return { ok: true }; });

  r.post('/api/projects/:id/split', async (c) => {
    const b = await c.json();
    const p = projects.getProject(c.params.id);
    const { job } = llmQueue.add({ kind: 'llm', label: `剧本拆分：${p.name}`, projectId: p.id, group: `split:${p.id}` }, async (ctx) => {
      const preview = await splitScript(
        { text: String(b.text ?? ''), knownRoles: p.roles.map((x) => x.name), rewrite: !!b.rewrite, withInstruction: !!b.withInstruction, targetLen: Number(b.targetLen) || 120 },
        { model: modelRef(b.model), signal: ctx.signal, onProgress: (d, t) => ctx.progress(d, t, t > 1 ? `第 ${Math.min(d + 1, t)}/${t} 部分` : undefined) },
      );
      return { jobResult: preview };
    });
    return { job };
  });
  r.post('/api/projects/:id/apply-split', async (c) => {
    const b = await c.json();
    const segs: { role: string; text: string; instruction?: string }[] = Array.isArray(b.segments) ? b.segments : [];
    if (!segs.length) throw bad('没有可导入的片段');
    const roleDefs: { name: string; description?: string; instruction?: string }[] = Array.isArray(b.roles) ? b.roles : [];
    const names = [...new Set(segs.map((s) => String(s.role || '旁白').trim() || '旁白'))];
    const map = await projects.ensureRoles(c.params.id, names.map((n) => ({ name: n, instruction: roleDefs.find((r) => r.name === n)?.instruction })));
    // 角色设定写进备注，配音推荐时会用到
    const p = projects.getProject(c.params.id);
    for (const def of roleDefs) {
      const role = p.roles.find((r) => r.name === def.name);
      if (role && !role.notes && def.description) await projects.updateRole(c.params.id, role.id, { notes: def.description });
    }
    await projects.insertSegments(c.params.id, {
      replaceAll: !!b.replaceAll,
      items: segs.map((s) => ({ roleId: map[String(s.role || '旁白').trim() || '旁白'], text: s.text, instruction: s.instruction ?? '' })),
    });
    return projects.viewProject(c.params.id);
  });
  r.post('/api/projects/:id/cast', async (c) => {
    const b = await c.json();
    const p = projects.getProject(c.params.id);
    const ids: string[] | null = Array.isArray(b.roleIds) && b.roleIds.length ? b.roleIds : null;
    const roles = p.roles.filter((x) => !ids || ids.includes(x.id)).map((x) => ({ name: x.name, description: [x.notes, x.instruction].filter(Boolean).join('；') }));
    return castRoles(roles, voices.listVoices(), { model: modelRef(b.model) });
  });
  r.post('/api/projects/:id/llm-batch', async (c) => {
    const b = await c.json();
    if (b.task !== 'batch-instruction' && b.task !== 'batch-tags') throw bad('未知的任务');
    const p = projects.getProject(c.params.id);
    const ids = new Set<string>(b.ids ?? []);
    const items = p.segments.filter((s) => ids.has(s.id) && !s.locked).map((s) => ({
      id: s.id, role: p.roles.find((r) => r.id === s.roleId)?.name ?? '', text: s.text, instruction: s.instruction || undefined,
    }));
    const rolesDesc = p.roles.map((r) => `- ${r.name}${r.notes ? `：${r.notes}` : ''}`).join('\n');
    const out = await batchSegments(b.task, items, rolesDesc, String(b.intent ?? ''), { model: modelRef(b.model) });
    return {
      ...out,
      values: out.values.map((v) => {
        const s = p.segments.find((x) => x.id === v.id)!;
        return { ...v, beforeText: s.text, beforeInstruction: s.instruction };
      }),
    };
  });

  // ───────── 大模型 ─────────
  r.post('/api/llm/run', async (c) => {
    const b = await c.json();
    return runSimpleTask(String(b.task), b.vars ?? {}, { model: modelRef(b.model) });
  });
  r.post('/api/llm/models', async (c) => {
    const b = await c.json();
    let ep = { baseUrl: String(b.baseUrl ?? ''), apiKey: String(b.apiKey ?? '') };
    if (b.endpointId) {
      const saved = getSettings().llm.endpoints.find((e) => e.id === b.endpointId);
      if (saved) ep = { baseUrl: ep.baseUrl || saved.baseUrl, apiKey: ep.apiKey || saved.apiKey };
    }
    if (!ep.baseUrl) throw bad('请填写 Base URL');
    return { models: await listModels(ep) };
  });
  r.get('/api/prompts', () => listTemplates());
  r.put('/api/prompts/:task', async (c) => saveTemplate(c.params.task, await c.json()));
  r.delete('/api/prompts/:task', (c) => resetTemplate(c.params.task));
}

function listVoicesWithRefs(trash: boolean): (VoiceSummary & { refCount: number })[] {
  const counts = new Map<string, number>();
  for (const p of projects.allProjects()) {
    if (p.trashedAt) continue;
    for (const r of p.roles) if (r.voiceId) counts.set(r.voiceId, (counts.get(r.voiceId) ?? 0) + 1);
  }
  return voices.listVoices({ trash }).map((v) => ({ ...v, refCount: counts.get(v.id) ?? 0 }));
}

// ───────── 数据文件 ─────────

const SERVABLE = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|mp4|mov|mkv|wma|amr|zip|srt|bin)$/i;

export async function serveDataFile(c: Ctx): Promise<void> {
  const rel = decodeURIComponent(c.url.pathname.slice('/files/'.length));
  const abs = path.resolve(config.dataDir, rel);
  const relCheck = path.relative(config.dataDir, abs);
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw notFound();
  if (!SERVABLE.test(abs) || /^(prompts|settings)/.test(relCheck)) throw notFound();
  let file = abs;
  if (c.query.get('format') === 'mp3' && /\.wav$/i.test(abs)) {
    const { wavToMp3 } = await import('./audio/ffmpeg.ts');
    file = await wavToMp3(abs);
  }
  const dl = c.query.get('download');
  await sendFile(c.req, c.res, file, {
    cache: /\/(takes|audio|refs|exports)\//.test(file) ? 'private, max-age=31536000, immutable' : 'no-cache',
    downloadName: dl ? (c.query.get('format') === 'mp3' ? dl.replace(/\.wav$/i, '') + '.mp3' : dl) : undefined,
  });
}


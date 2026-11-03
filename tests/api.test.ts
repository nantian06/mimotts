// 接口集成测试：启动模拟上游 + 工作台服务，走一遍主要流程
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../server/audio/wav.ts';
import { ffmpegStatus } from '../server/audio/ffmpeg.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 18000 + Math.floor(Math.random() * 900);
const APP_PORT = MOCK_PORT + 1000;
const base = `http://127.0.0.1:${APP_PORT}`;
let dataDir = '';
const procs: ChildProcess[] = [];

function startNode(file: string, env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    const onData = (c: Buffer) => { out += c.toString(); if (/on http|已启动/.test(out)) resolve(p); };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', (c: Buffer) => { out += c.toString(); });
    p.on('exit', (code) => reject(new Error(`${file} exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`timeout starting ${file}: ${out}`)), 15000);
  });
}

async function api<T = any>(method: string, url: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<T> {
  const res = await fetch(base + url, {
    method,
    headers: raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = text; }
  if (!res.ok) { const e: any = new Error(`${method} ${url} → ${res.status}: ${j?.error ?? text}`); e.status = res.status; throw e; }
  return j;
}

async function waitJobs(ids: string[], timeout = 30000): Promise<any[]> {
  const t0 = Date.now();
  for (;;) {
    const jobs: any[] = await api('GET', '/api/jobs');
    const mine = ids.map((id) => jobs.find((j) => j.id === id));
    if (mine.every((j) => j && ['done', 'failed', 'canceled'].includes(j.status))) return mine;
    if (Date.now() - t0 > timeout) throw new Error(`jobs timeout: ${JSON.stringify(mine)}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-api-'));
  await startNode(path.join(root, 'scripts/mock-upstream.ts'), { MOCK_PORT: String(MOCK_PORT), MOCK_DELAY_MS: '30', MOCK_FAIL_EVERY: '7' });
  await startNode(path.join(root, 'server/index.ts'), { PORT: String(APP_PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, WEB_DIR: path.join(dataDir, 'noweb') });
  await api('PUT', '/api/settings', {
    mimo: { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-test-123456', retries: 3, maxChars: 40 },
    llm: { endpoints: [{ id: 'ep1', name: 'mock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'k', models: ['mock-llm'] }], defaultModel: { endpointId: 'ep1', model: 'mock-llm' } },
  });
});

after(() => {
  for (const p of procs) p.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('设置：Key 脱敏、状态', async () => {
  const s = await api('GET', '/api/settings');
  assert.equal(s.mimo.apiKeySet, true);
  assert.equal(s.mimo.apiKey, undefined);
  assert.equal(s.llm.endpoints[0].apiKey, undefined);
  const st = await api('GET', '/api/status');
  assert.equal(st.mimoConfigured, true);
  assert.equal(st.llmConfigured, true);
});

test('预置音色：快速合成（长文本切块 + 429 重试）', async () => {
  const text = '(温柔)第一句话在这里，说得稍微长一点。第二句话也不短，需要被切开才行。第三句，继续说下去吧！第四句到这里就结束了。';
  const { job } = await api('POST', '/api/synth', { voice: { type: 'library', id: 'builtin-bingtang' }, text, instruction: '语速稍慢' });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  const list = await api('GET', '/api/quick');
  const r = list.find((x: any) => x.id === j.result.resultId);
  assert.ok(r.chunks.length >= 2, `chunks=${r.chunks.length}`);
  assert.equal(r.model, 'mimo-v2.5-tts');
  assert.equal(r.instruction, '语速稍慢');
  const audio = await fetch(base + r.url);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  const received = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__received`)).json();
  const sent = received.filter((x: any) => x.model === 'mimo-v2.5-tts');
  assert.ok(sent.every((x: any) => x.assistant.startsWith('(温柔)')), '每段都带开头风格标签');
  assert.ok(sent.every((x: any) => x.user === '语速稍慢' && x.audio.voice === '冰糖'));
});

test('预置音色：流式合成', async () => {
  const res = await fetch(base + '/api/synth/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: { type: 'library', id: 'builtin-mia' }, text: 'Hello there, this is a streaming test.' }),
  });
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'start');
  assert.ok(lines.filter((l) => l.type === 'audio').length >= 2);
  const done = lines.find((l) => l.type === 'done');
  assert.ok(done?.result?.id, JSON.stringify(lines.filter((l) => l.type !== 'audio')));
});

test('唱歌模式只允许预置音色；设计音色忽略风格指令', async () => {
  const e = await api('POST', '/api/synth', { voice: { type: 'adhoc-design', description: '年轻男声' }, text: '(唱歌)啦啦啦' }).catch((x) => x);
  assert.equal(e.status, 400);
  const { job } = await api('POST', '/api/synth', { voice: { type: 'adhoc-design', description: '年轻男声，清亮' }, text: '你好呀。', instruction: '开心一点' });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  const r = (await api('GET', '/api/quick')).find((x: any) => x.id === j.result.resultId);
  assert.equal(r.instructionIgnored, true);
  assert.equal(r.model, 'mimo-v2.5-tts-voicedesign');
  // 存为设计音色（带上这条作为试听）
  const v = await api('POST', '/api/voices/from-quick', { resultId: r.id, name: '清亮男声' });
  assert.equal(v.kind, 'design');
  assert.equal(v.takes.length, 1);
});

test('智能润色、文本留空的设计结果可以送入剧本（用实际朗读文本）', async () => {
  const { job } = await api('POST', '/api/synth', { voice: { type: 'adhoc-design', description: '温柔的女声' }, text: '', optimizeTextPreview: true });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  const r = (await api('GET', '/api/quick')).find((x: any) => x.id === j.result.resultId);
  assert.equal(r.text, '');
  assert.ok(r.actualText);
  const p = await api('POST', '/api/projects', { name: '润色送入' });
  await api('POST', `/api/quick/${r.id}/to-project`, { projectId: p.id });
  const view = await api('GET', `/api/projects/${p.id}`);
  assert.equal(view.segments.length, 1);
  assert.equal(view.segments[0].text, r.actualText.trim());
  assert.ok(view.segments[0].activeTakeId);
});

test('设计音色：抽卡 → 固化 → 走 voiceclone', async () => {
  const v = await api('POST', '/api/voices', { kind: 'design', name: '睡前故事', description: '温柔的年轻女声，语速舒缓', tags: ['温柔'] });
  const { jobs } = await api('POST', `/api/voices/${v.id}/takes`, { count: 2, text: '晚安呀，今天辛苦了。把灯调暗一点，闭上眼睛，我给你讲一个很短很短的故事。' });
  const done = await waitJobs(jobs.map((j: any) => j.id));
  assert.ok(done.every((j) => j.status === 'done'), JSON.stringify(done));
  let d = await api('GET', `/api/voices/${v.id}`);
  assert.equal(d.takes.length, 2);
  assert.equal(d.summary.status, 'drafting');
  assert.equal(d.summary.mode, 'design');
  const fixed = await api('POST', `/api/voices/${v.id}/fix`, { takeId: d.takes[1].id });
  assert.equal(fixed.currentRef, 1);
  assert.equal(fixed.refs[0].preset, 'fix');
  d = await api('GET', `/api/voices/${v.id}`);
  assert.equal(d.summary.status, 'fixed');
  assert.equal(d.summary.mode, 'clone');
  assert.equal(d.summary.version, 'ref:v1');
  // 再次固化同一条复用版本
  const again = await api('POST', `/api/voices/${v.id}/fix`, { takeId: d.takes[1].id });
  assert.equal(again.refs.length, 1);
  const { job } = await api('POST', '/api/synth', { voice: { type: 'library', id: v.id }, text: '固化后的声音。', instruction: '轻声' });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  const r = (await api('GET', '/api/quick')).find((x: any) => x.id === j.result.resultId);
  assert.equal(r.model, 'mimo-v2.5-tts-voiceclone');
  assert.equal(r.instruction, '轻声');
  // 取消固化
  const un = await api('POST', `/api/voices/${v.id}/unfix`);
  assert.equal(un.currentRef, null);
});

test('克隆音色：上传 → 标准化 → 创建 → 新版本 → 合成', { skip: !ffmpegStatus().ok }, async () => {
  const fs0 = 44100;
  const n = fs0 * 9;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs0;
    const on = (t > 1 && t < 4) || (t > 6 && t < 8);
    x[i] = on ? 0.05 * Math.sin(2 * Math.PI * 170 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : (Math.random() - 0.5) * 0.0005;
  }
  const up = await api('POST', '/api/uploads?name=me.wav', undefined, { data: encodeWav(x, fs0), type: 'audio/wav' });
  assert.equal(up.info.sampleRate, 44100);
  assert.equal(up.peaks.length, 1200);
  const pr = await api('POST', `/api/uploads/${up.id}/process`, { preset: 'standard', region: null });
  assert.ok(Math.abs(pr.report.after.lufs + 20) < 1, `lufs ${pr.report.after.lufs}`);
  assert.ok(pr.report.after.durationSec < 6.5, `dur ${pr.report.after.durationSec}`);
  assert.equal(pr.report.usable, true);
  const v = await api('POST', '/api/voices', { kind: 'clone', name: '我的声音', gender: 'male', ref: { uploadId: up.id, preset: 'standard' } });
  assert.equal(v.currentRef, 1);
  assert.equal(v.refs[0].report.sampleRate, 24000);
  // 用截取区间 + 自定义参数做第二个版本
  const up2 = await api('POST', '/api/uploads/from', { type: 'voice-ref', voiceId: v.id, version: 1 });
  const v2 = await api('POST', `/api/voices/${v.id}/refs`, { uploadId: up2.id, region: { start: 0.5, end: 4.5 }, preset: 'custom', params: { targetLufs: -18, compressPauses: false } });
  assert.equal(v2.currentRef, 2);
  assert.equal(v2.refs[1].params.targetLufs, -18);
  // 不可用的参考音频（太短）拒绝保存
  const bad = await api('POST', `/api/voices/${v.id}/refs`, { uploadId: up2.id, region: { start: 1.0, end: 2.0 }, preset: 'standard' }).catch((e) => e);
  assert.equal(bad.status, 422);
  const { job } = await api('POST', '/api/synth', { voice: { type: 'library', id: v.id }, text: '克隆的声音。' });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  // 导出 → 导入
  const zip = Buffer.from(await (await fetch(`${base}/api/voices/${v.id}/export`)).arrayBuffer());
  const imp = await api('POST', '/api/voices/import', undefined, { data: zip, type: 'application/zip' });
  assert.equal(imp.imported.length, 1);
  assert.notEqual(imp.imported[0].id, v.id);
  const d = await api('GET', `/api/voices/${imp.imported[0].id}`);
  assert.equal(d.refs.length, 2);
  const f = await fetch(base + d.urls.refs[2].processed);
  assert.equal(f.status, 200);
  // 回收站
  await api('POST', `/api/voices/${v.id}/trash`);
  assert.ok((await api('GET', '/api/voices?trash=1')).some((x: any) => x.id === v.id));
  await api('POST', `/api/voices/${v.id}/restore`);
  assert.ok((await api('GET', '/api/voices')).some((x: any) => x.id === v.id));
});

test('剧本：拆分 → 配音推荐 → 批量生成 → 过期检测 → 导出', async () => {
  const p = await api('POST', '/api/projects', { name: '测试剧本' });
  const text = '夜深了，街上没有人。\n小明：“你还在等谁？”\n小红：“等一个不会来的人。”\n风吹过，灯灭了。';
  const { job } = await api('POST', `/api/projects/${p.id}/split`, { text, withInstruction: false });
  const [j] = await waitJobs([job.id]);
  assert.equal(j.status, 'done', j.error);
  const preview = j.result;
  assert.equal(preview.segments.length, 4);
  assert.ok(preview.coverage > 0.9, `coverage ${preview.coverage}`);
  let view = await api('POST', `/api/projects/${p.id}/apply-split`, { roles: preview.roles, segments: preview.segments });
  assert.deepEqual(view.roles.map((r: any) => r.name).sort(), ['小明', '小红', '旁白'].sort());
  const cast = await api('POST', `/api/projects/${p.id}/cast`, {});
  assert.equal(cast.suggestions.length, 3);
  for (const s of cast.suggestions) {
    const role = view.roles.find((r: any) => r.name === s.role);
    await api('PATCH', `/api/projects/${p.id}/roles/${role.id}`, { voiceId: s.voiceId });
  }
  const batch = await api('POST', `/api/projects/${p.id}/llm-batch`, { task: 'batch-instruction', ids: view.segments.map((s: any) => s.id) });
  assert.equal(batch.values.length, 4);
  await api('POST', `/api/projects/${p.id}/segments/values`, { values: batch.values });
  const gen = await api('POST', `/api/projects/${p.id}/generate`, { mode: 'missing' });
  assert.equal(gen.jobs.length, 4, JSON.stringify(gen.skipped));
  const res = await waitJobs(gen.jobs.map((x: any) => x.id));
  assert.ok(res.every((x) => x.status === 'done'), JSON.stringify(res.map((x) => x.error)));
  view = await api('GET', `/api/projects/${p.id}`);
  assert.ok(view.segments.every((s: any) => s.activeTakeId));
  // 改文本后应该算过期，只重新生成这一段
  await api('PATCH', `/api/projects/${p.id}/segments/${view.segments[0].id}`, { text: '夜很深了，街上空无一人。' });
  const stale = await api('POST', `/api/projects/${p.id}/generate`, { mode: 'stale' });
  assert.equal(stale.jobs.length, 1);
  await waitJobs(stale.jobs.map((x: any) => x.id));
  view = await api('GET', `/api/projects/${p.id}`);
  assert.equal(view.segments[0].takes.length, 2);
  // 锁定后不生成
  await api('PATCH', `/api/projects/${p.id}/segments/${view.segments[1].id}`, { locked: true });
  const all = await api('POST', `/api/projects/${p.id}/generate`, { mode: 'all' });
  assert.ok(all.skipped.some((s: any) => s.reason === '已锁定'));
  await waitJobs(all.jobs.map((x: any) => x.id));
  // 导出
  const wav = await api('POST', `/api/projects/${p.id}/export`, { format: 'wav' });
  assert.equal((await fetch(base + wav.url)).status, 200);
  const srt = await api('POST', `/api/projects/${p.id}/export`, { format: 'srt', includeRole: true });
  const srtText = await (await fetch(base + srt.url)).text();
  assert.match(srtText, /小明：你还在等谁？/);
  const zip = await api('POST', `/api/projects/${p.id}/export`, { format: 'zip' });
  assert.equal((await fetch(base + zip.url)).status, 200);
  if (ffmpegStatus().mp3) {
    const mp3 = await api('POST', `/api/projects/${p.id}/export`, { format: 'mp3' });
    assert.match(mp3.name, /\.mp3$/);
  }
  const pkg = await api('POST', `/api/projects/${p.id}/export`, { format: 'package' });
  const buf = Buffer.from(await (await fetch(base + pkg.url)).arrayBuffer());
  const imported = await api('POST', '/api/projects/import', undefined, { data: buf, type: 'application/zip' });
  assert.equal(imported.segments.length, 4);
  const exportsList = await api('GET', `/api/projects/${p.id}/exports`);
  assert.ok(exportsList.length >= 4);
  // 插入片段：显式 roleId: null 保持不指定角色，省略时归给第一个角色
  const [unassigned, defaulted] = await api('POST', `/api/projects/${p.id}/segments`, { items: [{ roleId: null, text: '没有角色的一段' }, { text: '默认角色的一段' }] });
  assert.equal(unassigned.roleId, null);
  assert.equal(defaulted.roleId, view.roles[0].id);
});

test('大模型辅助：指令、导演模式、打标签、描述润色、提示词模板', async () => {
  const a = await api('POST', '/api/llm/run', { task: 'instruction-natural', vars: { text: '晚安。', intent: '温柔' } });
  assert.ok(a.output.length > 5);
  assert.equal(a.debug.model, 'mock-llm');
  const d = await api('POST', '/api/llm/run', { task: 'instruction-director', vars: { text: '那年冬天……' } });
  assert.ok(d.output.role && d.output.scene && d.output.guidance);
  const t = await api('POST', '/api/llm/run', { task: 'tags', vars: { text: '你好，今天天气不错。' } });
  assert.match(t.output, /^\(平静\)/);
  assert.equal(t.warnings.length, 0);
  const dd = await api('POST', '/api/llm/run', { task: 'design-desc', vars: { draft: '温柔姐姐' } });
  assert.ok(dd.output.description && dd.output.previewText);
  const tpl = await api('GET', '/api/prompts');
  assert.equal(tpl.length, 9);
  await api('PUT', '/api/prompts/preview-text', { user: '描述：{{description}}，写台词' });
  assert.equal((await api('GET', '/api/prompts')).find((x: any) => x.task === 'preview-text').overridden, true);
  await api('DELETE', '/api/prompts/preview-text');
  const models = await api('POST', '/api/llm/models', { endpointId: 'ep1' });
  assert.deepEqual(models.models, ['mock-llm', 'mock-llm-pro']);
});

test('文件服务：路径穿越与设置文件不可访问', async () => {
  assert.equal((await fetch(base + '/files/settings.json')).status, 404);
  assert.equal((await fetch(base + '/files/..%2F..%2Fetc%2Fpasswd')).status, 404);
});

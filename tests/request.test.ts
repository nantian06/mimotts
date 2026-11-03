import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMimoBody, redactBody, SynthInputError } from '../server/mimo/request.ts';
import { effectiveSegment, staleReasons } from '../shared/effective.ts';
import type { Project, VoiceSummary } from '../shared/types.ts';

test('预置音色：文本在 assistant，指令在 user，voice=预置 ID', () => {
  const { body } = buildMimoBody({ mode: 'preset', presetId: '冰糖' }, { text: '你好', instruction: '开心' });
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.deepEqual(body.messages, [{ role: 'user', content: '开心' }, { role: 'assistant', content: '你好' }]);
  assert.deepEqual(body.audio, { format: 'wav', voice: '冰糖' });
  const s = buildMimoBody({ mode: 'preset', presetId: 'Mia' }, { text: 'hi', stream: true }).body;
  assert.equal(s.stream, true);
  assert.equal(s.audio.format, 'pcm16');
  assert.equal(s.messages.length, 1);
});

test('设计音色：user=描述（必填），不传 voice，指令被忽略并提示', () => {
  const { body, warnings } = buildMimoBody({ mode: 'design', description: '年轻男声' }, { text: '你好', instruction: '开心' });
  assert.equal(body.model, 'mimo-v2.5-tts-voicedesign');
  assert.deepEqual(body.messages[0], { role: 'user', content: '年轻男声' });
  assert.equal(body.audio.voice, undefined);
  assert.equal(warnings.length, 1);
  const o = buildMimoBody({ mode: 'design', description: 'x' }, { text: '', optimizeTextPreview: true }).body;
  assert.equal(o.messages.length, 1);
  assert.equal(o.audio.optimize_text_preview, true);
  assert.throws(() => buildMimoBody({ mode: 'design', description: '' }, { text: 'a' }), SynthInputError);
  assert.throws(() => buildMimoBody({ mode: 'design', description: 'x' }, { text: '' }), SynthInputError);
});

test('克隆音色：voice=data URI，总是带 user 消息；唱歌被拒绝', () => {
  const uri = 'data:audio/wav;base64,' + 'A'.repeat(5000);
  const { body } = buildMimoBody({ mode: 'clone', refDataUri: uri }, { text: '你好' });
  assert.equal(body.model, 'mimo-v2.5-tts-voiceclone');
  assert.deepEqual(body.messages, [{ role: 'user', content: '' }, { role: 'assistant', content: '你好' }]);
  assert.equal(body.audio.voice, uri);
  assert.ok(String(redactBody(body).audio.voice).length < 80);
  assert.throws(() => buildMimoBody({ mode: 'clone', refDataUri: uri }, { text: '(唱歌)啦啦' }), /唱歌模式只支持预置音色/);
  assert.doesNotThrow(() => buildMimoBody({ mode: 'preset', presetId: '冰糖' }, { text: '(唱歌)啦啦' }));
});

function voice(p: Partial<VoiceSummary>): VoiceSummary {
  return {
    id: 'v1', kind: 'clone', builtin: false, name: 'V', tags: [], lang: '', gender: '', notes: '', favorite: false, defaultInstruction: '',
    mode: 'clone', version: 'ref:v1', status: 'ready', takeCount: 0, createdAt: 0, updatedAt: 0, trashed: false, ...p,
  };
}

test('片段继承：片段 > 角色 > 音色默认指令；未固化设计音色忽略指令', () => {
  const p: Project = {
    id: 'p', name: 'p', notes: '', createdAt: 0, updatedAt: 0, settings: { defaultGapMs: 400, keepTakes: 5 },
    roles: [{ id: 'r1', name: 'A', color: '#000', voiceId: 'v1', instruction: '', notes: '' }, { id: 'r2', name: 'B', color: '#000', voiceId: null, instruction: 'x', notes: '' }],
    segments: [
      { id: 's1', roleId: 'r1', text: '你好', instruction: '', pauseAfterMs: null, locked: false, note: '', takes: [], activeTakeId: null },
      { id: 's2', roleId: 'r2', text: '嗨', instruction: '', pauseAfterMs: null, locked: false, note: '', takes: [], activeTakeId: null },
    ],
  };
  const vm = new Map([['v1', voice({ defaultInstruction: '温柔' })]]);
  const e1 = effectiveSegment(p, p.segments[0], vm);
  assert.equal(e1.instruction, '温柔');
  assert.equal(e1.instructionSource, 'voice');
  p.roles[0].instruction = '严肃';
  assert.equal(effectiveSegment(p, p.segments[0], vm).instruction, '严肃');
  p.segments[0].instruction = '开心';
  assert.equal(effectiveSegment(p, p.segments[0], vm).instructionSource, 'segment');
  assert.ok(effectiveSegment(p, p.segments[1], vm).problems[0].includes('未绑定音色'));
  const design = new Map([['v1', voice({ kind: 'design', mode: 'design', version: 'desc:abc' })]]);
  const ed = effectiveSegment(p, p.segments[0], design);
  assert.equal(ed.instruction, '');
  assert.equal(ed.instructionIgnored, true);
});

test('过期检测：文本、指令、音色版本变化', () => {
  const p: Project = {
    id: 'p', name: 'p', notes: '', createdAt: 0, updatedAt: 0, settings: { defaultGapMs: 400, keepTakes: 5 },
    roles: [{ id: 'r1', name: 'A', color: '#000', voiceId: 'v1', instruction: '', notes: '' }],
    segments: [{
      id: 's1', roleId: 'r1', text: '你好', instruction: '', pauseAfterMs: null, locked: false, note: '', activeTakeId: 't1',
      takes: [{ id: 't1', file: '', createdAt: 0, durationMs: 1, peaks: [], voiceId: 'v1', voiceName: 'V', voiceVersion: 'ref:v1', model: '', instruction: '', text: '你好', chunks: [], warnings: [], starred: false }],
    }],
  };
  const vm = new Map([['v1', voice({})]]);
  assert.deepEqual(staleReasons(p.segments[0], effectiveSegment(p, p.segments[0], vm)), []);
  vm.set('v1', voice({ version: 'ref:v2' }));
  assert.deepEqual(staleReasons(p.segments[0], effectiveSegment(p, p.segments[0], vm)), ['音色已更新']);
  p.segments[0].text = '你好呀';
  assert.ok(staleReasons(p.segments[0], effectiveSegment(p, p.segments[0], vm)).includes('文本已改'));
});

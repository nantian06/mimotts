import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeFrames, compressPauses, highpass, integratedLoudness, limit, measure, samplePeak, suggestRegion, toDb, trimEdges, truePeak, trimSilence,
} from '../server/audio/dsp.ts';
import { computePeaks, decodeWav, encodeWav } from '../server/audio/wav.ts';
import { ffmpegStatus } from '../server/audio/ffmpeg.ts';
import { makeSource, processSource } from '../server/audio/preprocess.ts';
import { PROCESS_PRESETS } from '../shared/presets.ts';

function sine(freq: number, amp: number, sec: number, fs: number, phase = 0): Float32Array {
  const n = Math.round(sec * fs);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return x;
}

/** 类语音信号：基频 + 谐波，音节包络，句间停顿，底噪 */
function speechLike(fs: number, opts: { lead: number; segs: number[]; gaps: number[]; tail: number; noiseDb: number; level: number }): Float32Array {
  const parts: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const noiseAmp = Math.pow(10, opts.noiseDb / 20) * 2;
  const pushSilence = (sec: number) => { for (let i = 0; i < Math.round(sec * fs); i++) parts.push(rnd() * noiseAmp); };
  const pushSpeech = (sec: number) => {
    const n = Math.round(sec * fs);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const f0 = 160 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
      const syll = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      parts.push(opts.level * syll * v * 0.5 + rnd() * noiseAmp);
    }
  };
  pushSilence(opts.lead);
  opts.segs.forEach((s, i) => { pushSpeech(s); if (i < opts.gaps.length) pushSilence(opts.gaps[i]); });
  pushSilence(opts.tail);
  return Float32Array.from(parts);
}

test('BS.1770：997Hz -20dBFS 正弦 ≈ -23.0 LUFS（48k / 24k）', () => {
  for (const fs of [48000, 24000, 16000]) {
    const l = integratedLoudness(sine(997, 0.1, 5, fs), fs)!;
    assert.ok(Math.abs(l - -23.01) < 0.15, `fs=${fs} lufs=${l}`);
  }
});

test('响度：过短返回 null，静音返回 -70', () => {
  assert.equal(integratedLoudness(new Float32Array(1000), 24000), null);
  assert.equal(integratedLoudness(new Float32Array(48000), 24000), -70);
});

test('真峰值：fs/4 正弦相位偏移时能估出样本间峰值', () => {
  const fs = 24000;
  const x = sine(fs / 4, 0.8, 0.5, fs, Math.PI / 4);
  assert.ok(samplePeak(x) < 0.6);
  const tp = truePeak(x);
  assert.ok(Math.abs(toDb(tp) - toDb(0.8)) < 0.6, `tp=${tp}`);
});

test('限幅：所有样本不超过上限', () => {
  const fs = 24000;
  const x = sine(220, 0.5, 1, fs);
  for (let i = 5000; i < 5100; i++) x[i] *= 3;
  const r = limit(x, fs, 0.8);
  assert.ok(samplePeak(r.samples) <= 0.8 + 1e-6);
  assert.ok(r.events >= 1 && r.maxReductionDb < 0);
  // 远离尖峰的地方不受影响
  assert.ok(Math.abs(r.samples[20000] - x[20000]) < 1e-6);
});

test('高通：去掉直流和低频', () => {
  const fs = 24000;
  const x = sine(30, 0.5, 2, fs);
  for (let i = 0; i < x.length; i++) x[i] += 0.2;
  const y = highpass(x, fs, 80);
  const tail = y.subarray(fs);
  assert.ok(samplePeak(tail) < 0.1, `peak=${samplePeak(tail)}`);
});

test('语音检测：裁首尾静音 + 压缩长停顿', () => {
  const fs = 24000;
  const x = speechLike(fs, { lead: 1.2, segs: [1.5, 1.0], gaps: [2.0], tail: 1.5, noiseDb: -65, level: 0.3 });
  const a = analyzeFrames(x, fs);
  const t = trimEdges(x, fs, a, 150);
  const d1 = t.samples.length / fs;
  assert.ok(d1 > 4.4 && d1 < 4.9, `trimmed=${d1}`);
  const c = compressPauses(t.samples, fs, analyzeFrames(t.samples, fs), 700, 350);
  assert.equal(c.count, 1);
  const d2 = c.samples.length / fs;
  assert.ok(d2 > 2.7 && d2 < 3.3, `compressed=${d2}`);
});

test('推荐区间：长素材选出语音密集段', () => {
  const fs = 16000;
  const x = speechLike(fs, { lead: 8, segs: [3, 3, 3, 3, 3, 3], gaps: [0.4, 0.4, 0.4, 0.4, 0.4], tail: 6, noiseDb: -60, level: 0.3 });
  const r = suggestRegion(x, fs, 10)!;
  assert.ok(r, '应该给出推荐');
  assert.ok(r.start >= 7 && r.end <= 29, JSON.stringify(r));
  assert.ok(r.end - r.start >= 9.5 && r.end - r.start <= 13.5, JSON.stringify(r));
});

test('WAV 编解码往返 & 峰值', () => {
  const x = sine(440, 0.5, 0.3, 24000);
  const y = decodeWav(encodeWav(x, 24000));
  assert.equal(y.sampleRate, 24000);
  assert.equal(y.samples.length, x.length);
  assert.ok(Math.abs(y.samples[100] - x[100]) < 1e-4);
  const p = computePeaks(x, 50);
  assert.equal(p.length, 50);
  assert.ok(Math.abs(p[10] - 0.5) < 0.01);
});

test('合成结果首尾静音裁剪', () => {
  const fs = 24000;
  const x = new Float32Array(fs * 2);
  x.set(sine(300, 0.3, 1, fs), fs / 2);
  const y = trimSilence(x, fs, -48, 60);
  assert.ok(y.length / fs > 1.05 && y.length / fs < 1.2, `${y.length / fs}`);
});

test('参考音频标准化流水线（需要 ffmpeg）', { skip: !ffmpegStatus().ok }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-pre-'));
  try {
    const fsr = 44100;
    // 双声道、音量偏低、有长停顿和首尾静音
    const mono = speechLike(fsr, { lead: 1.0, segs: [2.5, 2.0, 2.5], gaps: [1.8, 0.3], tail: 1.2, noiseDb: -62, level: 0.06 });
    const stereo = Buffer.alloc(44 + mono.length * 4);
    const w = encodeWav(mono, fsr);
    // 手工改成双声道
    stereo.write('RIFF', 0, 'ascii'); stereo.writeUInt32LE(36 + mono.length * 4, 4); stereo.write('WAVE', 8, 'ascii');
    stereo.write('fmt ', 12, 'ascii'); stereo.writeUInt32LE(16, 16); stereo.writeUInt16LE(1, 20); stereo.writeUInt16LE(2, 22);
    stereo.writeUInt32LE(fsr, 24); stereo.writeUInt32LE(fsr * 4, 28); stereo.writeUInt16LE(4, 32); stereo.writeUInt16LE(16, 34);
    stereo.write('data', 36, 'ascii'); stereo.writeUInt32LE(mono.length * 4, 40);
    for (let i = 0; i < mono.length; i++) { const v = w.readInt16LE(44 + i * 2); stereo.writeInt16LE(v, 44 + i * 4); stereo.writeInt16LE(v, 46 + i * 4); }
    const orig = path.join(dir, 'orig.wav');
    fs.writeFileSync(orig, stereo);
    const src = path.join(dir, 'source.wav');
    const s = await makeSource(orig, src, 15);
    assert.equal(s.info.channels, 2);
    assert.equal(s.sampleRate, 44100);
    assert.equal(s.peaks.length, 1200);

    const out = await processSource(src, null, PROCESS_PRESETS.standard.params, { minSec: 4, recommendMaxSec: 30, hardMaxSec: 90 }, s.info);
    const r = out.report;
    assert.equal(out.sampleRate, 24000);
    assert.ok(r.after.lufs !== null && Math.abs(r.after.lufs + 20) < 0.8, `lufs=${r.after.lufs}`);
    assert.ok(r.after.truePeakDb <= -0.9, `tp=${r.after.truePeakDb}`);
    assert.ok(r.after.durationSec < r.before.durationSec - 2, `${r.before.durationSec} → ${r.after.durationSec}`);
    assert.ok(r.steps.some((x) => x.includes('压缩 1 处')), r.steps.join(' | '));
    assert.ok(r.warnings.some((x) => x.code === 'downmix'));
    assert.equal(r.usable, true);
    const back = decodeWav(out.wav);
    assert.equal(back.sampleRate, 24000);

    // 截取区间 + 不处理
    const raw = await processSource(src, { start: 1, end: 3 }, PROCESS_PRESETS.raw.params, { minSec: 4, recommendMaxSec: 30, hardMaxSec: 90 }, s.info);
    assert.ok(Math.abs(raw.report.after.durationSec - 2) < 0.05);
    assert.ok(raw.report.warnings.some((x) => x.code === 'short'));

    // 降噪预设
    if (ffmpegStatus().denoise) {
      const nz = await processSource(src, null, PROCESS_PRESETS.noisy.params, { minSec: 4, recommendMaxSec: 30, hardMaxSec: 90 }, s.info);
      assert.ok(nz.report.steps.some((x) => x.startsWith('降噪')));
    }
    assert.ok(measure(out.samples, 24000).speechRatio > 0.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

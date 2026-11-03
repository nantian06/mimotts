// 克隆参考音频标准化流水线 + 质量报告
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { AudioInfo, AudioMetrics, PreprocessSettings, ProcessParams, QualityReport, QualityWarning, Region } from '../../shared/types.ts';
import { REF_BASE64_LIMIT } from '../../shared/presets.ts';
import { decodeToFloat, denoise, ffmpegStatus, parseInfo } from './ffmpeg.ts';
import {
  analyzeFrames, applyGain, compressPauses, fade, fromDb, highpass, integratedLoudness, limit, measure,
  samplePeak, suggestRegion, toDb, trimEdges, truePeak,
} from './dsp.ts';
import { computePeaks, encodeWav } from './wav.ts';

/** 读取输入音频格式（不解码全部数据） */
export function probe(file: string): Promise<AudioInfo> {
  const s = ffmpegStatus();
  if (!s.ok) return Promise.reject(new Error('未检测到 ffmpeg'));
  return new Promise((resolve, reject) => {
    const p = spawn(s.path, ['-hide_banner', '-nostdin', '-i', file, '-t', '0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    p.on('error', reject);
    p.on('close', () => {
      const info = parseInfo(err);
      if (!info.sampleRate) reject(new Error('无法识别的音频文件（未找到音频流）'));
      else resolve(info);
    });
  });
}

export interface SourceResult {
  info: AudioInfo;
  sampleRate: number;
  durationSec: number;
  peaks: number[];
  suggestion: Region | null;
}

/** 把任意格式的原始文件解码成可编辑的源 WAV（单声道，保留 16k–48k 采样率） */
export async function makeSource(originalFile: string, sourceFile: string, autoPickSec: number): Promise<SourceResult> {
  const info = await probe(originalFile);
  const sampleRate = Math.min(48000, Math.max(16000, info.sampleRate || 48000));
  const { samples } = await decodeToFloat(originalFile, { sampleRate });
  if (!samples.length) throw new Error('音频解码结果为空');
  await fs.writeFile(sourceFile, encodeWav(samples, sampleRate));
  return {
    info: { ...info, durationSec: info.durationSec || samples.length / sampleRate },
    sampleRate,
    durationSec: Math.round((samples.length / sampleRate) * 100) / 100,
    peaks: computePeaks(samples, 1200),
    suggestion: suggestRegion(samples, sampleRate, autoPickSec),
  };
}

const DENOISE_LABEL = { light: '轻度', medium: '中度', strong: '强' } as const;

export interface ProcessOutput {
  wav: Buffer;
  samples: Float32Array;
  sampleRate: number;
  report: QualityReport;
}

const fmt1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

export async function processSource(
  sourceFile: string,
  region: Region | null,
  params: ProcessParams,
  limits: Pick<PreprocessSettings, 'minSec' | 'recommendMaxSec' | 'hardMaxSec'>,
  originalInfo: AudioInfo,
): Promise<ProcessOutput> {
  const sr = params.sampleRate;
  const { samples: x0 } = await decodeToFloat(sourceFile, { sampleRate: sr, region });
  if (x0.length < sr * 0.2) throw new Error('截取的片段太短');
  const before = measure(x0, sr);
  const steps: string[] = [];
  const warnings: QualityWarning[] = [];
  let x = x0;

  steps.push(`转为单声道 ${sr / 1000} kHz`);
  if (params.highpassHz > 0) {
    x = highpass(x, sr, params.highpassHz);
    steps.push(`高通滤波 ${params.highpassHz} Hz（去低频轰鸣与直流偏移）`);
  }
  if (params.denoise !== 'off') {
    x = await denoise(x, sr, params.denoise);
    steps.push(`降噪（${DENOISE_LABEL[params.denoise]}）`);
  }
  // 在裁剪/压缩停顿之前估算底噪：之后静音段大多被剪掉，百分位估计会失真
  const mid = analyzeFrames(x, sr);
  if (params.trimEdges) {
    const r = trimEdges(x, sr, mid, params.edgePadMs);
    x = r.samples;
    if (r.removedHead + r.removedTail > sr * 0.05) {
      steps.push(`裁掉首部静音 ${fmt1(r.removedHead / sr)} 秒、尾部 ${fmt1(r.removedTail / sr)} 秒`);
    }
  }
  if (params.compressPauses) {
    const r = compressPauses(x, sr, analyzeFrames(x, sr), params.maxPauseMs, params.keepPauseMs);
    x = r.samples;
    if (r.count) steps.push(`压缩 ${r.count} 处长停顿（共缩短 ${fmt1(r.removed / sr)} 秒）`);
  }

  let boostDb = 0;
  if (params.normalize) {
    const measured = integratedLoudness(x, sr) ?? toDb(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length)));
    let gain = Math.max(-20, Math.min(30, params.targetLufs - measured));
    x = applyGain(x, gain);
    const ceilingLin = fromDb(params.ceilingDb);
    const tpDb = toDb(truePeak(x));
    const overDb = tpDb - params.ceilingDb;
    if (overDb > 6) {
      // 限幅最多压 6dB，再多就降低整体增益，避免破坏音色
      x = applyGain(x, -(overDb - 6));
      gain -= overDb - 6;
    }
    boostDb = gain;
    steps.push(`响度 ${fmt1(measured)} → ${fmt1(measured + gain)} LUFS（${gain >= 0 ? '+' : ''}${fmt1(gain)} dB）`);
    if (overDb > 0) {
      const lim = limit(x, sr, ceilingLin * 0.94);
      x = lim.samples;
      if (lim.events) steps.push(`峰值限幅 ${lim.events} 处（最大衰减 ${fmt1(-lim.maxReductionDb)} dB）`);
    }
    if (overDb > 6) {
      warnings.push({ level: 'info', code: 'loudness-capped', message: `峰值过高，为避免过度压缩，响度只提升到约 ${fmt1(measured + gain)} LUFS` });
    }
  } else {
    const pk = samplePeak(x);
    if (pk > 0.999) { boostDb = toDb(0.99 / pk); x = applyGain(x, boostDb); steps.push('防削波：整体降低音量'); }
  }
  if (params.fadeMs > 0) x = fade(x, sr, params.fadeMs);

  const measured = measure(x, sr);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const after: AudioMetrics = {
    ...measured,
    noiseFloorDb: r1(Math.max(-100, mid.noiseFloorDb + boostDb)),
    speechLevelDb: r1(mid.speechLevelDb + boostDb),
    snrDb: r1(mid.speechLevelDb - mid.noiseFloorDb),
  };
  const wav = encodeWav(x, sr);
  const base64Bytes = Math.ceil(wav.length / 3) * 4 + 'data:audio/wav;base64,'.length;

  // ───── 质量检查 ─────
  const d = after.durationSec;
  if (after.speechRatio === 0) warnings.push({ level: 'error', code: 'no-speech', message: '没有检测到人声' });
  if (d < 1.5) warnings.push({ level: 'error', code: 'too-short', message: `参考音频太短（${fmt1(d)} 秒），至少需要几秒清晰人声` });
  else if (d < limits.minSec) warnings.push({ level: 'warn', code: 'short', message: `参考音频偏短（${fmt1(d)} 秒），建议 5–20 秒，音色会更稳定` });
  if (d > limits.hardMaxSec) warnings.push({ level: 'error', code: 'too-long', message: `参考音频过长（${fmt1(d)} 秒），超过上限 ${limits.hardMaxSec} 秒，请截取一段` });
  else if (d > limits.recommendMaxSec) warnings.push({ level: 'warn', code: 'long', message: `参考音频偏长（${fmt1(d)} 秒），会占用更多上下文；建议截取最有代表性的 10–20 秒` });
  if (base64Bytes > REF_BASE64_LIMIT) {
    warnings.push({ level: 'error', code: 'size', message: `编码后约 ${(base64Bytes / 1048576).toFixed(1)} MB，超过官方 10 MB 上限，请缩短` });
  }
  if (before.clipEvents >= 20) warnings.push({ level: 'warn', code: 'clipping-heavy', message: `原始音频有明显削波（${before.clipEvents} 处），破音会被一起克隆，建议换一段素材` });
  else if (before.clipEvents >= 3) warnings.push({ level: 'warn', code: 'clipping', message: `检测到 ${before.clipEvents} 处削波失真，听一下是否有破音` });
  const snr = params.denoise !== 'off' ? after.snrDb : before.snrDb;
  if (snr < 12) warnings.push({ level: 'warn', code: 'noisy-heavy', message: `底噪很高（信噪比约 ${fmt1(snr)} dB），克隆效果会明显受影响，建议换更干净的录音` });
  else if (snr < 20) warnings.push({ level: 'warn', code: 'noisy', message: `底噪偏高（信噪比约 ${fmt1(snr)} dB）${params.denoise === 'off' ? '，可试试「嘈杂素材」预设' : ''}` });
  if (after.speechRatio > 0 && after.speechRatio < 0.45) warnings.push({ level: 'warn', code: 'sparse', message: `有效人声占比偏低（${Math.round(after.speechRatio * 100)}%），可能含较多静音或背景声` });
  if (originalInfo.sampleRate && originalInfo.sampleRate < 16000) warnings.push({ level: 'warn', code: 'low-sr', message: `原始采样率只有 ${originalInfo.sampleRate} Hz，高频细节缺失` });
  if (originalInfo.channels > 1) warnings.push({ level: 'info', code: 'downmix', message: `原始为 ${originalInfo.channels} 声道，已混为单声道` });
  if (boostDb > 18) warnings.push({ level: 'info', code: 'boost', message: `原始音量很低，已提升 ${fmt1(boostDb)} dB，底噪也会同步放大` });
  if (params.denoise !== 'off') warnings.push({ level: 'info', code: 'denoise', message: '已降噪：若听感发闷或有金属声，克隆会一并学到，可与「标准」预设对比' });

  const hasError = warnings.some((w) => w.level === 'error');
  const severe = warnings.some((w) => w.code === 'clipping-heavy' || w.code === 'noisy-heavy');
  const grade = hasError || severe ? 'poor' : warnings.some((w) => w.level === 'warn') ? 'ok' : 'good';

  return {
    wav,
    samples: x,
    sampleRate: sr,
    report: { before, after, steps, warnings, grade, base64Bytes, sampleRate: sr, params, usable: !hasError },
  };
}

// ffmpeg 封装：解码任意格式为单声道 Float32、降噪、导出 MP3
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { config } from '../config.ts';
import type { AudioInfo, Region } from '../../shared/types.ts';

export interface FfmpegStatus {
  ok: boolean;
  path: string;
  version: string;
  denoise: boolean;
  mp3: boolean;
}

let status: FfmpegStatus | null = null;

function candidates(): string[] {
  const list: string[] = [];
  if (config.ffmpegPath) list.push(config.ffmpegPath);
  list.push('ffmpeg');
  try {
    // 可选依赖 ffmpeg-static（npm 安装时会自带二进制）
    const req = createRequire(import.meta.url);
    const p = req('ffmpeg-static') as string;
    if (p) list.push(p);
  } catch { /* 未安装 */ }
  return list;
}

export function ffmpegStatus(): FfmpegStatus {
  if (status) return status;
  for (const bin of candidates()) {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) continue;
    const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? '?';
    const filters = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '';
    const encoders = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
    status = { ok: true, path: bin, version, denoise: /\bafftdn\b/.test(filters), mp3: /libmp3lame/.test(encoders) };
    return status;
  }
  status = { ok: false, path: '', version: '', denoise: false, mp3: false };
  return status;
}

function requireFfmpeg(): string {
  const s = ffmpegStatus();
  if (!s.ok) throw new Error('未检测到 ffmpeg：请安装 ffmpeg 或设置环境变量 FFMPEG_PATH（Docker 镜像已内置）');
  return s.path;
}

interface RunResult { stdout: Buffer; stderr: string }

function run(args: string[], input?: Buffer): Promise<RunResult> {
  const bin = requireFfmpeg();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); if (err.length > 200_000) err = err.slice(-100_000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else {
        const lines = err.trim().split('\n').filter((l) => !/^\s*(Input|Output|Stream|Duration|Metadata|encoder|  )/.test(l));
        reject(new Error(`ffmpeg 处理失败：${(lines.slice(-3).join(' ') || err.slice(-300)).trim()}`));
      }
    });
    if (input) {
      p.stdin.on('error', () => undefined);
      p.stdin.end(input);
    } else p.stdin.end();
  });
}

/** 从 ffmpeg 的输出信息里解析输入音频格式 */
export function parseInfo(stderr: string): AudioInfo {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const line = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(stderr)?.[1] ?? '';
  const codec = line.split(/[ ,(]/)[0] || 'unknown';
  const sampleRate = Number(/(\d+) Hz/.exec(line)?.[1] ?? 0);
  let channels = 1;
  if (/\bmono\b/.test(line)) channels = 1;
  else if (/\bstereo\b/.test(line)) channels = 2;
  else {
    const m = /(\d+)\s*channels/.exec(line) ?? /(\d)\.(\d)/.exec(line);
    if (m) channels = m[2] !== undefined ? Number(m[1]) + Number(m[2]) : Number(m[1]);
  }
  const br = /(\d+) kb\/s/.exec(line)?.[1];
  return { codec, sampleRate, channels, durationSec: Math.round(durationSec * 100) / 100, bitrateKbps: br ? Number(br) : undefined };
}

/** 解码为单声道 Float32（可选截取区间、重采样） */
export async function decodeToFloat(file: string, opts: { sampleRate: number; region?: Region | null }): Promise<{ samples: Float32Array; info: AudioInfo }> {
  const args = ['-i', file];
  if (opts.region) args.push('-ss', opts.region.start.toFixed(3), '-to', opts.region.end.toFixed(3));
  args.push('-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(opts.sampleRate), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1');
  const { stdout, stderr } = await run(args);
  const n = Math.floor(stdout.length / 4);
  const ab = new ArrayBuffer(n * 4);
  new Uint8Array(ab).set(stdout.subarray(0, n * 4));
  return { samples: new Float32Array(ab), info: parseInfo(stderr) };
}

const DENOISE: Record<string, string> = {
  light: 'afftdn=nr=6:nf=-50:tn=1',
  medium: 'afftdn=nr=12:nf=-45:tn=1',
  strong: 'afftdn=nr=20:nf=-40:tn=1',
};

/** FFT 降噪（afftdn，开启噪声跟踪） */
export async function denoise(samples: Float32Array, sampleRate: number, level: 'light' | 'medium' | 'strong'): Promise<Float32Array> {
  if (!ffmpegStatus().denoise) throw new Error('当前 ffmpeg 不支持 afftdn 降噪滤镜');
  const input = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const { stdout } = await run(
    ['-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-af', DENOISE[level], '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'],
    input,
  );
  const n = Math.min(samples.length, Math.floor(stdout.length / 4));
  const ab = new ArrayBuffer(samples.length * 4);
  new Uint8Array(ab).set(stdout.subarray(0, n * 4));
  return new Float32Array(ab);
}

/** WAV → MP3（同目录缓存） */
export async function wavToMp3(wavFile: string, bitrate = '192k'): Promise<string> {
  const out = wavFile.replace(/\.wav$/i, '') + '.mp3';
  try {
    const [a, b] = [fs.statSync(wavFile), fs.statSync(out)];
    if (b.mtimeMs >= a.mtimeMs && b.size > 0) return out;
  } catch { /* 需要生成 */ }
  if (!ffmpegStatus().mp3) throw new Error('当前 ffmpeg 不支持 MP3 编码（缺少 libmp3lame）');
  const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp.mp3`);
  await run(['-y', '-i', wavFile, '-codec:a', 'libmp3lame', '-b:a', bitrate, tmp]);
  fs.renameSync(tmp, out);
  return out;
}

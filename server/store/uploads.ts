// 临时上传：原始文件 → 可编辑的源 WAV → 按参数生成标准化预览（缓存）
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { ProcessParams, ProcessResult, QualityReport, Region, RefSource, UploadInfo } from '../../shared/types.ts';
import { hash32 } from '../../shared/text.ts';
import { fileUrl, paths } from '../config.ts';
import { ensureDir, listDirs, readJson, removePath, writeJson } from '../util/fs.ts';
import { newId, isSafeId } from '../util/id.ts';
import { makeSource, processSource } from '../audio/preprocess.ts';
import { computePeaks } from '../audio/wav.ts';
import { getSettings } from './settings.ts';
import { notFound, bad } from '../http.ts';

export interface UploadMeta extends UploadInfo {
  originalFile: string;
  sourceSampleRate: number;
  processed: Record<string, { file: string; report: QualityReport; durationMs: number; peaks: number[] }>;
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg', 'audio/webm': '.webm',
  'audio/flac': '.flac', 'audio/x-flac': '.flac', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
};

function extFor(name: string, mime: string): string {
  const e = path.extname(name).toLowerCase();
  if (/^\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|mp4|mov|mkv|wma|amr)$/.test(e)) return e;
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] ?? '.bin';
}

function dirOf(id: string): string {
  if (!isSafeId(id)) throw bad('无效的上传 ID');
  return path.join(paths.uploads(), id);
}

async function saveMeta(m: UploadMeta): Promise<void> {
  await writeJson(path.join(dirOf(m.id), 'meta.json'), m);
}

export async function getUpload(id: string): Promise<UploadMeta> {
  const m = await readJson<UploadMeta | null>(path.join(dirOf(id), 'meta.json'), null);
  if (!m) throw notFound('上传的音频已过期或不存在，请重新上传');
  return m;
}

export function publicUpload(m: UploadMeta): UploadInfo {
  const { originalFile, sourceSampleRate, processed, ...rest } = m;
  return rest;
}

export async function createUpload(
  data: Buffer,
  opts: { name: string; mime: string; source: RefSource; sourceLabel?: string; takeId?: string },
): Promise<UploadMeta> {
  if (!data.length) throw bad('文件为空');
  const id = newId('u');
  const dir = dirOf(id);
  await ensureDir(dir);
  const originalFile = `original${extFor(opts.name, opts.mime)}`;
  await fsp.writeFile(path.join(dir, originalFile), data);
  try {
    const s = await makeSource(path.join(dir, originalFile), path.join(dir, 'source.wav'), getSettings().preprocess.autoPickSec);
    const meta: UploadMeta = {
      id,
      name: opts.name || originalFile,
      mime: opts.mime || 'application/octet-stream',
      bytes: data.length,
      info: s.info,
      source: opts.source,
      sourceLabel: opts.sourceLabel,
      takeId: opts.takeId,
      sourceUrl: fileUrl(path.join(dir, 'source.wav')),
      sourceDurationSec: s.durationSec,
      peaks: s.peaks,
      suggestion: s.suggestion,
      createdAt: Date.now(),
      originalFile,
      sourceSampleRate: s.sampleRate,
      processed: {},
    };
    await saveMeta(meta);
    return meta;
  } catch (e: any) {
    await removePath(dir);
    throw bad(`无法读取这个音频：${e?.message ?? e}`);
  }
}

export async function createUploadFromFile(
  file: string,
  opts: { name: string; mime: string; source: RefSource; sourceLabel?: string; takeId?: string },
): Promise<UploadMeta> {
  return createUpload(await fsp.readFile(file), opts);
}

export function paramsHash(region: Region | null, params: ProcessParams): string {
  return hash32(JSON.stringify({ region, params }));
}

export async function processUpload(id: string, region: Region | null, params: ProcessParams): Promise<ProcessResult> {
  const m = await getUpload(id);
  const reg = normalizeRegion(region, m.sourceDurationSec);
  const hash = paramsHash(reg, params);
  const dir = dirOf(id);
  const cached = m.processed[hash];
  if (cached) {
    return { hash, url: fileUrl(path.join(dir, cached.file)), durationMs: cached.durationMs, peaks: cached.peaks, report: cached.report };
  }
  const s = getSettings().preprocess;
  const out = await processSource(path.join(dir, 'source.wav'), reg, params, s, m.info);
  const file = `processed-${hash}.wav`;
  await fsp.writeFile(path.join(dir, file), out.wav);
  const durationMs = Math.round((out.samples.length / out.sampleRate) * 1000);
  const peaks = computePeaks(out.samples, 600);
  // 重新读取再写，避免并发处理互相覆盖
  const fresh = await getUpload(id);
  fresh.processed[hash] = { file, report: out.report, durationMs, peaks };
  await saveMeta(fresh);
  return { hash, url: fileUrl(path.join(dir, file)), durationMs, peaks, report: out.report };
}

export function normalizeRegion(region: Region | null | undefined, duration: number): Region | null {
  if (!region) return null;
  const start = Math.max(0, Math.min(duration, Number(region.start) || 0));
  const end = Math.max(0, Math.min(duration, Number(region.end) || duration));
  if (end - start < 0.2) throw bad('截取区间太短');
  if (start <= 0.01 && end >= duration - 0.01) return null;
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
}

export function uploadDir(id: string): string {
  return dirOf(id);
}

export async function deleteUpload(id: string): Promise<void> {
  await removePath(dirOf(id));
}

/** 清理 24 小时前的临时上传 */
export async function cleanupUploads(maxAgeMs = 24 * 3600 * 1000): Promise<number> {
  let n = 0;
  for (const id of await listDirs(paths.uploads())) {
    try {
      const st = await fsp.stat(path.join(paths.uploads(), id));
      if (Date.now() - st.mtimeMs > maxAgeMs) { await removePath(path.join(paths.uploads(), id)); n++; }
    } catch { /* ignore */ }
  }
  return n;
}

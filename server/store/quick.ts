// 快速合成历史：quick/history.json + quick/audio/<id>.wav
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { QuickResult } from '../../shared/types.ts';
import { fileUrl, paths } from '../config.ts';
import { ensureDir, KeyedMutex, readJson, removePath, writeJson } from '../util/fs.ts';
import { notFound } from '../http.ts';
import { emitChange } from '../events.ts';

let items: QuickResult[] = [];
const lock = new KeyedMutex();
const file = () => path.join(paths.quick(), 'history.json');

export async function loadQuick(): Promise<void> {
  items = await readJson<QuickResult[]>(file(), []);
}

async function persist(): Promise<void> {
  await writeJson(file(), items);
  emitChange({ topic: 'quick' });
}

export function quickAudioPath(r: Pick<QuickResult, 'file'>): string {
  return path.join(paths.quick(), r.file);
}

export function withUrl(r: QuickResult): QuickResult & { url: string } {
  return { ...r, url: fileUrl(quickAudioPath(r)) };
}

export function listQuick(limit = 100, before?: number): (QuickResult & { url: string })[] {
  return items.filter((r) => (before ? r.createdAt < before : true)).slice(0, limit).map(withUrl);
}

export function getQuick(id: string): QuickResult {
  const r = items.find((x) => x.id === id);
  if (!r) throw notFound('合成记录不存在');
  return r;
}

export async function addQuick(r: QuickResult, wav: Buffer): Promise<QuickResult> {
  return lock.run('q', async () => {
    await ensureDir(path.join(paths.quick(), 'audio'));
    await fsp.writeFile(quickAudioPath(r), wav);
    items.unshift(r);
    await persist();
    return r;
  });
}

export async function updateQuick(id: string, patch: { starred?: boolean }): Promise<QuickResult> {
  return lock.run('q', async () => {
    const r = getQuick(id);
    if (typeof patch.starred === 'boolean') r.starred = patch.starred;
    await persist();
    return r;
  });
}

export async function deleteQuick(ids: string[] | 'unstarred'): Promise<number> {
  return lock.run('q', async () => {
    const del = ids === 'unstarred' ? items.filter((r) => !r.starred) : items.filter((r) => ids.includes(r.id));
    for (const r of del) {
      await removePath(quickAudioPath(r));
      await removePath(quickAudioPath(r).replace(/\.wav$/, '.mp3'));
    }
    const set = new Set(del.map((r) => r.id));
    items = items.filter((r) => !set.has(r.id));
    await persist();
    return del.length;
  });
}

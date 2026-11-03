import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return fallback;
    throw new Error(`读取 ${file} 失败：${e?.message ?? e}`);
  }
}

/** 原子写入：先写临时文件再 rename，避免写一半断电损坏 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function removePath(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** 跨设备也能用的移动 */
export async function movePath(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  try {
    await fsp.rename(from, to);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fsp.cp(from, to, { recursive: true });
    await removePath(from);
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

export async function fileSize(p: string): Promise<number> {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

/** 确保 child 在 root 之内（防路径穿越） */
export function within(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || fallback).slice(0, 120);
}

/** 按 key 串行执行的异步锁（同一个音色/项目的写入不会互相覆盖） */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

export function syncExists(p: string): boolean {
  return fs.existsSync(p);
}

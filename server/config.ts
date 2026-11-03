import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const config = {
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data')),
  webDir: path.resolve(process.env.WEB_DIR ?? path.join(ROOT, 'dist', 'web')),
  accessToken: process.env.ACCESS_TOKEN ?? '',
  ffmpegPath: process.env.FFMPEG_PATH ?? '',
  version: '0.1.0',
};

export const paths = {
  settings: () => path.join(config.dataDir, 'settings.json'),
  prompts: () => path.join(config.dataDir, 'prompts'),
  voices: () => path.join(config.dataDir, 'voices'),
  voice: (id: string) => path.join(config.dataDir, 'voices', id),
  presets: () => path.join(config.dataDir, 'presets'),
  projects: () => path.join(config.dataDir, 'projects'),
  project: (id: string) => path.join(config.dataDir, 'projects', id),
  quick: () => path.join(config.dataDir, 'quick'),
  uploads: () => path.join(config.dataDir, 'uploads'),
  trash: (kind: 'voices' | 'projects') => path.join(config.dataDir, 'trash', kind),
};

/** 把数据目录内的绝对路径转成 /files/... URL */
export function fileUrl(abs: string): string {
  const rel = path.relative(config.dataDir, abs).split(path.sep).map(encodeURIComponent).join('/');
  return `/files/${rel}`;
}

// 入口：加载数据 → 启动 HTTP 服务
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, paths } from './config.ts';
import { HttpError, makeCtx, parseCookies, Router, sendError, sendFile, sendJson, STREAMED } from './http.ts';
import { registerRoutes, serveDataFile } from './routes.ts';
import { loadSettings } from './store/settings.ts';
import { loadBuiltinPreviews, loadVoices } from './store/voices.ts';
import { loadQuick } from './store/quick.ts';
import { loadProjects } from './store/projects.ts';
import { cleanupUploads } from './store/uploads.ts';
import { ensureDir } from './util/fs.ts';
import { ffmpegStatus } from './audio/ffmpeg.ts';

const router = new Router();
registerRoutes(router);

const COOKIE = 'mimotts_token';

function tokenOk(req: http.IncomingMessage): boolean {
  if (!config.accessToken) return true;
  const got = parseCookies(req)[COOKIE] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(config.accessToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const abs = path.resolve(config.webDir, rel);
  const inside = path.relative(config.webDir, abs);
  if (!inside.startsWith('..') && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    await sendFile(req, res, abs, { cache: rel === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    return;
  }
  const index = path.join(config.webDir, 'index.html');
  if (!fs.existsSync(index)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端还没有构建：请先运行 npm run build');
    return;
  }
  await sendFile(req, res, index, { cache: 'no-cache' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname === '/api/login' && req.method === 'POST') {
      const ctx = makeCtx(req, res, url, {});
      const { token } = await ctx.json<{ token?: string }>();
      if (config.accessToken && token !== config.accessToken) throw new HttpError(401, '口令不正确');
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token ?? '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      sendJson(res, 200, { ok: true });
      return;
    }
    const isApi = pathname.startsWith('/api/');
    const isFile = pathname.startsWith('/files/');
    if ((isApi || isFile) && pathname !== '/api/health' && !tokenOk(req)) throw new HttpError(401, '需要访问口令', 'auth');
    if (isFile) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的方法');
      await serveDataFile(makeCtx(req, res, url, {}));
      return;
    }
    if (isApi) {
      const m = router.match(req.method ?? 'GET', pathname);
      if (m === 'method') throw new HttpError(405, '不支持的方法');
      if (!m) throw new HttpError(404, '接口不存在');
      const out = await m.handler(makeCtx(req, res, url, m.params));
      if (out === STREAMED || res.headersSent) return;
      sendJson(res, 200, out ?? { ok: true });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的方法');
    await serveStatic(req, res, pathname);
  } catch (e) {
    sendError(res, e);
  }
});

async function main(): Promise<void> {
  for (const d of [config.dataDir, paths.voices(), paths.projects(), paths.quick(), paths.uploads(), paths.presets(), paths.prompts()]) await ensureDir(d);
  await loadSettings();
  await loadVoices();
  await loadBuiltinPreviews();
  await loadQuick();
  await loadProjects();
  cleanupUploads().catch(() => undefined);
  setInterval(() => cleanupUploads().catch(() => undefined), 3600 * 1000).unref();
  const f = ffmpegStatus();
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.listen(config.port, config.host, () => {
    console.log(`MiMo TTS 工作台已启动：http://localhost:${config.port}`);
    console.log(`数据目录：${config.dataDir}`);
    console.log(f.ok ? `ffmpeg：${f.path}（${f.version}${f.denoise ? '，支持降噪' : ''}${f.mp3 ? '，支持 MP3' : ''}）` : 'ffmpeg：未检测到（参考音频处理与 MP3 导出不可用）');
    if (config.accessToken) console.log('已启用访问口令（ACCESS_TOKEN）');
  });
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}

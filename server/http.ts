// 极简 HTTP 框架：路由、JSON/原始请求体、错误处理、带 Range 的静态文件
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = '未找到') => new HttpError(404, msg);

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  json<T = any>(): Promise<T>;
  raw(limitBytes?: number): Promise<Buffer>;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export const STREAMED = Symbol('streamed');

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null | 'method' {
    const segs = pathname.split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = segs[i];
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method) { methodMismatch = true; continue; }
      return { handler: r.handler, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function makeCtx(req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: Record<string, string>): Ctx {
  let jsonCache: any;
  return {
    req, res, url, params, query: url.searchParams,
    async json() {
      if (jsonCache !== undefined) return jsonCache;
      const buf = await readBody(req, 64 * 1024 * 1024);
      if (!buf.length) return (jsonCache = {});
      try { jsonCache = JSON.parse(buf.toString('utf8')); } catch { throw bad('请求体不是合法 JSON'); }
      return jsonCache;
    },
    raw(limit = 512 * 1024 * 1024) { return readBody(req, limit); },
  };
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendError(res: http.ServerResponse, e: unknown): void {
  const status = e instanceof HttpError ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  if (status >= 500) console.error('[error]', e);
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  sendJson(res, status, { error: message, code: e instanceof HttpError ? e.code : undefined });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.map': 'application/json',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 发送文件（支持 Range，音频可拖动进度） */
export async function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  opts: { cache?: string; downloadName?: string } = {},
): Promise<void> {
  let st: fs.Stats;
  try { st = await fsp.stat(file); } catch { throw notFound('文件不存在'); }
  if (!st.isFile()) throw notFound('文件不存在');
  const headers: Record<string, string | number> = {
    'Content-Type': mimeOf(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (opts.downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('error', reject);
    res.on('close', () => resolve());
    s.pipe(res);
  });
}

export function sendBuffer(res: http.ServerResponse, buf: Buffer, type: string, downloadName?: string): void {
  const headers: Record<string, string | number> = { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  res.writeHead(200, headers);
  res.end(buf);
}

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

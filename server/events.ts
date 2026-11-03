// Server-Sent Events：把任务进度与数据变更推给前端
import type http from 'node:http';
import type { ChangeEvent, JobInfo } from '../shared/types.ts';

const clients = new Set<http.ServerResponse>();

export function addClient(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function send(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch { clients.delete(c); }
  }
}

export function emitJob(job: JobInfo): void { send('job', job); }
export function emitChange(ev: ChangeEvent): void { send('change', ev); }

setInterval(() => {
  for (const c of clients) {
    try { c.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 25000).unref();

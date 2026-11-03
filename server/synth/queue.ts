// 任务队列：并发上限、取消、进度与结果推送
import type { JobInfo, JobKind } from '../../shared/types.ts';
import { newId } from '../util/id.ts';
import { emitJob } from '../events.ts';

export interface JobContext {
  signal: AbortSignal;
  progress(done: number, total: number, note?: string): void;
  retrying(attempt: number, message: string): void;
}

interface Entry {
  info: JobInfo;
  run: (ctx: JobContext) => Promise<unknown>;
  ctrl: AbortController;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class JobQueue {
  private queued: Entry[] = [];
  private running = new Map<string, Entry>();
  private finished: JobInfo[] = [];
  private concurrency: () => number;

  constructor(concurrency: () => number) {
    this.concurrency = concurrency;
  }

  add<T>(
    meta: { kind: JobKind; label: string; projectId?: string; segmentId?: string; voiceId?: string; group?: string },
    run: (ctx: JobContext) => Promise<T>,
  ): { job: JobInfo; done: Promise<T> } {
    const info: JobInfo = { id: newId('j'), status: 'queued', createdAt: Date.now(), attempt: 1, ...meta };
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<T>((res, rej) => { resolve = res as any; reject = rej; });
    done.catch(() => undefined);
    this.queued.push({ info, run: run as any, ctrl: new AbortController(), resolve, reject });
    emitJob(info);
    queueMicrotask(() => this.pump());
    return { job: info, done };
  }

  private pump(): void {
    while (this.running.size < Math.max(1, this.concurrency()) && this.queued.length) {
      const e = this.queued.shift()!;
      this.start(e);
    }
  }

  private start(e: Entry): void {
    e.info.status = 'running';
    e.info.startedAt = Date.now();
    this.running.set(e.info.id, e);
    emitJob(e.info);
    const ctx: JobContext = {
      signal: e.ctrl.signal,
      progress: (done, total, note) => { e.info.progress = { done, total, note }; if (e.info.status === 'retrying') e.info.status = 'running'; emitJob(e.info); },
      retrying: (attempt, message) => { e.info.status = 'retrying'; e.info.attempt = attempt + 1; e.info.error = message; emitJob(e.info); },
    };
    e.run(ctx).then(
      (result) => {
        e.info.status = 'done';
        e.info.error = undefined;
        e.info.result = result && typeof result === 'object' && 'jobResult' in (result as any) ? (result as any).jobResult : undefined;
        this.finish(e);
        e.resolve(result);
      },
      (err) => {
        e.info.status = e.ctrl.signal.aborted ? 'canceled' : 'failed';
        e.info.error = e.ctrl.signal.aborted ? '已取消' : String(err?.message ?? err);
        this.finish(e);
        e.reject(err);
      },
    );
  }

  private finish(e: Entry): void {
    e.info.finishedAt = Date.now();
    this.running.delete(e.info.id);
    this.finished.unshift(e.info);
    if (this.finished.length > 300) this.finished.length = 300;
    emitJob(e.info);
    this.pump();
  }

  cancel(id: string): boolean {
    const qi = this.queued.findIndex((e) => e.info.id === id);
    if (qi >= 0) {
      const [e] = this.queued.splice(qi, 1);
      e.ctrl.abort();
      e.info.status = 'canceled';
      e.info.error = '已取消';
      e.info.finishedAt = Date.now();
      this.finished.unshift(e.info);
      emitJob(e.info);
      e.reject(new Error('已取消'));
      return true;
    }
    const r = this.running.get(id);
    if (r) { r.ctrl.abort(); return true; }
    return false;
  }

  cancelWhere(pred: (j: JobInfo) => boolean): number {
    const ids = [...this.queued, ...this.running.values()].map((e) => e.info).filter(pred).map((j) => j.id);
    ids.forEach((id) => this.cancel(id));
    return ids.length;
  }

  list(): JobInfo[] {
    return [...[...this.running.values()].map((e) => e.info), ...this.queued.map((e) => e.info), ...this.finished.slice(0, 100)];
  }

  active(): JobInfo[] {
    return [...[...this.running.values()].map((e) => e.info), ...this.queued.map((e) => e.info)];
  }

  isActive(pred: (j: JobInfo) => boolean): boolean {
    return this.active().some(pred);
  }

  /** 设置变了（比如并发数）之后调用 */
  kick(): void { this.pump(); }
}

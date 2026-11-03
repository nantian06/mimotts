// 请求封装
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorized: (() => void) | null = null;
export function onUnauthorized(fn: () => void) { unauthorized = fn; }

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && data?.code === 'auth') unauthorized?.();
    throw new ApiError(data?.error ?? (typeof data === 'string' && data ? data : `请求失败（${res.status}）`), res.status, data?.code);
  }
  return data as T;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('连不上工作台服务，请确认它还在运行', 0);
  }
  return handle<T>(res);
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T = any>(url: string) => api<T>('DELETE', url);

export async function uploadRaw<T = any>(url: string, data: Blob, type?: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': type || data.type || 'application/octet-stream' }, body: data, credentials: 'same-origin' });
  return handle<T>(res);
}

/** 下载接口返回的二进制（POST） */
export async function downloadPost(url: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) await handle(res);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  saveBlob(blob, m ? decodeURIComponent(m[1]) : fallbackName);
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 用带 download 属性的链接触发下载（同源时浏览器直接用这个文件名） */
export function startDownload(url: string, name?: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name ?? '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 下载数据文件：?download= 让服务端带上 Content-Disposition；mp3 = 服务端转码 */
export function downloadFile(url: string, name: string, mp3 = false) {
  startDownload(downloadUrl(url, name, mp3), mp3 ? name.replace(/\.wav$/i, '') + '.mp3' : name);
}

export function downloadUrl(url: string, name: string, mp3 = false): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}download=${encodeURIComponent(name)}${mp3 ? '&format=mp3' : ''}`;
}

import { useSyncExternalStore } from 'react';

function current(): string {
  const h = location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/quick';
}

export function useRoute(): { path: string; parts: string[]; query: URLSearchParams } {
  const path = useSyncExternalStore((cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); }, current);
  const [p, q = ''] = path.split('?');
  return { path: p, parts: p.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

export function navigate(path: string) {
  if (current() !== path) location.hash = path;
}

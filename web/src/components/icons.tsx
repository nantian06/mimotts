// 线性图标（24px 网格，1.75 描边）
import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  play: 'M7 5.5v13l11-6.5z',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  stop: 'M7 7h10v10H7z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
  wave: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0',
  library: 'M5 4v16M9 4v16M13 5l4 15M19 4v0',
  script: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  restore: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v8',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M8 10l4 4 4-4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  scissors: 'M6 6a2.5 2.5 0 1 0 0 .1M6 18a2.5 2.5 0 1 0 0 .1M8 7.5l12 9M8 16.5l12-9',
  merge: 'M7 4v6a5 5 0 0 0 5 5h5M17 4v16M14 12l3 3-3 3',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  queue: 'M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20a8 8 0 0 1 16 0',
  users: 'M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 5.5a3 3 0 0 1 0 6M18 14.5a5.5 5.5 0 0 1 3.5 5.5',
  import: 'M12 3v12M7 10l5 5 5-5M4 17v3h16v-3',
  export: 'M12 15V3M7 8l5-5 5 5M4 17v3h16v-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, style, className }: { name: IconName | string; size?: number; style?: CSSProperties; className?: string }) {
  const d = P[name] ?? P.info;
  const filled = name === 'play' || name === 'pause' || name === 'stop';
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={style}
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

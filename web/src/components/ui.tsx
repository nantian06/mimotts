// 通用组件
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type KeyboardEvent, type TextareaHTMLAttributes, type Ref, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import type { VoiceKind } from '../../../shared/types.ts';
import { KIND_LABELS } from '../../../shared/presets.ts';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'plain' | 'danger' | 'quiet';
  icon?: string;
  busy?: boolean;
  size?: 'sm' | 'md';
};

export function Button({ variant = 'plain', icon, busy, size = 'md', children, className = '', disabled, ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, active, className = '', size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button type="button" className={`icon-btn icon-btn-${size} ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 15 : 17} />
    </button>
  );
}

export function Spinner({ size = 15 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="处理中" />;
}

export function Field({ label, hint, children, inline, error }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean; error?: string }) {
  return (
    <label className={`field ${inline ? 'field-inline' : ''}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
      <span className="toggle-text">{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md', ariaLabel }: { value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; size?: 'sm' | 'md'; ariaLabel?: string }) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} disabled={o.disabled}
          className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function KindBadge({ kind, mode, builtin }: { kind: VoiceKind; mode?: string; builtin?: boolean }) {
  const label = builtin ? '官方' : kind === 'design' && mode === 'clone' ? '设计·已固化' : KIND_LABELS[kind];
  return <span className={`kind-badge kind-${kind}`}>{label}</span>;
}

export function Empty({ icon = 'wave', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Notice({ kind = 'info', children, action }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const icon = kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : kind === 'ok' ? 'check' : 'info';
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <Icon name={icon} size={16} />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, width = 560, className = '' }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not(.modal-close)');
    first?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('has-modal');
    return () => {
      window.removeEventListener('keydown', onKey);
      if (!document.querySelector('.modal-backdrop + .modal-backdrop')) document.body.classList.remove('has-modal');
      prev?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={{ width: `min(${width}px, calc(100vw - 32px))` }} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="关闭" className="modal-close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; ok: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = (title: string, body: ReactNode, ok = '确定', danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, ok, danger, resolve }));
  const node = state ? (
    <Modal title={state.title} width={440} onClose={() => { state.resolve(false); setState(null); }}
      footer={<>
        <Button variant="ghost" onClick={() => { state.resolve(false); setState(null); }}>取消</Button>
        <Button variant={state.danger ? 'danger' : 'primary'} data-autofocus onClick={() => { state.resolve(true); setState(null); }}>{state.ok}</Button>
      </>}>
      <div className="confirm-body">{state.body}</div>
    </Modal>
  ) : null;
  return { confirm, node };
}

/** 下拉菜单（点击外部关闭，方向键可选） */
export function Menu({ trigger, items, align = 'end' }: {
  trigger: (open: () => void, isOpen: boolean) => ReactNode;
  items: ({ label: ReactNode; icon?: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | 'sep' | null | false)[];
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, right: window.innerWidth - r.right });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !(document.querySelector('.menu-pop')?.contains(t))) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const scroll = () => setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  };
  const list = items.filter(Boolean) as Exclude<(typeof items)[number], null | false>[];
  return (
    <span className="menu-wrap" ref={wrap}>
      {trigger(() => setOpen((v) => !v), open)}
      {open && pos && createPortal(
        <div className="menu-pop" role="menu" onKeyDown={onKey}
          style={{ top: Math.min(pos.top, window.innerHeight - 40), ...(align === 'end' ? { right: pos.right } : { left: pos.left }) }}
          ref={(el) => { if (el) { const r = el.getBoundingClientRect(); if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, pos.top - r.height - 40)}px`; el.querySelector<HTMLButtonElement>('button')?.focus(); } }}>
          {list.map((it, i) => it === 'sep' ? <hr key={i} /> : (
            <button key={i} type="button" role="menuitem" disabled={it.disabled} className={it.danger ? 'is-danger' : ''} title={it.hint}
              onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.icon && <Icon name={it.icon} size={15} />}<span>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}

export function TagInput({ value, onChange, suggestions = [], placeholder = '输入后回车' }: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = (t: string) => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setText('');
  };
  const rest = suggestions.filter((s) => !value.includes(s) && (!text || s.includes(text))).slice(0, 8);
  return (
    <div className="tag-input">
      <div className="tag-input-box">
        {value.map((t) => (
          <span className="chip" key={t}>{t}<button type="button" aria-label={`删除标签 ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}><Icon name="close" size={12} /></button></span>
        ))}
        <input value={text} placeholder={value.length ? '' : placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && text.trim()) { e.preventDefault(); add(text); }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)} />
      </div>
      {rest.length > 0 && (
        <div className="tag-suggest">{rest.map((s) => <button type="button" key={s} className="chip chip-ghost" onMouseDown={(e) => { e.preventDefault(); add(s); }}>{s}</button>)}</div>
      )}
    </div>
  );
}

/** 自动增高的文本框 */
export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; innerRef?: Ref<HTMLTextAreaElement> }) {
  const { minRows = 2, innerRef, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [props.value]);
  return (
    <textarea rows={minRows} {...rest} ref={(el) => {
      ref.current = el;
      if (typeof innerRef === 'function') innerRef(el);
      else if (innerRef) (innerRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }} />
  );
}

export function GradeBadge({ grade }: { grade?: 'good' | 'ok' | 'poor' }) {
  if (!grade) return null;
  const label = grade === 'good' ? '良好' : grade === 'ok' ? '可用' : '较差';
  return <span className={`grade grade-${grade}`}>{label}</span>;
}

export function Progress({ value, max = 1, tone }: { value: number; max?: number; tone?: 'ok' | 'warn' | 'error' }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return <div className={`progress ${tone ? `progress-${tone}` : ''}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>;
}

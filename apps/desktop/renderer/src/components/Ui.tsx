import { LoaderCircle, Save, X } from 'lucide-react';
import { Children, cloneElement, isValidElement, useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

export function IconButton({ title, children, onClick, active = false, disabled = false, checked, label }: { title: string; children: ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean; checked?: boolean; label?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''}`} title={title} aria-label={label || title} role={checked === undefined ? undefined : 'switch'} aria-checked={checked} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} disabled={disabled}><span /></button>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const controls = Children.map(children, (child) => {
    if (!isValidElement(child) || !['input', 'textarea', 'select'].includes(String(child.type))) return child;
    const element = child as ReactElement<Record<string, unknown>>;
    return cloneElement(element, { 'aria-label': element.props['aria-label'] || label });
  });
  return <label className="field"><span className="field-label">{label}</span>{controls}{hint && <small>{hint}</small>}</label>;
}
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="setting-row"><span>{label}</span><div>{children}</div></div>;
}
export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="header-actions">{children}</div></header>;
}
export function SaveButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return <button type="button" className="primary" onClick={onClick} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存</button>;
}
export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.querySelector<HTMLElement>('input:not([type=file]),textarea,select,button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={onClose}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
    if (e.key === 'Escape') close.current();
    if (e.key !== 'Tab') return;
    const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]') || [])].filter((node) => node.getClientRects().length > 0);
    const first = nodes[0], last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}><header><h2>{title}</h2><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>{children}{footer && <footer className="dialog-footer">{footer}</footer>}</section></div>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty-state">{children}</div>; }

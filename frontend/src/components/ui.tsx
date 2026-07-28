import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Card({ title, children }: { title?: string; children: ReactNode; }) {
    return (
        <section className="card">
            {title ? <h3>{title}</h3> : null}
            {children}
        </section>
    );
}

export function Field({ label, children }: { label: string; children: ReactNode; }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
        </label>
    );
}

export function Check(
    { label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void; },
) {
    return (
        <label className="check">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
    );
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'err' | 'accent'; children: ReactNode; }) {
    return <span className={tone ? `badge ${tone}` : 'badge'}>{children}</span>;
}

/**
 * A 503 means the capability's service is not running, which is a normal state for this
 * stack rather than a fault — so it is reported with the command that fixes it instead of
 * as an error.
 */
export function ErrorNotice({ error }: { error: unknown; }) {
    if (error instanceof ApiError && error.isUnconfigured) {
        return (
            <div className="notice warn">
                <strong>Not configured.</strong> {error.message}
            </div>
        );
    }

    return <div className="notice err">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Empty({ children }: { children: ReactNode; }) {
    return <p className="empty">{children}</p>;
}

export function bytes(n?: number): string {
    if (!n) return '—';
    return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

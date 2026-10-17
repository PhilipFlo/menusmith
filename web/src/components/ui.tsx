import type { ReactNode } from 'react';
import { modelName, modelTier } from '../format.ts';

export type StepState = 'pending' | 'running' | 'done' | 'fail' | 'skip';

export function StateIcon({ state, size = 18 }: { state: StepState; size?: number }) {
  const label = { pending: 'Pending', running: 'Running', done: 'Done', fail: 'Failed', skip: 'Skipped' }[state];
  return (
    <span className={`state-icon state-${state}`} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
        {state === 'pending' && <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2.5" />}
        {state === 'running' && (
          <>
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="spin" />
          </>
        )}
        {state === 'done' && (
          <>
            <circle cx="10" cy="10" r="8" fill="currentColor" />
            <path d="M6.2 10.3l2.4 2.4 5.2-5.4" fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {state === 'fail' && (
          <>
            <circle cx="10" cy="10" r="8" fill="currentColor" />
            <path d="M7 7l6 6M13 7l-6 6" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
        {state === 'skip' && (
          <>
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M6.5 10h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2 className="panel-title">{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? (
        <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
          <path d="M8 26h28c2 0 3.5 1.5 3.5 3.5S38 33 36 33h-4l-3 5h4v3H15v-3h4l-3-5h-2c-3.5 0-6-2.5-6-7z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M22 8v8M26 8v8M30 8v8M22 16h8v1.5a4 4 0 0 1-4 4 4 4 0 0 1-4-4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'accent' | 'pass' | 'fail' | 'warn' | 'info' }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value num">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'pass' | 'fail' | 'warn' | 'info'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ModelChip({ model }: { model: string }) {
  return (
    <span className={`model-chip tier-${modelTier(model)}`} title={model}>
      {modelName(model)}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <StateIcon state="running" size={16} />
      <span>{label}</span>
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="error-note" role="alert">
      <StateIcon state="fail" size={16} />
      <div>{children}</div>
    </div>
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  wordpress: 'WordPress',
  squarespace: 'Squarespace',
  wix: 'Wix',
  webflow: 'Webflow',
  shopify: 'Shopify',
  favrit: 'Favrit',
  unknown: 'Custom',
};

export function PlatformBadge({ platform }: { platform?: string | null }) {
  const p = platform || 'unknown';
  return <span className={`platform platform-${p}`}>{PLATFORM_LABEL[p] ?? p}</span>;
}

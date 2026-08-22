import type { ReactNode } from 'react';
import type { MemoryKind } from '../lib/types.js';
import { KIND_LABELS, percent } from '../lib/format.js';

export function Panel({
  title,
  action,
  children,
  footer,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="panel">
      {title !== undefined && (
        <header className="panel__head">
          <h2 className="panel__title">{title}</h2>
          {action && <div className="push row row--tight">{action}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
      {footer && <footer className="panel__foot">{footer}</footer>}
    </section>
  );
}

export function KindBadge({ kind }: { kind: MemoryKind }) {
  return <span className={`badge badge--${kind}`}>{KIND_LABELS[kind]}</span>;
}

/**
 * A horizontal bar for a 0-1 value.
 *
 * `title` carries the exact figure so the precise number is always one hover
 * away, and the bar itself is marked up as a progressbar for screen readers.
 */
export function Meter({
  value,
  color,
  label,
}: {
  value: number;
  color?: string;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      title={`${label ? `${label}: ` : ''}${percent(clamped)}`}
    >
      <div
        className="meter__fill"
        style={{ width: `${clamped * 100}%`, ...(color ? { background: color } : {}) }}
      />
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="stat__value">{value}</span>
      {note && <span className="stat__note">{note}</span>}
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

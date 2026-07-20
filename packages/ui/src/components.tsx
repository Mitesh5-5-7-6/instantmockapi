/**
 * Shared components (doc 12 §5). Styling comes from `@instantmockapi/ui/styles.css`;
 * these components only compose class names, so the design is re-skinnable by
 * swapping tokens without touching component code.
 */

import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Button ── */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      className={cx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className)}
      {...rest}
    />
  );
}

/* ── StatusChip ── */

export interface StatusChipProps {
  status: string;
  label?: string;
}

export function StatusChip({ status, label }: StatusChipProps) {
  return <span className={cx('ui-chip', `ui-chip--${status}`)}>{label ?? status}</span>;
}

/* ── Card ── */

export interface CardProps {
  children: ReactNode;
  interactive?: boolean;
  className?: string;
}

export function Card({ children, interactive, className }: CardProps) {
  return (
    <div className={cx('ui-card', interactive && 'ui-card--interactive', className)}>
      {children}
    </div>
  );
}

/* ── Form controls ── */

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input className={cx('ui-input', className)} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select className={cx('ui-select', className)} {...rest} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea className={cx('ui-textarea', className)} {...rest} />;
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
  return (
    <label className="ui-checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="ui-label">{label}</span>
      {children}
    </div>
  );
}

/* ── CodeBlock ── */

export function CodeBlock({ code, maxHeight }: { code: string; maxHeight?: number }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="ui-codeblock" style={maxHeight ? { maxHeight } : undefined}>
      <div className="ui-codeblock__copy">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

/* ── Modal ── */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  if (!open) {
    return null;
  }
  return (
    <div
      className="ui-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="ui-modal" role="dialog" aria-label={title}>
        <div className="ui-row ui-row--between" style={{ marginBottom: 'var(--space-4)' }}>
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Worker board (doc 12 §6) ── */

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div
      className="ui-progress"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="ui-progress__fill" style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

export interface WorkerRowProps {
  worker: string;
  artifactType: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error?: string | null;
  waitingOn?: string;
  action?: ReactNode;
}

export function WorkerRow({
  worker,
  artifactType,
  status,
  error,
  waitingOn,
  action,
}: WorkerRowProps) {
  return (
    <div className={cx('ui-worker-row', status === 'running' && 'ui-worker-row--generating')}>
      <span className="ui-worker-row__id">{worker}</span>
      <span className="ui-worker-row__artifact">{artifactType}</span>
      {waitingOn && status === 'queued' ? (
        <span className="ui-meta">Waiting on {waitingOn}</span>
      ) : null}
      {error ? <span className="ui-worker-row__error">{error}</span> : null}
      {action}
      <StatusChip status={status} label={status === 'running' ? 'generating' : status} />
    </div>
  );
}

/* ── CountdownBadge ── */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function formatRemaining(expiresAt: string | Date): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / HOUR_MS);
  if (days > 0) {
    return `${days}d ${hours}h left`;
  }
  const minutes = Math.floor((remaining % HOUR_MS) / 60_000);
  return `${hours}h ${minutes}m left`;
}

export function CountdownBadge({ expiresAt }: { expiresAt: string | null }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!expiresAt) {
    return null;
  }
  const remaining = new Date(expiresAt).getTime() - Date.now();
  const warning = remaining < DAY_MS;
  return (
    <span className={cx('ui-countdown', warning && 'ui-countdown--warning')}>
      {formatRemaining(expiresAt)}
    </span>
  );
}

/* ── Empty state ── */

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      <h3 style={{ marginBottom: 'var(--space-2)' }}>{title}</h3>
      {children}
    </div>
  );
}

/* ── SchemaTree (doc 12 §5) ── */

export interface SchemaTreeField {
  name: string;
  type: string;
  required: boolean;
  children: SchemaTreeField[];
  validation?: Record<string, unknown>;
}

export interface SchemaTreeEntity {
  name: string;
  fields: SchemaTreeField[];
}

function ruleSummary(validation: Record<string, unknown> | undefined): string {
  if (!validation) {
    return '';
  }
  return Object.entries(validation)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}:${JSON.stringify(value)}`))
    .join(' ');
}

function TreeField({ field }: { field: SchemaTreeField }) {
  const rules = ruleSummary(field.validation);
  return (
    <div>
      <div className="ui-tree__field">
        <span className="ui-tree__field-name">
          {field.name}
          {field.required ? '' : '?'}
        </span>
        <span className="ui-tree__type">{field.type}</span>
        {rules ? <span className="ui-tree__rule">{rules}</span> : null}
      </div>
      {field.children.length > 0 ? (
        <div className="ui-tree__nested">
          {field.children.map((child) => (
            <TreeField key={child.name} field={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SchemaTree({ entities }: { entities: SchemaTreeEntity[] }) {
  return (
    <div className="ui-tree">
      {entities.map((entity) => (
        <div key={entity.name}>
          <div className="ui-tree__entity">{entity.name}</div>
          {entity.fields.map((field) => (
            <TreeField key={field.name} field={field} />
          ))}
        </div>
      ))}
    </div>
  );
}

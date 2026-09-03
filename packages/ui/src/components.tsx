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
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName, type IconSize } from './icons.js';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Button ── */

/**
 * Only `primary` is filled.
 *
 * Everything else is transparent with a grey hover, following shadcn's
 * `outline`/`ghost` treatment. `primary` is for the actions that commit
 * something — Generate, Create, Publish, Save, Confirm — and is meant to be the
 * only filled thing on a screen; `accent` is the middle ground, a grey surface
 * with a green label for an accent-flavoured action that should not be a fill.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'ghost' | 'danger';

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

export interface FieldProps {
  label: string;
  children: ReactNode;
  /**
   * The id of the control this labels.
   *
   * When given, the label is a real `<label htmlFor>` — which is what lets a
   * screen reader announce the field and what makes clicking the text focus the
   * input. Without it the text is only visually adjacent, so a placeholder ends
   * up doing the labelling and disappears on the first keystroke (WCAG 3.3.2).
   *
   * Optional so the existing call sites keep working; pass it on anything a
   * person has to fill in.
   */
  htmlFor?: string;
  /** Small explanatory text under the label — units, formats, constraints. */
  hint?: ReactNode;
  /** Validation message. Rendered with role="alert" so it is announced. */
  error?: string | null;
}

export function Field({ label, children, htmlFor, hint, error }: FieldProps) {
  return (
    <div>
      {htmlFor !== undefined ? (
        <label className="ui-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ui-label">{label}</span>
      )}
      {children}
      {hint !== undefined && hint !== null ? <p className="ui-field__hint">{hint}</p> : null}
      {error !== undefined && error !== null && error !== '' ? (
        <p className="ui-error" role="alert">
          {error}
        </p>
      ) : null}
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

/* ── CodeViewer ── */

/**
 * Multi-file code viewer: file tabs (when a bundle has >1 file), a filename
 * label, and the active file's contents in a copy-enabled CodeBlock. Single-
 * file artifacts collapse to a label + one block. Syntax highlighting is out
 * of scope for V1 — monospace + one-tap copy per doc 11 §11.
 */
export function CodeViewer({
  files,
  onDownload,
  downloadLabel = 'Download',
}: {
  files: Record<string, string> | undefined;
  /**
   * Receives the file the viewer is currently showing.
   *
   * Both arguments are load-bearing: a bundle artifact holds several files, so a
   * download handler that isn't told which tab is active cannot save the right
   * one. Wiring this straight to `onClick` would instead hand the callback
   * React's MouseEvent as its first argument.
   */
  onDownload?: (filename: string, code: string) => void;
  downloadLabel?: string;
}) {
  const names = files ? Object.keys(files) : [];
  const [active, setActive] = useState(names[0] ?? '');
  const key = names.join('|');
  useEffect(() => {
    setActive(names[0] ?? '');
  }, [key]);

  if (!files || names.length === 0) {
    return null;
  }

  return (
    <div className="ui-stack" style={{ gap: 'var(--space-3)' }}>
      <div className="ui-row ui-row--between" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {names.length > 1 ? (
          <div className="ui-row" style={{ flexWrap: 'wrap', gap: 'var(--space-1)' }}>
            {names.map((name) => (
              <Button
                key={name}
                variant={name === active ? 'secondary' : 'ghost'}
                size="sm"
                aria-selected={name === active}
                onClick={() => setActive(name)}
              >
                {name}
              </Button>
            ))}
          </div>
        ) : (
          <span className="ui-mono ui-meta">{names[0]}</span>
        )}
        {onDownload ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDownload(active, files[active] ?? '')}
          >
            {downloadLabel}
          </Button>
        ) : null}
      </div>
      <CodeBlock code={active ? (files[active] ?? '') : ''} maxHeight={520} />
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
            <Icon name="x" size={16} />
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

/* ── FlowScope ── */

export type Flow = 'project' | 'single';

/**
 * Re-points the accent token for one creation flow.
 *
 * A wrapper rather than a prop on every control: the whole palette hangs off
 * `--accent`, so scoping it here recolours buttons, tabs, focus rings, the
 * stepper and the diagram at once, and a new control inherits the flow colour
 * without being told about it.
 */
export function FlowScope({ flow, children }: { flow: Flow; children: ReactNode }) {
  return (
    <div data-flow={flow} className="ui-stack" style={{ gap: 'var(--space-6)' }}>
      {children}
    </div>
  );
}

/* ── Stepper ── */

export interface StepperProps {
  steps: string[];
  /** 1-based index of the step being shown. */
  current: number;
  /**
   * Jump to an earlier step. Only completed steps are offered — moving forward
   * has to go through each step's own validation, so a stepper shortcut would
   * skip the checks the Next button performs.
   */
  onGoTo?: (step: number) => void;
}

export function Stepper({ steps, current, onGoTo }: StepperProps) {
  return (
    <ol className="ui-stepper">
      {steps.map((label, index) => {
        const number = index + 1;
        const done = number < current;
        const active = number === current;
        const clickable = done && onGoTo !== undefined;
        const className = cx(
          'ui-stepper__step',
          done && 'ui-stepper__step--done',
          clickable && 'ui-stepper__step--clickable',
        );
        const body = (
          <>
            <span className="ui-stepper__num">
              {done ? <Icon name="check" size={14} /> : number}
            </span>
            <span>{label}</span>
          </>
        );
        return (
          <li key={label} style={{ listStyle: 'none' }}>
            {clickable ? (
              <button
                type="button"
                className={className}
                onClick={() => onGoTo(number)}
                aria-current={active ? 'step' : undefined}
              >
                {body}
              </button>
            ) : (
              <div className={className} aria-current={active ? 'step' : undefined}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ── Note ── */

/** An inline explanation or caution attached to a control. */
export function Note({
  children,
  variant = 'info',
}: {
  children: ReactNode;
  variant?: 'info' | 'warning';
}) {
  return (
    <p className={cx('ui-note', variant === 'warning' && 'ui-note--warning')} role="note">
      {children}
    </p>
  );
}

/* ── Badge ── */

/** Small accent-coloured label, e.g. the `API` marker on an entity row. */
export function Badge({ children }: { children: ReactNode }) {
  return <span className="ui-badge">{children}</span>;
}

/* ── MethodBadge ── */

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Colour-coded HTTP method label for an endpoint row. */
export function MethodBadge({ method }: { method: ApiMethod }) {
  return <span className={`ui-method ui-method--${method}`}>{method}</span>;
}

/* ── Stat ── */

export interface StatProps {
  value: ReactNode;
  label: string;
  /**
   * Promotes the plain figure to a dashboard tile: larger value, an icon in the
   * top-right corner, room for a delta line.
   *
   * The tile treatment is gated on this prop rather than applied unconditionally,
   * so the four existing call sites on the Ready screen — which pass only
   * `value` and `label` — keep rendering byte-identically. A parallel
   * `StatCard` component would have guaranteed the two drifted apart instead.
   */
  icon?: IconName;
  tone?: Tone;
  /**
   * Secondary line under the figure.
   *
   * `direction` is presentational only: the caller decides whether "fewer
   * requests" is good news. `null` renders nothing, which is what a percentage
   * with no comparable previous window should produce — never "+0%" or "+∞%".
   */
  delta?: { text: string; direction?: 'up' | 'down' } | null;
  /**
   * Qualifying text under the figure — what it covers, or why it is absent.
   *
   * Distinct from `delta`, which is a comparison. This carries the caveats that
   * keep a figure honest: "timed for 412 of 5.2K requests", "no requests yet".
   * Without somewhere to put those, a mean taken over a subset of rows renders
   * as though it covered all of them.
   */
  hint?: string;
}

/** A single headline figure, e.g. "12 · Total Entities", or a dashboard tile. */
export function Stat({ value, label, icon, tone = 'accent', delta, hint }: StatProps) {
  const isTile = icon !== undefined;

  return (
    <div className={cx('ui-stat', isTile && 'ui-stat--tile')}>
      {isTile ? (
        <div className="ui-stat__head">
          <div className="ui-stat__label">{label}</div>
          <IconTile icon={icon} tone={tone} size="md" />
        </div>
      ) : null}
      <div className="ui-stat__value">{value}</div>
      {isTile ? null : <div className="ui-stat__label">{label}</div>}
      {delta ? (
        <div
          className={cx(
            'ui-stat__delta',
            delta.direction === 'up' && 'ui-stat__delta--up',
            delta.direction === 'down' && 'ui-stat__delta--down',
          )}
        >
          {delta.direction ? <Icon name="arrow-up" size={14} /> : null}
          <span>{delta.text}</span>
        </div>
      ) : null}
      {hint !== undefined ? <div className="ui-stat__hint">{hint}</div> : null}
    </div>
  );
}

/* ── SuccessMark ── */

export function SuccessMark() {
  return (
    <span className="ui-success-mark" role="img" aria-label="Generated successfully">
      {/* The label is on the wrapper, so the glyph itself stays aria-hidden. */}
      <Icon name="check" size={28} />
    </span>
  );
}

/* ── Tone ── */

/**
 * Tint vocabulary shared by `IconTile`, `Avatar` and `Stat`.
 *
 * Each name maps to an existing design token in `styles.css` rather than to a
 * literal, so anything the theme re-points follows — `accent` in particular
 * flips per theme and per `[data-flow]` scope.
 */
export type Tone = 'accent' | 'cyan' | 'success' | 'warning' | 'error' | 'violet';

/* ── IconTile ── */

export interface IconTileProps {
  icon: IconName;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  /** Only when the tile is the sole content of a control. */
  label?: string;
}

/** A coloured rounded square holding one icon. */
export function IconTile({ icon, tone = 'accent', size = 'md', label }: IconTileProps) {
  const glyph: IconSize = size === 'lg' ? 24 : size === 'sm' ? 16 : 18;
  return (
    <span className={cx('ui-icon-tile', `ui-icon-tile--${size}`, `ui-tone--${tone}`)}>
      <Icon name={icon} size={glyph} {...(label ? { label } : {})} />
    </span>
  );
}

/* ── Avatar ── */

export interface AvatarProps {
  /** Pre-computed initials — deriving them from a name is the app's job. */
  initials: string;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  /** Shows a presence dot. */
  online?: boolean;
  /** Full name or email, so the circle is not announced as two stray letters. */
  label?: string;
}

/**
 * Initials in a tinted circle.
 *
 * Deliberately dumb: `initialsOf` and the deterministic tone choice live in the
 * app, where they can be unit-tested. A project must not change colour between
 * renders, and that is a property of the derivation, not of the rendering.
 */
export function Avatar({ initials, tone = 'accent', size = 'md', online, label }: AvatarProps) {
  return (
    <span
      className={cx('ui-avatar', `ui-avatar--${size}`, `ui-tone--${tone}`)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {initials}
      {online ? <span className="ui-avatar__status" /> : null}
    </span>
  );
}

/* ── Kbd ── */

/** A keyboard key, e.g. the `⌘K` hint in the search field. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

/* ── ListRow ── */

export interface ListRowProps {
  /** Avatar, icon tile, or method badge. */
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Status chips, counts, a kebab — laid out at the end of the row. */
  trailing?: ReactNode;
  /** Makes the whole row a button. */
  onClick?: () => void;
}

/**
 * One row of a list: leading slot, a title/meta stack that absorbs the slack,
 * and trailing slots.
 *
 * Generalises the shape `.ui-worker-row` already has. `WorkerRow` itself is left
 * alone — it is the progress board's signature surface and has no test coverage,
 * so refactoring it onto this is risk with no return.
 */
export function ListRow({ leading, title, meta, trailing, onClick }: ListRowProps) {
  const body = (
    <>
      {leading}
      <span className="ui-list-row__body">
        <span className="ui-list-row__title">{title}</span>
        {meta ? <span className="ui-list-row__meta">{meta}</span> : null}
      </span>
      {trailing}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="ui-list-row ui-list-row--interactive" onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className="ui-list-row">{body}</div>;
}

/* ── Tabs ── */

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  /** Optional count or badge rendered after the label. */
  hint?: ReactNode;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Accessible name for the tablist. */
  label: string;
}

/**
 * A controlled tab strip.
 *
 * Replaces five hand-rolled copies of the `.ui-tabs` pattern, which had drifted:
 * some set `role="tablist"`, none supported the keyboard, and one used buttons
 * with `aria-selected` and no list role at all. The styling already lived in
 * `styles.css`; only the component was missing.
 *
 * **Arrow keys move between tabs**, which is what the ARIA tabs pattern requires
 * and what none of the copies did — without it a keyboard user tabs through every
 * tab individually to reach the panel, and on an eight-tab strip that is eight
 * stops before the content.
 *
 * `roving tabindex`: only the active tab is reachable by Tab, and Left/Right move
 * the selection. That is the whole point of the pattern — Tab should land on the
 * strip once and then move into the panel.
 */
export function Tabs<T extends string>({ items, active, onChange, label }: TabsProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const index = items.findIndex((item) => item.id === active);
    // Wraps, so Right on the last tab returns to the first — the ARIA pattern's
    // default and what stops the strip feeling like a dead end.
    const next = items[(index + delta + items.length) % items.length];
    if (next) {
      onChange(next.id);
    }
  };

  return (
    <div
      className="ui-tabs ui-tabs--scroll"
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            // Roving tabindex: the strip is one tab stop, not N.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.hint !== undefined ? <span className="ui-tabs__hint">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a `Tabs` strip controls. Wires up the aria relationship both ways. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}

export interface NavTabItem {
  href: string;
  label: string;
  hint?: ReactNode;
}

export interface NavTabsProps {
  items: readonly NavTabItem[];
  /** Which href is current. Compared exactly. */
  activeHref: string;
  label: string;
  /** Rendered per item — the router's Link, which this package cannot import. */
  renderLink: (item: NavTabItem, props: NavTabLinkProps) => ReactNode;
}

export interface NavTabLinkProps {
  className: string;
  'aria-current': 'page' | undefined;
  children: ReactNode;
}

/**
 * Tabs that are navigation rather than in-page state.
 *
 * **Not `role="tablist"`.** These are links that change the URL, so a screen
 * reader should hear "link", not "tab" — announcing a tab implies the content
 * swaps in place and the back button will not help. `aria-current="page"` carries
 * the selection, exactly as the sidebar nav does.
 *
 * `renderLink` is a callback because `packages/ui` has no dependencies and cannot
 * import `next/link`; a plain `<a>` would full-page-reload between tabs.
 */
export function NavTabs({ items, activeHref, label, renderLink }: NavTabsProps) {
  return (
    <nav className="ui-tabs ui-tabs--scroll" aria-label={label}>
      {items.map((item) =>
        renderLink(item, {
          className: item.href === activeHref ? 'ui-tabs__link is-active' : 'ui-tabs__link',
          'aria-current': item.href === activeHref ? 'page' : undefined,
          children: (
            <>
              {item.label}
              {item.hint !== undefined ? <span className="ui-tabs__hint">{item.hint}</span> : null}
            </>
          ),
        }),
      )}
    </nav>
  );
}

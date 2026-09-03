'use client';

/**
 * Form controls — shadcn structure, this product's palette.
 *
 * The three text controls share a base because they were already one CSS rule
 * (`.ui-input, .ui-select, .ui-textarea`) and they should stay visually
 * identical: a select that sits a pixel taller than the input beside it is the
 * kind of thing nobody reports and everybody notices.
 *
 * Focus is a ring, not a border-colour change. A border change shifts nothing
 * but is easy to mistake for hover, and on a dark surface the two read almost
 * the same.
 */

import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from 'react';

import { cn } from '../lib/utils.js';

const CONTROL_BASE = cn(
  'w-full rounded-[var(--radius-sm)] border border-border bg-background',
  'px-3 py-2 text-sm text-foreground',
  'placeholder:text-subtle-foreground',
  'transition-[border-color,box-shadow] duration-150 ease-out',
  'outline-none focus-visible:border-accent-mark focus-visible:ring-2 focus-visible:ring-ring',
  'disabled:cursor-not-allowed disabled:opacity-50',
  // `aria-invalid` rather than a prop: the attribute is what assistive tech
  // reads, so tying the visual state to it means the two cannot disagree.
  'aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/40',
);

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL_BASE, 'h-10', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      // A native select, not Radix. It is the only control here that a mobile
      // browser renders as its own picker, and that picker is better than
      // anything a listbox reimplements — worth keeping until a case needs
      // multi-select or search.
      className={cn(CONTROL_BASE, 'h-10 cursor-pointer appearance-none pr-8', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL_BASE, 'min-h-20 resize-y', className)} {...rest} />;
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A native checkbox, wrapped in its own label.
 *
 * Not Radix's: a real `<input type="checkbox">` inside a `<label>` is already
 * keyboard-operable, announced correctly, and participates in form reset and
 * autofill. `accent-color` tints it to the palette, which is all the styling it
 * needed. Radix's version exists to allow a custom indicator — worth it for a
 * design that draws one, wasted here.
 */
export function Checkbox({ checked, onChange, label, disabled, className }: CheckboxProps) {
  return (
    <label
      className={cn(
        'inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer accent-[var(--accent-mark)] disabled:cursor-not-allowed"
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
  className?: string;
}

export function Field({ label, children, htmlFor, hint, error, className }: FieldProps) {
  return (
    <div className={className}>
      {htmlFor !== undefined ? (
        <label className="mb-1 block text-sm font-medium text-muted-foreground" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="mb-1 block text-sm font-medium text-muted-foreground">{label}</span>
      )}
      {children}
      {hint !== undefined && hint !== null ? (
        <p className="mt-1 text-xs text-subtle-foreground">{hint}</p>
      ) : null}
      {error !== undefined && error !== null && error !== '' ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

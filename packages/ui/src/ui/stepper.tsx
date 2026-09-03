'use client';

/**
 * Stepper — the wizard's progress strip.
 *
 * Not in the shadcn registry at all, so this is the shadcn *conventions*
 * (Tailwind utilities, `cn`, a class table per state) applied to the component
 * that already existed.
 */

import { Icon } from '../icons.js';
import { cn } from '../lib/utils.js';

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
  className?: string;
}

const STEP = cn(
  'flex items-center gap-2 px-3 py-2',
  'rounded-[var(--radius-md)] border border-border bg-card',
  'text-left font-[inherit] text-sm text-muted-foreground',
  'transition-colors',
);

const NUMBER = cn(
  'inline-flex size-6 flex-[0_0_1.5rem] items-center justify-center rounded-full',
  'border border-border text-xs font-semibold text-muted-foreground',
);

export function Stepper({ steps, current, onGoTo, className }: StepperProps) {
  return (
    <ol className={cn('flex flex-wrap items-start gap-2', className)}>
      {steps.map((label, index) => {
        const number = index + 1;
        const done = number < current;
        const active = number === current;
        const clickable = done && onGoTo !== undefined;

        const stepClass = cn(
          STEP,
          done && 'text-foreground',
          active && 'border-accent-mark bg-popover text-foreground',
          clickable && 'cursor-pointer hover:border-accent-text',
          clickable && 'outline-none focus-visible:ring-2 focus-visible:ring-ring',
        );

        const numberClass = cn(
          NUMBER,
          // Black on the vivid green: 13:1. The fill is 24px, so vividness costs
          // nothing here — this is the size at which bright green belongs.
          (active || done) && 'border-accent-mark bg-accent-mark text-background',
        );

        const body = (
          <>
            <span className={numberClass}>{done ? <Icon name="check" size={14} /> : number}</span>
            <span>{label}</span>
          </>
        );

        return (
          <li key={label} className="list-none">
            {clickable ? (
              <button
                type="button"
                className={stepClass}
                onClick={() => onGoTo(number)}
                aria-current={active ? 'step' : undefined}
              >
                {body}
              </button>
            ) : (
              <div className={stepClass} aria-current={active ? 'step' : undefined}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

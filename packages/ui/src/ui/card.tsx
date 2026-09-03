'use client';

/**
 * Card — shadcn structure, with this product's existing API kept.
 *
 * shadcn ships `Card`/`CardHeader`/`CardTitle`/`CardContent`/`CardFooter`. Those
 * are exported here for new code, but `Card` itself keeps its original
 * `{ children, interactive, className }` signature because roughly forty call
 * sites pass exactly that — and a card is the one component where the
 * sub-structure genuinely varies per screen, so forcing every one of them
 * through a header/content pair would add markup without adding meaning.
 */

import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/utils.js';

export interface CardProps {
  children: ReactNode;
  /** Adds a hover state, for a card that is itself a link or a target. */
  interactive?: boolean;
  className?: string;
}

export function Card({ children, interactive, className }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-md)] border border-border bg-card p-6',
        // Grey, never green. Every card in a grid hovers in turn, so a coloured
        // hover put the accent under the cursor once per card.
        interactive && 'transition-colors hover:border-border-strong hover:bg-muted',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-lg leading-none font-semibold', className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-4', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2', className)} {...rest} />;
}

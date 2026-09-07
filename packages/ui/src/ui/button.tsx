'use client';

/**
 * Button — shadcn structure, this product's palette.
 *
 * ## What is kept from before, and why
 *
 * The variant and size names are unchanged (`primary|secondary|accent|ghost|
 * danger`, `md|sm`) because roughly ninety call sites use them. shadcn's own
 * names — `default`, `outline`, `destructive`, `lg`, `icon` — are accepted as
 * aliases so newly-copied shadcn snippets work too, but nothing had to be
 * touched to get here.
 *
 * ## The one rule the variants encode
 *
 * Only `primary` is filled. Everything else is transparent and hovers to a
 * grey, which is shadcn's own treatment: its `outline` is
 * `border bg-background hover:bg-accent` and its `ghost` is `hover:bg-accent`,
 * where `--accent` is a chroma-zero grey. Interaction moves the grey; it never
 * adds colour.
 *
 * `primary` is for the actions that commit something — Generate, Create,
 * Publish, Save, Confirm — and is meant to be the only filled thing on a screen.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../lib/utils.js';

export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap',
    'rounded-md border border-transparent',
    'text-sm font-medium',
    'transition-[background-color,border-color,color] duration-150 ease-out',
    'cursor-pointer',
    // Focus is a ring rather than a border change, so it cannot be confused with
    // the hover state or shift layout by a pixel.
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
    // Icons inside a button should never be selected by the pointer or scale
    // with a stray font rule.
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        secondary:
          'border-border bg-transparent text-foreground hover:border-border-strong hover:bg-muted active:bg-muted-strong',
        /* Grey surface, green label — for an accent-flavoured action that should
           not become a fill. */
        accent:
          'border-border bg-transparent text-accent-text hover:border-accent-text hover:bg-muted',
        ghost:
          'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted-strong',
        /* Tints on hover rather than filling: a Delete button that turns solid
           red becomes the loudest thing on the row, which is the opposite of
           what a destructive action should be before it is chosen. */
        danger:
          'border-destructive/45 bg-transparent text-destructive hover:border-destructive hover:bg-destructive/12',
      },
      size: {
        md: 'h-10 px-4',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6',
        /* Square, for a single icon — the width would otherwise be padding. */
        icon: 'size-8 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

/** shadcn's vocabulary, so a copied snippet works without translation. */
const VARIANT_ALIASES = {
  default: 'primary',
  outline: 'secondary',
  destructive: 'danger',
} as const;

export type ButtonVariant =
  NonNullable<VariantProps<typeof buttonVariants>['variant']> | keyof typeof VARIANT_ALIASES;

export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']> | 'default';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'primary', size = 'md', className, ...rest }: ButtonProps) {
  const resolvedVariant =
    variant in VARIANT_ALIASES
      ? VARIANT_ALIASES[variant as keyof typeof VARIANT_ALIASES]
      : (variant as VariantProps<typeof buttonVariants>['variant']);

  return (
    <button
      // `className` last, so `cn`'s tailwind-merge lets a caller's utility win
      // over the variant's. Without that ordering an override depends on CSS
      // source order rather than on intent.
      className={cn(
        buttonVariants({
          variant: resolvedVariant,
          size: size === 'default' ? 'md' : size,
        }),
        className,
      )}
      {...rest}
    />
  );
}

'use client';

/**
 * Dialog — Radix primitives, shadcn styling.
 *
 * ## Why this one earns a dependency
 *
 * Most of these components did not need Radix; a native `<select>` or
 * `<input type="checkbox">` already does the accessible thing. A dialog does
 * not. The hand-rolled `Modal` this replaces was a `div` with a click handler,
 * which means it was missing all of:
 *
 * - focus moving into the dialog on open and **back to the trigger on close**
 * - a focus trap, so Tab could not walk out into the page behind it
 * - `Escape` to dismiss
 * - `aria-modal` plus the inert/`aria-hidden` treatment of the rest of the page,
 *   so a screen reader does not read the dialog and the page underneath as one
 *   document
 * - scroll lock on the body
 *
 * Every one of those is a bug a user hits rather than a nicety, and each is
 * fiddly enough that reimplementing them is how you end up with a subtly broken
 * dialog. This is the case Radix exists for.
 *
 * ## The API is unchanged
 *
 * `Modal` keeps its `{ open, onClose, title, children }` signature — six call
 * sites use it, and they get the accessibility for free without an edit. The
 * composable Radix parts are exported alongside for anything new.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';

import { Icon } from '../icons.js';
import { cn } from '../lib/utils.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...rest
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/70',
        // An entrance fade only, and a real keyframe rather than shadcn's
        // `data-[state=open]:animate-in`: those classes come from the
        // `tailwindcss-animate` plugin, which this project does not use, so
        // copying them in produced two class names that matched nothing and
        // silently did nothing. There is no exit animation because Radix
        // unmounts the overlay on close unless `forceMount` coordinates it.
        'motion-safe:animate-[ui-fade-in_150ms_ease-out]',
        className,
      )}
      {...rest}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...rest
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-[var(--radius-md)] border border-border bg-popover p-6 shadow-2xl',
          // The viewport cap plus its own scroll: a dialog holding a long
          // validation list must not grow past the screen and strand its buttons
          // below the fold.
          'max-h-[85vh] overflow-y-auto',
          className,
        )}
        {...rest}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('mb-4 flex flex-col gap-1.5', className)} {...rest} />;
}

export function DialogTitle({ className, ...rest }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg leading-none font-semibold', className)}
      {...rest}
    />
  );
}

export function DialogDescription({
  className,
  ...rest
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...rest}
    />
  );
}

export function DialogFooter({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex items-center justify-end gap-2', className)} {...rest} />;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * The signature the existing call sites use.
 *
 * `onOpenChange` is narrowed to "closed": Radix fires it for both directions,
 * but `open` here is owned by the caller's own state and only the close needs
 * reporting back.
 */
export function Modal({ open, onClose, title, children }: ModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      {/*
        `aria-describedby={undefined}` is the documented way to tell Radix a
        dialog genuinely has no description. Without it, every one of these
        logs a dev warning asking for one — and the six call sites pass
        `children` that are forms and lists, not a describable sentence.
      */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <DialogTitle>{title}</DialogTitle>
            <DialogClose
              aria-label="Close"
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
                'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <Icon name="x" size={16} />
            </DialogClose>
          </div>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

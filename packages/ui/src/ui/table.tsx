'use client';

/**
 * Table — shadcn's composable primitives.
 *
 * Replaces three hand-rolled tables that each restyled the same thing:
 * `.endpoint-table`, `.log-table` and `.projects-table`. Composition rather than
 * one `<Table columns={…} rows={…}>` component, because every one of those
 * tables needs a different cell — a status chip, a method badge, a countdown, a
 * row of buttons — and a data-driven table ends up growing a render prop per
 * column until it is harder to read than the markup it replaced.
 *
 * `Table` supplies its own scroll container. Eight columns do not fit a phone,
 * and a horizontally scrolling *document* is worse than a horizontally scrolling
 * table — so this is a property of the component rather than something each
 * caller has to remember to wrap.
 */

import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
  TableHTMLAttributes,
} from 'react';

import { cn } from '../lib/utils.js';

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...rest} />
    </div>
  );
}

export function TableHeader({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...rest} />;
}

export function TableBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      // The last row's rule is the container's edge, so it would double up.
      className={cn('[&_tr:last-child]:border-0', className)}
      {...rest}
    />
  );
}

export function TableFooter({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn(
        'border-t border-border bg-muted/40 font-medium [&>tr]:last:border-b-0',
        className,
      )}
      {...rest}
    />
  );
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors',
        // Grey, like every other hover in the system.
        'hover:bg-muted data-[state=selected]:bg-muted',
        className,
      )}
      {...rest}
    />
  );
}

export function TableHead({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-9 px-2 align-middle text-xs font-medium whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...rest}
    />
  );
}

export function TableCell({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-2 py-2 align-middle', className)} {...rest} />;
}

/**
 * A row header — `<th scope="row">`.
 *
 * Not part of shadcn's set, and worth having: the first cell of a data row is
 * the thing that names it, and marking it up as a header is what lets a screen
 * reader announce "pipe, Status, Active" instead of reading a bare grid of
 * values. It carries `TableCell`'s padding with the weight reset a `th` brings.
 */
export function TableRowHeader({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="row"
      className={cn('px-2 py-2 text-left align-middle font-medium', className)}
      {...rest}
    />
  );
}

export function TableCaption({ className, ...rest }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('mt-4 text-sm text-muted-foreground', className)} {...rest} />;
}

/** Right-aligned with tabular figures, so numbers compare down the column. */
export const tableNumeric = 'text-right tabular-nums';

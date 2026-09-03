'use client';

/**
 * Tabs — the ARIA tabs pattern, and its navigation counterpart.
 *
 * ## Why not `@radix-ui/react-tabs`
 *
 * Radix's Tabs owns the selected value. Every one of the five call sites here
 * keeps that value somewhere else — in a URL query parameter, in a parent's
 * state that also drives a fetch, in a wizard step — so Radix would run in
 * controlled mode and contribute only the keyboard handling and the aria
 * wiring. Those are twenty lines, written below and unit-testable, against a
 * dependency whose `Root`/`List`/`Trigger`/`Content` split would mean rewriting
 * all five call sites to gain nothing.
 *
 * `Dialog` went the other way, and the difference is worth naming: a dialog
 * needs focus trapping, focus restoration and page inerting, which are not
 * twenty lines and are where hand-rolled versions go wrong.
 *
 * ## Arrow keys are the point
 *
 * This replaces five hand-rolled copies of the pattern, which had drifted: some
 * set `role="tablist"`, none supported the keyboard, and one used buttons with
 * `aria-selected` and no list role at all. Without arrow-key movement a
 * keyboard user tabs through every tab to reach the panel — eight stops before
 * the content on the widest strip.
 */

import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '../lib/utils.js';

/** The strip itself: one row, a hairline under it, and horizontal scroll. */
const TABLIST = cn(
  'mb-4 flex gap-1 border-b border-border',
  // A flex row's items shrink by default; tabs must keep their label width and
  // let the container scroll instead.
  'max-w-full flex-nowrap overflow-x-auto [scrollbar-width:thin]',
  // Snapping makes a swiped strip settle on a tab rather than mid-label.
  '[scroll-snap-type:x_proximity]',
  '[&>*]:flex-none [&>*]:[scroll-snap-align:start]',
  // The scrollbar sits directly under the 1px border and doubles it visually.
  // Thin and dim is enough of an affordance next to a clipped tab.
  '[&::-webkit-scrollbar]:h-[3px]',
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
);

/** One tab. `selected` drives both the colour and the underline. */
const TAB = cn(
  'inline-flex cursor-pointer items-center gap-2 whitespace-nowrap',
  'border-0 border-b-2 border-b-transparent bg-transparent px-3 py-2',
  'text-sm font-medium text-muted-foreground no-underline',
  'transition-colors hover:text-foreground',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

/* Green is the *underline* plus the label — a 2px rule and one word, which is
   the scale at which the accent belongs. A filled tab would put a green block
   on every screen that has tabs. */
const TAB_SELECTED = 'border-b-accent-mark text-accent-text';

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
  className?: string;
}

/** Small count or badge after a tab's label. */
function TabHint({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[18px] items-center justify-center rounded-full px-[5px]',
        'bg-popover text-[11px] text-muted-foreground tabular-nums',
      )}
    >
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  items,
  active,
  onChange,
  label,
  className,
}: TabsProps<T>) {
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
    <div className={cn(TABLIST, className)} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
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
            // Roving tabindex: the strip is one tab stop, not N. That is the
            // whole point of the pattern — Tab should land on the strip once and
            // then move into the panel.
            tabIndex={selected ? 0 : -1}
            className={cn(TAB, selected && TAB_SELECTED)}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.hint !== undefined ? <TabHint>{item.hint}</TabHint> : null}
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

export interface NavTabLinkProps {
  className: string;
  'aria-current': 'page' | undefined;
  children: ReactNode;
}

export interface NavTabsProps {
  items: readonly NavTabItem[];
  /** Which href is current. Compared exactly. */
  activeHref: string;
  label: string;
  /** Rendered per item — the router's Link, which this package cannot import. */
  renderLink: (item: NavTabItem, props: NavTabLinkProps) => ReactNode;
  className?: string;
}

/**
 * Tabs that are navigation rather than in-page state.
 *
 * **Not `role="tablist"`.** These are links that change the URL, so a screen
 * reader should hear "link", not "tab" — announcing a tab implies the content
 * swaps in place and the back button will not help. `aria-current="page"` carries
 * the selection, exactly as the sidebar nav does, so the style cannot drift from
 * what is announced.
 *
 * `renderLink` is a callback because `packages/ui` has no dependency on a router
 * and cannot import `next/link`; a plain `<a>` would full-page-reload between
 * tabs.
 */
export function NavTabs({ items, activeHref, label, renderLink, className }: NavTabsProps) {
  return (
    <nav className={cn(TABLIST, className)} aria-label={label}>
      {items.map((item) => {
        const current = item.href === activeHref;
        return renderLink(item, {
          className: cn(TAB, current && TAB_SELECTED),
          'aria-current': current ? 'page' : undefined,
          children: (
            <>
              {item.label}
              {item.hint !== undefined ? <TabHint>{item.hint}</TabHint> : null}
            </>
          ),
        });
      })}
    </nav>
  );
}

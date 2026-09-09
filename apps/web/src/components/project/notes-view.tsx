'use client';

/**
 * The rendered Technical Notes (Phase 4 §10).
 *
 * Renders the blocks `parseNotesDocument` read out of the markdown the API
 * returned — the same string the raw view shows and the download saves. So the
 * three cannot disagree: there is one document and three presentations of it.
 *
 * ## Colour
 *
 * None. This is the longest reading surface in the workspace, and the theme's
 * rule is that vividness scales inversely with area — a document with coloured
 * field types would be a page of coloured text. Structure carries the meaning
 * here: heading weight, indentation, and monospace for the things that are
 * literally identifiers.
 *
 * ## No HTML
 *
 * Every span is a plain string placed in a text node. Nothing is interpolated
 * as markup, so a project description containing angle brackets renders as
 * angle brackets. (The generator also flattens newlines out of free text, so it
 * cannot forge a heading upstream of here either.)
 */

import { cn } from '@instantmockapi/ui';
import { sectionId, type NotesBlock, type NotesSpan } from '../../lib/notes-document';

function Spans({ spans }: { spans: readonly NotesSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        // Index keys: spans are a positional decomposition of one line, never
        // reordered and never keyed by identity.
        if (span.kind === 'code') {
          return (
            <code
              key={index}
              className="rounded bg-background px-1 py-[1px] font-mono text-[0.85em] text-foreground"
            >
              {span.text}
            </code>
          );
        }
        if (span.kind === 'strong') {
          return (
            <strong key={index} className="font-medium text-foreground">
              {span.text}
            </strong>
          );
        }
        if (span.kind === 'em') {
          return (
            <em key={index} className="text-muted-foreground">
              {span.text}
            </em>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

/**
 * Heading sizes, chosen so §2's three readers can all skim.
 *
 * `h1` is the document title and is rendered once. `h2` is a section and gets a
 * rule above it, which is what makes the document scannable at a glance without
 * any colour. `h3` is one entity, `h4` one of its groups.
 */
const HEADING: Record<1 | 2 | 3 | 4, string> = {
  1: 'text-xl font-semibold text-foreground',
  2: 'mt-8 border-t border-border pt-6 text-base font-semibold text-foreground',
  3: 'mt-6 text-sm font-semibold text-foreground',
  4: 'mt-4 text-xs font-medium tracking-wide text-muted-foreground uppercase',
};

/** A total map, not an array index: `noUncheckedIndexedAccess` widens those. */
const HEADING_TAG: Record<1 | 2 | 3 | 4, 'h1' | 'h2' | 'h3' | 'h4'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
};

export function NotesView({ blocks }: { blocks: readonly NotesBlock[] }) {
  return (
    <div className="flex flex-col gap-1 text-sm/[1.7] text-muted-foreground">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          const Tag = HEADING_TAG[block.level];
          return (
            <Tag
              key={index}
              // The anchor the outline scrolls to. `scroll-mt` keeps the heading
              // clear of the sticky workspace header once it lands.
              id={block.level === 2 ? sectionId(block.text) : undefined}
              className={cn(HEADING[block.level], block.level === 2 && 'scroll-mt-24')}
            >
              {block.text}
            </Tag>
          );
        }

        if (block.kind === 'bullet') {
          return (
            <div
              key={index}
              className="flex gap-2"
              // Indentation by depth, so a nested field reads as belonging to
              // its parent. Inline because the depth is data, not a fixed set
              // of classes Tailwind could have generated.
              style={block.depth > 0 ? { paddingLeft: `${block.depth * 1.25}rem` } : undefined}
            >
              <span aria-hidden className="select-none text-border">
                —
              </span>
              <span className="min-w-0">
                <Spans spans={block.spans} />
              </span>
            </div>
          );
        }

        return (
          <p key={index} className="my-1">
            <Spans spans={block.spans} />
          </p>
        );
      })}
    </div>
  );
}

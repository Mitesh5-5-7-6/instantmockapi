import { describe, it, expect } from 'vitest';
import {
  documentSections,
  notesFilename,
  parseNotesDocument,
  parseSpans,
  sectionId,
} from './notes-document';

/**
 * Reading the Technical Notes document (Phase 4 §10).
 *
 * The claim under test is narrow and worth stating: this reads the output of
 * one emitter, `packages/generators/docs/src/notes-markdown.ts`, so the fixture
 * below is a transcript of what that emitter actually produces rather than
 * invented markdown. Anything the grammar does not cover must survive as
 * literal text — a document that silently lost a line would be worse than one
 * that showed an asterisk.
 */

/** A transcript of real output: headings, nested bullets, ids, italics, prose. */
const REAL = [
  '# Shop — Technical Notes',
  '',
  '## Project',
  '',
  '- Name: Shop',
  '- Type: project',
  '- Definition version: v3',
  '- Public id: `prj_abc1234`',
  '',
  '## Current state',
  '',
  '_These facts move on their own. Every other section describes the definition, which does not._',
  '',
  '- Status: active',
  '',
  '## Authentication',
  '',
  'Authentication: Disabled',
  '',
  'Every endpoint is open — no token is required.',
  '',
  '## Data model',
  '',
  '### MainEntity',
  '',
  '- Stable id: `ent_836ad4f9`',
  '- Identity: `id` (uuid)',
  '',
  '#### Fields',
  '',
  '- **id** `fld_d776` — uuid · optional · identity · read-only',
  '- **customer** `fld_aa01` — object · required',
  '  - **name** `fld_bb02` — string · required',
  '  - **age** `fld_cc03` — number · optional · min=0',
  '',
  '## API',
  '',
  '- `GET /mainentity` — List MainEntity · Authentication: Not required',
  '',
].join('\n');

describe('parseSpans', () => {
  it('reads a bold field name, a code id and the plain remainder', () => {
    expect(parseSpans('**id** `fld_d776` — uuid · optional')).toEqual([
      { kind: 'strong', text: 'id' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'fld_d776' },
      { kind: 'text', text: ' — uuid · optional' },
    ]);
  });

  it('reads an italic run', () => {
    expect(parseSpans('_No fields._')).toEqual([{ kind: 'em', text: 'No fields.' }]);
  });

  /**
   * Code first, deliberately. A code span may contain `*` or `_` — a `regex`
   * rule routinely does — and matching emphasis first would tear the span in
   * half and swallow the delimiters.
   */
  it('does not read emphasis inside a code span', () => {
    expect(parseSpans('`^a_b*c$`')).toEqual([{ kind: 'code', text: '^a_b*c$' }]);
  });

  it('keeps text with no markup whole', () => {
    expect(parseSpans('Authentication: Disabled')).toEqual([
      { kind: 'text', text: 'Authentication: Disabled' },
    ]);
  });

  /** An unmatched delimiter is text, not an excuse to drop the line. */
  it('keeps an unclosed delimiter as literal text', () => {
    expect(parseSpans('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }]);
  });

  /**
   * A round trip, which is the strongest form of "nothing was lost".
   *
   * Re-emitting each span with its own delimiters must reproduce the line
   * exactly — so a dropped character, a merged pair of spans, or a run given
   * the wrong kind all fail. Comparing against a hand-stripped copy of the line
   * was the first attempt and it was wrong: it also stripped the underscore
   * inside `` `prj_abc1234` ``, which the parser correctly keeps.
   */
  it('round-trips every line back to itself', () => {
    const reemit = (line: string): string =>
      parseSpans(line)
        .map((span) => {
          if (span.kind === 'code') return `\`${span.text}\``;
          if (span.kind === 'strong') return `**${span.text}**`;
          if (span.kind === 'em') return `_${span.text}_`;
          return span.text;
        })
        .join('');

    for (const line of REAL.split('\n')) {
      expect(reemit(line), line).toBe(line);
    }
  });
});

describe('parseNotesDocument', () => {
  const blocks = parseNotesDocument(REAL);

  it('reads every heading at its level', () => {
    const headings = blocks
      .filter((block) => block.kind === 'heading')
      .map((block) => (block.kind === 'heading' ? `${block.level}:${block.text}` : ''));

    expect(headings).toEqual([
      '1:Shop — Technical Notes',
      '2:Project',
      '2:Current state',
      '2:Authentication',
      '2:Data model',
      '3:MainEntity',
      '4:Fields',
      '2:API',
    ]);
  });

  /**
   * Two spaces per level, which is what `renderFields` emits for a nested
   * field. Losing the depth would flatten a nested object into a sibling of its
   * own parent, so the rendered view would claim a different record shape.
   */
  it('reads nested bullet depth', () => {
    const depths = blocks
      .filter((block) => block.kind === 'bullet')
      .map((block) => (block.kind === 'bullet' ? block.depth : -1));

    expect(depths).toContain(0);
    expect(depths).toContain(1);
    expect(Math.max(...depths)).toBe(1);
  });

  it('keeps a prose line as a paragraph', () => {
    const paragraphs = blocks
      .filter((block) => block.kind === 'paragraph')
      .map((block) =>
        block.kind === 'paragraph' ? block.spans.map((span) => span.text).join('') : '',
      );

    expect(paragraphs).toContain('Authentication: Disabled');
    expect(paragraphs).toContain('Every endpoint is open — no token is required.');
  });

  it('drops blank lines rather than representing them', () => {
    expect(blocks.every((block) => block.kind !== 'heading' || block.text !== '')).toBe(true);
    expect(blocks).toHaveLength(REAL.split('\n').filter((line) => line !== '').length);
  });

  /**
   * The whole point of rendering from the markdown: nothing may be dropped, or
   * the rendered view and the download would describe different projects.
   */
  it('accounts for every non-blank line', () => {
    const lines = REAL.split('\n').filter((line) => line !== '');
    expect(blocks).toHaveLength(lines.length);
  });

  it('reads an empty document as no blocks', () => {
    expect(parseNotesDocument('')).toEqual([]);
    expect(parseNotesDocument('\n\n\n')).toEqual([]);
  });

  /** `#####` is not a heading this emitter produces, so it stays text. */
  it('treats an unsupported heading level as a paragraph', () => {
    const [block] = parseNotesDocument('##### Deeper');
    expect(block?.kind).toBe('paragraph');
  });
});

describe('documentSections', () => {
  it('lists the section headings only', () => {
    expect(documentSections(parseNotesDocument(REAL)).map((section) => section.text)).toEqual([
      'Project',
      'Current state',
      'Authentication',
      'Data model',
      'API',
    ]);
  });

  /**
   * `###` is one entity. A forty-entity project would otherwise produce an
   * outline longer than the document it indexes.
   */
  it('does not list entity headings', () => {
    expect(documentSections(parseNotesDocument(REAL)).map((section) => section.text)).not.toContain(
      'MainEntity',
    );
  });

  it('gives each section a stable id', () => {
    const sections = documentSections(parseNotesDocument(REAL));
    expect(sections.map((section) => section.id)).toEqual([
      'project',
      'current-state',
      'authentication',
      'data-model',
      'api',
    ]);
  });
});

describe('sectionId', () => {
  it('slugs punctuation and case away', () => {
    expect(sectionId('Current state')).toBe('current-state');
    expect(sectionId('Shop — Technical Notes')).toBe('shop-technical-notes');
  });

  it('never returns an empty id, which would break the anchor', () => {
    expect(sectionId('———')).toBe('section');
    expect(sectionId('')).toBe('section');
  });
});

describe('notesFilename', () => {
  /**
   * Named from the project: three downloads from three projects otherwise land
   * as `technical-notes.md`, `technical-notes (1).md`, `technical-notes (2).md`
   * in one folder, which is an unusable set.
   */
  it('names the file after the project slug', () => {
    expect(notesFilename('notes', { slug: 'shop' })).toBe('shop-technical-notes.md');
    expect(notesFilename('ai', { slug: 'shop' })).toBe('shop-ai-context.md');
  });

  it('falls back to the name before the project has a slug', () => {
    expect(notesFilename('notes', { slug: null, name: 'My Shop' })).toBe(
      'my-shop-technical-notes.md',
    );
  });

  it('stays a valid filename when the project has neither', () => {
    expect(notesFilename('notes', {})).toBe('project-technical-notes.md');
    expect(notesFilename('ai', { name: '———' })).toBe('section-ai-context.md');
  });
});

describe('notesFilename for a blueprint', () => {
  /**
   * The mirror of `blueprintFilename` in `packages/ips/src/blueprint.ts`.
   *
   * `web-must-not-import-server` forbids importing it, and this app needs the
   * name client-side because it downloads from the parsed body — it
   * pretty-prints the JSON — rather than following the API's
   * `content-disposition` header. These are the same literals that side pins;
   * a drift shows up as one suite passing and the other failing.
   */
  it('uses the §17 suffix with the project stem', () => {
    expect(notesFilename('blueprint', { slug: 'shop' })).toBe('shop.blueprint.json');
  });

  it('lowercases and slugs, as the server-side rule does', () => {
    expect(notesFilename('blueprint', { slug: 'My Shop' })).toBe('my-shop.blueprint.json');
    expect(notesFilename('blueprint', { slug: 'Shop_2' })).toBe('shop-2.blueprint.json');
  });

  it('falls back the same way when there is no slug', () => {
    expect(notesFilename('blueprint', {})).toBe('project.blueprint.json');
  });
});

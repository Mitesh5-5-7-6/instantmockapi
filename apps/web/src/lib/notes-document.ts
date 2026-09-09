/**
 * The Technical Notes document, read for rendering (Phase 4 §10).
 *
 * §10 asks for a rendered view, a raw markdown view, a copy and a download.
 * This module turns the markdown into blocks the page renders; the raw view,
 * the clipboard and the `.md` file all use the same string untouched. So the
 * four are one document by construction — the rendered view cannot show a fact
 * the download omits, because it has no other source.
 *
 * ## Why parsing our own output is not the mistake it looks like
 *
 * This is not a markdown parser. It is a reader for one emitter:
 * `packages/generators/docs/src/notes-markdown.ts`, whose grammar is fixed and
 * covered by its own tests. The alternative — sending the
 * `DocumentationModel` and rendering from that — is barred anyway
 * (`web-must-not-import-server` forbids the web app importing a generator, so
 * the model's types would have to be hand-mirrored and would drift), and it
 * would make the rendered view a *third* rendering of the definition, free to
 * disagree with the `.md`. That is the failure §9's shared model exists to
 * prevent, so reintroducing it one layer up would be the real mistake.
 *
 * Anything the grammar does not cover renders as its own literal text. There is
 * no HTML in the output and none is produced: every block carries plain strings
 * that React puts in text nodes, so there is nothing here to sanitise.
 */

/** An inline run. `code` is rendered monospace, `strong` bold, `em` italic. */
export interface NotesSpan {
  kind: 'text' | 'strong' | 'code' | 'em';
  text: string;
}

export type NotesBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'bullet'; depth: number; spans: NotesSpan[] }
  | { kind: 'paragraph'; spans: NotesSpan[] };

/**
 * Inline runs, in one pass.
 *
 * Order matters: `` ` `` is matched before `*` and `_`, because a code span may
 * legitimately contain either (`` `**` `` is not bold) and the emitter puts
 * field types and ids in code spans. Matching emphasis first would tear one in
 * half.
 */
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|_([^_]+)_/g;

export function parseSpans(line: string): NotesSpan[] {
  const spans: NotesSpan[] = [];
  let at = 0;

  for (const match of line.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) {
      spans.push({ kind: 'text', text: line.slice(at, start) });
    }
    const [, code, strong, em] = match;
    if (code !== undefined) {
      spans.push({ kind: 'code', text: code });
    } else if (strong !== undefined) {
      spans.push({ kind: 'strong', text: strong });
    } else if (em !== undefined) {
      spans.push({ kind: 'em', text: em });
    }
    at = start + match[0].length;
  }

  if (at < line.length) {
    spans.push({ kind: 'text', text: line.slice(at) });
  }
  // An empty line has no spans; a line of only markup would too, and both
  // render as nothing rather than as an empty paragraph.
  return spans;
}

/** `  - **name** — …` → depth 1. Two spaces per level, as `renderFields` emits. */
function bulletDepth(indent: string): number {
  return Math.floor(indent.length / 2);
}

/**
 * The document, as blocks.
 *
 * Blank lines are dropped rather than represented: spacing is the page's
 * decision, and a `blank` block would make the renderer reproduce the
 * markdown's vertical rhythm instead of the dashboard's.
 */
export function parseNotesDocument(markdown: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') {
      continue;
    }

    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4,
        text: heading[2]!,
      });
      continue;
    }

    const bullet = /^( *)- (.*)$/.exec(line);
    if (bullet !== null) {
      blocks.push({
        kind: 'bullet',
        depth: bulletDepth(bullet[1]!),
        spans: parseSpans(bullet[2]!),
      });
      continue;
    }

    blocks.push({ kind: 'paragraph', spans: parseSpans(line) });
  }

  return blocks;
}

/**
 * The document's headings, for a jump list.
 *
 * Only `##` — the section level. `###` is one entity or one endpoint group, and
 * a project with forty entities would produce an outline longer than the
 * document it indexes.
 */
export interface NotesSection {
  text: string;
  /** `data-notes-section`, so the page can scroll to it without a library. */
  id: string;
}

export function documentSections(blocks: readonly NotesBlock[]): NotesSection[] {
  return blocks
    .filter((block): block is NotesBlock & { kind: 'heading' } => block.kind === 'heading')
    .filter((block) => block.level === 2)
    .map((block) => ({ text: block.text, id: sectionId(block.text) }));
}

/** A stable slug for a heading. Deterministic, so a link survives a reload. */
export function sectionId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/**
 * The filename a download lands as.
 *
 * Named from the project rather than fixed, because a developer downloading the
 * notes for three projects ends up with three files in one folder — and
 * `technical-notes.md`, `technical-notes (1).md`, `technical-notes (2).md` is
 * an unusable set. The slug is already the project's own URL segment.
 */
export function notesFilename(
  kind: 'notes' | 'ai' | 'blueprint',
  project: { slug?: string | null; name?: string | null },
): string {
  const stem = sectionId(project.slug ?? project.name ?? 'project');
  if (kind === 'notes') {
    return `${stem}-technical-notes.md`;
  }
  if (kind === 'ai') {
    return `${stem}-ai-context.md`;
  }
  /*
   * The blueprint's name is `<stem>.blueprint.json` — §17's suffix.
   *
   * **Mirrors `blueprintFilename` in `packages/ips/src/blueprint.ts`**, which
   * the API uses for the `content-disposition` header.
   * `web-must-not-import-server` forbids importing it, and this app downloads
   * from the parsed body (it pretty-prints the JSON for a human reader) so it
   * needs the name rather than the header. Both slug the same way and both test
   * suites pin the same literals; change one and change the other.
   */
  return `${stem}.blueprint.json`;
}

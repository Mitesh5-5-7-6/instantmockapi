import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards on how failures are allowed to reach the screen.
 *
 * The error system it protects replaced 24 hand-written error blocks across 14
 * files, each in a slightly different place. Nothing stops the 25th being added
 * next week except a check that fails when it is — the components and the
 * normaliser are only a convention until something enforces them.
 *
 * A filesystem test rather than a rendering one because `apps/web` runs vitest
 * in a node environment with no DOM. The same approach already guards the
 * project tab routes.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) {
      found.push(path);
    }
  }
  return found;
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('the source tree', () => {
  it('is being scanned at all', () => {
    // A guard that silently matches nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(40);
  });
});

describe('raw error blocks', () => {
  /**
   * `FieldError` is red text beside a control. It is legitimate for a message
   * about *that* control, and it was being used for everything else too — API
   * failures, query failures, whole-form rejections — each in its own ad-hoc
   * `<p>` at the bottom of whatever screen raised it.
   *
   * The marker used to be the class name `ui-error`, which the shadcn migration
   * replaced with the `FieldError` component. An identifier is the better thing
   * to key on: a class string can be renamed out from under a guard silently,
   * where an import cannot.
   *
   * The allowed uses are all genuinely field-level or status data. Adding another
   * means either using `FormError`/`ErrorState`/a toast, or adding a line here
   * with the reason.
   */
  const ALLOWED = new Map([
    [
      'app/projects/[id]/files/page.tsx',
      'artifact.errorMessage is recorded server-side per artifact — status data in a table, not a UI failure',
    ],
    ['components/builder/entity-card.tsx', "server messages beside the entity's own name input"],
    ['components/builder/field-row.tsx', 'server messages beside the field row they describe'],
    ['components/hosted-playground.tsx', 'invalid JSON, beside the textarea that holds it'],
    /*
     * These two were invisible to the earlier version of this guard: they used
     * `ui-field-error`, and the guard matched `ui-error`, which is not a
     * substring of it. Both are legitimate — a name collision and a missing
     * relation target are properties of the one row they sit in — but they were
     * only ever unlisted by accident, so they are recorded now.
     */
    ['components/builder/endpoint-card.tsx', 'a duplicate endpoint name, beside that name input'],
    ['components/builder/relation-editor.tsx', 'name and target issues, beside their own selects'],
  ]);

  it('appear only where a message belongs beside its control', () => {
    const offenders = files
      // `<FieldError`, not the bare name: the guard is about *rendering* a raw
      // error block, and matching the identifier loosely also hit every file
      // that mentions `onFieldErrors` — six false offenders, all of them
      // routing errors correctly.
      .filter((file) => file.text.includes('<FieldError'))
      .map((file) => file.path)
      .filter((path) => !ALLOWED.has(path));

    expect(
      offenders,
      `Use FormError, ErrorState or a toast — or add the file to ALLOWED with a reason:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('has no stale entries in its allowlist', () => {
    // An allowlist that outlives its reason quietly permits the next regression.
    for (const path of ALLOWED.keys()) {
      const file = files.find((candidate) => candidate.path === path);
      expect(file, `${path} is allowlisted but no longer exists`).toBeDefined();
      expect(file!.text, `${path} no longer renders a FieldError`).toContain('<FieldError');
    }
  });
});

describe('browser dialogs', () => {
  /**
   * §29 of the error spec. `window.confirm` cannot be styled, blocks the whole
   * tab, and is announced by a different path from everything else in the app.
   * The one that existed became a `Modal`.
   */
  it('are never used for product interactions', () => {
    const offenders = files
      .filter((file) => /\bwindow\.(confirm|alert|prompt)\s*\(/.test(file.text))
      .map((file) => file.path);

    expect(offenders, `Use Modal, a toast, or inline validation:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('raw error messages', () => {
  /**
   * The specific bug that started this work:
   *
   *     } catch (cause) { setError((cause as Error).message); }
   *
   * threw away `details[]` and put `IPS validation failed` in a `<p>` under the
   * button. Everything now goes through `normalizeError`, which is also what
   * stops `Failed to fetch` and `undefined` reaching a user.
   */
  it('are not read straight off a thrown value', () => {
    const offenders = files
      // `errors.ts` names the pattern in its docstring, which is the opposite of
      // using it.
      .filter((file) => file.path !== 'lib/errors.ts')
      .filter((file) => /\(cause as Error\)\.message|\(error as Error\)\.message/.test(file.text))
      .map((file) => file.path);

    expect(offenders, `Use normalizeError(cause) instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * `api-client` is the one place allowed to touch `ApiError.message` directly —
   * `errors.ts` reads it to decide whether the server said anything useful.
   * Elsewhere it bypasses the status mapping and the 5xx redaction.
   */
  it('do not read ApiError.message outside the normaliser', () => {
    const offenders = files
      .filter((file) => file.path !== 'lib/errors.ts' && file.path !== 'lib/api-client.ts')
      .filter((file) => /\.error\.message|error instanceof ApiError \? .*\.message/.test(file.text))
      .map((file) => file.path);

    expect(
      offenders,
      `Route through normalizeError so 5xx bodies stay redacted:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('the notification outlet', () => {
  /**
   * Exactly one, mounted outside the page tree. Two would each hold their own
   * position preference and each render the same queue, so every notification
   * would appear twice — which is the failure this whole system exists to
   * remove, reintroduced at the root.
   */
  it('is mounted exactly once', () => {
    const mounts = files.filter(
      (file) => file.path !== 'components/toast-host.tsx' && file.text.includes('<ToastHost'),
    );
    expect(mounts.map((file) => file.path)).toEqual(['app/providers.tsx']);
  });
});

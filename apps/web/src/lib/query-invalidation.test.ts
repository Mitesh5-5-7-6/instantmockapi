import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Every project-derived cache is invalidated when a definition changes.
 *
 * ## The bug this exists to prevent
 *
 * `technical-notes`, `ai-context` and `blueprint` were invalidated by nothing
 * at all. They stayed correct only because the provider's `staleTime` was ten
 * seconds, so everything refetched shortly after any change — invalidation by
 * accident. The cost was four API calls on every tab switch, because each tab
 * page mounts its own `useProject` observer and a remount refetches anything
 * stale.
 *
 * Raising `staleTime` fixed the calls and made the missing invalidation visible
 * instead: a document would then describe a schema the user had already
 * changed. So the two go together, and this is the guard on the half that is
 * easy to forget — a new project-derived query is one line, and remembering to
 * add it to the invalidation list is a separate thought nobody is prompted to
 * have.
 *
 * A source scan rather than a rendered-hook test: `apps/web`'s vitest runs in a
 * node environment with no DOM, so hooks cannot be mounted here. The scan also
 * catches the case a rendered test would miss — a query added months later.
 */

const HOOKS = readFileSync(join(process.cwd(), 'src/lib/hooks.ts'), 'utf8');

/** First segment of every `queryKey: ['x', projectId` in the hooks module. */
function projectScopedQueryKeys(): string[] {
  const found = new Set<string>();
  for (const match of HOOKS.matchAll(/queryKey: \['([a-z-]+)', projectId/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/** The list `projectScopedKeys()` actually invalidates. */
function invalidatedKeys(): string[] {
  const block =
    /function projectScopedKeys\(projectId: string\): unknown\[\]\[\] \{([\s\S]*?)\n\}/.exec(HOOKS);
  if (block === null) {
    throw new Error('projectScopedKeys() not found — did it move or get renamed?');
  }
  const found = new Set<string>();
  for (const match of block[1]!.matchAll(/\['([a-z-]+)', projectId\]/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/**
 * Queries scoped to a project that a *definition* change does not affect.
 *
 * Each one needs a reason, because "it is not in the list" is exactly how the
 * original bug looked.
 */
const NOT_DEFINITION_DERIVED: Record<string, string> = {
  'project-logs':
    'requests the hosted API served — history of traffic, which an edit does not rewrite',
  'project-metrics': 'the same traffic, aggregated',
  /*
   * Comparisons are between two stored snapshots, which are immutable, and the
   * hook already sets `staleTime: Infinity` on that basis. Worth a note rather
   * than silence: when one side is the *current* definition it has no snapshot
   * row, so that one case is not immutable — the compare page remounts on
   * navigation, which is what covers it today.
   */
  'version-compare': 'immutable snapshot pairs; the hook pins staleTime: Infinity for that reason',
};

describe('project-scoped cache invalidation', () => {
  it('finds the queries and the invalidation list', () => {
    // Guards the regexes themselves: a rename that silently matched nothing
    // would make every assertion below vacuously true.
    expect(projectScopedQueryKeys().length).toBeGreaterThan(5);
    expect(invalidatedKeys().length).toBeGreaterThan(5);
  });

  it('invalidates every definition-derived query', () => {
    const invalidated = new Set(invalidatedKeys());
    const missing = projectScopedQueryKeys().filter(
      (key) => !invalidated.has(key) && NOT_DEFINITION_DERIVED[key] === undefined,
    );

    expect(
      missing,
      [
        'These queries are scoped to a project but nothing invalidates them when',
        'its definition changes, so they will serve a stale answer for as long as',
        'their staleTime allows:',
        ...missing.map((key) => `  - ${key}`),
        '',
        'Add each to projectScopedKeys() in hooks.ts, or to NOT_DEFINITION_DERIVED',
        'here with the reason it is unaffected.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no stale entries in its exemption list', () => {
    // An exemption for a query that no longer exists hides the next real one.
    const existing = new Set(projectScopedQueryKeys());
    const gone = Object.keys(NOT_DEFINITION_DERIVED).filter((key) => !existing.has(key));

    expect(gone, `exempted but no longer present: ${gone.join(', ')}`).toEqual([]);
  });

  it('does not invalidate a key nothing queries', () => {
    // The mirror image: an entry in the list that matches no query is dead
    // weight, and reads as coverage that is not there.
    const existing = new Set(projectScopedQueryKeys());
    const orphans = invalidatedKeys().filter((key) => !existing.has(key));

    expect(orphans, `invalidated but never queried: ${orphans.join(', ')}`).toEqual([]);
  });

  /**
   * The one a worker causes, which no mutation can.
   *
   * Generation moves `status`, `currentVersion`, `publishedVersion` and
   * `hosted.url` from outside any request the client made, so the job stream is
   * the only place that can notice. It previously wrote the job and nothing
   * else.
   */
  it('invalidates the project scope when a job settles', () => {
    const stream = /export function useJobStream\([\s\S]*?\n\}/.exec(HOOKS);
    expect(stream, 'useJobStream not found').not.toBeNull();

    const body = stream![0];
    expect(body).toContain('projectScopedKeys(');
    expect(body).toContain("'completed'");
    expect(body).toContain("'failed_partial'");
  });
});

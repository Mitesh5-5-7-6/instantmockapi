import { describe, it, expect } from 'vitest';

import type {
  ChangeImpact,
  ChangeType,
  MatchingReportView,
  SchemaChangeView,
  VersionComparison,
} from './api-types';
import {
  CHANGE_GLYPH,
  IMPACT_CHIP,
  IMPACT_LABEL,
  directionHeading,
  emptyStateMessage,
  formatValue,
  isTruncated,
  matchingNotice,
  summaryLine,
  valuePair,
} from './diff-view';

function change(over: Partial<SchemaChangeView> = {}): SchemaChangeView {
  return {
    kind: 'FIELD_TYPE_CHANGED',
    risk: 'BREAKING',
    aspect: 'both',
    entity: 'User',
    field: 'age',
    path: null,
    before: 'integer',
    after: 'string',
    summary: 'Field User.age type changed from integer to string',
    ...over,
  };
}

function comparison(over: Partial<VersionComparison> = {}): VersionComparison {
  return {
    from: { version: 3, note: null, createdAt: null, source: 'version' },
    to: { version: 4, note: null, createdAt: null, source: 'version' },
    direction: 'forward',
    summary: {
      total: 0,
      changeTypes: { ADDED: 0, REMOVED: 0, MODIFIED: 0, RENAMED: 0 },
      impact: { BREAKING: 0, POTENTIALLY_BREAKING: 0, NON_BREAKING: 0 },
      risk: null,
      affectedEntities: 0,
      affectedEndpoints: 0,
      affectedArtifacts: 0,
    },
    matching: {
      byId: 0,
      byName: 0,
      nameMatchedEntities: [],
      renamesUndetectable: false,
      legacyBothSides: false,
    },
    tree: {
      entities: [],
      project: {
        changes: [],
        counts: {
          total: 0,
          added: 0,
          removed: 0,
          modified: 0,
          renamed: 0,
          breaking: 0,
          potentiallyBreaking: 0,
          nonBreaking: 0,
        },
        impact: null,
      },
      counts: {
        total: 0,
        added: 0,
        removed: 0,
        modified: 0,
        renamed: 0,
        breaking: 0,
        potentiallyBreaking: 0,
        nonBreaking: 0,
      },
    },
    truncated: null,
    affected: [],
    unaffected: [],
    artifacts: [],
    incomplete: false,
    ...over,
  };
}

const matching = (over: Partial<MatchingReportView> = {}): MatchingReportView => ({
  byId: 5,
  byName: 0,
  nameMatchedEntities: [],
  renamesUndetectable: false,
  legacyBothSides: false,
  ...over,
});

describe('glyphs and labels', () => {
  /**
   * §34: colour is never the only indication. Every change shape has a glyph
   * and every impact has a word, so the diff is readable in greyscale and to a
   * screen reader.
   */
  it('gives every change type a glyph', () => {
    const types: ChangeType[] = ['ADDED', 'REMOVED', 'MODIFIED', 'RENAMED'];
    for (const type of types) {
      expect(CHANGE_GLYPH[type], type).toBeTruthy();
    }
  });

  it('gives every impact a word and a chip', () => {
    const impacts: ChangeImpact[] = ['BREAKING', 'POTENTIALLY_BREAKING', 'NON_BREAKING'];
    for (const impact of impacts) {
      expect(IMPACT_LABEL[impact], impact).toBeTruthy();
      expect(IMPACT_CHIP[impact], impact).toBeTruthy();
    }
  });

  it('does not say "breaking" for a merely-possible break', () => {
    // The middle bucket is where the useful information is; collapsing its
    // wording into the outer two is what makes people ignore the axis.
    expect(IMPACT_LABEL.POTENTIALLY_BREAKING).not.toBe(IMPACT_LABEL.BREAKING);
    expect(IMPACT_LABEL.POTENTIALLY_BREAKING).not.toBe(IMPACT_LABEL.NON_BREAKING);
  });
});

describe('formatValue', () => {
  it('distinguishes absent from the string "null"', () => {
    // An added field has no before. Rendering `null` there would claim it used
    // to hold one.
    expect(formatValue(null)).toBeNull();
    expect(formatValue(undefined)).toBeNull();
    expect(formatValue('null')).toBe('null');
  });

  it('renders scalars as themselves rather than as JSON', () => {
    expect(formatValue('integer')).toBe('integer');
    expect(formatValue(3)).toBe('3');
    expect(formatValue(false)).toBe('false');
  });

  it('renders a composite payload as JSON', () => {
    expect(formatValue({ name: 'age', type: 'integer' })).toBe('{"name":"age","type":"integer"}');
  });

  it('shows the preview of a value the server capped', () => {
    const capped = { __truncated: true as const, preview: 'abc…', bytes: 9000 };
    expect(isTruncated(capped)).toBe(true);
    expect(formatValue(capped)).toBe('abc…');
  });
});

describe('valuePair', () => {
  it('carries both sides for a modification', () => {
    expect(valuePair(change())).toEqual({
      before: 'integer',
      after: 'string',
      truncated: false,
    });
  });

  it('leaves the missing side null for an addition', () => {
    const pair = valuePair(
      change({ kind: 'FIELD_ADDED', before: undefined, after: { name: 'x' } }),
    );
    expect(pair.before).toBeNull();
    expect(pair.after).toBe('{"name":"x"}');
  });

  it('reports when the server capped a side', () => {
    const pair = valuePair(change({ after: { __truncated: true, preview: 'big…', bytes: 9000 } }));
    expect(pair.truncated).toBe(true);
  });

  /**
   * §15's side-by-side needs nothing but the change itself.
   *
   * "Side-by-side needs both schemas" is the obvious wrong conclusion — the
   * snapshots deliberately never cross the wire, and a field group already
   * collects that field's type, requiredness and validation changes together.
   */
  it('needs no snapshot to build a side-by-side panel', () => {
    const pair = valuePair(change());
    expect(pair.before).not.toBeNull();
    expect(pair.after).not.toBeNull();
  });
});

describe('summaryLine', () => {
  it('says "no changes" rather than "0 changes"', () => {
    expect(summaryLine(comparison())).toBe('No changes');
  });

  it('breaks the total down by shape', () => {
    const line = summaryLine(
      comparison({
        summary: {
          ...comparison().summary,
          total: 6,
          changeTypes: { ADDED: 2, REMOVED: 1, MODIFIED: 3, RENAMED: 0 },
        },
      }),
    );
    expect(line).toBe('6 changes · 2 added, 1 removed, 3 modified');
  });

  it('omits empty buckets and gets the singular right', () => {
    const line = summaryLine(
      comparison({
        summary: {
          ...comparison().summary,
          total: 1,
          changeTypes: { ADDED: 0, REMOVED: 0, MODIFIED: 0, RENAMED: 1 },
        },
      }),
    );
    expect(line).toBe('1 change · 1 renamed');
  });
});

describe('directionHeading', () => {
  it('states a forward comparison as fact', () => {
    expect(directionHeading(comparison())).toBe('What changed between v3 and v4');
  });

  /**
   * A backward pair is what a rollback *would* do, and the impact report for it
   * is a claim about a hypothetical. "These APIs are affected" would assert
   * something about the present that is not true.
   */
  it('states a backward comparison as a hypothetical', () => {
    const heading = directionHeading(
      comparison({
        direction: 'backward',
        from: { version: 4, note: null, createdAt: null, source: 'version' },
        to: { version: 2, note: null, createdAt: null, source: 'version' },
      }),
    );
    expect(heading).toContain('If you restored v2');
    expect(heading).toContain('would change');
  });
});

describe('matchingNotice', () => {
  /**
   * Three levels, and the gradation is the point: a caveat on a confident
   * comparison trains people to ignore the one that matters.
   */
  it('says nothing when everything was matched by stable id', () => {
    const notice = matchingNotice(matching());
    expect(notice.level).toBe('none');
    expect(notice.message).toBeNull();
  });

  it('badges only the affected groups when the comparison was mixed', () => {
    const notice = matchingNotice(matching({ byName: 2, renamesUndetectable: true }));
    expect(notice.level).toBe('entity');
    expect(notice.message).toContain('matched by name');
  });

  it('warns at page level when neither side had stable ids', () => {
    const notice = matchingNotice(matching({ byId: 0, byName: 4, legacyBothSides: true }));
    expect(notice.level).toBe('page');
    // The consequence has to be stated, not just the fact.
    expect(notice.message).toContain('Renames cannot be detected');
    expect(notice.message).toContain('removal and one addition');
    // And what IS reliable, so the warning does not read as "trust nothing".
    expect(notice.message).toContain('are accurate');
  });

  it('escalates to page level even when no change was name-matched', () => {
    // Two identical legacy snapshots produce no changes, and the warning must
    // still appear — otherwise "no differences" reads as certainty about a
    // comparison that could not have detected a rename in the first place.
    const notice = matchingNotice(matching({ byId: 0, byName: 0, legacyBothSides: true }));
    expect(notice.level).toBe('page');
  });
});

describe('emptyStateMessage', () => {
  it('states no changes plainly when the comparison was id-matched', () => {
    expect(emptyStateMessage(comparison())).toBe('No changes detected between these versions.');
  });

  /**
   * The name fallback is what turns "no changes detected" from a lie into a true
   * claim — under ids-only, two id-less snapshots reported nothing whatever
   * their contents. The footnote says which question was answered.
   */
  it('footnotes it when the comparison rested on names', () => {
    const message = emptyStateMessage(
      comparison({ matching: matching({ legacyBothSides: true }) }),
    );
    expect(message).toContain('compared by name');
  });
});

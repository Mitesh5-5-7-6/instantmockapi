import { describe, it, expect } from 'vitest';
import {
  failedJobEvent,
  mergeActivity,
  projectCreatedEvent,
  versionEvent,
  type ActivityEvent,
} from './activity.js';

function event(id: string, at: string): ActivityEvent {
  return {
    id,
    type: 'project.created',
    at,
    projectId: 'p1',
    projectName: 'Demo',
    text: id,
  };
}

describe('mergeActivity', () => {
  it('interleaves sources into one reverse-chronological feed', () => {
    const a = [event('a2', '2026-05-18T10:00:00.000Z'), event('a1', '2026-05-16T10:00:00.000Z')];
    const b = [event('b1', '2026-05-17T10:00:00.000Z')];
    expect(mergeActivity([a, b], 10).map((entry) => entry.id)).toEqual(['a2', 'b1', 'a1']);
  });

  it('respects the limit', () => {
    const a = [event('a1', '2026-05-18T10:00:00.000Z'), event('a2', '2026-05-17T10:00:00.000Z')];
    expect(mergeActivity([a], 1).map((entry) => entry.id)).toEqual(['a1']);
  });

  it('taking N per source then the global top N loses nothing', () => {
    // The correctness argument for not using $unionWith: an event can only be
    // wrongly dropped if N events from its OWN source outrank it — in which case
    // it was never in the global top N anyway. Verified against a brute-force
    // merge of the full sources.
    const limit = 4;
    const sources = [
      [1, 4, 7, 10, 13, 16]
        .map((day) => event(`a${day}`, `2026-05-${String(day).padStart(2, '0')}T00:00:00.000Z`))
        .reverse(),
      [2, 5, 8, 11, 14, 17]
        .map((day) => event(`b${day}`, `2026-05-${String(day).padStart(2, '0')}T00:00:00.000Z`))
        .reverse(),
      [3, 6, 9, 12, 15, 18]
        .map((day) => event(`c${day}`, `2026-05-${String(day).padStart(2, '0')}T00:00:00.000Z`))
        .reverse(),
    ];

    const capped = mergeActivity(
      sources.map((source) => source.slice(0, limit)),
      limit,
    );
    const brute = mergeActivity(sources, limit);
    expect(capped.map((entry) => entry.id)).toEqual(brute.map((entry) => entry.id));
  });

  it('breaks ties deterministically, so the feed does not reshuffle between renders', () => {
    const sameMoment = '2026-05-18T10:00:00.000Z';
    const forwards = mergeActivity([[event('a', sameMoment)], [event('b', sameMoment)]], 10);
    const backwards = mergeActivity([[event('b', sameMoment)], [event('a', sameMoment)]], 10);
    expect(forwards.map((entry) => entry.id)).toEqual(backwards.map((entry) => entry.id));
  });

  it('handles empty and absent sources', () => {
    expect(mergeActivity([], 5)).toEqual([]);
    expect(mergeActivity([[], []], 5)).toEqual([]);
    const only = [event('a1', '2026-05-18T10:00:00.000Z')];
    expect(mergeActivity([[], only, []], 5).map((entry) => entry.id)).toEqual(['a1']);
  });

  it('returns nothing for a non-positive limit rather than the whole feed', () => {
    expect(mergeActivity([[event('a', '2026-05-18T10:00:00.000Z')]], 0)).toEqual([]);
  });
});

describe('projectCreatedEvent', () => {
  const base = { id: 'p1', name: 'Weather API', createdAt: new Date('2026-05-18T10:00:00.000Z') };

  it('describes creation by how the project was made', () => {
    // There is no separate "imported" event to draw on — inputSource.type is the
    // current value, not a history — so one event carries the right verb.
    expect(projectCreatedEvent({ ...base, inputType: 'swagger' })).toMatchObject({
      type: 'project.imported',
      text: 'Imported an OpenAPI spec into Weather API',
    });
    expect(projectCreatedEvent({ ...base, inputType: 'builder' })).toMatchObject({
      type: 'project.built',
      text: 'Built Weather API in the schema builder',
    });
    expect(projectCreatedEvent({ ...base, inputType: 'json' })).toMatchObject({
      type: 'project.created',
      text: 'Created Weather API from a JSON sample',
    });
  });

  it('namespaces the id so it cannot collide with another source', () => {
    expect(projectCreatedEvent({ ...base, inputType: 'json' }).id).toBe('project:p1');
  });
});

describe('versionEvent', () => {
  const base = {
    id: 'v1',
    projectId: 'p1',
    projectName: 'Student ERP',
    version: 3,
    createdAt: new Date('2026-05-18T10:00:00.000Z'),
  };

  it('quotes the note the version already carries', () => {
    // Version.note is written for exactly this ("Regenerated: zod, openapi"), so
    // the feed reads it rather than diffing two IPS snapshots — which would
    // misattribute edits, because PATCH bumps currentVersion without writing a
    // Version row.
    expect(versionEvent({ ...base, note: 'Regenerated: zod, openapi' }).text).toBe(
      'Regenerated: zod, openapi in Student ERP (v3)',
    );
  });

  it('falls back to a plain verb when there is no note', () => {
    expect(versionEvent({ ...base, note: null }).text).toBe('Generated in Student ERP (v3)');
    expect(versionEvent({ ...base, note: '   ' }).text).toBe('Generated in Student ERP (v3)');
  });
});

describe('failedJobEvent', () => {
  it('says how much of the generation failed', () => {
    expect(
      failedJobEvent({
        id: 'j1',
        projectId: 'p1',
        projectName: 'Demo',
        failed: 3,
        total: 8,
        at: new Date('2026-05-18T10:00:00.000Z'),
      }),
    ).toMatchObject({ type: 'job.failed', text: '3 of 8 artifacts failed for Demo' });
  });
});

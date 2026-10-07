import { describe, it, expect } from 'vitest';
import { firstHostedSegment, parseHostedPath, refPath } from './path.js';

const OID = '6a7da7ff5fbc5ebc7da6062c';
const PID = 'prj_7d5e9a2f1c';
const SID = 'sng_8fa1c2eab0';

describe('parseHostedPath — legacy ObjectId form', () => {
  it('treats a bare project id as the index', () => {
    expect(parseHostedPath(`/p/${OID}`)).toEqual({
      ref: { form: 'legacy', projectId: OID },
      kind: 'index',
    });
  });

  it('parses a collection', () => {
    expect(parseHostedPath(`/p/${OID}/customer`)).toEqual({
      ref: { form: 'legacy', projectId: OID },
      kind: 'collection',
      entity: 'customer',
    });
  });

  it('parses a record', () => {
    expect(parseHostedPath(`/p/${OID}/customer/c-1`)).toEqual({
      ref: { form: 'legacy', projectId: OID },
      kind: 'record',
      entity: 'customer',
      recordId: 'c-1',
    });
  });

  it('rejects a fourth segment', () => {
    expect(parseHostedPath(`/p/${OID}/customer/c-1/extra`)).toBeNull();
  });

  it('accepts uppercase hex', () => {
    expect(parseHostedPath(`/p/${OID.toUpperCase()}/customer`)?.kind).toBe('collection');
  });
});

describe('parseHostedPath — pretty publicId form', () => {
  it('treats {publicId}/{slug} as the index', () => {
    expect(parseHostedPath(`/p/${PID}/student-erp`)).toEqual({
      ref: { form: 'pretty', publicId: PID, slug: 'student-erp' },
      kind: 'index',
    });
  });

  it('parses a collection', () => {
    expect(parseHostedPath(`/p/${PID}/student-erp/student`)).toEqual({
      ref: { form: 'pretty', publicId: PID, slug: 'student-erp' },
      kind: 'collection',
      entity: 'student',
    });
  });

  it('parses a record', () => {
    expect(parseHostedPath(`/p/${PID}/student-erp/student/1`)).toEqual({
      ref: { form: 'pretty', publicId: PID, slug: 'student-erp' },
      kind: 'record',
      entity: 'student',
      recordId: '1',
    });
  });

  it('accepts the single-API prefix', () => {
    expect(parseHostedPath(`/p/${SID}/weather/current`)?.kind).toBe('collection');
  });

  it('rejects a bare public id — the slug segment is part of the base URL', () => {
    expect(parseHostedPath(`/p/${PID}`)).toBeNull();
  });

  it('rejects a fifth segment', () => {
    expect(parseHostedPath(`/p/${PID}/student-erp/student/1/marks`)).toBeNull();
  });

  it('rejects an uppercase public id', () => {
    expect(parseHostedPath(`/p/PRJ_7D5E9A2F1C/student-erp/student`)).toBeNull();
  });

  it('rejects a public id shorter than the minimum', () => {
    expect(parseHostedPath('/p/prj_7d5e9/student-erp/student')).toBeNull();
  });
});

describe('parseHostedPath — the disjointness that makes one wildcard route work', () => {
  // 3 segments mean different things depending on the first segment alone: an
  // ObjectId can never contain '_', and prj_/sng_ can never be 24 hex chars.
  it('reads 3 segments as entity+recordId under a legacy id', () => {
    expect(parseHostedPath(`/p/${OID}/customer/c-1`)!.kind).toBe('record');
  });

  it('reads 3 segments as slug+entity under a public id', () => {
    expect(parseHostedPath(`/p/${PID}/student-erp/student`)!.kind).toBe('collection');
  });
});

describe('parseHostedPath — malformed input', () => {
  it.each([
    ['not the hosted prefix', '/v1/projects'],
    ['empty', ''],
    ['root', '/'],
    ['prefix only', '/p'],
    ['unknown id shape', '/p/whatever/customer'],
    ['malformed percent escape', `/p/${OID}/%zz`],
  ])('returns null for %s', (_label, url) => {
    expect(parseHostedPath(url)).toBeNull();
  });

  it('collapses repeated slashes', () => {
    expect(parseHostedPath(`/p//${OID}//customer//`)).toEqual({
      ref: { form: 'legacy', projectId: OID },
      kind: 'collection',
      entity: 'customer',
    });
  });

  it('strips the query string', () => {
    expect(parseHostedPath(`/p/${OID}/customer?page=2&limit=5`)).toEqual({
      ref: { form: 'legacy', projectId: OID },
      kind: 'collection',
      entity: 'customer',
    });
  });

  it('strips a fragment', () => {
    expect(parseHostedPath(`/p/${OID}/customer#top`)?.kind).toBe('collection');
  });

  it('percent-decodes segments', () => {
    expect(parseHostedPath(`/p/${OID}/customer/a%20b`)).toMatchObject({ recordId: 'a b' });
  });
});

describe('firstHostedSegment', () => {
  it('returns the id segment for both forms', () => {
    expect(firstHostedSegment(`/p/${OID}/customer`)).toBe(OID);
    expect(firstHostedSegment(`/p/${PID}/student-erp/student`)).toBe(PID);
  });

  it('returns null off the hosted prefix', () => {
    expect(firstHostedSegment('/health/live')).toBeNull();
    expect(firstHostedSegment('/p')).toBeNull();
  });

  it('does not validate the segment — the limiter only needs a bucket key', () => {
    expect(firstHostedSegment('/p/garbage/customer')).toBe('garbage');
  });
});

describe('refPath', () => {
  it('rebuilds the prefix the caller used', () => {
    expect(refPath({ form: 'legacy', projectId: OID })).toBe(`/p/${OID}`);
    expect(refPath({ form: 'pretty', publicId: PID, slug: 'student-erp' })).toBe(
      `/p/${PID}/student-erp`,
    );
  });
});

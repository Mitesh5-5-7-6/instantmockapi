import { describe, it, expect } from 'vitest';

import { ApiError, NetworkError } from './api-client';
import { countAffectedPaths, isSessionExpiry, normalizeError } from './errors';

const api = (
  status: number,
  message: string,
  details?: { path: string; issue: string }[],
  requestId?: string,
) => new ApiError(status, 'CODE', message, details, requestId);

describe('status mapping', () => {
  /** Every row of §16 of the error spec, when the server says nothing useful. */
  it.each([
    [400, 'Request could not be processed'],
    [401, 'Your session has expired'],
    [403, "You don't have permission to do that"],
    [404, 'Not found'],
    [409, 'This has changed since you loaded it'],
    [422, 'Some details need fixing'],
    [429, 'Too many requests'],
    [500, 'Something went wrong on the server'],
    [502, 'The service is temporarily unavailable'],
    [503, 'The service is temporarily unavailable'],
    [504, 'The service took too long to respond'],
  ])('%i reads as "%s"', (status, title) => {
    expect(normalizeError(api(status, `Request failed with status ${status}`)).title).toBe(title);
  });

  it.each([
    [400, 'VALIDATION'],
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'VALIDATION'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('%i classifies as %s', (status, kind) => {
    expect(normalizeError(api(status, '')).kind).toBe(kind);
  });

  it('falls back for a status it has never seen', () => {
    const failure = normalizeError(api(418, ''));
    expect(failure.title).toBe('Request could not be processed');
    expect(failure.kind).toBe('UNKNOWN');
  });
});

describe('choosing between the server message and our own', () => {
  /**
   * §16 closes with "prefer the backend message when it is useful". Discarding
   * `IPS validation failed` for a generic 422 sentence would throw away the only
   * specific thing known about the failure.
   */
  it('prefers a specific server message', () => {
    expect(normalizeError(api(422, 'IPS validation failed')).title).toBe('IPS validation failed');
    expect(normalizeError(api(409, "You already have a project using the slug 'shop'")).title).toBe(
      "You already have a project using the slug 'shop'",
    );
  });

  it('ignores the placeholder parseError produces for a bodyless response', () => {
    expect(normalizeError(api(404, 'Request failed with status 404')).title).toBe('Not found');
  });

  it('ignores an empty or whitespace message', () => {
    expect(normalizeError(api(403, '')).title).toBe("You don't have permission to do that");
    expect(normalizeError(api(403, '   ')).title).toBe("You don't have permission to do that");
  });

  /**
   * A 5xx message is a stack-adjacent internal string. The API already replaces
   * it, and echoing anything from that range would leak implementation detail
   * for no user benefit.
   */
  it('never echoes a 5xx body, even a specific-looking one', () => {
    expect(normalizeError(api(500, 'Internal server error')).title).toBe(
      'Something went wrong on the server',
    );
    expect(
      normalizeError(api(500, 'MongoServerError: E11000 duplicate key on projects.$slug_1')).title,
    ).toBe('Something went wrong on the server');
    expect(normalizeError(api(503, 'ECONNREFUSED 127.0.0.1:6379')).title).toBe(
      'The service is temporarily unavailable',
    );
  });
});

describe('field detail', () => {
  const details = [
    { path: 'entities[1].fields[1].name', issue: 'Field name must be alphanumeric' },
    { path: 'entities[2].name', issue: 'Entity name is invalid' },
  ];

  it('is carried through for inline mapping and the details panel', () => {
    expect(normalizeError(api(422, 'IPS validation failed', details)).details).toEqual(details);
  });

  /**
   * The toast says how much is wrong rather than quoting the first issue — the
   * user is about to look at the form, where each issue sits beside its field.
   */
  it('summarises as a count rather than quoting one issue', () => {
    expect(normalizeError(api(422, 'IPS validation failed', details)).detail).toBe(
      '2 fields need attention.',
    );
  });

  it('is singular for one field', () => {
    expect(normalizeError(api(422, 'nope', [details[0]!])).detail).toBe('1 field needs attention.');
  });

  it('counts each path once, however many issues it carries', () => {
    const repeated = [
      { path: 'entities[0].name', issue: 'is required' },
      { path: 'entities[0].name', issue: 'must be alphanumeric' },
    ];
    expect(countAffectedPaths(repeated)).toBe(1);
    expect(normalizeError(api(422, 'nope', repeated)).detail).toBe('1 field needs attention.');
  });

  it('falls back to the status hint when there is no field detail', () => {
    expect(normalizeError(api(429, '')).detail).toBe('Please try again shortly.');
  });

  it('leaves the second line empty rather than padding it', () => {
    expect(normalizeError(api(400, 'Bad shape')).detail).toBeNull();
  });
});

describe('network failures', () => {
  /**
   * §17: `Failed to fetch`, `undefined`, `AxiosError` and friends must never
   * reach a user. This is the interception point.
   */
  it('read as a connection problem, not the browser’s wording', () => {
    const failure = normalizeError(new NetworkError(new TypeError('Failed to fetch')));
    expect(failure.kind).toBe('NETWORK');
    expect(failure.title).toBe('Connection failed');
    expect(failure.detail).toBe("We couldn't reach the API. Check your connection and try again.");
    expect(JSON.stringify(failure)).not.toContain('Failed to fetch');
  });

  it('has no status or code to report', () => {
    const failure = normalizeError(new NetworkError(new Error('offline')));
    expect(failure.status).toBeNull();
    expect(failure.details).toEqual([]);
  });
});

describe('anything else thrown', () => {
  it('is a bug, and says so without exposing the message', () => {
    const failure = normalizeError(
      new TypeError("Cannot read properties of undefined (reading 'x')"),
    );
    expect(failure.kind).toBe('UNKNOWN');
    expect(failure.title).toBe('Something went wrong');
    // The message is kept for the details panel, not shown as the headline.
    expect(failure.details[0]?.issue).toContain('Cannot read properties');
  });

  it('survives a thrown non-Error', () => {
    expect(normalizeError('boom').title).toBe('Something went wrong');
    expect(normalizeError(undefined).title).toBe('Something went wrong');
    expect(normalizeError(null).title).toBe('Something went wrong');
    expect(normalizeError({ nope: true }).title).toBe('Something went wrong');
  });

  /** `[object Object]` is exactly the string this module exists to prevent. */
  it('never puts a stringified object in the title', () => {
    expect(normalizeError({ nope: true }).title).not.toContain('object Object');
  });
});

describe('deduplication keys', () => {
  /**
   * §20: one user action produces at most one notification. The key is what lets
   * a repeat refresh the existing toast instead of stacking a second identical
   * one.
   */
  it('are stable across identical failures', () => {
    expect(normalizeError(api(422, 'IPS validation failed')).key).toBe(
      normalizeError(api(422, 'IPS validation failed')).key,
    );
  });

  it('differ when the message differs', () => {
    expect(normalizeError(api(422, 'IPS validation failed')).key).not.toBe(
      normalizeError(api(422, 'Slug already taken')).key,
    );
  });

  it('differ when the status differs', () => {
    expect(normalizeError(api(404, 'Nope')).key).not.toBe(normalizeError(api(403, 'Nope')).key);
  });

  /**
   * Every network failure is the same failure to a user, so a retry loop must
   * not produce a column of identical toasts.
   */
  it('collapse every network failure to one', () => {
    expect(normalizeError(new NetworkError(new Error('a'))).key).toBe(
      normalizeError(new NetworkError(new Error('b'))).key,
    );
  });

  /** 5xx messages are not shown, so they must not split the key either. */
  it('collapse 5xx failures with different internal messages', () => {
    expect(normalizeError(api(500, 'Mongo timeout')).key).toBe(
      normalizeError(api(500, 'Redis timeout')).key,
    );
  });
});

describe('correlation', () => {
  it('carries a request id when the API supplied one', () => {
    expect(normalizeError(api(500, '', undefined, 'req_8f3c1a2b')).requestId).toBe('req_8f3c1a2b');
  });

  it('is null when it did not', () => {
    expect(normalizeError(api(500, '')).requestId).toBeNull();
  });

  /** The id is for the details panel; it must never become the message. */
  it('never appears in the title or detail', () => {
    const failure = normalizeError(api(500, '', undefined, 'req_8f3c1a2b'));
    expect(failure.title).not.toContain('req_');
    expect(failure.detail ?? '').not.toContain('req_');
  });
});

describe('isSessionExpiry', () => {
  /**
   * A 401 that survives the client's refresh-and-retry means the session is
   * genuinely gone, and the answer is the auth flow rather than a toast the user
   * reads on the way to the sign-in page.
   */
  it('is true only for auth failures', () => {
    expect(isSessionExpiry(normalizeError(api(401, '')))).toBe(true);
    expect(isSessionExpiry(normalizeError(api(403, '')))).toBe(false);
    expect(isSessionExpiry(normalizeError(new NetworkError(new Error())))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { isOwner, assertOwnership } from './ownership.js';

const OWNER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';

/** Stand-in for a Mongo ObjectId: only its string form matters. */
const objectIdLike = (hex: string) => ({ toString: () => hex });

describe('isOwner', () => {
  it('matches identical string ids', () => {
    expect(isOwner(OWNER, OWNER)).toBe(true);
  });

  it('matches ObjectId-like owners against the token sub', () => {
    expect(isOwner(objectIdLike(OWNER), OWNER)).toBe(true);
  });

  it('rejects a different user', () => {
    expect(isOwner(OWNER, OTHER)).toBe(false);
    expect(isOwner(objectIdLike(OWNER), OTHER)).toBe(false);
  });
});

describe('assertOwnership', () => {
  it('returns ok for the owner', () => {
    const res = assertOwnership(objectIdLike(OWNER), OWNER, 'Project');
    expect(res.ok).toBe(true);
  });

  it('returns NOT_FOUND (404) for non-owners so existence is not leaked', () => {
    const res = assertOwnership(OWNER, OTHER, 'Project');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('NOT_FOUND');
      expect(res.error.statusCode).toBe(404);
      expect(res.error.message).toBe('Project not found');
    }
  });
});

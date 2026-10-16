import { describe, expect, it } from 'vitest';
import { LIMITS, calculateExpiresAt, canCreateJob } from './limits.js';

describe('limits', () => {
  it('gives every account 30-day hosting, 10 projects and 3 concurrent jobs', () => {
    expect(LIMITS).toEqual({ hostedApiLifetimeDays: 30, maxProjects: 10, maxConcurrentJobs: 3 });
  });

  it('expires a hosted API 30 days after it is published', () => {
    const published = new Date('2026-10-15T12:00:00.000Z');
    expect(calculateExpiresAt(published).toISOString()).toBe('2026-11-14T12:00:00.000Z');
  });

  it('allows a job only while fewer than the limit are in flight', () => {
    expect(canCreateJob(0)).toBe(true);
    expect(canCreateJob(2)).toBe(true);
    expect(canCreateJob(3)).toBe(false);
  });
});

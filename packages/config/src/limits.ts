/**
 * Platform limits — the single source of truth for usage limits.
 *
 * There are no plans: every account gets the same limits. Every component that
 * needs one imports it from here rather than restating the number.
 */

export interface Limits {
  /** How long a hosted API stays live after its first publish, in days. */
  readonly hostedApiLifetimeDays: number;
  /** Generation jobs one account may have queued or running at once. */
  readonly maxConcurrentJobs: number;
  /** Projects one account may own. */
  readonly maxProjects: number;
}

export const LIMITS: Limits = {
  hostedApiLifetimeDays: 30,
  maxConcurrentJobs: 3,
  maxProjects: 10,
};

/** When a hosted API published at `from` expires. */
export function calculateExpiresAt(from: Date = new Date()): Date {
  const expiresAt = new Date(from);
  expiresAt.setDate(expiresAt.getDate() + LIMITS.hostedApiLifetimeDays);
  return expiresAt;
}

/** Whether an account with `activeJobCount` jobs in flight may start another. */
export function canCreateJob(activeJobCount: number): boolean {
  return activeJobCount < LIMITS.maxConcurrentJobs;
}

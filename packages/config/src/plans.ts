/**
 * Plan limits — the single source of truth for plan-based values.
 *
 * "Free = 2 days / 1 job" lives in exactly one place (doc 05 §5, doc 17 §3.6).
 * Every component that needs plan limits imports from here.
 */

import type { PlanTier } from '@instantmockapi/shared';

// ---------------------------------------------------------------------------
// Plan configuration
// ---------------------------------------------------------------------------

export interface PlanConfig {
  /** Hosted API lifetime in days (doc 01 §7) */
  readonly hostedApiLifetimeDays: number;
  /** Maximum concurrent generation jobs (doc 02 §7) */
  readonly maxConcurrentJobs: number;
  /** Maximum projects (0 = unlimited) */
  readonly maxProjects: number;
}

/**
 * Plan limits table — matches doc 01 §7, doc 02 §7 exactly.
 *
 * | Plan       | Hosted API | Concurrent Jobs |
 * |------------|------------|-----------------|
 * | Free       | 2 days     | 1               |
 * | Pro        | 7 days     | 3               |
 * | Enterprise | 30 days    | Unlimited       |
 */
export const PLAN_CONFIGS: Readonly<Record<PlanTier, PlanConfig>> = {
  free: {
    hostedApiLifetimeDays: 2,
    maxConcurrentJobs: 1,
    maxProjects: 10,
  },
  pro: {
    hostedApiLifetimeDays: 7,
    maxConcurrentJobs: 3,
    maxProjects: 100,
  },
  enterprise: {
    hostedApiLifetimeDays: 30,
    maxConcurrentJobs: Infinity,
    maxProjects: 0, // unlimited
  },
} as const;

/** Get the plan config for a tier. */
export function getPlanConfig(tier: PlanTier): PlanConfig {
  return PLAN_CONFIGS[tier];
}

/** Calculate the expiration date for a hosted API based on plan tier. */
export function calculateExpiresAt(tier: PlanTier, from: Date = new Date()): Date {
  const config = getPlanConfig(tier);
  const expiresAt = new Date(from);
  expiresAt.setDate(expiresAt.getDate() + config.hostedApiLifetimeDays);
  return expiresAt;
}

/** Check if a user can create a new generation job given their active count. */
export function canCreateJob(tier: PlanTier, activeJobCount: number): boolean {
  const config = getPlanConfig(tier);
  return activeJobCount < config.maxConcurrentJobs;
}

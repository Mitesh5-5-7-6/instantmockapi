// @instantmockapi/config — plan limits, environment configuration
// The single source of truth for plan values and env loading (doc 05 §5).

export {
  PLAN_CONFIGS,
  type PlanConfig,
  getPlanConfig,
  calculateExpiresAt,
  canCreateJob,
} from './plans.js';

export {
  type EnvConfig,
  loadEnvConfig,
  assertProductionSecrets,
  productionConfigProblems,
  DEV_JWT_SECRET,
} from './env.js';

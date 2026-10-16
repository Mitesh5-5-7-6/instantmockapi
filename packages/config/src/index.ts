// @instantmockapi/config — platform limits, environment configuration
// The single source of truth for limit values and env loading (doc 05 §5).

export { LIMITS, type Limits, calculateExpiresAt, canCreateJob } from './limits.js';

export {
  type EnvConfig,
  loadEnvConfig,
  assertProductionSecrets,
  productionConfigProblems,
  DEV_JWT_SECRET,
} from './env.js';

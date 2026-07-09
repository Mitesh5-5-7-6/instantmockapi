/**
 * Environment configuration loader.
 *
 * Reads config from environment variables with sensible defaults.
 * Secrets are never hardcoded (doc 13 §6, doc 17 §3.6).
 */

export interface EnvConfig {
  /** Application environment */
  readonly nodeEnv: 'development' | 'staging' | 'production';

  /** Platform API port */
  readonly apiPort: number;

  /** Mock runtime port */
  readonly mockRuntimePort: number;

  /** Web app port */
  readonly webPort: number;

  /** MongoDB connection string */
  readonly mongoUri: string;

  /** Redis connection string */
  readonly redisUrl: string;

  /** S3-compatible object storage */
  readonly s3Endpoint: string;
  readonly s3Bucket: string;
  readonly s3AccessKey: string;
  readonly s3SecretKey: string;

  /** JWT signing secret */
  readonly jwtSecret: string;

  /** JWT token lifetime in seconds */
  readonly jwtExpiresIn: number;

  /** Platform API rate limit (requests per minute per user) */
  readonly rateLimitPerMinute: number;

  /** Mock API rate limit (requests per minute per project) */
  readonly mockRateLimitPerMinute: number;

  /** IPS maximum nesting depth (doc 04 §F3) */
  readonly maxNestingDepth: number;

  /** Default mock records per entity */
  readonly defaultMockRecords: number;

  /** Max mock records per entity */
  readonly maxMockRecords: number;

  /** Max request body size in bytes */
  readonly maxRequestBodySize: number;

  /** Max pagination limit */
  readonly maxPaginationLimit: number;

  /** Log level */
  readonly logLevel: string;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Load environment configuration.
 * Call once at app startup; pass the result to constructors/factories.
 */
export function loadEnvConfig(): EnvConfig {
  return {
    nodeEnv: (envStr('NODE_ENV', 'development') as EnvConfig['nodeEnv']),
    apiPort: envInt('API_PORT', 4000),
    mockRuntimePort: envInt('MOCK_RUNTIME_PORT', 4001),
    webPort: envInt('WEB_PORT', 3000),
    mongoUri: envStr('MONGO_URI', 'mongodb://localhost:27017/instantmockapi'),
    redisUrl: envStr('REDIS_URL', 'redis://localhost:6379'),
    s3Endpoint: envStr('S3_ENDPOINT', 'http://localhost:9000'),
    s3Bucket: envStr('S3_BUCKET', 'instantmockapi-artifacts'),
    s3AccessKey: envStr('S3_ACCESS_KEY', ''),
    s3SecretKey: envStr('S3_SECRET_KEY', ''),
    jwtSecret: envStr('JWT_SECRET', 'dev-secret-change-in-production'),
    jwtExpiresIn: envInt('JWT_EXPIRES_IN', 3600),
    rateLimitPerMinute: envInt('RATE_LIMIT_PER_MINUTE', 100),
    mockRateLimitPerMinute: envInt('MOCK_RATE_LIMIT_PER_MINUTE', 200),
    maxNestingDepth: envInt('MAX_NESTING_DEPTH', 10),
    defaultMockRecords: envInt('DEFAULT_MOCK_RECORDS', 25),
    maxMockRecords: envInt('MAX_MOCK_RECORDS', 1000),
    maxRequestBodySize: envInt('MAX_REQUEST_BODY_SIZE', 1_048_576), // 1MB
    maxPaginationLimit: envInt('MAX_PAGINATION_LIMIT', 100),
    logLevel: envStr('LOG_LEVEL', 'info'),
  };
}

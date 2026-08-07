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

  /**
   * Whether cache traffic may use Redis at all. False → CacheService runs
   * L1-only. The generation queue always needs Redis and ignores this.
   */
  readonly redisEnabled: boolean;

  /** Max entries held in the in-process L1 cache */
  readonly cacheL1MaxEntries: number;

  /** Max total bytes held in the in-process L1 cache */
  readonly cacheL1MaxBytes: number;

  /** Ceiling on how long L1 may serve a value without re-checking Redis */
  readonly cacheL1TtlSeconds: number;

  /** Redis TTL for hosted-config blobs (key is content-addressed) */
  readonly cacheConfigTtlSeconds: number;

  /** Redis TTL for mock seed record sets */
  readonly cacheSeedTtlSeconds: number;

  /** L1 TTL for mock seed record sets — bounds cross-replica write staleness */
  readonly cacheSeedL1TtlSeconds: number;

  /** How long an idle queue worker blocks on Redis before re-polling */
  readonly queueDrainDelaySeconds: number;

  /** Interval between BullMQ stalled-job sweeps */
  readonly queueStalledIntervalMs: number;

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

  /** Artifact storage backend: 'mongo' (GridFS) or 's3' (object storage) */
  readonly storageDriver: string;

  /** GridFS bucket name used when storageDriver is 'mongo' */
  readonly storageMongoBucket: string;

  /** Public base URL of the hosted mock runtime (…/p). Hosted API URLs are
   * built as `${hostedBaseUrl}/${projectId}`. Override per-deployment. */
  readonly hostedBaseUrl: string;
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

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

/**
 * Redis is opt-out in deployed environments and opt-in locally: a developer
 * with no REDIS_URL set gets the in-memory cache rather than a connection
 * error, while an explicit REDIS_ENABLED always wins.
 */
function resolveRedisEnabled(nodeEnv: string): boolean {
  if (process.env['REDIS_ENABLED'] !== undefined) {
    return envBool('REDIS_ENABLED', true);
  }
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return process.env['REDIS_URL'] !== undefined;
  }
  return true;
}

/**
 * Load environment configuration.
 * Call once at app startup; pass the result to constructors/factories.
 */
export function loadEnvConfig(): EnvConfig {
  const nodeEnv = envStr('NODE_ENV', 'development');
  return {
    nodeEnv: nodeEnv as EnvConfig['nodeEnv'],
    apiPort: envInt('API_PORT', 4000),
    mockRuntimePort: envInt('MOCK_RUNTIME_PORT', 4001),
    webPort: envInt('WEB_PORT', 3000),
    mongoUri: envStr('MONGO_URI', 'mongodb://localhost:27017/instantmockapi'),
    redisUrl: envStr('REDIS_URL', 'redis://localhost:6379'),
    redisEnabled: resolveRedisEnabled(nodeEnv),
    cacheL1MaxEntries: envInt('CACHE_L1_MAX_ENTRIES', 500),
    cacheL1MaxBytes: envInt('CACHE_L1_MAX_BYTES', 16 * 1024 * 1024), // 16MB
    cacheL1TtlSeconds: envInt('CACHE_L1_TTL_SECONDS', 60),
    // Safe to keep for an hour: the key embeds version + generatedAt, so a
    // regenerate produces a different key rather than a stale hit.
    cacheConfigTtlSeconds: envInt('CACHE_CONFIG_TTL_SECONDS', 3600),
    // Same content-addressing applies; runtime writes invalidate explicitly.
    cacheSeedTtlSeconds: envInt('CACHE_SEED_TTL_SECONDS', 900),
    cacheSeedL1TtlSeconds: envInt('CACHE_SEED_L1_TTL_SECONDS', 5),
    queueDrainDelaySeconds: envInt('QUEUE_DRAIN_DELAY_SECONDS', 60),
    queueStalledIntervalMs: envInt('QUEUE_STALLED_INTERVAL_MS', 300_000),
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
    storageDriver: envStr('STORAGE_DRIVER', 'mongo'),
    storageMongoBucket: envStr('STORAGE_MONGO_BUCKET', 'artifacts'),
    hostedBaseUrl: envStr('HOSTED_BASE_URL', 'https://api.instantmockapi.dev/p'),
  };
}

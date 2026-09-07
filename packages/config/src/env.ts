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

  /**
   * Access-token lifetime in seconds.
   *
   * Short on purpose (doc 13 §1): revocation via `tokenVersion` is checked on
   * refresh, not on every request, so an already-issued access token outlives a
   * password reset by at most this long. Refreshing is cheap; an hour of
   * exposure is not.
   */
  readonly jwtExpiresIn: number;

  /**
   * Exact origin the web app is served from. Used for CORS, which with
   * credentialed requests may not answer `*` — the browser rejects a wildcard
   * whenever cookies are involved.
   */
  readonly webOrigin: string;

  /**
   * Public URL of the web app, used to build the links inside emails. Usually
   * identical to `webOrigin`; kept separate because a link may need to point at
   * a canonical marketing domain while CORS still names the app origin.
   */
  readonly appUrl: string;

  /** Resend API key. Empty ⇒ email is printed to the log instead of sent. */
  readonly resendApiKey: string;

  /** From address for transactional mail, e.g. `InstantMockAPI <no-reply@…>`. */
  readonly emailFrom: string;

  /** Google OAuth client id (public; also needed by the web app). */
  readonly googleClientId: string;

  /** Google OAuth client secret. Never leaves the API. */
  readonly googleClientSecret: string;

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

  /**
   * Ceiling on how many changes one version comparison serialises.
   *
   * The worst case is ordinary rather than adversarial: v1 of one design
   * compared against v9 after a re-parse shares nothing, and `validateIPS`
   * caps neither entity nor field count — so every element on both sides
   * becomes a change and the response is megabytes nobody can read.
   *
   * Only the BODY is capped. The counts in the summary are always computed over
   * the full set, so the header stays true when the list below it is elided.
   */
  readonly maxDiffChanges: number;

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

/**
 * The published default. Named rather than inlined so the production guard can
 * compare against the same literal the loader falls back to — two copies of the
 * string would eventually drift and quietly disarm the check.
 */
export const DEV_JWT_SECRET = 'dev-secret-change-in-production';

/** Below this a JWT_SECRET is short enough to be worth brute-forcing offline. */
const MIN_JWT_SECRET_LENGTH = 32;

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
  const webPort = envInt('WEB_PORT', 3000);
  const webOrigin = envStr('WEB_ORIGIN', `http://localhost:${webPort}`);
  return {
    nodeEnv: nodeEnv as EnvConfig['nodeEnv'],
    apiPort: envInt('API_PORT', 4000),
    mockRuntimePort: envInt('MOCK_RUNTIME_PORT', 4001),
    webPort,
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
    jwtSecret: envStr('JWT_SECRET', DEV_JWT_SECRET),
    jwtExpiresIn: envInt('JWT_EXPIRES_IN', 900),
    webOrigin,
    appUrl: envStr('APP_URL', webOrigin),
    resendApiKey: envStr('RESEND_API_KEY', ''),
    emailFrom: envStr('EMAIL_FROM', 'InstantMockAPI <no-reply@instantmockapi.dev>'),
    googleClientId: envStr('GOOGLE_CLIENT_ID', ''),
    googleClientSecret: envStr('GOOGLE_CLIENT_SECRET', ''),
    rateLimitPerMinute: envInt('RATE_LIMIT_PER_MINUTE', 100),
    mockRateLimitPerMinute: envInt('MOCK_RATE_LIMIT_PER_MINUTE', 200),
    maxNestingDepth: envInt('MAX_NESTING_DEPTH', 10),
    defaultMockRecords: envInt('DEFAULT_MOCK_RECORDS', 25),
    maxMockRecords: envInt('MAX_MOCK_RECORDS', 1000),
    maxRequestBodySize: envInt('MAX_REQUEST_BODY_SIZE', 1_048_576), // 1MB
    maxPaginationLimit: envInt('MAX_PAGINATION_LIMIT', 100),
    maxDiffChanges: envInt('MAX_DIFF_CHANGES', 2000),
    logLevel: envStr('LOG_LEVEL', 'info'),
    storageDriver: envStr('STORAGE_DRIVER', 'mongo'),
    storageMongoBucket: envStr('STORAGE_MONGO_BUCKET', 'artifacts'),
    hostedBaseUrl: envStr('HOSTED_BASE_URL', 'https://api.instantmockapi.dev/p'),
  };
}

/**
 * Every way the configuration is unfit for production, or an empty list.
 *
 * Split from the thrower so tests can read the reasons without catching, and so
 * a deployment script can report all of them at once instead of one per restart.
 *
 * Returns an empty list for any non-production environment — a developer must be
 * able to run the whole stack with nothing configured.
 */
export function productionConfigProblems(config: EnvConfig): string[] {
  if (config.nodeEnv !== 'production') {
    return [];
  }
  const problems: string[] = [];

  if (config.jwtSecret === DEV_JWT_SECRET) {
    // The worst failure mode available: the default is in a public repository,
    // so anyone can mint a token for any account.
    problems.push('JWT_SECRET is still the published development default');
  } else if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    problems.push(
      `JWT_SECRET is ${config.jwtSecret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required`,
    );
  }

  if (config.resendApiKey === '') {
    // Without a mail transport signup and password reset are both dead ends —
    // the link is only written to the log, where nobody will read it.
    problems.push('RESEND_API_KEY is empty, so no verification or reset email can be delivered');
  }

  if (config.googleClientId === '' || config.googleClientSecret === '') {
    problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Google sign-in');
  }

  if (!config.appUrl.startsWith('https://')) {
    // Email links land in a browser that will drop the auth cookie on http, and
    // an emailed token over http is readable in transit.
    problems.push(`APP_URL must be https in production (got "${config.appUrl}")`);
  }

  return problems;
}

/**
 * Throw unless the configuration is fit for production. Called at boot, before
 * anything listens.
 *
 * Refusing to start is deliberately louder than a warning: a warning scrolls
 * past in a deploy log and the service runs anyway, on a secret everyone knows.
 */
export function assertProductionSecrets(config: EnvConfig): void {
  const problems = productionConfigProblems(config);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
}

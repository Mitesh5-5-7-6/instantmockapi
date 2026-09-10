import dns from 'node:dns';
import mongoose from 'mongoose';
import { logger, getErrorMessage } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';

let isConnected = false;

/**
 * The in-flight connect, so concurrent first callers share one attempt.
 *
 * `isConnected` alone is not enough (Phase 6 §11). It only flips *after*
 * `mongoose.connect` resolves, so two callers racing on a cold start both read
 * `false` and both enter the retry loop — and with the loop's 15 attempts that
 * is not a momentary overlap but two independent connect sequences, which is
 * precisely the "connection storm when multiple requests arrive after a cold
 * start" §11 warns about.
 *
 * Cleared on failure, so a failed boot does not poison later attempts.
 */
let connecting: Promise<typeof mongoose> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Some hosts leave Node's c-ares resolver pointed at 127.0.0.1 (or an IPv6
 * link-local address) with no local DNS daemon listening, which breaks the
 * `mongodb+srv://` SRV lookup with ECONNREFUSED even though the OS resolver
 * works. Setting DNS_SERVERS (e.g. "8.8.8.8,1.1.1.1") overrides c-ares for
 * this process. Unset in production, where the platform provides working DNS.
 */
function applyDnsOverride(): void {
  const raw = process.env['DNS_SERVERS'];
  if (!raw) return;
  const servers = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (servers.length === 0) return;
  dns.setServers(servers);
  logger.info('Applied DNS server override for name resolution', { servers });
}

/**
 * Connect to MongoDB database using Mongoose.
 * Reuses existing connection if already established.
 */
export async function connectDB(customUri?: string): Promise<typeof mongoose> {
  if (isConnected) {
    logger.debug('Reusing active MongoDB connection');
    return mongoose;
  }
  if (connecting) {
    logger.debug('Joining in-flight MongoDB connection');
    return connecting;
  }

  connecting = openConnection(customUri).finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openConnection(customUri?: string): Promise<typeof mongoose> {
  applyDnsOverride();

  const env = loadEnvConfig();
  const uri = customUri ?? env.mongoUri;

  logger.info(`Connecting to MongoDB...`, { uri: uri.replace(/:([^:@]+)@/, ':****@') });

  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info('MongoDB connected successfully');
  });

  mongoose.connection.on('error', (err) => {
    isConnected = false;
    logger.error('MongoDB connection error', { error: err.message });
  });

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('MongoDB disconnected');
  });

  // Retry the INITIAL connection with backoff. A fresh Atlas IP-whitelist
  // entry can take a minute+ to propagate, and transient DNS/network blips
  // shouldn't kill a long-lived worker on boot. Each attempt fails fast
  // (serverSelectionTimeoutMS) so the loop stays responsive; once connected,
  // the driver's own topology monitor handles later reconnects.
  const maxAttempts = Math.max(1, Number(process.env['DB_CONNECT_MAX_ATTEMPTS'] ?? '15'));
  const baseDelayMs = Math.max(500, Number(process.env['DB_CONNECT_RETRY_MS'] ?? '3000'));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 8000,
        /*
         * Pool bounds, explicit (Phase 6 §11).
         *
         * The driver defaults `maxPoolSize` to 100 per process, and the limit
         * that binds is the cluster's: several API replicas plus a worker at
         * the default would ask Atlas for more connections than a shared tier
         * allows. `minPoolSize: 0` keeps a sleeping instance from holding
         * sockets it cannot use.
         */
        maxPoolSize: env.dbMaxPoolSize,
        minPoolSize: env.dbMinPoolSize,
      });
      isConnected = true;
      return mongoose;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(baseDelayMs * attempt, 15000);
      logger.warn('MongoDB connection attempt failed; retrying', {
        attempt,
        maxAttempts,
        retryInMs: delay,
        error: getErrorMessage(error),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Disconnect from MongoDB database.
 */
export async function disconnectDB(): Promise<void> {
  if (!isConnected) {
    return;
  }

  logger.info('Disconnecting from MongoDB...');
  await mongoose.disconnect();
  isConnected = false;
}

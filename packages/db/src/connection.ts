import dns from 'node:dns';
import mongoose from 'mongoose';
import { logger } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';

let isConnected = false;

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

  await mongoose.connect(uri);
  isConnected = true;
  return mongoose;
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

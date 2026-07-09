import mongoose from 'mongoose';
import { logger } from '@instantmockapi/shared';
import { loadEnvConfig } from '@instantmockapi/config';

let isConnected = false;

/**
 * Connect to MongoDB database using Mongoose.
 * Reuses existing connection if already established.
 */
export async function connectDB(customUri?: string): Promise<typeof mongoose> {
  if (isConnected) {
    logger.debug('Reusing active MongoDB connection');
    return mongoose;
  }

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

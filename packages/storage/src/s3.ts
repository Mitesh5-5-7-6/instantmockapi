/**
 * S3-compatible StorageClient (AWS S3, MinIO via forcePathStyle).
 * Credentials/endpoint come from env config — never hardcoded (doc 13 §6).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadEnvConfig, type EnvConfig } from '@instantmockapi/config';
import type { StorageClient } from './types.js';

export function createS3Storage(config: EnvConfig = loadEnvConfig()): StorageClient {
  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true, // required for MinIO/path-style endpoints
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  });
  const bucket = config.s3Bucket;

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
          ContentType: contentType,
        }),
      );
    },
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await response.Body?.transformToByteArray();
        if (!body) {
          return null;
        }
        return {
          body,
          contentType: response.ContentType ?? 'application/octet-stream',
        };
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchKey') {
          return null;
        }
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

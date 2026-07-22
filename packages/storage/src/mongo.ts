/**
 * MongoDB GridFS StorageClient.
 *
 * Stores artifact objects in the same MongoDB the rest of the platform already
 * uses, so no separate object-storage service is required. Reuses the mongoose
 * connection opened by connectDB() — call that before any put/get/delete.
 *
 * GridFS is used rather than a plain collection so artifacts are not bound by
 * the 16 MB BSON document limit (export_zip in particular can be large).
 */

import { mongoose } from '@instantmockapi/db';
import type { StorageClient, StorageObject } from './types.js';

const DEFAULT_BUCKET = 'artifacts';

export function createMongoStorage(bucketName: string = DEFAULT_BUCKET): StorageClient {
  function bucket() {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB is not connected; call connectDB() before using Mongo storage');
    }
    return new mongoose.mongo.GridFSBucket(db, { bucketName });
  }

  /** GridFS keeps revisions per filename; artifact keys are canonical, so replace. */
  async function removeAllRevisions(key: string): Promise<void> {
    const gridfs = bucket();
    const files = await gridfs.find({ filename: key }).toArray();
    await Promise.all(files.map((file) => gridfs.delete(file._id)));
  }

  return {
    async put(key, body, contentType) {
      await removeAllRevisions(key);

      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;

      await new Promise<void>((resolve, reject) => {
        // The driver dropped the deprecated top-level `contentType` option,
        // so it round-trips through metadata instead.
        const upload = bucket().openUploadStream(key, {
          metadata: { contentType },
        });
        upload.once('error', reject);
        upload.once('finish', () => {
          resolve();
        });
        upload.end(Buffer.from(bytes));
      });
    },

    async get(key) {
      const gridfs = bucket();
      const [file] = await gridfs
        .find({ filename: key })
        .sort({ uploadDate: -1 })
        .limit(1)
        .toArray();

      if (!file) {
        return null;
      }

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        gridfs
          .openDownloadStream(file._id)
          .once('error', reject)
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .once('end', () => {
            resolve();
          });
      });

      const metaContentType = (file.metadata as { contentType?: string } | undefined)?.contentType;

      return {
        body: new Uint8Array(Buffer.concat(chunks)),
        contentType: metaContentType ?? 'application/octet-stream',
      } satisfies StorageObject;
    },

    async delete(key) {
      await removeAllRevisions(key);
    },
  };
}

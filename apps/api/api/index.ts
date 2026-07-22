import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { connectDB } from '@instantmockapi/db';
import { buildServer } from '../src/server.js';

export const config = { maxDuration: 30 };

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  await connectDB();
  const app = await buildServer();
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  appPromise ??= getApp();
  const app = await appPromise;
  app.server.emit('request', req, res);
}

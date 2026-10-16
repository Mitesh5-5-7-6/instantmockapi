// One-off: give live hosted APIs the 30-day lifetime that replaced the plans.
// Run after deploying, with MONGO_URI set:
//   pnpm --filter @instantmockapi/db build
//   pnpm --filter @instantmockapi/db migrate:hosted-expiry
// Safe to run more than once; it never shortens an expiry.
import { connectDB, disconnectDB, extendHostedExpiry } from '../dist/index.js';

await connectDB();
try {
  const { checked, extended } = await extendHostedExpiry();
  console.log(`Checked ${checked} live hosted APIs; extended ${extended}.`);
} finally {
  await disconnectDB();
}

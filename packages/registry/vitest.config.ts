import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // mongodb-memory-server downloads a mongod binary on first run
    hookTimeout: 600_000,
    testTimeout: 30_000,
  },
});

import { defineConfig } from 'vitest/config';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// mongod test instances write their dbPath under os.tmpdir(); keep that on
// the repo drive — the system drive is chronically low on space and a full
// temp dir makes mongod fassert at startup.
const tmpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-tmp');
mkdirSync(tmpDir, { recursive: true });

export default defineConfig({
  test: {
    // mongodb-memory-server downloads a mongod binary on first run
    hookTimeout: 600_000,
    testTimeout: 30_000,
    env: { TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir },
  },
});

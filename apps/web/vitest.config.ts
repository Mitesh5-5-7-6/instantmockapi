import { defineConfig } from 'vitest/config';

// Only the wizard's pure logic is unit-tested here: schema serialization,
// relation rules, and diagram layout. Those are plain functions with no DOM,
// which is exactly why they were lifted out of the page components — a test
// that has to mount React to check that a foreign key was derived is testing
// the wrong thing.
export default defineConfig({
  test: {
    include: ['src/lib/**/*.test.ts'],
    environment: 'node',
  },
});

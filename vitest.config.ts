import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Integration tests that need the OCR binary / network are opt-in via env.
    // By default run the fast unit + local integration suite.
  },
});

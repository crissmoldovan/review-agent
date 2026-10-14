import { defineConfig } from 'vitest/config'

// A separate config, not a path argument to the default one: `vitest run <path>` still applies the
// default config's `exclude`, so pointing it at the e2e file would run zero tests and report success.
// These tests talk to GitHub and to a model. They are gated again inside the file, on env vars.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/e2e/**/*.e2e.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // One at a time: two reviews in parallel double the spend and interleave their output.
    fileParallelism: false,
  },
})

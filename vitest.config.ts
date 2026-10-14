import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    // Money safety, by configuration rather than by intention: `pnpm test` must never be able to
    // spend. Anything named *.e2e.test.ts costs a real model call and is run only by the separate
    // config Task 13 adds.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
  },
})

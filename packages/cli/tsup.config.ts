import { defineConfig } from 'tsup'
import { SHIP_SOURCEMAPS } from './sourcemaps'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // One switch, read by the build and by test/publishing.test.ts. The maps embed sourcesContent,
  // so shipping one ships the source (open decision, Criss, 2026-09-14).
  sourcemap: SHIP_SOURCEMAPS,
  banner: { js: '#!/usr/bin/env node' },   // package.json's `bin` must be executable
  dts: false,                              // a bin has no importers; skip the declaration emit
  // The workspace packages resolve to `./src/index.ts` in development (Task 1's `exports`), which
  // Node cannot load from a built file. Bundling them is what makes `node dist/index.js` work both
  // here and for an adopter. Their npm imports (zod, tar, @octokit/core) stay external.
  noExternal: [/^@review-agent\//],
  // There is no `onSuccess` copy step any more. It copied a wrap-up hook that was never built — the
  // wrap-up mechanism does not exist (engine.ts, `wrapUpFired`) — and it was POSIX shell (`cp`,
  // `2>/dev/null`, `|| true`), which fails the build under Windows' cmd.exe.
})

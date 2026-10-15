import { defineConfig } from 'tsup'

// One file, dist/server.js, run with `node`. tsup leaves everything in package.json's `dependencies`
// as an import, so the @review-agent packages load from node_modules as published and nothing of
// theirs is copied into this bundle.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // This is your own service, not a published package: a stack trace that points at src/ is worth
  // more than the few kilobytes the map costs.
  sourcemap: true,
})

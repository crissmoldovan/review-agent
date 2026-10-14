import { defineConfig } from 'tsup'
import { SHIP_SOURCEMAPS } from './sourcemaps'

export default defineConfig({
  entry: ['src/index.ts', 'src/receiver.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  // One switch, read by the build and by test/publishing.test.ts. The maps embed sourcesContent,
  // so shipping one ships the source (open decision, Criss, 2026-09-14).
  sourcemap: SHIP_SOURCEMAPS,
})

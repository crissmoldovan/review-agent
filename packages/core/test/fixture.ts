import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The absolute path of one recorded engine output under `test/fixtures/`. For tests that must
 *  give a child process a file — the fake CLI reads its fixture itself. */
export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

/** Reads one recorded engine output from `test/fixtures/`. The name may carry a sub-path, e.g.
 *  `readFixture('cli/success-opus-low.json')`. Returns `unknown`: a fixture is untrusted data, and
 *  every caller must narrow it the same way production code would. */
export const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8'))

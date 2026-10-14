// A deliberate violation of the rule `src/init-boundary.test.ts` enforces, and the exact edit that
// went unnoticed before that rule existed: two lines added to the init half put the registration
// private key on disk and the whole CLI suite stayed green. It is a fixture so the rule can be SEEN
// to fail on the real shape of the mistake, rather than only on a hand-edited file during review.
import { writeFileSync } from 'node:fs'
import type { ConvertedApp } from '@review-agent/app'

export const keepACopy = (app: ConvertedApp, path: string): void => {
  writeFileSync(path, app.pem.reveal())
}

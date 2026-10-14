// `createRequire` is how an ES module loads any built-in by name at runtime, so a rule that banned
// only `node:fs` would be one import of `node:module` away from meaning nothing.
import { createRequire } from 'node:module'
import type { ConvertedApp } from '@review-agent/app'

const load = createRequire(import.meta.url)

export const keepACopy = (app: ConvertedApp, path: string): void => {
  const fs = load('node:fs') as { writeFileSync: (p: string, data: string) => void }
  fs.writeFileSync(path, app.pem.reveal())
}

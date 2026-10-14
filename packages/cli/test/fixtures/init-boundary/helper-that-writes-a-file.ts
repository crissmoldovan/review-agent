// Innocent on its own, and that is the point: nothing here mentions a secret.
import { appendFileSync } from 'node:fs'

export const append = (path: string, text: string): void => { appendFileSync(path, text) }

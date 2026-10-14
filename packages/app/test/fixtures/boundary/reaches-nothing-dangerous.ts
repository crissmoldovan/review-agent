// The negative control, and the only fixture here that is NOT a violation: a module shaped like a
// real receiver — several files, node built-ins, no credentials anywhere. Without it, a rule that
// simply flagged everything would look as convincing as a rule that works.
import { createHmac } from 'node:crypto'
import { sameBytes } from './helper-that-reaches-nothing'

export const signedWith = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('hex')

export const matches = (a: string, b: string): boolean => sameBytes(a, b)

// A deliberate violation of the naming half of the rule. TypeScript erases this edge, so nothing
// reaches the key at runtime — but a receiver module that knows the shape of the App identity is a
// receiver module someone is about to hand one to, which is why naming it in any form is banned.
import type { AppIdentity } from '../../../src/credentials'

export type WhoTheAppIs = AppIdentity

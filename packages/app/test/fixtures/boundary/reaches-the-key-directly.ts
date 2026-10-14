// A deliberate violation of the boundary `src/boundary.test.ts` enforces: this is what a receiver
// module that imported the App private key would look like. It is here so the rule can be SEEN to
// fail on the real shape of the mistake, rather than only on a hand-edited list during review.
import { type AppIdentity, appJwt } from '../../../src/credentials'

export const mint = (identity: AppIdentity): string => appJwt({ identity })

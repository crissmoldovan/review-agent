/** The internet-facing half of this package, and the only subpath an adopter's webhook endpoint
 *  needs: `@review-agent/app/receiver`. It verifies a delivery, decides what it means and hands
 *  the decision to the runner. It cannot reach the App private key, and `src/boundary.test.ts`
 *  proves that over the import graph rather than trusting this comment (Criss, 2026-09-14: the
 *  product ships the receiver as a library, and each deployment's own web endpoint calls it). */
export * from './verify'
export * from './decide'
export * from './dispatch'
export * from './trigger-port'

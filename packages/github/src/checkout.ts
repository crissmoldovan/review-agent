import { rm } from 'node:fs/promises'

/** Delete a review's checkout — the downloaded copy of the code under review. Every way in calls it
 *  once it has finished with the checkout (publishing reads it, to place comments on lines), so a
 *  laptop, a CI runner or a long-running server does not keep a copy of every repository it has
 *  reviewed. Never throws: a review that finished must not fail because its scratch copy could not be
 *  removed. */
export const removeCheckout = async (dir: string): Promise<void> => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* best effort */ })
}

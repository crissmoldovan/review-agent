import type { ReviewRequest } from '@review-agent/core'

const NOT_BUILT = 'the multi-reviewer fan-out is not built yet'

/** What a summary says about a `--multi` it did not honour (Criss, 2026-09-14, decision 4), phrased
 *  once. The App's comment parser, its Re-run branch and every way into the review session say
 *  exactly these words, so a summary never names the same refusal two different ways. Until the
 *  multi-reviewer mode is built (spec 0.2.0 §8.3, Stage 3), when it stops being refused. */
export const MULTI_REFUSED = `\`--multi\` — ${NOT_BUILT}, so one reviewer ran.`

/** @deprecated Nothing refuses `--tier thorough` since 0.2.0: `thorough` is one reviewer at `high`
 *  effort, in every way in (spec 0.2.0 §8.1, decision §14.1). Kept, unchanged, so code that imported
 *  it from `@review-agent/app` still compiles; it will be removed in a later minor version. */
export const THOROUGH_REFUSED = `\`--tier thorough\` — ${NOT_BUILT}, so this review ran at the deployment’s default tier.`

/** Decision 4, for every doorway that is not the App's comment parser: a Re-run's `external_id`, a
 *  payload somebody triggered by hand, a CLI flag, an SDK option. `multi` is dropped and named, and
 *  the review runs with one reviewer — the same outcome the parser gives. Every other setting passes
 *  through untouched.
 *
 *  `thorough` is no longer refused (spec 0.2.0 §14.1): it used to be, because it was going to mean the
 *  fan-out, and paying its $8 target and $20 ceiling at per-token API prices for one reviewer was not
 *  what anybody asking for it expected. It now means exactly one reviewer at `high` effort, which is
 *  what it buys, so asking for it is honoured like any other tier. Moved here from the App in 0.2.0
 *  (spec §3.1), so the CLI and the SDK refuse what the App refuses. */
export function refuseUnbuilt<R extends Partial<ReviewRequest>>(r: R): { request: Omit<R, 'multi'>; refused: string[] } {
  const { multi, ...rest } = r
  return { request: rest, refused: multi === true ? [MULTI_REFUSED] : [] }
}

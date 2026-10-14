import type { ReviewRequest } from '@review-agent/core'

const NOT_BUILT = 'the multi-reviewer fan-out is not built yet'

/** What a summary says about a `--multi` the deployment does not allow (`allowMulti: false`, spec 0.2.0
 *  §14.19), phrased once (Criss, 2026-09-14, decision 4). The App's receiver, its runner and every way
 *  into the review session say exactly these words, so a summary never names the same refusal two
 *  different ways.
 *
 *  Same name, new words: until 0.2.0 it said the multi-reviewer mode was not built, and every
 *  `--multi` was refused with it. Code that imported it still compiles, and still gets the sentence a
 *  refused `--multi` is named with. */
export const MULTI_REFUSED = '`--multi` — this deployment does not run several reviewers on one review, so one reviewer ran.'

/** What a summary says when an AUTOMATIC review arrives asking for the multi-reviewer mode — a payload
 *  somebody built by hand, since no doorway puts it there. It runs only when a person asks for it,
 *  through a doorway that has checked they can push (spec 0.2.0 §8.3 point 5, decision §14.19): an
 *  automatic review is paid for on nobody's say-so, and costs one reviewer. */
export const MULTI_REFUSED_AUTOMATIC = '`multi` — several reviewers run only when somebody asks for them, and nobody asked for this review, so one reviewer ran.'

/** @deprecated Nothing refuses `--tier thorough` since 0.2.0: `thorough` is one reviewer at `high`
 *  effort, in every way in (spec 0.2.0 §8.1, decision §14.1). Kept, unchanged, so code that imported
 *  it from `@review-agent/app` still compiles; it will be removed in a later minor version. */
export const THOROUGH_REFUSED = `\`--tier thorough\` — ${NOT_BUILT}, so this review ran at the deployment’s default tier.`

/** Decision 4, for every doorway: a comment, a Re-run's `external_id`, a payload somebody triggered by
 *  hand, a CLI flag, an SDK option. What the deployment does not allow is dropped and named, and the
 *  review runs without it. Every other setting passes through untouched.
 *
 *  The name is from when it refused what was not built. Since 0.2.0 nothing is unbuilt: `multi` is
 *  honoured (spec 0.2.0 §8.3) unless
 *  - the deployment switched it off — `allowMulti: false`, passed here as `allowMulti` — and then it
 *    is named with `MULTI_REFUSED`; or
 *  - the request is `automatic` — nobody asked for it — and then it is named with
 *    `MULTI_REFUSED_AUTOMATIC` (decision §14.19: never automatic).
 *  Only `multi: true` is carried on; `false` and absent mean the same thing to `resolveSettings` and are
 *  both left off.
 *
 *  `allowMulti` left out is `true`, the built-in default (`defaultDeploymentConfig`), so a deployment
 *  whose own settings object predates the switch keeps the mode on. Every caller in this product passes
 *  its deployment's value.
 *
 *  `thorough` is not refused (spec 0.2.0 §14.1): it used to be, because it was going to mean the
 *  fan-out, and paying its $8 target and $20 ceiling at per-token API prices for one reviewer was not
 *  what anybody asking for it expected. It now means exactly one reviewer at `high` effort. */
export function refuseUnbuilt<R extends Partial<ReviewRequest>>(
  r: R,
  opts: { allowMulti?: boolean; automatic?: boolean } = {},
): { request: Omit<R, 'multi'> & { multi?: true }; refused: string[] } {
  const { multi, ...rest } = r
  if (multi !== true) return { request: rest, refused: [] }
  if (opts.automatic === true) return { request: rest, refused: [MULTI_REFUSED_AUTOMATIC] }
  if (opts.allowMulti === false) return { request: rest, refused: [MULTI_REFUSED] }
  return { request: { ...rest, multi: true }, refused: [] }
}

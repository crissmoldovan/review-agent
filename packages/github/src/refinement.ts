import type { ReviewRequest } from '@review-agent/core'
import { z } from 'zod'

// Moved from @review-agent/app's decide.ts in 0.2.0, so every way in — the App, the CLI, the SDK and
// the self-hosted server — stamps the same settings on the check run it creates, and a Re-run repeats
// them wherever the review came from. The App's receiver still exports both names.

const Refinement = z.object({
  tier: z.enum(['basic', 'normal', 'thorough']).optional(),
  multi: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  check: z.boolean().optional(),
  // no `brief`: it is never encoded (below), and an external_id from an older encoding that still
  // carries one has it dropped here rather than replayed.
  budgetUsd: z.number().optional(),
})

/** What "repeats the last request" needs: the settings, never the target. A check run's
 *  `external_id` is a string GitHub hands back untouched, so the settings of a review can ride
 *  along on the check run it produced without a database. Base64url keeps it out of trouble in a
 *  field whose escaping is not documented.
 *
 *  `brief` is dropped as well, and deliberately: it is free text a person typed after `/review`,
 *  and `external_id` is stored on the check run, readable by anyone who can read the check run and
 *  carried on every re-run for as long as it exists. A Re-run repeats the SETTINGS; whoever wants
 *  the brief again types it again. Base64url is an encoding, not a wrapper that makes text private. */
export function encodeRequestRefinement(r: ReviewRequest): string {
  const { repo: _repo, pr: _pr, headSha: _headSha, requestedBy: _by, requestId: _id,
          brief: _brief, ...settings } = r
  return Buffer.from(JSON.stringify(settings), 'utf8').toString('base64url')
}

export function decodeRequestRefinement(s: string | null | undefined): Partial<ReviewRequest> | null {
  if (s === null || s === undefined || s === '') return null
  try {
    const parsed = Refinement.safeParse(JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null // a check run this App did not create, or one from an older encoding
  }
}

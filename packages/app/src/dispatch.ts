import type { ReviewRequest } from '@review-agent/core'
import { HEAD_SHA_UNRESOLVED, isAutomatic } from './decide'

/** The trigger.dev task identifier. Task 13 defines the task with this id, and imports it from
 *  here: the contract belongs to the half that may be imported by an internet-facing process. */
export const REVIEW_TASK_ID = 'review-agent-review'

/** Everything the runner needs, and nothing else. The raw webhook body is never forwarded: a
 *  delivery may be up to 25 MB, carries no diff worth having (the runner fetches the pull request
 *  itself), and the trigger.dev payload limit is 3 MB.
 *  `retry` is never set by the receiver: it counts the NEW runs Task 13 started on purpose for a
 *  failure that spent nothing (Criss, 2026-09-14, answer 13), so a chain of them stops. */
export type ReviewTaskPayload = { request: ReviewRequest; installationId: number; refused?: string[]; retry?: number }

export type TriggerPort = (a: {
  taskId: string
  payload: ReviewTaskPayload
  idempotencyKey: string
  tags: string[]
}) => Promise<{ id: string }>

export async function dispatchReview(a: {
  request: ReviewRequest
  installationId: number
  /** What the comment doorway refused, already phrased (Task 10). The runner hands it to the
   *  summary; without this road a refusal is decided in the receiver and never heard of again. */
  refused?: string[]
  trigger: TriggerPort
}): Promise<{ runId: string; idempotencyKey: string }> {
  const payload = projectPayload({
    request: a.request, installationId: a.installationId,
    ...(a.refused !== undefined && { refused: a.refused }),
  })
  const idempotencyKey = idempotencyKeyFor(a.request)
  const handle = await a.trigger({
    taskId: REVIEW_TASK_ID, payload, idempotencyKey, tags: tagsFor(a.request),
  })
  return { runId: handle.id, idempotencyKey }
}

/** Field by field, never a spread: this is the one place a caller's mistake would turn into a
 *  megabyte on the wire or a credential in a run's payload, which trigger.dev keeps and shows. */
export function projectPayload(a: { request: ReviewRequest; installationId: number; refused?: string[] }): ReviewTaskPayload {
  const r = a.request
  const request: ReviewRequest = {
    repo: r.repo,
    pr: r.pr,
    headSha: r.headSha,
    ...(r.tier !== undefined && { tier: r.tier }),
    ...(r.multi !== undefined && { multi: r.multi }),
    ...(r.model !== undefined && { model: r.model }),
    ...(r.effort !== undefined && { effort: r.effort }),
    ...(r.check !== undefined && { check: r.check }),
    ...(r.brief !== undefined && { brief: r.brief }),
    ...(r.budgetUsd !== undefined && { budgetUsd: r.budgetUsd }),
    ...(r.requestedBy !== undefined && { requestedBy: r.requestedBy }),
    ...(r.requestId !== undefined && { requestId: r.requestId }),
  }
  // Decision 4's refusals ride along, already phrased, and only when there are some: an empty list
  // would be one more key on every automatic review for nothing.
  return withinBudget({
    request, installationId: a.installationId,
    ...(a.refused !== undefined && a.refused.length > 0 && { refused: [...a.refused] }),
  })
}

/** trigger.dev documents a 3 MB payload limit; this budget is 128 KB, two orders of magnitude
 *  under it. The gap is deliberate. A review request is a dozen scalars plus a brief a person
 *  typed, so anything approaching the real limit means somebody started forwarding delivery
 *  content, and the failure should name that here rather than arriving as a 400 from the API or,
 *  worse, succeeding. */
export const MAX_DISPATCH_PAYLOAD_BYTES = 131072

const withinBudget = (payload: ReviewTaskPayload): ReviewTaskPayload => {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (bytes > MAX_DISPATCH_PAYLOAD_BYTES) {
    throw new Error(
      `the review payload is ${bytes} bytes, over the ${MAX_DISPATCH_PAYLOAD_BYTES}-byte budget — ` +
      'a review request carries the decided ReviewRequest and an installation id, never the delivery body',
    )
  }
  return payload
}

/** trigger.dev scopes every key to the task and the environment already, so this only has to
 *  separate one review from another.
 *  A raw string key is `run`-scoped since SDK 4.3.1, but a backend trigger has no parent run, so it
 *  behaves globally — which is the scope we want, and why no `idempotencyKeys.create(…)` call is
 *  needed here.
 *  A FAILED run clears its key, so a review that crashed can be asked for again with the same key
 *  and will actually run. A successful one keeps it, which is what makes the automatic key a
 *  "review this head sha once" lock. */
export function idempotencyKeyFor(r: ReviewRequest): string {
  const automatic = isAutomatic(r)
  // Each branch refuses the value that would make ITS key say nothing. The automatic key is the
  // head sha, so a sentinel there collapses every unresolved review of a pull request into one run.
  // The explicit key is the request id, so a blank one collapses every `/review` on that pull
  // request into the first person's run — the same failure, in the branch that had no guard.
  // The guards are not interchangeable: an explicit review with an unresolved head sha is normal,
  // because the comment doorway has no head sha to give and this key does not use one.
  if (automatic && r.headSha === HEAD_SHA_UNRESOLVED) {
    throw new Error('an automatic review needs a resolved head sha before it can be dispatched')
  }
  const requestId = r.requestId ?? ''
  if (!automatic && requestId.trim() === '') {
    throw new Error('a requested review needs a request id before it can be dispatched')
  }
  const key = automatic
    ? `auto:${r.repo}#${r.pr}@${r.headSha}`
    // Explicit: keyed on WHO asked, not on what they asked about, so a second comment always runs
    // and a redelivered first comment does not.
    : `req:${r.repo}#${r.pr}:${requestId}`
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new Error(`an idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters, this one is ${key.length}`)
  }
  return key
}

/** trigger.dev rejects a longer key with a 400. Failing here names the cause. */
export const MAX_IDEMPOTENCY_KEY_CHARS = 2048

/** Up to 10 tags per run, 1–128 characters each, `namespace:value` by convention. A tag that
 *  cannot fit is dropped rather than truncated: half a repository name would file the run under a
 *  name that matches nothing. */
export function tagsFor(r: ReviewRequest): string[] {
  return [
    `repo:${r.repo}`,
    `pr:${r.repo}#${r.pr}`,
    `sha:${r.headSha.slice(0, 12)}`,
    isAutomatic(r) ? 'trigger:auto' : 'trigger:requested',
  ].filter((t) => t.length >= 1 && t.length <= 128).slice(0, 10)
}

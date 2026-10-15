import type { ReviewRequest } from '@review-agent/core'

/** One review waiting in the queue: what `decideDelivery` decided, and nothing of the delivery itself
 *  (spec 0.2.0 §7). The raw webhook body is never kept — it may be megabytes, and the review reads the
 *  pull request from GitHub itself, as of when it runs. */
export type ReviewJob = {
  /** `idempotencyKeyFor(request)`: the queue deduplicates on it. */
  key: string
  request: ReviewRequest
  installationId: number
  /** What a `/review` comment asked for and this deployment does not allow, already phrased. Logged:
   *  the SDK has no way to put it in the summary, which the App's runner does. */
  refused: string[]
  /** GitHub's `X-GitHub-Delivery` id, so a log line can be matched to the App's Recent Deliveries. */
  deliveryId: string | null
}

/** The fields of a job worth a log line. Never the brief: it is free text a person typed. */
export const describeJob = (job: ReviewJob): Record<string, unknown> => ({
  key: job.key,
  repo: job.request.repo,
  pr: job.request.pr,
  requestedBy: job.request.requestedBy ?? null,
  deliveryId: job.deliveryId,
})

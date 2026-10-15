import { decideDelivery, idempotencyKeyFor, verifyDelivery, type HeaderLookup } from '@review-agent/app/receiver'
import type { DeploymentConfig } from '@review-agent/core'
import { describeJob, type ReviewJob } from './job'
import type { Logger } from './log'
import type { Enqueued } from './queue'

export type WebhookReply = { status: number; body: string }

export type WebhookDeps = {
  secret: string
  /** Read for `command`, `autoReview` and `allowMulti`: what a delivery means. */
  deployment: DeploymentConfig
  enqueue: (job: ReviewJob) => Enqueued
  log: Logger
}

const header = (headers: HeaderLookup, name: string): string | null => {
  if (headers instanceof Headers) return headers.get(name)
  const value = headers[name]
  return typeof value === 'string' ? value : null
}

/** One webhook delivery, answered at once: verify, decide, queue (docs/deploying.md, "Write the
 *  receiver", with a queue where the App hands off to trigger.dev). Nothing here waits on GitHub, on
 *  the model or on the disk, so the answer is back well inside the 10 seconds GitHub allows; the review
 *  runs afterwards, from the queue.
 *
 *  | answer | when |
 *  |---|---|
 *  | 401 | the signature is missing, malformed, or not this secret's |
 *  | 400 | a signed body that is not JSON, or a decision no review can be keyed on |
 *  | 204 | understood, and nothing to do: most deliveries end here |
 *  | 202 | queued — or already queued, running or done (a redelivery) |
 *  | 503 | the queue is full, or the server is stopping. GitHub shows the delivery as failed, and it can be
 *  |     | redelivered from the App's settings once there is room |
 *
 *  It never throws: a reply that is not 2xx is how GitHub learns a delivery failed. */
export function handleWebhook(a: { rawBody: Uint8Array; headers: HeaderLookup }, deps: WebhookDeps): WebhookReply {
  const deliveryId = header(a.headers, 'x-github-delivery')
  const event = header(a.headers, 'x-github-event') ?? ''

  // Over the raw bytes, before any parse: a body that has been through JSON.parse and back is not what
  // GitHub signed.
  const verified = verifyDelivery({ rawBody: a.rawBody, headers: a.headers, secret: deps.secret })
  if (!verified.ok) {
    // Why, in the log only: telling the sender which check failed helps nobody but a forger.
    deps.log.warn('delivery refused: bad signature', { deliveryId, event, why: verified.why })
    return { status: 401, body: 'bad signature' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(a.rawBody)) as unknown
  } catch {
    deps.log.warn('delivery refused: the body is not JSON', { deliveryId, event })
    return { status: 400, body: 'not JSON' }
  }

  const decision = decideDelivery({ delivery: { event, payload }, deployment: deps.deployment })
  if (decision.kind === 'ignore') {
    deps.log.info('delivery ignored', { deliveryId, event, why: decision.why })
    return { status: 204, body: '' }
  }

  let key: string
  try {
    key = idempotencyKeyFor(decision.request)
  } catch (e) {
    deps.log.warn('delivery refused: no review can be keyed on it', { deliveryId, event, error: e })
    return { status: 400, body: 'no review can be keyed on this delivery' }
  }

  const job: ReviewJob = {
    key,
    request: decision.request,
    installationId: decision.installationId,
    refused: decision.refused ?? [],
    deliveryId,
  }
  const queued = deps.enqueue(job)
  switch (queued.kind) {
    case 'queued':
      deps.log.info('review queued', { ...describeJob(job), event, waiting: queued.waiting })
      return { status: 202, body: 'queued' }
    case 'duplicate':
      deps.log.info('review already taken', { ...describeJob(job), event, state: queued.state })
      return { status: 202, body: `already ${queued.state === 'done' ? 'reviewed' : queued.state}` }
    case 'full':
      deps.log.warn('review not queued: the queue is full', { ...describeJob(job), event, limit: queued.limit })
      return { status: 503, body: 'the review queue is full; redeliver this later' }
    case 'closed':
      deps.log.warn('review not queued: the server is stopping', { ...describeJob(job), event })
      return { status: 503, body: 'the server is stopping; redeliver this later' }
  }
}

import { createHmac } from 'node:crypto'
import { defaultDeploymentConfig } from '@review-agent/sdk'
import { describe, expect, it } from 'vitest'
import type { ReviewJob } from './job'
import { createLogger } from './log'
import { ReviewQueue, type RunOutcome } from './queue'
import { handleWebhook, type WebhookReply } from './webhook'

const SECRET = 'the-webhook-secret-set-on-the-app'
const HEAD_SHA = 'a'.repeat(40)

const sign = (body: Uint8Array, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const opened = {
  action: 'opened',
  installation: { id: 42 },
  repository: { full_name: 'acme/widgets' },
  pull_request: { number: 7, draft: false, head: { sha: HEAD_SHA } },
}
const reviewComment = {
  action: 'created',
  installation: { id: 42 },
  repository: { full_name: 'acme/widgets' },
  issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' } },
  comment: { id: 9001, body: '/review --tier normal', user: { login: 'alice', type: 'User' } },
}

/** The webhook handler in front of a real queue whose run is faked: the SDK call never happens, and
 *  each review stays running until the test ends, so what is queued is exactly what the test sent. */
const setup = (a: { limit?: number } = {}) => {
  const jobs: ReviewJob[] = []
  const lines: string[] = []
  const queue = new ReviewQueue<ReviewJob>({
    concurrency: 1,
    limit: a.limit ?? 10,
    run: (job) => {
      jobs.push(job)
      return new Promise<RunOutcome>(() => {}) // the review: still running
    },
  })
  const log = createLogger({ secrets: () => [SECRET], write: (l) => lines.push(l) })
  const deliver = (event: string, payload: unknown, o: { signature?: string | null; raw?: string } = {}): WebhookReply => {
    const rawBody = Buffer.from(o.raw ?? JSON.stringify(payload), 'utf8')
    const headers: Record<string, string> = { 'x-github-event': event, 'x-github-delivery': 'delivery-1' }
    const signature = o.signature === undefined ? sign(rawBody) : o.signature
    if (signature !== null) headers['x-hub-signature-256'] = signature
    return handleWebhook({ rawBody, headers }, {
      secret: SECRET, deployment: defaultDeploymentConfig(), enqueue: (job) => queue.enqueue(job), log,
    })
  }
  return { deliver, jobs, lines, queue }
}

describe('handleWebhook refuses', () => {
  it('a delivery signed with another secret: 401, and nothing queued', () => {
    const s = setup()
    const body = Buffer.from(JSON.stringify(opened))
    expect(s.deliver('pull_request', opened, { signature: sign(body, 'some-other-secret') }).status).toBe(401)
    expect(s.jobs).toEqual([])
  })

  it('a delivery with no signature: 401', () => {
    const s = setup()
    expect(s.deliver('pull_request', opened, { signature: null }).status).toBe(401)
    expect(s.jobs).toEqual([])
  })

  it('a signed body that is not JSON: 400', () => {
    const s = setup()
    expect(s.deliver('pull_request', null, { raw: '{"action":' }).status).toBe(400)
  })
})

describe('handleWebhook ignores', () => {
  it('an event it does not act on: 204, with why in the log', () => {
    const s = setup()
    const reply = s.deliver('push', { ref: 'refs/heads/main' })
    expect(reply).toEqual({ status: 204, body: '' })
    expect(s.jobs).toEqual([])
    expect(s.lines.some((l) => l.includes('delivery ignored') && l.includes('push is not an event'))).toBe(true)
  })

  it('a push to a pull request (synchronize), which the reviewer never reviews by itself: 204', () => {
    const s = setup()
    expect(s.deliver('pull_request', { ...opened, action: 'synchronize' }).status).toBe(204)
  })
})

describe('handleWebhook queues', () => {
  it('an opened pull request: 202, keyed on the head commit, as an automatic review', () => {
    const s = setup()
    expect(s.deliver('pull_request', opened)).toEqual({ status: 202, body: 'queued' })
    expect(s.jobs).toEqual([{
      key: `auto:acme/widgets#7@${HEAD_SHA}`,
      installationId: 42,
      request: { repo: 'acme/widgets', pr: 7, headSha: HEAD_SHA },
      refused: [],
      deliveryId: 'delivery-1',
    }])
  })

  it('a /review comment: 202, keyed on the comment, with who asked and what they asked for', () => {
    const s = setup()
    expect(s.deliver('issue_comment', reviewComment).status).toBe(202)
    expect(s.jobs[0]).toMatchObject({
      key: 'req:acme/widgets#7:9001',
      request: { repo: 'acme/widgets', pr: 7, tier: 'normal', requestedBy: 'alice', requestId: '9001' },
    })
  })

  it('a redelivery of a review already taken: 202 again, and one review', () => {
    const s = setup()
    s.deliver('pull_request', opened)
    expect(s.deliver('pull_request', opened)).toEqual({ status: 202, body: 'already running' })
    expect(s.jobs).toHaveLength(1)
  })
})

describe('handleWebhook answers 503', () => {
  it('when the queue is full, so GitHub shows the delivery as failed and it can be redelivered', () => {
    // One running, none may wait: the second distinct review has nowhere to go.
    const s = setup({ limit: 0 })
    expect(s.deliver('pull_request', opened).status).toBe(202)
    const another = { ...opened, pull_request: { ...opened.pull_request, number: 8 } }
    expect(s.deliver('pull_request', another).status).toBe(503)
    expect(s.jobs).toHaveLength(1)
  })

  it('once the server is stopping', () => {
    const s = setup()
    s.queue.close()
    expect(s.deliver('pull_request', opened).status).toBe(503)
  })
})

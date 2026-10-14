import { describe, expect, it, vi } from 'vitest'
import { REVIEW_TASK_ID } from './dispatch'
// vi.mock below is hoisted above these imports, so the adapter's own dynamic import of the SDK
// resolves to the spy: this test needs neither TRIGGER_SECRET_KEY nor a network.
import { sdkTriggerPort } from './trigger-port'

const triggerSpy = vi.hoisted(() => vi.fn(async () => ({
  id: 'run_2n4kd8wq', publicAccessToken: 'a-jwt', taskIdentifier: 'review-agent-review',
})))
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: triggerSpy } }))

describe('sdkTriggerPort', () => {
  it('passes the task id, the payload, the key and the tags straight through', async () => {
    const payload = { request: { repo: 'acme/widgets', pr: 25, headSha: '4f8e2a1' }, installationId: 4242 }

    const got = await sdkTriggerPort({
      taskId: REVIEW_TASK_ID, payload, idempotencyKey: 'auto:acme/widgets#25@4f8e2a1', tags: ['repo:acme/widgets'],
    })

    expect(got).toEqual({ id: 'run_2n4kd8wq' })
    expect(triggerSpy).toHaveBeenCalledWith(
      'review-agent-review',
      payload,
      { idempotencyKey: 'auto:acme/widgets#25@4f8e2a1', tags: ['repo:acme/widgets'] },
    )
  })
})

import { describe, expect, it, vi } from 'vitest'
import { sdkTriggerPort } from './trigger-port'

// The host never installed the optional peer: importing it fails, as Node's resolver would (0.2.1).
vi.mock('@trigger.dev/sdk', () => { throw new Error("Cannot find package '@trigger.dev/sdk'") })

describe('sdkTriggerPort without @trigger.dev/sdk installed', () => {
  it('fails with a sentence naming the package to install, not a resolver trace', async () => {
    await expect(sdkTriggerPort({
      taskId: 'review-agent-review', payload: { request: { repo: 'acme/widgets', pr: 1, headSha: 'a' }, installationId: 1 },
      idempotencyKey: 'k', tags: [],
    })).rejects.toThrow(/npm install @trigger\.dev\/sdk/)
  })
})

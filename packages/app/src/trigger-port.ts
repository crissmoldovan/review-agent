import type { TriggerPort } from './dispatch'

/** The only place `@trigger.dev/sdk` is imported, and it is imported lazily: a delivery that gets
 *  ignored should not pay for the SDK's module graph, and an adopter who supplies their own
 *  `TriggerPort` should not need the package at all.
 *  It lives in the receiver half on purpose. The process that triggers is the internet-facing one,
 *  so the adapter has to be reachable from there — and putting it next to the task would drag the
 *  App private key back across the boundary `src/boundary.test.ts` defends.
 *  Auth is `TRIGGER_SECRET_KEY`, read by the SDK from the environment. This module never reads it,
 *  never logs it, and never accepts it as an argument. */
export const sdkTriggerPort: TriggerPort = async ({ taskId, payload, idempotencyKey, tags }) => {
  // An OPTIONAL peer since 0.2.1: only a receiver that triggers through trigger.dev's own SDK needs it,
  // so the CLI and every other host no longer install it (and the advisories its WebSocket client
  // carries). A host that calls this without it gets a sentence naming the fix, not a resolver trace.
  let tasks: typeof import('@trigger.dev/sdk').tasks
  try {
    ;({ tasks } = await import('@trigger.dev/sdk'))
  } catch (e) {
    throw new Error(
      'sdkTriggerPort needs the @trigger.dev/sdk package, which @review-agent/app does not install for you: ' +
      'npm install @trigger.dev/sdk (or pass your own TriggerPort)', { cause: e })
  }
  const handle = await tasks.trigger(taskId, payload, { idempotencyKey, tags })
  return { id: handle.id }
}

import { logger, task } from '@trigger.dev/sdk'
import { appIdentityFromEnv } from '../credentials'
import {
  FOCUS_TASK_ID, focusTaskRun, type FocusBatchPort, type FocusTaskOutput, type FocusTaskPayload,
} from './focus-run'
import { liveFocusTaskDeps } from './review-job'
import { asTriggerError } from './trigger-error'

/** One focus of a multi-reviewer review, as a child task of the review that needs it (spec 0.2.0 §8.3
 *  point 4; decision §14.18 (a)): each on a machine of its own — the project's `small-2x`, the one a
 *  single review was measured on — because three Claude processes do not fit one. It registers itself
 *  with the deploy, like every task in this directory; nothing triggers it but `review-agent-review`.
 *
 *  No `machine`, no duration and no `retry` of its own: trigger.config.ts owns all three, so a focus
 *  runs on the machine, under the backstop and with the attempts every task in the project has —
 *  and its money rule is the review task's, applied by `focusTaskRun` and `asTriggerError`. */
export const focusTask = task({
  id: FOCUS_TASK_ID,
  run: async (payload: FocusTaskPayload, { signal }): Promise<FocusTaskOutput> => {
    try {
      return await focusTaskRun(payload, { signal }, liveFocusTaskDeps({
        identity: () => appIdentityFromEnv(process.env),
        log: (message, fields) => { logger.info(message, fields) },
      }))
    } catch (e) {
      throw asTriggerError(e)
    }
  },
})

/** The one call that starts a review's focuses and waits for them: all three in one batch, so the
 *  review is checkpointed once while they run, and not billed while it waits (trigger.dev 4.5.16
 *  docs, how-it-works: "we don't charge for the time waiting for subtasks"). */
export const sdkFocusBatch: FocusBatchPort = (items) => focusTask.batchTriggerAndWait(items)

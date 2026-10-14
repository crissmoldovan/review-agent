import { readFile } from 'node:fs/promises'
import { logger, metadata, task } from '@trigger.dev/sdk'
import { appIdentityFromEnv } from '../credentials'
import { REVIEW_TASK_ID, type ReviewTaskPayload } from '../dispatch'
import { sdkTriggerPort } from '../trigger-port'
import { liveReviewTaskDeps } from './review-job'
import { reviewTaskRun } from './review-run'
import { asTriggerError } from './trigger-error'

/** Task 12's probe reads the same two paths. cgroup v2's peak covers the `claude` child too, which is
 *  the number `small-2x`'s 1 GB is about. NOT VERIFIED to exist in trigger.dev's sandbox, so it is
 *  reported as null rather than assumed. */
const cgroupPeak = async (): Promise<number | null> => {
  for (const p of ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory.max_usage_in_bytes']) {
    try {
      const n = Number.parseInt((await readFile(p, 'utf8')).trim(), 10)
      if (Number.isFinite(n)) return n
    } catch { /* not this kernel's layout, or not readable: report null */ }
  }
  return null
}

/** The check run an attempt opened, kept on the trigger.dev RUN so a retried attempt of the same run
 *  can close it (Criss, 2026-09-24). Metadata belongs to the run, which every attempt shares
 *  (trigger.dev docs, runs/metadata). `set` is batched, and the case this exists for is an attempt
 *  killed moments later, so `flush` forces it into the database before any model money is spent.
 *  UNVERIFIED: that a retried attempt's `metadata.get` returns what the killed attempt flushed —
 *  the docs place metadata on the run but do not say it across attempts. If it does not, `recall`
 *  returns undefined and the hourly sweep closes the stale run, exactly as before this existed. */
const CHECK_RUN_KEY = 'reviewAgentCheckRunId'
const runMetadataMemory = {
  remember: async (checkRunId: number) => {
    metadata.set(CHECK_RUN_KEY, checkRunId)
    await metadata.flush()
  },
  recall: (): number | undefined => {
    const v = metadata.get(CHECK_RUN_KEY)
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
  },
}

/** The reviewing task. Its id and its payload type are DEFINED in dispatch.ts and imported from
 *  there: the contract belongs to the half an internet-facing process may import, and pointing the
 *  import the other way would drag credentials.ts across the boundary Task 8 tests.
 *  No `machine` and no duration setting here — trigger.config.ts (Task 12) owns both, and it owns
 *  them because its number was measured rather than chosen. */
export const reviewTask = task({
  id: REVIEW_TASK_ID,
  // The payload type is annotated on the FIRST argument. Two docs pages show
  // `run: async ({ payload, ctx })` — a documentation bug; the real signature is `(payload,
  // { ctx })`, and the second argument also carries `signal`.
  run: async (payload: ReviewTaskPayload, { ctx, signal }) => {
    try {
      return await reviewTaskRun(payload, { signal, attempt: ctx.attempt.number }, liveReviewTaskDeps({
        identity: () => appIdentityFromEnv(process.env),
        log: (message, fields) => { logger.info(message, fields) },
        // The verified facts confirm custom metrics are QUERYABLE and confirm no call that emits
        // one; Step 4 checked the installed SDK and the build log records the answer. A structured
        // log line keeps the numbers leaving the run either way.
        metric: (name, value, attributes) => { logger.info('metric', { name, value, ...attributes }) },
        // A failure that spent nothing starts a NEW run of the same request through Task 11's port
        // (Step 45e). Since 2026-09-18 trigger.dev also repeats a run itself, up to three attempts
        // (Criss, 2026-09-18, reversing answer 13); the new run's idempotency key carries the retry count, so repeated
        // attempts of one run start it once.
        startAnotherRun: sdkTriggerPort,
        checkRunMemory: runMetadataMemory,
      }))
    } catch (e) {
      throw asTriggerError(e)
    } finally {
      // Criss, 2026-09-14 (decision 12): the hosted run in Task 15 is also Task 12's criterion 5.
      // Logged on success and on failure alike; an OOM kill logs nothing, and that is its own answer.
      logger.info('memory', { cgroupPeakBytes: await cgroupPeak(), rssBytes: process.memoryUsage.rss() })
    }
  },
})

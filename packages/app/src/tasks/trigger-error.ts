import { AbortTaskRunError } from '@trigger.dev/sdk'
import { DoNotRetry } from './review-run'

/** `DoNotRetry` in, trigger.dev's `AbortTaskRunError` out — "This will fail the task attempt and
 *  disable retrying" — since 2026-09-18 this is the ONLY lock on repeating a run that has spent:
 *  the project allows three attempts (Task 12, `MAX_ATTEMPTS`; Criss, reversing answer 13), so a
 *  failure that reaches here as `DoNotRetry` is the one kind that is still never repeated. Everything else passes through as the same object that was
 *  thrown, so the run page shows the error that ended it — `RetryThis` included, a failure that
 *  spent nothing and for which `reviewTaskRun` has already started a new run (Step 45e).
 *  Its own module so this mapping can be tested without importing the one that calls `task()`. */
export const asTriggerError = (e: unknown): Error =>
  e instanceof DoNotRetry
    ? new AbortTaskRunError(e.message)
    : e instanceof Error
      ? e
      : new Error(String(e))

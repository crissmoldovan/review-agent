import { AbortTaskRunError } from '@trigger.dev/sdk'
import { describe, expect, it } from 'vitest'
import { DoNotRetry, RetryThis } from './review-run'
import { asTriggerError } from './trigger-error'

describe('what the task hands back to trigger.dev', () => {
  it('turns a do-not-retry into the error that disables retrying, so the model is not paid for twice', () => {
    const e = asTriggerError(new DoNotRetry('the review was withheld', 0.345))
    expect(e).toBeInstanceOf(AbortTaskRunError)
    expect(e.message).toBe('the review was withheld')
  })

  it('passes everything else through untouched, so the run fails with the error that explains it', () => {
    const original = new Error('GitHub responded 502')
    expect(asTriggerError(original)).toBe(original)
    expect(asTriggerError('a string nobody threw on purpose')).toBeInstanceOf(Error)
    // RetryThis is a $0 crash with no output, for which reviewTaskRun has already started a new run
    // (Step 45e). It arrives at trigger.dev as the very object that was thrown, so the run page
    // names the free failure; as an AbortTaskRunError it would read as a money stop that never
    // happened. Since 2026-09-18 trigger.dev repeats a RetryThis up to three attempts (Task 12,
    // MAX_ATTEMPTS (Criss, 2026-09-18, reversing answer 13)); a DoNotRetry, as an AbortTaskRunError, it still never repeats.
    const retryable = new RetryThis('the reviewer process crashed (exit 137) — nothing was spent, so this attempt may be retried')
    expect(asTriggerError(retryable)).toBe(retryable)
    expect(asTriggerError(retryable)).not.toBeInstanceOf(AbortTaskRunError)
  })
})

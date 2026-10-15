import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FOCUS_TASK_ID } from './focus-run'

// Read as text, as review-task.test.ts reads its task: the module calls `task()` at import, which is
// not verified to work outside a deployed worker.
const source = readFileSync(fileURLToPath(new URL('./focus-task.ts', import.meta.url)), 'utf8')

describe('the focus task definition (spec 0.2.0 §8.3 point 4)', () => {
  it('registers as review-agent-focus, under the id the review’s fan-out is written against', () => {
    expect(FOCUS_TASK_ID).toBe('review-agent-focus')
    expect(source).toMatch(/import \{[^}]*\bFOCUS_TASK_ID\b[^}]*\} from '\.\/focus-run'/)
    expect(source).toMatch(/\bid: FOCUS_TASK_ID\b/)
  })

  it('sets no machine, duration or attempt count of its own, so a focus runs as every task in the project does', () => {
    // "Each on today's machine" (decision §14.18 (a)): trigger.config.ts's small-2x, its maxDuration
    // backstop and its MAX_ATTEMPTS. A task-level value would silently outrank each of them.
    expect(source).not.toMatch(/\bmachine\s*:/)
    expect(source).not.toMatch(/\bmaxDuration\s*:/)
    expect(source).not.toMatch(/\bretry\s*:/)
  })

  it('applies the review task’s money rule: every failure through asTriggerError', () => {
    expect(source).toMatch(/focusTaskRun\(/)
    expect(source).toMatch(/throw asTriggerError\(e\)/)
  })

  it('starts a review’s focuses together and waits for them, with batchTriggerAndWait', () => {
    expect(source).toMatch(/focusTask\.batchTriggerAndWait\(items\)/)
  })

  it('reads the App identity inside the run, and never at module scope', () => {
    expect(source).toMatch(/identity: \(\) => appIdentityFromEnv\(process\.env\)/)
    expect(source).not.toMatch(/^(?:export\s+)?(?:const\s+\w+\s*=\s*)?appIdentityFromEnv\(/m)
  })
})

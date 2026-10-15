import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REVIEW_TASK_ID } from '../dispatch'

const source = readFileSync(fileURLToPath(new URL('./review-task.ts', import.meta.url)), 'utf8')

describe('the task definition', () => {
  it('registers under the id the receiver dispatches to, imported rather than retyped', () => {
    // Two constants for one task id is how a dispatch reaches a task that does not exist: every
    // unit test on both sides stays green, and no review ever runs.
    expect(REVIEW_TASK_ID).toBe('review-agent-review')
    expect(source).toMatch(/import \{[^}]*\bREVIEW_TASK_ID\b[^}]*\} from '\.\.\/dispatch'/)
    expect(source).toMatch(/\bid: REVIEW_TASK_ID\b/)
  })

  it('sets no machine and no duration of its own, so trigger.config.ts is the only place either lives', () => {
    // Task 12 MEASURES the preset; a task-level value silently outranks the project default, so a
    // move to medium-1x would leave this task on the 1 GB machine that was measured too small.
    expect(source).not.toMatch(/\bmachine\s*:/)
    expect(source).not.toMatch(/\bmaxDuration\s*:/)
  })

  it('builds the live collaborators and hands every failure through asTriggerError', () => {
    expect(source).toMatch(/liveReviewTaskDeps\(/)
    expect(source).toMatch(/throw asTriggerError\(e\)/)
  })

  it('starts another run through the port the receiver dispatches with, and sets no attempt count of its own', () => {
    // trigger.config.ts allows three attempts (Criss, 2026-09-18, reversing answer 13), and a task's own `retry`
    // would override it (verified facts, scheduled tasks §8: task settings override the config).
    // The one repeat this product makes is the new run Step 45e starts, through Task 11's port.
    expect(source).toMatch(/startAnotherRun: sdkTriggerPort\b/)
    expect(source).not.toMatch(/\bretry\s*:/)
  })

  it('runs a multi-reviewer review’s focuses as child tasks of this run (spec 0.2.0 §8.3 point 4)', () => {
    // Decision §14.18 (a): three Claude processes do not fit this task's 1 GB machine, so each focus
    // is a `review-agent-focus` run on a machine of its own, started together and waited for.
    expect(source).toMatch(/runFocuses: focusesAsChildTasks\(\{/)
    expect(source).toMatch(/installationId: payload\.installationId/)
    expect(source).toMatch(/batch: sdkFocusBatch\b/)
  })

  it('reports the machine peak memory on every run, so the one hosted run answers criterion 5', () => {
    // Criss, 2026-09-14 (decision 12): Task 15's hosted run is also Task 12's in-image memory
    // measurement. The number has to leave the run, and this is the only file that runs there.
    expect(source).toMatch(/\/sys\/fs\/cgroup\/memory\.peak/)
    expect(source).toMatch(/logger\.info\('memory'/)
    expect(source).toMatch(/finally\s*\{/)
  })

  it('checks no credential at module scope, so importing the file can never throw on a missing variable', () => {
    // Step 58. reviewTaskRun checks both at the top of every run, before any GitHub call. A check at
    // module scope would run wherever this file is imported — the deploy's indexing, every worker
    // start — where no test reaches. The identity is read lazily, inside run, and nowhere else.
    expect(source).not.toMatch(/\bassertModelCredential\b/)
    expect(source).not.toMatch(/^(?:export\s+)?(?:const\s+\w+\s*=\s*)?appIdentityFromEnv\(/m)
    expect(source).toMatch(/identity: \(\) => appIdentityFromEnv\(process\.env\)/)
  })
})

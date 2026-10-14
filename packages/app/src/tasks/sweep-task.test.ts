import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SWEEP_CRON, SWEEP_TASK_ID } from './sweep-run'

const source = readFileSync(fileURLToPath(new URL('./sweep-task.ts', import.meta.url)), 'utf8')

describe('the scheduled sweep definition', () => {
  it('is a scheduled task under the id and the hourly cron that sweep-run.ts names', () => {
    expect(SWEEP_TASK_ID).toBe('review-agent-sweep-stale-check-runs')
    expect(SWEEP_CRON).toBe('0 * * * *')
    expect(source).toMatch(/schedules\.task\(\{/)
    expect(source).toMatch(/\bid: SWEEP_TASK_ID\b/)
    expect(source).toMatch(/\bcron: SWEEP_CRON\b/)
  })

  it('runs one sweep at a time, and lets a tick that finds one still running expire', () => {
    expect(source).toMatch(/queue: \{ concurrencyLimit: 1 \}/)
    expect(source).toMatch(/\bttl: '30m'/)
  })

  it('sets no attempt count, machine or duration of its own, so trigger.config.ts decides all three', () => {
    // Three attempts per run, project-wide (Criss, 2026-09-18, reversing answer 13). A task's own setting would override it
    // (verified facts, scheduled tasks §8).
    expect(source).not.toMatch(/\bretry\s*:/)
    expect(source).not.toMatch(/\bmachine\s*:/)
    expect(source).not.toMatch(/\bmaxDuration\s*:/)
  })

  it('reads the App identity inside the run, and never at module scope', () => {
    expect(source).toMatch(/identity: \(\) => appIdentityFromEnv\(process\.env\)/)
    expect(source).not.toMatch(/^(?:export\s+)?(?:const\s+\w+\s*=\s*)?appIdentityFromEnv\(/m)
  })

  it('sweeps what the deployment names, under the deployment check-run name', () => {
    expect(source).toMatch(/targets: runnerSweepTargets\b/)
    expect(source).toMatch(/checkRunName: \(\) => runnerDeployment\(\)\.report\.checkRunName/)
    expect(source).toMatch(/\bcloseStaleCheckRuns,/)
  })
})

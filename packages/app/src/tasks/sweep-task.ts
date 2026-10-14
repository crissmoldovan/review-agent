import { closeStaleCheckRuns } from '@review-agent/github'
import { logger, schedules } from '@trigger.dev/sdk'
import { appIdentityFromEnv, installationToken } from '../credentials'
import { octokitFor, runnerDeployment, runnerSweepTargets } from './review-job'
import { SWEEP_CRON, SWEEP_TASK_ID, listOpenPullHeads, sweepRun } from './sweep-run'

/** Criss, 2026-09-14 (answer 14): the sweep of abandoned check runs is a product task, in the same
 *  trigger.dev project as the review task and holding the same, only, copy of the App's private
 *  key. Imported by no test: `schedules.task()` runs at module load, which is not verified to work
 *  outside a deployed worker — review-task.ts is kept apart for the same reason. */
export const sweepTask = schedules.task({
  id: SWEEP_TASK_ID,
  // Declarative: UTC, and synced into the environment each deploy targets (verified facts,
  // scheduled tasks §2, §4 and §5 — the last an inference the docs never state in one sentence).
  cron: SWEEP_CRON,
  // One sweep at a time, and a tick queued behind one still running expires after half the hour
  // between ticks instead of stacking up (§7: both are task options; the pairing is an inference).
  // No attempt count here: the project's three attempts apply (§8; Criss, 2026-09-18, reversing answer 13), so a failed sweep
  // is retried within seconds rather than waiting an hour. The sweep spends no model money and closing
  // an already-closed run is a no-op, so the retries are safe here.
  queue: { concurrencyLimit: 1 },
  ttl: '30m',
  run: async () => sweepRun({
    targets: runnerSweepTargets,
    // Lazily, inside the run (Task 13 Step 58's rule): a deployed version whose App identity was
    // removed still loads, and with no repository named this is never called at all.
    identity: () => appIdentityFromEnv(process.env),
    checkRunName: () => runnerDeployment().report.checkRunName,
    installationToken,
    makeOctokit: (token: string) => octokitFor({ token }),
    listOpenPullHeads,
    closeStaleCheckRuns,
    now: () => new Date(),
    log: (message: string, fields: Record<string, unknown>) => { logger.info(message, fields) },
  }),
})

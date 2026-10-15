import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  defaultDeploymentConfig,
  type DeploymentConfig, type ReviewRequest,
} from '@review-agent/core'
import {
  closeCheckRunIfInProgress, completeCheckRun, createCheckRun, defaultRunReviewDeps, fetchPullRequest,
  fetchRepoConfig, findSummaryComment, octokitFor, publishReview, pushAccessOf, runReview,
  type FocusRunner, type RunReviewDeps,
} from '@review-agent/github'
import { appBotLogin, installationToken, type AppIdentity } from '../credentials'
import type { TriggerPort } from '../dispatch'
import { FOCUS_DEADLINE_MS, type FocusTaskDeps } from './focus-run'
import { sendRecordCallback, type RecordCallback } from './record-callback'
import {
  DEFAULT_DEADLINE_MS, reviewTaskRun, type CheckRunMemory, type ReviewTaskDeps, type ReviewTaskResult,
} from './review-run'
import type { SweepTarget } from './sweep-run'

/** The deployment this runner reviews under. The product is open source and a deployment deploys
 *  this package into its own trigger.dev project (Task 12), so this is the one function a
 *  deployment changes to get its own check-run name, gate, mode or skills. The receiver half is
 *  handed a DeploymentConfig by whoever calls `decideDelivery`; the runner has no caller to hand it
 *  one, and v0 has no configuration file (design §3.1 is a table of defaults, not a format).
 *
 *  NO deviation from the built-in defaults. This function used to turn the disprove-it check pass
 *  on for `basic`; Criss's decision 2 of 2026-09-14 moved that into `defaultDeploymentConfig()`
 *  itself (Task 0), because every caller that posts wants it, and a default overridden in one
 *  runner is a default the CLI and every other deployment silently lack. $0.07-$0.58 per review at
 *  per-token API prices (measured; design §8), or the same figure drawn from the subscription
 *  allowance when the credential is a subscription token. */
export const runnerDeployment = (): DeploymentConfig => defaultDeploymentConfig()

/** The repositories the hourly sweep closes abandoned check runs in (Task 13b), per installation, as
 *  `owner/name`. None by default: Task 8 mints no installation-wide token, so the sweep cannot find
 *  repositories for itself, and a deployment that names none has asked for no sweep.
 *
 *  Named in the deployment's ENVIRONMENT since 2026-09-25, as JSON in `REVIEW_AGENT_SWEEP_TARGETS` —
 *  `[{"installationId":123,"repositories":["owner/name"]}]` — so a deployment runs this product
 *  unchanged instead of editing this function before every deploy (a deployment asked for it). A
 *  malformed value THROWS: the sweep spends no model money, so a visible failed run is the honest
 *  answer, where silently sweeping nothing would leave stuck check runs nobody knows about. */
export const runnerSweepTargets = (env: Record<string, string | undefined> = process.env): SweepTarget[] => {
  const raw = env.REVIEW_AGENT_SWEEP_TARGETS
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('REVIEW_AGENT_SWEEP_TARGETS is not JSON: expected [{"installationId":123,"repositories":["owner/name"]}]')
  }
  if (!Array.isArray(parsed)) throw new Error('REVIEW_AGENT_SWEEP_TARGETS must be a JSON list of targets')
  return parsed.map((t: unknown, i) => {
    const o = t as { installationId?: unknown; repositories?: unknown }
    if (typeof o?.installationId !== 'number' || !Number.isInteger(o.installationId) || o.installationId <= 0) {
      throw new Error(`REVIEW_AGENT_SWEEP_TARGETS[${i}].installationId must be a positive integer`)
    }
    const repos = o.repositories
    if (!Array.isArray(repos) || !repos.every((r) => typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r))) {
      throw new Error(`REVIEW_AGENT_SWEEP_TARGETS[${i}].repositories must be a list of owner/name`)
    }
    return { installationId: o.installationId, repositories: repos as string[] }
  })
}

/** Where each finished review's record is sent, signed (Task 13c): an https `url`, and `secretEnv`,
 *  the NAME of the variable holding the shared secret. `null` by default, so nothing leaves the
 *  runner until a deployment asks (Criss, 2026-09-14, answer 16).
 *
 *  Named in the deployment's ENVIRONMENT since 2026-09-25 (a deployment asked for it): the URL in
 *  `REVIEW_AGENT_RECORD_URL`, and the secret's variable NAME in `REVIEW_AGENT_RECORD_SECRET_ENV`,
 *  defaulting to `REVIEW_AGENT_RECORD_SECRET`. A bad URL or name is not refused here:
 *  `sendRecordCallback` already refuses `bad-url` and `bad-secret-name`, logged and never failing the
 *  review, and one place decides what a usable callback is. */
export const runnerRecordCallback = (env: Record<string, string | undefined> = process.env): RecordCallback | null => {
  const url = env.REVIEW_AGENT_RECORD_URL
  if (url === undefined || url.trim() === '') return null
  const secretEnv = env.REVIEW_AGENT_RECORD_SECRET_ENV
  return { url: url.trim(), secretEnv: secretEnv !== undefined && secretEnv.trim() !== '' ? secretEnv.trim() : 'REVIEW_AGENT_RECORD_SECRET' }
}

/** The client and the push-access question live in `@review-agent/github` since 0.2.0 (spec 0.2.0
 *  §3.1), so the CLI and the SDK build the same client and ask the same question. Re-exported here
 *  under the names the runner's own tasks and tests have always imported. */
export { octokitFor, pushAccessOf }

/** The runner's collaborators for `runReview`: the shared defaults (`defaultRunReviewDeps`), with
 *  the runner's own skill cache. Checkouts go under the system temp directory, a new directory per
 *  review, as they always have.
 *
 *  The focuses of a multi-reviewer review (spec 0.2.0 §8.3 point 4):
 *  - on trigger.dev, `runFocuses` — a child task per focus (`review-agent-focus`), each on a machine
 *    of its own, which the deployed task passes (decision §14.18 (a)). One review peaks around
 *    400 MiB and the runner's machine has 1 GB, so three Claude processes side by side do not fit
 *    one; until 0.2.0's Stage 6 the runner ran them one at a time instead.
 *  - in process (`runReviewJob`, on other hosting), side by side, `focusConcurrency` at a time —
 *    3 when left out (`DEFAULT_FOCUS_CONCURRENCY`), and fewer on a host short of memory. */
export const liveRunReviewDeps = (a: {
  note: (s: string) => void
  focusConcurrency?: number
  runFocuses?: FocusRunner
}): RunReviewDeps => ({
  ...defaultRunReviewDeps({
    note: a.note, ...(a.focusConcurrency !== undefined && { concurrency: a.focusConcurrency }),
  }),
  // Per user (spec 0.2.0 §9.3 P13). The temp directory is shared, and one cache directory for every
  // account on the machine let any of them plant an entry under the name this runner would look up;
  // `materialiseSkills` now creates it 0700 and trusts only what this user owns. The uid, not the
  // name, where there is one: it is what the ownership check compares. Read per review, not when
  // the deps are built, so a deployment's environment is what the review that runs under it sees.
  skillCacheDir: () => process.env.REVIEW_AGENT_SKILL_CACHE ??
    join(tmpdir(), `review-agent-skills-${process.getuid?.() ?? userInfo().username}`),
  ...(a.runFocuses !== undefined && { runFocuses: a.runFocuses }),
})

/** The App's own login, once per process for each App: it does not change while a worker lives, and
 *  a review should not pay a round trip for it twice. Only an answer is kept — a failure is asked
 *  again next time — and a failure is the caller's to log, never a reason to stop a review. */
const appLogins = new Map<string, string>()
const liveAppLogin = async (identity: AppIdentity): Promise<string> => {
  const known = appLogins.get(identity.clientId)
  if (known !== undefined) return known
  const login = await appBotLogin({ identity })
  appLogins.set(identity.clientId, login)
  return login
}

export const liveReviewTaskDeps = (a: {
  identity: () => AppIdentity
  log: (message: string, fields: Record<string, unknown>) => void
  metric: (name: string, value: number, attributes: Record<string, string>) => void
  /** Required, never defaulted: the deployed task passes Task 11's trigger port, and `runReviewJob`
   *  passes `null`, so which one a caller gets is always written where it is called. This file
   *  never names the port itself; Step 46's last case reads it as text to hold that. */
  startAnotherRun: TriggerPort | null
  /** Required, never defaulted, for the same reason: the deployed task passes trigger.dev run
   *  metadata and `runReviewJob` passes `null`, and each says so where it calls this. */
  checkRunMemory: CheckRunMemory | null
  recordCallback?: RecordCallback | null
  deployment?: () => DeploymentConfig
  /** Where a multi-reviewer review's focuses run. The deployed task passes child tasks; left out,
   *  they run in this process (`liveRunReviewDeps`). */
  runFocuses?: FocusRunner
  /** In process only: how many focuses run side by side. */
  focusConcurrency?: number
}): ReviewTaskDeps => ({
  env: process.env,
  identity: a.identity,
  now: () => new Date(),
  deadlineMs: DEFAULT_DEADLINE_MS,
  deployment: a.deployment ?? runnerDeployment,
  installationToken,
  makeOctokit: (token: string) => octokitFor({ token }),
  fetchPullRequest,
  fetchRepoConfig,
  // Read before the review, not during publishing: the re-review pass's question comes out of this
  // marker, and the pass runs inside `runReview` so its cost is recorded with the other two.
  findSummaryComment,
  hasPushAccess: pushAccessOf,
  runReview,
  // The pipeline's progress lines are log lines here, so what a person waits on in a terminal is
  // what an operator reads on the run page.
  runReviewDeps: liveRunReviewDeps({
    note: (s: string) => { a.log(s, {}) },
    ...(a.runFocuses !== undefined && { runFocuses: a.runFocuses }),
    ...(a.focusConcurrency !== undefined && { focusConcurrency: a.focusConcurrency }),
  }),
  publishReview,
  createCheckRun,
  completeCheckRun,
  closeCheckRunIfInProgress,
  checkRunMemory: a.checkRunMemory,
  log: a.log,
  metric: a.metric,
  startAnotherRun: a.startAnotherRun,
  recordCallback: a.recordCallback === undefined ? runnerRecordCallback() : a.recordCallback,
  sendRecord: sendRecordCallback,
  appLogin: liveAppLogin,
})

/** The collaborators of one focus run as a child task (`review-agent-focus`, spec 0.2.0 §8.3 point 4):
 *  the same token, client, reads, checkout, skill cache and engine as the review that started it,
 *  and the same deployment — so the focus resolves exactly the settings its review resolved. */
export const liveFocusTaskDeps = (a: {
  identity: () => AppIdentity
  log: (message: string, fields: Record<string, unknown>) => void
}): FocusTaskDeps => ({
  env: process.env,
  identity: a.identity,
  deployment: runnerDeployment,
  deadlineMs: FOCUS_DEADLINE_MS,
  installationToken,
  makeOctokit: (token: string) => octokitFor({ token }),
  fetchPullRequest,
  fetchRepoConfig,
  runReviewDeps: liveRunReviewDeps({ note: (s: string) => { a.log(s, {}) } }),
  log: a.log,
})

/** The task's whole run, in process, with no trigger.dev runtime: what Task 15's one paid review
 *  calls, and what a deployment on other hosting calls from its own job system (spec 0.2.0 §3.1,
 *  §7) — published as `@review-agent/app/runner` since 0.2.0. It is the SAME code the task runs, so
 *  a real posted review proves the task rather than a copy of it. It lives here and not in
 *  review-task.ts because that module calls `task()` at import, and nothing reachable from here
 *  imports `@trigger.dev/sdk` at all (`src/runner-boundary.test.ts`).
 *
 *  What differs from the deployed task is only what trigger.dev provides: nothing starts another run
 *  for a free failure, nothing remembers a check run across attempts, and a multi-reviewer review's
 *  focuses run in this process, `focusConcurrency` at a time (3 when left out — one review peaks
 *  around 400 MiB, so a 1 GB host says 1).
 *
 *  It returns `reviewed`, `skipped` or `refused`, and throws for everything else: `DoNotRetry` when
 *  running it again would pay for the model again or could not help, `RetryThis` for a crash at $0,
 *  and any other error for a failure before anything was spent. A host's own retry policy reads
 *  exactly that: never retry a `DoNotRetry`. */
export const runReviewJob = (a: {
  identity: AppIdentity
  installationId: number
  request: ReviewRequest
  deployment?: DeploymentConfig
  signal?: AbortSignal
  log?: (message: string, fields: Record<string, unknown>) => void
  focusConcurrency?: number
}): Promise<ReviewTaskResult> => {
  const log = a.log ?? ((message: string, fields: Record<string, unknown>) => {
    process.stderr.write(`${message} ${JSON.stringify(fields)}\n`)
  })
  const deployment = a.deployment
  return reviewTaskRun(
    { request: a.request, installationId: a.installationId },
    { signal: a.signal },
    liveReviewTaskDeps({
      identity: () => a.identity,
      log,
      // No runner to start another run on, and none is wanted: a review run in process is paid for
      // on somebody's say-so, once (Criss, 2026-09-14, answer 13; Task 15, decision 14).
      startAnotherRun: null,
      // In process there is no trigger.dev run, so nothing retries it and nothing is remembered.
      checkRunMemory: null,
      metric: (name: string, value: number, attributes: Record<string, string>) => {
        log('metric', { name, value, ...attributes })
      },
      ...(deployment !== undefined && { deployment: () => deployment }),
      ...(a.focusConcurrency !== undefined && { focusConcurrency: a.focusConcurrency }),
    }),
  )
}

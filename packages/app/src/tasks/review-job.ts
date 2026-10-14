import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, materialiseSkills, runCheckPass, runEngine, runRecheckPass,
  type DeploymentConfig, type ReviewRequest,
} from '@review-agent/core'
import {
  closeCheckRunIfInProgress, completeCheckRun, createCheckRun, downloadArchive, fetchPullRequest, fetchRepoConfig,
  findSummaryComment, publishReview, runReview, type RunReviewDeps,
} from '@review-agent/github'
import { z } from 'zod'
import { GITHUB_API_VERSION, installationToken, type AppIdentity } from '../credentials'
import type { TriggerPort } from '../dispatch'
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

/** The authenticated client, built once per review because an installation token expires in an
 *  hour. @octokit/core 7.0.8's constructor turns only `userAgent` and `timeZone` into headers
 *  (dist-src/index.js), so the API-version pin is a before-request hook, which every
 *  `octokit.request` passes through. `fetch` is injectable for the test and for nothing else. */
export const octokitFor = (a: { token: string; fetch?: typeof fetch }): Octokit => {
  const octokit = new Octokit({
    auth: a.token,
    ...(a.fetch !== undefined && { request: { fetch: a.fetch } }),
  })
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION
  })
  return octokit
}

/** GitHub's own boolean for decision 3's question, read off the live endpoint at Step 27c:
 *  `user.permissions.push`, true for admin, maintain and write, false for triage, read and none. The
 *  coarse `permission` word (admin | write | read | none) is not read, so there is one field to
 *  agree on — the one a deployment's own permission checks should read too. A response
 *  without it is not an answer that grants anything. */
const PermissionSchema = z.object({ user: z.object({ permissions: z.object({ push: z.boolean() }) }) })

/** Criss, 2026-09-14 (decision 3): whether a requester may spend this deployment's money. A 404 is
 *  an answer — GitHub does not know them on this repository — so it is `false`. Anything else is not
 *  an answer about the person and is thrown, before the engine, where it costs nothing. */
export const pushAccessOf = async (a: {
  octokit: Octokit; owner: string; repo: string; username: string
}): Promise<boolean> => {
  let data: unknown
  try {
    data = (await a.octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
      owner: a.owner, repo: a.repo, username: a.username,
    })).data
  } catch (e) {
    if ((e as { status?: unknown }).status === 404) return false
    throw e
  }
  const parsed = PermissionSchema.safeParse(data)
  if (!parsed.success) return false
  return parsed.data.user.permissions.push
}

export const liveRunReviewDeps = (a: { note: (s: string) => void }): RunReviewDeps => ({
  fetchPullRequest, fetchRepoConfig, downloadArchive, materialiseSkills, runEngine, runCheckPass,
  runRecheckPass,
  // A new directory per review: two reviews can share a warm machine, and a checkout that leaked
  // into another review's tree would be the reviewed code reviewing itself.
  makeCheckoutDir: () => mkdtemp(join(tmpdir(), 'review-agent-')),
  skillCacheDir: () => process.env.REVIEW_AGENT_SKILL_CACHE ?? join(tmpdir(), 'review-agent-skills'),
  now: () => new Date(),
  note: a.note,
})

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
  runReviewDeps: liveRunReviewDeps({ note: (s: string) => { a.log(s, {}) } }),
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
})

/** The task's whole run, in process, with no trigger.dev runtime: what Task 15's one paid review
 *  calls, and what a deployment on other hosting calls from its own runner (design §6). It is the
 *  SAME code the task runs, so the real posted review proves the task rather than a copy of it.
 *  It lives here and not in review-task.ts because that module calls `task()` at import, which is
 *  not verified to work outside a deployed worker. */
export const runReviewJob = (a: {
  identity: AppIdentity
  installationId: number
  request: ReviewRequest
  deployment?: DeploymentConfig
  signal?: AbortSignal
  log?: (message: string, fields: Record<string, unknown>) => void
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
    }),
  )
}

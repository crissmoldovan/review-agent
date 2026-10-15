import { installationToken, type AppIdentity } from '@review-agent/app'
import { isAutomatic, skipAsReleaseOnly } from '@review-agent/app/receiver'
import type { DeploymentConfig } from '@review-agent/core'
import { octokitFor } from '@review-agent/github'
import { pushAccessOf, reviewPullRequest, type ProgressEvent, type ReviewOptions, type ReviewResult, type SecretValue } from '@review-agent/sdk'
import { describeJob, type ReviewJob } from './job'
import type { Logger } from './log'
import type { RunOutcome } from './queue'

type Octokit = ReturnType<typeof octokitFor>

export type WorkerDeps = {
  identity: AppIdentity
  apiKey: SecretValue
  deployment: DeploymentConfig
  /** Absolute; each review's checkout is a new directory in it, removed when the review ends. */
  workDir: string
  skillCacheDir: string
  log: Logger
  // The three calls that reach GitHub or the model, replaceable so the worker is tested without either.
  mintToken?: typeof installationToken
  github?: (token: string) => Octokit
  review?: (options: ReviewOptions) => Promise<ReviewResult>
}

/** GitHub's own cap on a pull request's file list: 30 pages of 100 (`MAX_FILE_PAGES` in
 *  @review-agent/github). */
const MAX_FILE_PAGES = 30

/** The paths a pull request changes, for the release-only rule. Only the list: the review reads the
 *  pull request, its diff and its code itself. */
const changedPaths = async (octokit: Octokit, owner: string, repo: string, pr: number): Promise<string[]> => {
  const paths: string[] = []
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner, repo, pull_number: pr, per_page: 100, page,
    })
    const files = res.data as { filename: string }[]
    for (const f of files) paths.push(f.filename)
    if (files.length < 100) break
  }
  return paths
}

/** One review, from the queue: what the App's runner does for a delivery, with the SDK in place of
 *  trigger.dev (spec 0.2.0 §7, UC-7). It returns rather than throws, and says whether the queue should
 *  remember the job's key:
 *
 *  - remembered — the review ran (whatever it found), was refused, was skipped, or failed after the
 *    model had been paid: a redelivery of the same webhook must not pay for it again;
 *  - forgotten — it failed before anything was spent, or was cancelled: asking again should run again,
 *    as a trigger.dev run that failed clears its idempotency key.
 *
 *  It posts as the App: a token minted for this one repository, `post: true`, and a check run as the
 *  report, which an installation token can always create (spec 0.2.0 §2.2). */
export async function reviewJob(job: ReviewJob, signal: AbortSignal, deps: WorkerDeps): Promise<RunOutcome> {
  const { log } = deps
  const about = describeJob(job)
  const [owner = '', repo = ''] = job.request.repo.split('/')
  const automatic = isAutomatic(job.request)

  if (job.refused.length > 0) log.info('the request asked for something this deployment does not allow', { ...about, refused: job.refused })

  // A requested review is paid for on somebody's say-so, so that somebody must be able to push here
  // (the App's rule: docs/pull-requests.md, "Asking for a review"). Nobody named means nobody to ask.
  // The App posts a "Review refused" check run here; this example logs it.
  const requestedBy = job.request.requestedBy ?? ''
  if (!automatic && requestedBy === '') {
    log.warn('review refused: requested by nobody GitHub named, so push access cannot be checked', about)
    return { remember: true }
  }

  if (signal.aborted) {
    log.warn('review cancelled before it started', about)
    return { remember: false }
  }

  let octokit: Octokit
  try {
    // One token per review, scoped to the one repository, and dead within the hour: never cached
    // (docs/sdk.md, example 3). It never reaches the Claude process, whose environment is an allow-list.
    const { token } = await (deps.mintToken ?? installationToken)({
      identity: deps.identity, installationId: job.installationId, repositories: [repo],
    })
    octokit = (deps.github ?? ((t: string) => octokitFor({ token: t })))(token)

    // The App's release-only rule (design §5; `skipAsReleaseOnly` is the receiver's own): an AUTOMATIC
    // review of a pull request that changes only lock files, version files and changelogs is not paid
    // for. A `/review` on the same pull request still reviews — `skipAsReleaseOnly` checks that itself.
    if (automatic && skipAsReleaseOnly({
      request: job.request, changedPaths: await changedPaths(octokit, owner, repo, job.request.pr),
    })) {
      log.info('review skipped: every changed file is a release file', about)
      return { remember: true }
    }
  } catch (e) {
    // Nothing was spent: GitHub would not mint the token or list the files. Forgotten, so a redelivery
    // from the App's settings runs it.
    log.error('review failed before it started: GitHub did not answer', { ...about, error: e })
    return { remember: false }
  }

  const r = job.request
  log.info('review started', about)
  const result = await (deps.review ?? reviewPullRequest)({
    repo: r.repo,
    pr: r.pr,
    github: { octokit },
    credential: { apiKey: deps.apiKey },
    post: true,
    report: 'check-run',
    // The whole deployment object: the SDK merges it over the defaults, and ignores the two keys only
    // the receiver reads (`command`, `autoReview`).
    settings: deps.deployment,
    ...(r.tier !== undefined && { tier: r.tier }),
    ...(r.effort !== undefined && { effort: r.effort }),
    ...(r.model !== undefined && { model: r.model }),
    ...(r.check !== undefined && { check: r.check }),
    ...(r.brief !== undefined && { brief: r.brief }),
    ...(r.budgetUsd !== undefined && { budgetUsd: r.budgetUsd }),
    // One focused reviewer at a time: each is a Claude process of its own, and three at once would
    // triple a review's memory on a machine sized for one (spec 0.2.0 §8.3 point 4).
    ...(r.multi === true && { multi: { concurrency: 1 } }),
    // Asked after the pull request is read and before anything is downloaded or spent.
    ...(!automatic && { requestedBy, authorize: pushAccessOf }),
    workDir: deps.workDir,
    skillCacheDir: deps.skillCacheDir,
    signal,
    onProgress: (e) => { logProgress(log, about, e) },
  })
  return outcomeOf(log, about, result)
}

const logProgress = (log: Logger, about: Record<string, unknown>, e: ProgressEvent): void => {
  if (e.note !== undefined) log.info(e.note, { ...about, stage: e.stage, ...e.details })
  else if (e.stage !== 'done') log.info(`review ${e.stage}`, { ...about, ...('focus' in e && { focus: e.focus }) })
}

const outcomeOf = (log: Logger, about: Record<string, unknown>, r: ReviewResult): RunOutcome => {
  switch (r.kind) {
    case 'reviewed':
      log.info('review finished', {
        ...about,
        findings: r.findings.length,
        // Model spend at per-token API prices, as the Claude Code CLI reports it.
        costUsd: r.record.costUsd,
        conclusion: r.report?.conclusion ?? null,
        summaryUrl: r.posted?.summaryUrl ?? null,
        checkRunUrl: r.report?.url ?? null,
      })
      return { remember: true }
    case 'unfinished':
      log.warn('review did not finish', { ...about, reason: r.reason, spentUsd: r.spentUsd, stopped: r.stopped, retryable: r.retryable })
      return { remember: !forgettable(r) }
    case 'refused':
      log.info('review refused', { ...about, reason: r.reason })
      return { remember: true }
    case 'failed':
      // `cause` is the error as thrown and is not scanned by the SDK; the logger scans every line.
      log.error('review failed', {
        ...about, stage: r.stage, reason: r.reason, spentUsd: r.spentUsd, stopped: r.stopped, retryable: r.retryable, cause: r.cause,
      })
      return { remember: !forgettable(r) }
  }
}

/** Asking again may run again: nothing was spent (the SDK's `retryable`), or the server stopped it on
 *  the way down. A review its own deadline stopped after spending stays remembered. */
const forgettable = (r: { retryable: boolean; stopped: string | null }): boolean =>
  r.retryable || r.stopped === 'cancelled'

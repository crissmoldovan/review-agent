import { encodeRequestRefinement } from './refinement'
import type { Octokit } from '@octokit/core'
import {
  resolveSettings, scanForSecrets, SecretLeak, writesSummaryComment,
  type ClaudeRuntime, type DeploymentConfig, type EngineFailure, type ReportMode, type RepoConfig,
  type ResolvedSettings, type ReviewRecord, type ReviewRequest,
} from '@review-agent/core'
import type { ReviewVia } from './body'
import {
  checkRunWanted, gateOf, verdictJson, type CheckConclusion, type CheckOutcome,
} from './check-run'
import { removeCheckout } from './checkout'
import { recheckQuestions, repeatCandidates, type MarkerState } from './marker'
import { fetchPullRequest as fetchPullRequestLive, type PullRequestContext } from './pr'
import { findSummaryComment as findSummaryCommentLive, type FoundSummary } from './post'
import { publishReview as publishReviewLive, type PublishedReview } from './publish'
import { refuseUnbuilt } from './refusals'
import { fetchRepoConfig as fetchRepoConfigLive } from './repo-config'
import { noReporter, type ReportHandle, type ReportKind, type Reporter } from './reporter'
import {
  runReview as runReviewLive, type FocusRunner, type ReviewAsk, type RunReviewDeps, type RunReviewResult,
} from './run-review'

// ── What the App's runner and the session share ──────────────────────────────────────────────────
// Moved here from `app/src/tasks/review-run.ts` in 0.2.0 (spec 0.2.0 §3.1). The runner imports them
// from here, so the money rules and the sentences a pull request reads are written once, whichever
// way in a review came.

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Any free text that is about to be put in front of people — a check run's summary, a commit
 *  status, a failed result an SDK host may print — made safe to render. `runReview`'s scan covers the
 *  review output and the check verdicts (Task 1, Step 16) and nothing scans the message of an error
 *  a collaborator threw: an octokit error can quote the request it made, and a token can be in it.
 *  Design §4.3: the output is scanned for secrets before posting. The withheld sentence names no
 *  pattern and no location, because what it is written on is public. */
export const saidSafely = (s: string): string =>
  scanForSecrets(s).length > 0 ? 'its text is withheld because it matched a secret pattern' : s

/** One sentence a human reads about a review that produced nothing. The `cli-error` branch carries
 *  the Claude CLI's own words ("Not logged in · Please run /login"), which is the most useful thing
 *  to say — but it is model-adjacent text on a posting path, so it gets the same secret scan
 *  everything else posted gets (design §4.3). */
export const failureSentence = (record: ReviewRecord): string => {
  if (record.failure === null) return 'the review completed'
  // A multi-reviewer review fails only when every focus produced nothing (spec 0.2.0 §8.3 point 2),
  // and `failure` is then the first focus's alone: each is named, so a reader is not sent looking at
  // one focus's ceiling for a review whose other two crashed.
  // `?? []`: a record written before 0.2.0 has no `focuses`, and this rule is exported for hosts that
  // keep records.
  const focuses = record.focuses ?? []
  if (focuses.length > 0) {
    return `none of the ${focuses.length} focused reviewers produced a review — ` +
      focuses.map((f) => `${f.lens}: ${stopSentence(f.failure, record.settings.budget.ceilingUsd)}`).join('; ')
  }
  return stopSentence(record.failure, record.settings.budget.ceilingUsd)
}

/** Why one engine run produced nothing, in a sentence; `ceilingUsd` is the ceiling it ran under. */
const stopSentence = (f: EngineFailure | null, ceilingUsd: number): string => {
  if (f === null) return 'it returned no answer'
  switch (f.kind) {
    case 'budget':
      return `the review stopped at its $${ceilingUsd.toFixed(2)} ceiling after $${f.spentUsd.toFixed(2)}`
    case 'schema': return 'the model could not produce a review in the required shape'
    case 'refusal': return 'the model answered in prose instead of the review schema'
    case 'crashed': return `the reviewer process crashed (exit ${String(f.code)})`
    case 'cli-error':
      return scanForSecrets(f.message).length > 0
        ? 'the Claude CLI reported an error; its text is withheld because it matched a secret pattern'
        : `the Claude CLI reported: ${f.message}`
  }
}

/** May this review be run again, and paid for a second time? Only a run that failed and spent
 *  nothing, for a reason a second run can change.
 *  `costUsd` is the CLI's `total_cost_usd`, computed at per-token API prices; on a subscription
 *  credential the same figure is drawn from the subscription allowance instead of billed. Either
 *  way it is spent, and spending it twice buys nothing. */
export const mayRetry = (record: ReviewRecord): boolean => {
  if (record.failure === null) return false
  if (record.costUsd > 0) return false
  switch (record.failure.kind) {
    // The model answered and declined, answered off-schema, or hit its ceiling. All three are
    // decided by the same prompt over the same commit: attempt two buys the same answer twice.
    case 'budget': case 'schema': case 'refusal': return false
    // The CLI died, or reported an error before producing anything, without spending — a killed
    // child, an overloaded API. The one class a retry can actually fix.
    case 'crashed': case 'cli-error': return true
  }
}

/** One posted inline comment, and the finding it carries. `line` is where the comment was PLACED,
 *  which is the line a reply's thread hangs off. */
export type PostedComment = { findingId: string; file: string; line: number; commentId: number }

/** This run's comments, from the marker `publishReview` just wrote. The marker keeps up to ten runs
 *  and the last one for this head sha is the one this review appended — an earlier review's comments
 *  belong to that review's record, and a reply under one of them is about that review. A finding
 *  with no comment id — summary-only, or an inline comment GitHub refused — has nothing a reply
 *  could hang off, and is left out. So is a finding found again (`said.repeated`, Criss, 2026-10-15):
 *  its row carries the earlier review's comment, which this review noted and did not post. */
export const postedCommentsOf = (
  published: { headSha: string; marker: MarkerState; said?: { repeated?: { commentId: number }[] } },
): PostedComment[] => {
  const run = [...published.marker.runs].reverse().find((r) => r.headSha === published.headSha)
  const noted = new Set((published.said?.repeated ?? []).map((r) => r.commentId))
  return (run?.findings ?? []).flatMap((f) =>
    f.commentId === null || noted.has(f.commentId)
      ? [] : [{ findingId: f.id, file: f.file, line: f.line, commentId: f.commentId }])
}

/** 30 minutes: six times the slowest review ever measured (4m40s, design §8). Not a performance
 *  target: the point past which something has gone wrong and a person should be told. A host with a
 *  harder limit of its own passes a shorter `deadlineMs`, so the session's stop is the one that fires
 *  and the report is completed rather than left running. */
export const DEFAULT_SESSION_DEADLINE_MS = 30 * 60 * 1000

// ── The session ──────────────────────────────────────────────────────────────────────────────────

/** Why a review did not produce one, and where it stopped (spec 0.2.0 §4.3):
 *  - `before-model`: nothing was spent — GitHub would not answer, the report could not be opened,
 *    the archive would not download, or the review was cancelled before the engine started;
 *  - `model`: the engine ran, and something after it failed or the review was stopped;
 *  - `withheld`: the output matched a secret pattern, so nothing of it is said anywhere;
 *  - `publish`: the review ran and was paid for, and GitHub would not take it. `review` carries it,
 *    so a caller can still show it rather than lose it. */
export type SessionStage = 'before-model' | 'model' | 'withheld' | 'publish'

/** How the review was reported on the commit, when it was. `conclusion` is what a check run would
 *  conclude — `neutral` for a review that did not run — for a commit status too; null when the
 *  report could not be completed. */
export type SessionReport = { kind: ReportKind; id: number | null; url: string | null; conclusion: CheckConclusion | null }

/** Who stopped a review that was stopped: the deadline, or whoever ran it (`signal`). */
export type StoppedBy = 'deadline' | 'cancelled'

export type SessionFailed = {
  kind: 'failed'
  stage: SessionStage
  /** One sentence, already scanned for secrets: safe to show anyone who can see the pull request. */
  reason: string
  /** Model spend known to have been spent, at per-token API prices: the record's figure where there
   *  is a record, and what was watched going out where there is not — a lower bound when a pass was
   *  cut off mid-run. */
  spentUsd: number
  engineStarted: boolean
  /** Whether running the same review again could not pay for the model twice: nothing was spent,
   *  and it was not stopped on purpose. A host's retry policy reads this, never `stage`. */
  retryable: boolean
  stopped: StoppedBy | null
  /** The finished review that could not be posted (`stage: 'publish'`); null otherwise. */
  review: RunReviewResult | null
  report: SessionReport | null
  /** The error as it was thrown, for the caller's own logs. Never shown to anyone by this product:
   *  it is not scanned, and `reason` is the sentence that is. */
  cause: unknown
}

export type SessionUnfinished = {
  kind: 'unfinished'
  /** The model ran and produced nothing usable (spec 0.2.0 §4.3), or was stopped before it could. */
  review: RunReviewResult
  record: ReviewRecord
  reason: string
  spentUsd: number
  retryable: boolean
  stopped: StoppedBy | null
  /** The "This review did not complete" summary, when it was written: never for a stopped review,
   *  which says so on its report alone, and never when not posting. */
  published: PublishedReview | null
  report: SessionReport | null
  /** The checkout, when `keepCheckout` asked for it to be kept; otherwise it is gone. */
  checkoutDir: string | null
}

export type SessionReviewed = {
  kind: 'reviewed'
  review: RunReviewResult
  record: ReviewRecord
  /** What was posted; null when the session was not posting. */
  published: PublishedReview | null
  report: SessionReport | null
  /** The hidden machine-readable line (`verdictJson`) — a check run's `output.text` — whenever the
   *  review was published, in every mode; null when not posting. */
  verdict: string | null
  /** The inline comment each of this review's posted findings became. Empty when nothing was. */
  comments: PostedComment[]
  /** The stop landed after the review had already finished, and it was published anyway. */
  stoppedAfterFinishing: boolean
  checkoutDir: string | null
}

export type SessionResult = SessionReviewed | SessionUnfinished | SessionFailed

/** A pull request, read and settled, before anything is spent on it: everything a caller's gates need
 *  (who asked, which files changed, the report's name) and everything `runReviewSession` would
 *  otherwise fetch a second time — and a second fetch could answer with a different commit. */
export type PreparedReview = {
  kind: 'prepared'
  octokit: Octokit
  owner: string
  repo: string
  number: number
  deployment: DeploymentConfig
  /** What was asked, minus what the deployment does not allow (`refuseUnbuilt`). */
  ask: ReviewAsk
  /** Those settings, phrased, for the summary's "Not honoured" (Criss, decision 4). */
  refused: string[]
  pr: PullRequestContext
  /** The reviewed repository's own settings file, read from the BASE commit (design §4.3, §7). */
  repoConfig: RepoConfig | null
  /** Resolved from the deployment, the repository and the ask, at the head this review will read. */
  settings: ResolvedSettings
}

const failure = (a: {
  stage: SessionStage; reason: string; spentUsd?: number; engineStarted?: boolean; retryable: boolean
  stopped?: StoppedBy | null; review?: RunReviewResult | null; report?: SessionReport | null; cause?: unknown
}): SessionFailed => ({
  kind: 'failed', stage: a.stage, reason: a.reason, spentUsd: a.spentUsd ?? 0,
  engineStarted: a.engineStarted ?? false, retryable: a.retryable, stopped: a.stopped ?? null,
  review: a.review ?? null, report: a.report ?? null, cause: a.cause,
})

/** The first half of a review (spec 0.2.0 §3): read the pull request and the repository's settings
 *  file, and resolve the settings this review will run with. No model, nothing written.
 *
 *  It returns a failure rather than throwing one — GitHub not answering is an outcome a caller
 *  handles, and costs nothing (`stage: 'before-model'`, `retryable: true`). It throws only for a
 *  programmer's error. */
export async function prepareReview(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  deployment: DeploymentConfig
  ask: ReviewAsk
  deps?: { fetchPullRequest?: typeof fetchPullRequestLive; fetchRepoConfig?: typeof fetchRepoConfigLive }
}): Promise<PreparedReview | SessionFailed> {
  if (!Number.isInteger(a.number) || a.number <= 0) throw new TypeError(`number must be a pull request number, got ${String(a.number)}`)
  const fetchPullRequest = a.deps?.fetchPullRequest ?? fetchPullRequestLive
  const fetchRepoConfig = a.deps?.fetchRepoConfig ?? fetchRepoConfigLive
  // Decision 4, for every way in: what the deployment does not allow is dropped and named, never run
  // in silence — today, a `multi` with `allowMulti: false` (spec 0.2.0 §14.19). Applied here, so the
  // CLI and an SDK host refuse exactly what the App refuses. Whether a review is automatic is the
  // caller's to know, not this function's — the App's runner refuses `multi` on an automatic review
  // itself (§14.19) before it calls this function, as it did before it moved onto it. The ask's
  // own `repo`, `pr` and `headSha`, if a JavaScript caller put them there, go too: the review is of
  // the pull request fetched below and nothing else.
  const unbuilt = refuseUnbuilt(a.ask as Partial<ReviewRequest>, { allowMulti: a.deployment.allowMulti })
  const { repo: _repo, pr: _pr, headSha: _headSha, ...ask } = unbuilt.request
  try {
    const pr = await fetchPullRequest({ octokit: a.octokit, owner: a.owner, repo: a.repo, number: a.number })
    // From the BASE commit: a pull request that can edit `.review-agent/review.md` would write the
    // instructions that judge it (design §4.3, §7). The report's mode depends on it — a repository
    // may lower it — so it is read before anything is reported.
    const repoConfig = await fetchRepoConfig({ octokit: a.octokit, owner: a.owner, repo: a.repo, baseRef: pr.baseSha })
    const settings = resolveSettings({
      deployment: a.deployment, repo: repoConfig,
      request: { ...ask, repo: `${a.owner}/${a.repo}`, pr: a.number, headSha: pr.headSha },
    })
    return {
      kind: 'prepared', octokit: a.octokit, owner: a.owner, repo: a.repo, number: a.number,
      deployment: a.deployment, ask, refused: unbuilt.refused, pr, repoConfig, settings,
    }
  } catch (e) {
    return failure({
      stage: 'before-model', retryable: true, cause: e,
      reason: `the pull request could not be read: ${saidSafely(messageOf(e))}`,
    })
  }
}

export type SessionDeps = {
  /** How to download, where to put the checkout, the engine: `defaultRunReviewDeps()` for real. */
  runReviewDeps: RunReviewDeps
  /** Seams for tests; the real ones when left out. */
  runReview?: typeof runReviewLive
  publishReview?: typeof publishReviewLive
  findSummaryComment?: typeof findSummaryCommentLive
  /** Operational lines — never the review itself. Never allowed to fail a review. */
  log?: (message: string, fields: Record<string, unknown>) => void
}

/** A `FocusRunner`, watched: the engine counts as started before the focuses are asked for, and what
 *  they report spending is added to the spend the session knows of, the moment they answer. */
const watchFocuses = (run: FocusRunner, spend: { engineStarted: boolean; usd: number }): FocusRunner =>
  async (x) => {
    spend.engineStarted = true
    const outcome = await run(x)
    spend.usd += outcome.runs.reduce((total, r) => total + r.result.usage.costUsd, 0)
    return outcome
  }

/** A repository config with its mode taken out, for a review whose mode the session has settled. */
const withoutMode = (c: RepoConfig | null): RepoConfig | null => {
  if (c === null) return null
  const { mode: _mode, ...rest } = c
  return rest
}

/** The second half of a review, the same whichever way in asked for it (spec 0.2.0 §3): open the
 *  report, read the previous review's marker, run the review with its deadline, publish it, finish
 *  the report, and remove the checkout. The App's runner, the CLI and the SDK all end here, so a
 *  review is the same review whoever asked.
 *
 *  It returns every outcome — reviewed, unfinished, failed — and throws only a programmer's error.
 *  It knows nothing about any runner: where the App's runner on trigger.dev must decide whether to
 *  start another run, it reads `retryable`.
 *
 *  `post: false` is the CLI's reading mode: no marker read, no re-review pass, nothing written to
 *  GitHub, no report — `reporter` is not consulted. */
export async function runReviewSession(a: {
  prepared: PreparedReview
  /** Post the review, its comments and summary, and report on the commit. */
  post: boolean
  /** How to report on the commit (`reporterFor`). Consulted only when posting; none when left out. */
  reporter?: Reporter
  /** How this review was run, which every posted body says (spec 0.2.0 §5.6). */
  via: ReviewVia
  /** The login about to post, when known: its own summary comment is preferred (§14.7). */
  selfLogin?: string
  /** The App's own bot login, when known: its replies are not a person's answer (§14.6). */
  ignoreRepliesFrom?: string
  /** Refusals the caller made before preparing, phrased (Criss, decision 4). */
  refused?: string[]
  /** Carried on a check run: the App's Re-run settings. */
  externalId?: string
  /** The credential, binary and variables every model pass runs with (spec 0.2.0 §3.2). */
  runtime?: ClaudeRuntime
  signal?: AbortSignal
  deadlineMs?: number
  /** Leave the downloaded code where it is, and say where (spec 0.2.0 §3.3). */
  keepCheckout?: boolean
  /** Buy the re-review pass over the previous review's findings, when there is a previous review
   *  (spec 0.2.0 §5.2, the CLI's `--re-review`; on unless `false`). `false` still reads the previous
   *  summary — this review edits it rather than posting a second, and carries its state on — but asks
   *  nothing about it, so no earlier finding is judged resolved and the pass costs nothing. Read only
   *  when posting: a review that posts nothing reads no previous summary at all. */
  reReview?: boolean
  /** Hears the review the moment it has run — before anything is published or reported — whatever
   *  it produced: the place a host records what the model cost, which it must not miss because
   *  publishing failed. The App's runner emits its metrics and its "review finished" line here, where
   *  it always has (0.2.0 Stage 6). It runs after the money is spent, so a throw from it is a failure
   *  like any other there — the report says the review did not complete, the result is `failed` at
   *  stage `model` and not retryable — never a free-looking error that buys the review again. Not
   *  called for a review that threw: there is no review to hear. */
  onReviewed?: (review: RunReviewResult) => void | Promise<void>
  deps: SessionDeps
}): Promise<SessionResult> {
  const { prepared } = a
  if (prepared?.kind !== 'prepared') throw new TypeError('runReviewSession needs what prepareReview returned')
  if (typeof a.post !== 'boolean') throw new TypeError('post must be true or false')
  const deadlineMs = a.deadlineMs ?? DEFAULT_SESSION_DEADLINE_MS
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError(`deadlineMs must be a positive number, got ${String(deadlineMs)}`)

  const runReview = a.deps.runReview ?? runReviewLive
  const publishReview = a.deps.publishReview ?? publishReviewLive
  const findSummaryComment = a.deps.findSummaryComment ?? findSummaryCommentLive
  const log = (message: string, fields: Record<string, unknown>): void => {
    try { a.deps.log?.(message, fields) } catch { /* a logger that throws must not undo a review */ }
  }
  const { octokit, owner, repo, number, pr, settings } = prepared
  const where = { repo: `${owner}/${repo}`, pr: number }

  // A signal that has ALREADY aborted never fires its listener, and the listener below is attached
  // after a round trip to GitHub — so without this a cancelled review opens a report and pays the
  // model in full for an answer nobody is waiting for.
  if (a.signal?.aborted === true) {
    return failure({ stage: 'before-model', retryable: false, stopped: 'cancelled', reason: 'the review was cancelled before it started' })
  }

  const configuredMode = settings.report.mode
  // Every mode gets a report except `silent` (Task 6), and only when posting: a report on the commit
  // is a write, and `post: false` writes nothing.
  let handle: ReportHandle | null = null
  if (a.post && checkRunWanted(configuredMode)) {
    try {
      handle = await (a.reporter ?? noReporter).start({
        octokit, owner, repo, headSha: pr.headSha, name: settings.report.checkRunName,
        // The settings a Re-run repeats (design §5). A caller may pass its own; otherwise the session
        // stamps what was asked, less what was refused — so the CLI's, the SDK's and the self-hosted
        // server's check runs carry them too, not only the App's (0.2.0).
        externalId: a.externalId ?? encodeRequestRefinement({ ...prepared.ask, repo: `${owner}/${repo}`, pr: number, headSha: pr.headSha }),
        gate: gateOf(settings.report), mode: configuredMode,
        maxInline: settings.report.maxInline, bands: settings.severity.bands, log,
      })
    } catch (e) {
      // Before the archive and the engine: the report could not be opened — a token that cannot
      // create a check run, or set a status — and nothing has been spent.
      return failure({
        stage: 'before-model', retryable: true, cause: e,
        reason: `the review could not be reported on the commit: ${saidSafely(messageOf(e))}`,
      })
    }
  }

  // Decision §14.3: `check-only` posts its findings as a check run's annotations, and nothing else.
  // With no check run to carry them — a person's token reports with a commit status, or nothing —
  // they go into the summary comment instead, rather than nowhere. The review runs as `summary-only`
  // from here on, so the record, the re-review pass and the publisher all agree about what it did.
  const mode: ReportMode = a.post && configuredMode === 'check-only' && handle?.kind !== 'check-run'
    ? 'summary-only'
    : configuredMode
  const deployment: DeploymentConfig = mode === configuredMode
    ? prepared.deployment
    : { ...prepared.deployment, report: { ...prepared.deployment.report, mode } }
  // The repository may only LOWER the mode (config.ts, LOUDNESS), so its own `check-only` would
  // undo the line above; this review's mode is settled, and its other settings are kept.
  const repoConfig = mode === configuredMode ? prepared.repoConfig : withoutMode(prepared.repoConfig)

  let conclusion: CheckConclusion | null = null
  const report = (): SessionReport | null =>
    handle === null ? null : { kind: handle.kind, id: handle.id, url: handle.url, conclusion }

  /** Wall clock, and the stop that is meant to fire. A signal this session holds is one it can catch,
   *  finish the report from, and kill the model's child process with (EngineInput.signal →
   *  spawnClaude → the child). */
  const stop = new AbortController()
  const stopped: { by: StoppedBy | null } = { by: null }
  // At most once, here as in the handle: a second call — the catch-all below, after a report was
  // already finished — must not overwrite the conclusion the result reports with the handle's `null`.
  let finished = false
  const finish = async (outcome: CheckOutcome, summaryUrl: string | null = null): Promise<void> => {
    if (handle === null || finished) return
    finished = true
    conclusion = await handle.finish({ outcome, summaryUrl, interrupted: stopped.by === 'cancelled' })
  }
  const failedOutcome = (reason: string): CheckOutcome => ({ kind: 'failed', headSha: pr.headSha, reason })

  const cancel = (): void => {
    stopped.by ??= 'cancelled'
    stop.abort(new Error('the review was cancelled'))
  }
  a.signal?.addEventListener('abort', cancel, { once: true })
  // Again, immediately: an abort that landed between the check above and the listener fired nothing,
  // and everything after this point is the part that spends. Truthiness rather than `=== true`:
  // TypeScript narrows `aborted` to `false` from the guard above, which the live getter is not.
  if (a.signal?.aborted ?? false) cancel()
  const timer = setTimeout(() => {
    stopped.by ??= 'deadline'
    stop.abort(new Error(`the review passed its ${Math.round(deadlineMs / 1000)}s deadline and was stopped`))
  }, deadlineMs)
  // Nothing should be kept alive by a review that already finished.
  timer.unref()

  // What the engine has already been paid, watched from the outside. `runReview` throws SecretLeak
  // and can throw from `runCheckPass` AFTER `runEngine` has spent, and neither error carries a usage
  // or a record — so the only way to know the money is gone is to have seen it go.
  const spend = { engineStarted: false, usd: 0 }
  let checkoutToRemove: string | null = null
  const kept = (dir: string): string | null => (a.keepCheckout === true ? dir : null)
  const refused = [...new Set([...(a.refused ?? []), ...prepared.refused])]
  const publishWith = {
    via: a.via,
    ...(a.selfLogin !== undefined && { selfLogin: a.selfLogin }),
    ...(a.ignoreRepliesFrom !== undefined && { ignoreRepliesFrom: a.ignoreRepliesFrom }),
    ...(refused.length > 0 && { refused }),
  }

  try {
    const base = a.deps.runReviewDeps
    const runDeps: RunReviewDeps = {
      ...base,
      // What prepareReview already read: a second fetch could answer with a different commit from
      // the one the report was opened on.
      fetchPullRequest: async () => pr,
      fetchRepoConfig: async () => repoConfig,
      runEngine: async (input) => {
        spend.engineStarted = true
        const result = await base.runEngine(input)
        spend.usd += result.usage.costUsd
        return result
      },
      runCheckPass: async (x) => {
        const checked = await base.runCheckPass(x)
        spend.usd += checked.usage.costUsd
        return checked
      },
      runRecheckPass: async (x) => {
        const judged = await base.runRecheckPass(x)
        spend.usd += judged.usage.costUsd
        return judged
      },
      // Focuses run elsewhere (spec 0.2.0 §8.3 point 4) are model spend like any other: watched the
      // same way, so a failure after they ran is never mistaken for one that spent nothing. Counted
      // as started before they are asked for — what a focus that failed had spent is not known here,
      // and not knowing is never read as nothing.
      ...(base.runFocuses !== undefined && { runFocuses: watchFocuses(base.runFocuses, spend) }),
    }

    // The previous review's marker, before the review, because the re-review pass's question comes
    // out of it — and only when this review will write a summary for the answer to land in. A
    // refusal here is not a failed review: the pass is not bought, and `publishReview` reads for
    // itself. `undefined` is "nobody looked"; `null` is "looked, and there is none".
    let existing: FoundSummary | null | undefined
    if (a.post && writesSummaryComment(mode)) {
      try {
        existing = await findSummaryComment({
          octokit, owner, repo, number, ...(a.selfLogin !== undefined && { selfLogin: a.selfLogin }),
        })
      } catch (e) {
        log('the previous review’s marker could not be read; no re-review pass will run', {
          ...where, error: saidSafely(messageOf(e)),
        })
      }
    }
    const publishExisting = existing === undefined ? {} : { existing }
    // No question, no pass: `runReview` buys the re-review pass only for a non-empty list.
    const previousFindings = existing === undefined || a.reReview === false
      ? []
      : recheckQuestions(existing?.marker ?? null).questions
    // The earlier comments still open, for the check pass to say which new finding repeats one (Criss,
    // 2026-10-15). Not behind `reReview`: that skips a pass and its spend, and this is a few rows more
    // for the check pass to read, which decides what is said either way.
    const earlierComments = existing === undefined ? [] : repeatCandidates(existing?.marker ?? null).questions

    let review: RunReviewResult
    try {
      review = await runReview({
        octokit, owner, repo, number, deployment, ask: prepared.ask, deps: runDeps, signal: stop.signal,
        previousFindings, earlierComments, ...(a.runtime !== undefined && { runtime: a.runtime }),
      })
      checkoutToRemove = review.checkoutDir
    } catch (e) {
      // SecretLeak's own message is names and locations only, never the matched text
      // (packages/core/src/secrets.ts), so it is safe to render as it is. The stop's reason is a
      // sentence this file wrote. Anything else is somebody else's error and is scanned.
      const reason = stop.signal.aborted
        ? messageOf(stop.signal.reason)
        : e instanceof SecretLeak
          ? `the review was withheld: ${e.message}`
          : `the review did not complete: ${saidSafely(messageOf(e))}`
      await finish(failedOutcome(reason))
      return failure({
        stage: e instanceof SecretLeak ? 'withheld' : spend.engineStarted ? 'model' : 'before-model',
        reason, spentUsd: spend.usd, engineStarted: spend.engineStarted,
        // The engine has run: a second run asks the same model the same question about the same
        // commit and pays again — a withheld review is withheld again. A stopped one was stopped on
        // purpose. Before the engine — a tarball 502, a skill that would not download — nothing was
        // spent, and a second run is what can fix it.
        retryable: !(spend.engineStarted || stop.signal.aborted || e instanceof SecretLeak),
        stopped: stopped.by, report: report(), cause: e,
      })
    }

    const { record } = review
    // The caller's bookkeeping, before anything is published. Inside this `try`: a throw lands in the
    // catch-all below, which finishes the report and returns a failure that spent.
    await a.onReviewed?.(review)

    // A review that is FINISHED is published, even if the stop landed while it was finishing
    // (Criss, 2026-09-16): the re-review pass swallows its own abort and returns normally, so a
    // deadline landing in it produced a complete, paid-for review that used to be thrown away.
    const finished = review.result.output !== null && review.result.failure === null
    if (stop.signal.aborted && !finished) {
      // The engine came back after its child was killed, with nothing usable. Whatever it reports,
      // this review was stopped, and that is what the report says.
      const reason = messageOf(stop.signal.reason)
      await finish(failedOutcome(reason))
      return {
        kind: 'unfinished', review, record, reason, spentUsd: record.costUsd, retryable: false,
        stopped: stopped.by, published: null, report: report(), checkoutDir: kept(review.checkoutDir),
      }
    }
    const stoppedAfterFinishing = stop.signal.aborted
    if (stoppedAfterFinishing) {
      log('the review was stopped after it had already finished; publishing it anyway', {
        ...where, reason: saidSafely(messageOf(stop.signal.reason)),
      })
    }

    if (review.result.output === null) {
      // Nothing to place on a line, but the pull request is still told: publishReview writes the
      // summary that says "This review did not complete" in its own fixed words — never the CLI's
      // unscanned stderr — and carries the previous marker over untouched. Returning without it would
      // leave the LAST review's summary standing as though it were this one's.
      const sentence = failureSentence(record)
      let published: PublishedReview | null = null
      if (a.post) {
        try {
          published = await publishReview({ octokit, owner, repo, number, review, ...publishWith, ...publishExisting })
        } catch (e) {
          // The reason the review stopped is the more useful thing to say, so a failure to write the
          // summary is logged and does not replace it on the report.
          log('the unfinished review could not be published', { ...where, error: saidSafely(messageOf(e)) })
        }
      }
      await finish(failedOutcome(sentence), published?.summaryUrl ?? null)
      return {
        kind: 'unfinished', review, record, reason: sentence, spentUsd: record.costUsd,
        retryable: mayRetry(record), stopped: null, published, report: report(),
        checkoutDir: kept(review.checkoutDir),
      }
    }

    if (!a.post) {
      return {
        kind: 'reviewed', review, record, published: null, report: null, verdict: null, comments: [],
        stoppedAfterFinishing, checkoutDir: kept(review.checkoutDir),
      }
    }

    // A budget stop keeps the partial findings the model had already written, so the test above is
    // whether there is anything to say and not whether the engine finished.
    let published: PublishedReview
    try {
      published = await publishReview({ octokit, owner, repo, number, review, ...publishWith, ...publishExisting })
    } catch (e) {
      // Paid for, and GitHub would not take it. The review is handed back (`review`), so whoever ran
      // it can still show it; running it again would pay for the model a second time because GitHub
      // had a bad minute.
      const reason = `the review ran and could not be posted: ${saidSafely(messageOf(e))}`
      await finish(failedOutcome(reason))
      return failure({
        stage: 'publish', reason, spentUsd: record.costUsd, engineStarted: true, retryable: false,
        stopped: stopped.by, review, report: report(), cause: e,
      })
    }

    const outcome: CheckOutcome = {
      kind: 'reviewed', headSha: published.headSha,
      tier: review.settings.tier, model: review.settings.model, costUsd: record.costUsd,
      // What the review SAID (in check-only, would have said), at the check pass's severity and never
      // a refuted finding — so the gate cannot fail a build over something the check pass disproved.
      findings: published.findings,
      confirmed: published.confirmed,
      cutShort: review.result.cutShort,
      // Inline, summary-only and found again: a finding said only in the summary was still said, and
      // so was one noted as still present on the earlier comment that reports it.
      posted: published.counts.inline + published.counts.summaryOnly + published.counts.repeated,
      // GitHub's own link to the summary, now that it hands one back (spec 0.2.0 §14.2).
      summaryUrl: published.summaryUrl,
    }
    await finish(outcome, published.summaryUrl)
    log('review published', {
      ...where, headSha: published.headSha.slice(0, 12), mode: published.mode, conclusion,
      inline: published.counts.inline, summaryOnly: published.counts.summaryOnly,
      droppedInline: published.counts.droppedInline, suppressed: published.counts.suppressed,
      notInCheckout: published.counts.notInCheckout, retracted: published.counts.retracted,
      reinstated: published.counts.reinstated, retractionsWithheld: published.counts.retractionsWithheld,
      repeated: published.counts.repeated, stillPresentNoted: published.counts.stillPresentNoted,
    })
    return {
      kind: 'reviewed', review, record, published, report: report(),
      verdict: verdictJson({ outcome, bands: review.settings.severity.bands }),
      comments: postedCommentsOf(published), stoppedAfterFinishing, checkoutDir: kept(review.checkoutDir),
    }
  } catch (e) {
    // Whatever no branch above was written for. Returned, not thrown: a caller that cannot tell a
    // failure that spent from one that did not is a caller that pays twice. The report is finished
    // at most once, so one already completed is untouched and one still open stops saying so.
    const reason = saidSafely(messageOf(e))
    await finish(failedOutcome(reason))
    return failure({
      stage: spend.engineStarted ? 'model' : 'before-model', reason, spentUsd: spend.usd,
      engineStarted: spend.engineStarted, retryable: !spend.engineStarted && !stop.signal.aborted,
      stopped: stopped.by, report: report(), cause: e,
    })
  } finally {
    clearTimeout(timer)
    a.signal?.removeEventListener('abort', cancel)
    // The downloaded code, once publishing has read it (spec 0.2.0 §3.3, §9.3 P6), unless asked to keep
    // it. A review that failed inside `runReview` has already had its checkout removed there.
    if (checkoutToRemove !== null && a.keepCheckout !== true) await removeCheckout(checkoutToRemove)
  }
}

import type { Octokit } from '@octokit/core'
import {
  modelCredentialFromEnv,
  type DeploymentConfig, type ModelCredential, type ReviewRecord,
} from '@review-agent/core'
import {
  checkRunReporter, checkRunWanted, DEFAULT_SESSION_DEADLINE_MS, gateOf, mayRetry, postedCommentsOf,
  prepareReview, refuseUnbuilt, runReviewSession, saidSafely,
  type CheckConclusion, type closeCheckRunIfInProgress, type completeCheckRun, type createCheckRun,
  type fetchPullRequest, type fetchRepoConfig, type findSummaryComment, type PostedComment,
  type PublishCounts, type publishReview, type runReview, type ReviewVia, type RunReviewDeps,
  type SessionFailed, type SessionResult,
} from '@review-agent/github'
import type { AppIdentity, installationToken } from '../credentials'
import { encodeRequestRefinement, isAutomatic, skipAsReleaseOnly } from '../decide'
import {
  REVIEW_TASK_ID, idempotencyKeyFor, tagsFor, type ReviewTaskPayload, type TriggerPort,
} from '../dispatch'
import type { RecordCallback, sendRecordCallback } from './record-callback'

/** Every collaborator the task reaches through, so the whole run is testable with no network, no
 *  model and no trigger.dev cloud — the same shape `ReviewCommandDeps` uses in the CLI. Each one is
 *  typed as `typeof <the real function>`, so a producer that changes its signature breaks this file
 *  at compile time instead of at three in the morning on a deployed worker. */
export type ReviewTaskDeps = {
  env: Record<string, string | undefined>
  /** Read per run rather than passed as a value, so a deployment missing its App identity fails in
   *  the same place as a missing model credential: at the top, before any GitHub call. */
  identity: () => AppIdentity
  now: () => Date
  deadlineMs: number
  deployment: () => DeploymentConfig
  installationToken: typeof installationToken
  makeOctokit: (token: string) => Octokit
  /** How the review session reads the pull request and the base branch's settings file
   *  (`prepareReview`), once each, before anything is opened or spent. */
  fetchPullRequest: typeof fetchPullRequest
  fetchRepoConfig: typeof fetchRepoConfig
  /** The bot's own summary comment on this pull request, and the marker it carries — read by the
   *  review session before the review, because the re-review pass (Criss, 2026-09-16) is asked about
   *  the findings in that marker, and handed to `publishReview` as it was read: one listing for the
   *  whole run, and the rows a judgement addresses are the rows it was computed about. */
  findSummaryComment: typeof findSummaryComment
  /** Whether `username` may push to the repository — the one question asked before a REQUESTED
   *  review spends anything (Criss, 2026-09-14, decision 3). Live: `pushAccessOf`, review-job.ts. */
  hasPushAccess: (a: { octokit: Octokit; owner: string; repo: string; username: string }) => Promise<boolean>
  runReview: typeof runReview
  /** Handed to `runReview` by the review session, which patches in the pull request and the repo
   *  config it already read and wraps every model pass so it knows whether money has been spent. On
   *  trigger.dev it carries `runFocuses`: the focuses of a multi-reviewer review run as child tasks
   *  (spec 0.2.0 §8.3 point 4). */
  runReviewDeps: RunReviewDeps
  publishReview: typeof publishReview
  /** The check run's two calls, for the review's own check run (the session's check-run reporter)
   *  and for the "Review refused" one this runner writes itself. */
  createCheckRun: typeof createCheckRun
  completeCheckRun: typeof completeCheckRun
  /** Closes the check run a killed attempt left `in_progress`, by id, only while it still is. */
  closeCheckRunIfInProgress: typeof closeCheckRunIfInProgress
  /** Where an attempt records the check run it opened, so a RETRY of the same trigger.dev run can
   *  close exactly that one (Criss, 2026-09-24: "Fix it inside #6 first"). Live in the deployed task:
   *  trigger.dev run metadata, flushed at once. `null` where there is no run to remember it on —
   *  `runReviewJob`, in process — and required, never defaulted, like `startAnotherRun`. */
  checkRunMemory: CheckRunMemory | null
  /** Starts a NEW run of this task for a failure that spent nothing (Criss, 2026-09-14, answer 13).
   *  Live in the deployed task: Task 11's `sdkTriggerPort`. `null` where there is no runner to start
   *  one on — `runReviewJob`, in process — so a failure there is reported and repeated by nobody. */
  startAnotherRun: TriggerPort | null
  /** Where the finished record goes, or `null` for nowhere (Task 13c; Criss, 2026-09-14, answer 16). */
  recordCallback: RecordCallback | null
  /** Live: `sendRecordCallback`, which never rejects. The call site catches anyway (sendRecordSafely). */
  sendRecord: typeof sendRecordCallback
  log: (message: string, fields: Record<string, unknown>) => void
  metric: (name: string, value: number, attributes: Record<string, string>) => void
  /** The login this App's own comments are posted under (`appBotLogin`), so the review session finds
   *  this App's summary comment before anyone else's and does not read this App's replies as a
   *  person's (spec 0.2.0 §3.3, decisions §14.6 and §14.7). Left out, or failing, the review runs
   *  without it — as every review did before 0.2.0's Stage 6. */
  appLogin?: (identity: AppIdentity) => Promise<string>
}

/** The one fact a retried attempt needs from the attempt before it. `recall` returns `undefined`
 *  when there is nothing to recall — a first attempt, or a value that never reached the store —
 *  and every caller treats that as "close nothing", which is the behaviour before this existed. */
export type CheckRunMemory = {
  remember: (checkRunId: number) => Promise<void>
  recall: () => number | undefined
}

/** The comment each posted finding became, the money rule, and the two sentences a pull request
 *  reads about a failure are `@review-agent/github`'s since 0.2.0 (spec 0.2.0 §3.1): the review
 *  session applies them for every way in, and this runner imports the same ones rather than keeping
 *  a copy that could drift. Re-exported under the names this module has always offered. */
export { mayRetry, postedCommentsOf, type PostedComment }

/** How this runner's reviews say they were run (spec 0.2.0 §5.6, decision §14.9): every summary and
 *  review the App posts opens with the automated-review line too. */
const VIA_APP: ReviewVia = { kind: 'app' }

/** What the run hands back — to trigger.dev as a JSON I/O packet, and to `runReviewJob`'s callers
 *  as the ids they need to read the result back off GitHub. `skipped` has no record because no
 *  review happened: design §5's release-only pull request is not paid for. */
export type ReviewTaskResult =
  | {
      kind: 'reviewed'
      /** The sha reviewed and posted on — `pr.headSha`, never the payload's. */
      headSha: string
      record: ReviewRecord
      reviewId: number | null
      summaryCommentId: number | null
      counts: PublishCounts
      /** Task 6's hidden JSON line (`verdictJson`), in every mode. Wherever a check run is posted it
       *  is also that check run's `output.text`; in `silent`, which posts none, this is the only place
       *  it exists (Criss, decision 7). The record carries `cutShort` beside it. */
      verdict: string
      checkRun: { id: number; conclusion: CheckConclusion | null } | null
      /** The inline comment each of THIS run's posted findings became — so a deployment can match a
       *  reply, which arrives carrying only `in_reply_to_id`, to the finding it answers, without a
       *  GitHub read of its own (Criss, 2026-09-24). Empty, never absent, when nothing was posted
       *  inline. `findingId` is `findingId(finding)` from @review-agent/github. */
      comments: PostedComment[]
    }
  | { kind: 'skipped'; reason: 'release-only'; headSha: string }
  | {
      kind: 'refused'; reason: 'no-push-access'; headSha: string; requestedBy: string | null
      checkRun: { id: number; conclusion: CheckConclusion | null }
    }

/** Raised on every path where running the review again would pay for the model again, or could not
 *  help: it starts no new run (Step 45e). `trigger-error.ts` turns it into trigger.dev's
 *  `AbortTaskRunError`, which "will fail the task attempt and disable retrying" — since 2026-09-18
 *  the only lock, the project allowing three attempts (Task 12, `MAX_ATTEMPTS`; Criss, reversing
 *  answer 13). It lives here, and not in the SDK's
 *  terms, so the whole money decision is testable without importing `@trigger.dev/sdk`.
 *  `spentUsd` is what is KNOWN to have been spent: the record's cost where there is a record, and
 *  what the engine wrappers saw where there is not — a lower bound when a check pass was cut off
 *  mid-run. */
export class DoNotRetry extends Error {
  readonly spentUsd: number
  constructor(message: string, spentUsd: number) {
    super(message)
    this.name = 'DoNotRetry'
    this.spentUsd = spentUsd
  }
}

/** The opposite claim: the review ran, produced nothing, and spent nothing, for a reason a second
 *  run can change — a crash or a CLI error at $0 (`mayRetry`, which the review session applies and
 *  reports as `retryable`). A TYPE rather than a plain Error so the claim is legible wherever it
 *  lands: on the run page, to a host calling `runReviewJob`, and to `asTriggerError`, which passes
 *  it through untouched. `reviewTaskRun` starts a NEW run of the same request for it (Step 45e).
 *  Since 2026-09-18 trigger.dev ALSO repeats the run itself, up to three attempts (Task 12,
 *  `MAX_ATTEMPTS`; Criss, reversing answer 13), and each attempt reaches `reviewTaskRun`'s catch and
 *  asks for another run again. That is safe, not a triple start: the new run's idempotency key
 *  carries the retry count (`startAnotherRunFor`, `:retry-${retry}`), so every attempt of one run
 *  asks for the same key and trigger.dev starts it once.
 *  No `spentUsd`: nothing was spent, which is the whole reason it exists. */
export class RetryThis extends Error {}

/** The two variables that are a model credential (Criss, 2026-09-14, decision 10). Core's since 0.2.0,
 *  where the rules that read them live; re-exported here for the record callback and the end-to-end
 *  gate, which import it from the runner. */
export { MODEL_CREDENTIAL_VARS } from '@review-agent/core'

/** Criss, 2026-09-14: exactly two credential kinds, and the deployment chooses — an Anthropic API key
 *  or a subscription token from `claude setup-token`. `CHILD_ENV_ALLOWLIST` passes exactly these two
 *  to the child, so this is validation, not an engine change. A run pointed at a gateway is refused
 *  outright rather than quietly not forwarded, because an operator who set a base URL believes the
 *  reviewed code is going there.
 *  Called before the first GitHub call so a misconfigured deployment fails at the top of every run
 *  instead of after a checkout has been paid for — and only there, never at module scope in
 *  review-task.ts, where a check would run wherever the file is imported (Step 58).
 *  Exactly one, not at-least-one: two credentials means nobody can say which one a review was
 *  billed to, and this repository does not leave money ambiguous.
 *  NEVER prints a value. The names are enough to fix the deployment.
 *
 *  The rules themselves are core's since 0.2.0 (`modelCredentialFromEnv`, spec 0.2.0 §3.1), because
 *  the CLI and the SDK apply the same ones; this is the runner asking them with no `claude login`
 *  allowed — a login on a server is somebody's personal account paying for everybody's reviews. */
export const assertModelCredential = (env: Record<string, string | undefined>): void => {
  modelCredentialFromEnv(env, { allowLogin: false })
}

const splitRepo = (full: string): { owner: string; repo: string } => {
  const [owner, repo] = full.split('/')
  if (owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new Error(`repo must be owner/name: ${full}`)
  }
  return { owner, repo }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Whether a failed review may start a NEW run of the whole review, model included (Step 45e), is
// `mayRetry` — `@review-agent/github`'s since 0.2.0 — and since Stage 6 it is the review session that
// applies it (`retryable` on what the session returns); this runner reads the answer. trigger.dev
// ALSO retries a crashed or evicted attempt itself, up to `MAX_ATTEMPTS` (3, Criss, 2026-09-18),
// which that rule cannot stop: it only classifies what the task throws. The gate's mapping
// (`gateOf`) and the scan every sentence goes through (`saidSafely`) are the github package's too,
// so the check run here and the report a session writes say the same sentences, scanned the same way
// (design §4.3).

/** 100 KB against trigger.dev's 128 KB (131,072-byte) I/O packet cap. A record is findings plus
 *  usage and carries no transcript, but `report.maxFindings` is 50 and nothing bounds an
 *  explanation's length, so a record CAN get there.
 *  Measured 2026-09-14, with the fixtures of review-run.test.ts: the review this product actually
 *  produced — one finding — is **1,588 bytes**, so the warning is nowhere near a real review. But
 *  `maxFindings` findings with 2,500-character explanations is **138,444 bytes**, which is already
 *  PAST the 128 KB cap, not merely past this threshold. So this is not a guard against a
 *  hypothetical: at the configured maximum the run page really would clip the record, and the
 *  warning is what explains a clipped page to whoever is reading it. Lowering `maxFindings`, or
 *  bounding an explanation's length, is the fix if that is ever seen in the wild. */
export const RECORD_WARN_BYTES = 100 * 1024

const emitMetrics = (
  deps: ReviewTaskDeps,
  m: { costUsd: number; findings: number; durationMs: number },
  attributes: Record<string, string>,
): void => {
  // Cost first: it is the number a deployment is asked about. It is the CLI's `total_cost_usd`,
  // computed at per-token API prices; when the credential is a subscription token the same figure
  // is drawn from the subscription allowance rather than billed per token.
  deps.metric('review.cost_usd', m.costUsd, attributes)
  deps.metric('review.findings', m.findings, attributes)
  // Wall clock — what a person waited for. `usage.durationMs` is the model's own time and is
  // already in the record.
  deps.metric('review.duration_ms', m.durationMs, attributes)
}

const logRun = (deps: ReviewTaskDeps, record: ReviewRecord, attempt: number): void => {
  const recordBytes = Buffer.byteLength(JSON.stringify(record))
  deps.log('review finished', {
    repo: record.request.repo, pr: record.request.pr, headSha: record.request.headSha.slice(0, 12),
    attempt, costUsd: record.costUsd, findings: record.output?.findings.length ?? 0,
    failure: record.failure?.kind ?? null, cutShort: record.cutShort,
    // Whether the re-review pass answered, and how many findings it called resolved. "No outcome
    // changed" and "the pass never ran" are the same silence from outside, and this feature's whole
    // history is outcomes that were wrong and looked fine — so the difference is said out loud on
    // every run. `not-asked` is a first review, which buys no pass at all.
    recheck: record.recheckJudgements === null ? 'not-asked' : record.recheckSkipped ?? 'ran',
    recheckResolved: (record.recheckJudgements ?? []).filter((j) => j.state === 'resolved').length,
    durationMs: record.timings.durationMs, recordBytes,
  })
  if (recordBytes > RECORD_WARN_BYTES) {
    deps.log('this review record is close to the 128 KB I/O packet limit and the run page may clip it', {
      recordBytes, findings: record.output?.findings.length ?? 0,
    })
  }
}

/** 30 minutes — the review session's own default, which this runner hands it (0.2.0 Stage 6), named
 *  here because three numbers are ordered around it. Six times the slowest review ever measured
 *  (4m40s, design §8). Not a performance target: it is the point past which something has gone wrong
 *  and a human should be told. It must stay below trigger.config.ts's `maxDuration` (2700 seconds) —
 *  the stop that completes the check run has to fire before the one that skips every lifecycle hook
 *  — and below the hour at which an installation token dies and STALE_AFTER_MS calls a check run
 *  abandoned. */
export const DEFAULT_DEADLINE_MS = DEFAULT_SESSION_DEADLINE_MS

/** Sends the finished record and never throws. It runs after the money is spent and the review is
 *  posted, where a throw would fail a run whose review is already on the pull request — and a failed
 *  run clears its idempotency key, so the next delivery for the same commit would pay again.
 *  `sendRecordCallback` never rejects; this catch is for whatever is injected in its place. The
 *  address is never logged: a query string can carry a token. */
const sendRecordSafely = async (
  deps: ReviewTaskDeps, result: Extract<ReviewTaskResult, { kind: 'reviewed' }>,
): Promise<void> => {
  try {
    const outcome = await deps.sendRecord({ callback: deps.recordCallback, env: deps.env, body: { version: 1, result } })
    deps.log('record callback', { ...outcome })
  } catch (e) {
    try {
      deps.log('record callback', { sent: false, why: 'threw', error: saidSafely(messageOf(e)) })
    } catch {
      // A logger that throws must not undo a finished review either.
    }
  }
}

/** The error a failed session ends this run with, by the session's own verdict on the money
 *  (`retryable`): nothing spent and nothing stopped on purpose is the error itself, as it was thrown,
 *  so the run page says what failed and `reviewTaskRun` may start another run for it (Step 45e);
 *  anything else is a `DoNotRetry`, which trigger.dev does not repeat either. Every sentence in it
 *  is the session's, already scanned (`reason`). */
const errorFor = (f: SessionFailed): Error => {
  if (f.retryable) return f.cause instanceof Error ? f.cause : new Error(f.reason)
  if (f.stage === 'publish') {
    // Another run repeats the whole review, not the line: one here would re-run the model and pay for
    // it a second time because GitHub had a bad minute. The durable fix is a post-only second task,
    // and it needs the record to survive between runs — which this product has nowhere to put, by
    // design: re-review state lives in the bot's own comment and there is no database (design §5).
    return new DoNotRetry(`${f.reason} ($${f.spentUsd.toFixed(2)} spent, and not spent again)`, f.spentUsd)
  }
  // The engine has run, or the review was stopped on purpose, or what it said was withheld: a retry
  // asks the same model the same question about the same commit and pays again.
  return new DoNotRetry(
    `${f.reason} — $${f.spentUsd.toFixed(2)} is known to have been spent, so this run is not retried`,
    f.spentUsd,
  )
}

/** One attempt at one review: the App's own steps — the credential and the App identity, a token for
 *  the one repository, the release-only skip, the push-access gate, closing the check run a killed
 *  attempt left open — and then the review session every way in shares (`prepareReview`,
 *  `runReviewSession`; spec 0.2.0 §3.1, §6), whose outcome this maps to what trigger.dev and the
 *  record callback have always been given. The deadline, the stop, the spend watched from outside,
 *  the report, publishing and the checkout are the session's, written once there. */
const reviewOnce = async (
  payload: ReviewTaskPayload,
  options: { signal?: AbortSignal; attempt?: number },
  deps: ReviewTaskDeps,
): Promise<ReviewTaskResult> => {
  const attempt = options.attempt ?? 1
  const startedAt = deps.now()

  // trigger.dev can cancel a run while it waits in the queue, and this function is entered anyway.
  // `addEventListener('abort', …)` on a signal that has ALREADY aborted never fires — so without this
  // line a cancelled run mints a token, reads the pull request and opens a check run for an answer
  // nobody is waiting for.
  if (options.signal?.aborted === true) {
    throw new DoNotRetry('the review run was cancelled before it started', 0)
  }

  // Before the first GitHub call, so a misconfigured deployment fails at the top of every run instead
  // of after a checkout has been paid for. The credential is core's rule with no `claude login`
  // allowed (a login on a server is somebody's personal account paying for everybody's reviews), and
  // it travels with this review to every model pass (spec 0.2.0 §3.2) — the one the environment
  // holds, as before, now named rather than inherited.
  let identity: AppIdentity
  let credential: ModelCredential
  try {
    credential = modelCredentialFromEnv(deps.env, { allowLogin: false })
    identity = deps.identity()
  } catch (e) {
    throw new DoNotRetry(messageOf(e), 0)
  }

  const { owner, repo } = splitRepo(payload.request.repo)
  const number = payload.request.pr
  const deployment = deps.deployment()
  // Criss, 2026-09-14 (decision 4), and spec 0.2.0 §14.19: `multi` runs several reviewers, so it is
  // honoured only when somebody asked — a comment or the Re-run button, whose requester must still
  // pass the push-access check below before anything is spent. An AUTOMATIC review never runs it, by
  // whatever road it arrived: no doorway puts it on one, and a payload triggered by hand reaches here
  // past every doorway. This rule is the App's alone — the session cannot know who asked — and it is
  // applied before anything is resolved, so the settings, the check run's external_id and the review
  // all see the request without it, and the summary names it. The deployment's own switch
  // (`allowMulti`) is `prepareReview`'s, for every way in.
  const automatic = refuseUnbuilt(payload.request, { automatic: isAutomatic(payload.request) })
  const { repo: _repo, pr: _pr, headSha: _headSha, ...ask } = automatic.request

  // Scoped to the one repository under review, by NAME, never to the installation.
  const minted = await deps.installationToken({
    identity, installationId: payload.installationId, repositories: [repo],
  })
  const octokit = deps.makeOctokit(minted.token)

  // The pull request, and the reviewed repository's own file from the BASE commit, read once: the
  // report mode decides whether a check run exists at all, and a repository may lower it.
  const prepared = await prepareReview({
    octokit, owner, repo, number, deployment, ask,
    deps: { fetchPullRequest: deps.fetchPullRequest, fetchRepoConfig: deps.fetchRepoConfig },
  })
  // GitHub would not answer, and nothing was opened or spent: the error itself, as it always was.
  if (prepared.kind === 'failed') throw errorFor(prepared)
  const { pr, settings } = prepared

  const attributesFor = (outcome: string): Record<string, string> => ({
    repo: payload.request.repo, pr: String(number),
    tier: settings.tier, model: settings.model, outcome, attempt: String(attempt),
  })

  // Design §5: an AUTOMATIC review of a pull request that changes only release files is not paid
  // for; `skipAsReleaseOnly` checks `isAutomatic` itself, so a `/review` on the same commit still
  // reviews. A basic review is $0.88–1.06 at per-token API prices (design §8), and this is the one
  // place that price is avoided rather than spent. No check run either: nothing is in progress, and
  // a check that says "skipped" on every version bump is noise on every release.
  if (skipAsReleaseOnly({
    request: payload.request, changedPaths: pr.changedFiles.map((f) => f.path),
  })) {
    deps.log('review skipped: every changed file is a release file', {
      repo: payload.request.repo, pr: number, headSha: pr.headSha.slice(0, 12),
      files: pr.changedFiles.length,
    })
    emitMetrics(
      deps,
      { costUsd: 0, findings: 0, durationMs: deps.now().getTime() - startedAt.getTime() },
      attributesFor('skipped'),
    )
    return { kind: 'skipped', reason: 'release-only', headSha: pr.headSha }
  }

  // Criss, 2026-09-14 (decision 3): a REQUESTED review is paid for on somebody's say-so, so that
  // somebody must be able to push here. Asked after the token exists and before the archive, the
  // engine or the check pass, so a refusal costs one GET and $0 of model spend. The automatic path
  // is not asked about: any pull request that opens is reviewed.
  // The refusal is visible, not silent: a check run on the head, concluded neutral (Task 6), naming
  // who asked. It is written even in `silent` mode, because `silent` governs what a REVIEW says, and
  // a person who asked and heard nothing cannot tell a refusal from an outage.
  if (!isAutomatic(payload.request)) {
    const who = payload.request.requestedBy
    const named = who !== undefined && who !== ''
    const allowed = named && await deps.hasPushAccess({ octokit, owner, repo, username: who })
    if (!allowed) {
      const reason = named
        ? `@${who} asked for a review and does not have push access to ${payload.request.repo}`
        : 'a review was requested by nobody GitHub named, so push access could not be checked'
      const refusal = await deps.createCheckRun({
        octokit, owner, repo, headSha: pr.headSha, name: settings.report.checkRunName,
      })
      const conclusion = await deps.completeCheckRun({
        octokit, owner, repo, checkRunId: refusal.id,
        outcome: { kind: 'refused', headSha: pr.headSha, reason },
        gate: gateOf(settings.report),
        mode: settings.report.mode, maxInline: settings.report.maxInline, bands: settings.severity.bands,
      })
      deps.log('review refused: the requester cannot push to this repository', {
        repo: payload.request.repo, pr: number, headSha: pr.headSha.slice(0, 12), requestedBy: named ? who : null,
      })
      return {
        kind: 'refused', reason: 'no-push-access', headSha: pr.headSha,
        requestedBy: named ? who : null, checkRun: { id: refusal.id, conclusion },
      }
    }
  }

  // Task 6: every mode gets a check run except `silent`.
  const wantsCheck = checkRunWanted(settings.report.mode)

  // A RETRY closes the check run of the attempt it replaces, before it opens its own (Criss,
  // 2026-09-24). createCheckRun's sweep cannot: that run is seconds old, not an hour. By id, so a
  // concurrent sibling review's check on the same commit is never touched. Housekeeping only —
  // a failure here is logged and the review goes on, exactly as createCheckRun treats its sweep.
  if (wantsCheck && attempt > 1 && deps.checkRunMemory !== null) {
    const previous = deps.checkRunMemory.recall()
    if (previous !== undefined) {
      try {
        await deps.closeCheckRunIfInProgress({
          octokit, owner, repo, checkRunId: previous, name: settings.report.checkRunName, headSha: pr.headSha,
        })
      } catch (e) {
        deps.log('could not close the check run the previous attempt left open', {
          checkRunId: previous, attempt, error: messageOf(e),
        })
      }
    }
  }

  // This App's own login, when GitHub says what it is: the session then edits this App's summary
  // comment rather than one a person posted on the same pull request, and skips this App's replies.
  // Asked only now, so a skipped or refused review does not pay the round trip. Never a reason to
  // stop: without it, the review runs as every review did before Stage 6.
  let botLogin: string | undefined
  if (deps.appLogin !== undefined) {
    try {
      botLogin = await deps.appLogin(identity)
    } catch (e) {
      deps.log('the App’s own login could not be read; its summary comment is found by its marker alone', {
        error: saidSafely(messageOf(e)),
      })
    }
  }

  // trigger.dev's signal, relayed. The session, handed a signal that has already aborted, opens
  // nothing and returns. This runner has always opened its check run first and closed it as
  // cancelled when the cancellation landed in its first round trips — the token, the pull request,
  // the config — so the person who asked sees the run end rather than nothing. An abort that lands
  // before the check run exists is held back until it does; one with no check run to wait for, and
  // every abort after it, goes straight through.
  const relay = new AbortController()
  let reported = !wantsCheck
  const forward = (): void => { if (reported) relay.abort(options.signal?.reason) }
  options.signal?.addEventListener('abort', forward, { once: true })
  if (options.signal?.aborted ?? false) forward()

  // Whether `runReview` was reached, and came back: the money a failure spent is metered here when
  // the review itself threw, and by `onReviewed` when it returned.
  const ran = { started: false, returned: false }
  let session: SessionResult
  try {
    session = await runReviewSession({
      prepared,
      post: true,
      reporter: checkRunReporter({
        // Recorded at once, before any model money is spent, so an attempt killed from here on has
        // left its id where the next attempt will look for it. The relay first: the session asks
        // whether the run was cancelled the moment this returns.
        onStarted: async (checkRunId) => {
          reported = true
          if (options.signal?.aborted === true) relay.abort(options.signal.reason)
          if (deps.checkRunMemory === null) return
          try {
            await deps.checkRunMemory.remember(checkRunId)
          } catch (e) {
            deps.log('could not remember the check run for a retry to close', { checkRunId, error: messageOf(e) })
          }
        },
        calls: { createCheckRun: deps.createCheckRun, completeCheckRun: deps.completeCheckRun },
      }),
      via: VIA_APP,
      ...(botLogin !== undefined && { selfLogin: botLogin, ignoreRepliesFrom: botLogin }),
      // Task 10's refusals, carried to the summary (Criss, decision 4): the comment doorway's, and the
      // one refuseUnbuilt made above for an automatic review's `multi`. The session adds the
      // deployment's own, and says each once.
      refused: [...(payload.refused ?? []), ...automatic.refused],
      // The Re-run button repeats these settings (design §5): what was asked, less what was refused.
      externalId: encodeRequestRefinement({
        ...prepared.ask, repo: payload.request.repo, pr: number, headSha: pr.headSha,
      }),
      runtime: { credential },
      signal: relay.signal,
      deadlineMs: deps.deadlineMs,
      // The money is spent by the time this runs, so it is recorded before anything is published —
      // and a throw from this bookkeeping (in the deployed runner, `logger.info`) is a failure that
      // spent, which no new run follows.
      onReviewed: (review) => {
        emitMetrics(deps, {
          costUsd: review.record.costUsd,
          findings: review.record.output?.findings.length ?? 0,
          durationMs: review.record.timings.durationMs,
        }, attributesFor(review.record.failure?.kind ?? 'reviewed'))
        logRun(deps, review.record, attempt)
      },
      deps: {
        runReviewDeps: deps.runReviewDeps,
        runReview: async (x) => {
          ran.started = true
          const review = await deps.runReview(x)
          ran.returned = true
          return review
        },
        publishReview: deps.publishReview,
        findSummaryComment: deps.findSummaryComment,
        log: deps.log,
      },
    })
  } finally {
    options.signal?.removeEventListener('abort', forward)
  }

  if (session.kind === 'failed') {
    // A review that threw, or was stopped before it could run, still has its money recorded: a
    // withheld review is the one failure that has no record at all, and the spend watched going out
    // is the only account of it.
    if (!ran.returned && (ran.started || session.stopped !== null)) {
      try {
        emitMetrics(
          deps,
          { costUsd: session.spentUsd, findings: 0, durationMs: deps.now().getTime() - startedAt.getTime() },
          attributesFor(session.stopped ?? (session.stage === 'withheld' ? 'withheld' : 'error')),
        )
      } catch {
        // The failure below is what this run is about; a metric that would not go must not replace it.
      }
    }
    throw errorFor(session)
  }

  if (session.kind === 'unfinished') {
    // Stopped — the deadline, or trigger.dev cancelling the run — with nothing usable: not retried,
    // whatever the engine says it cost. A deadline means the model ran for the whole deadline.
    if (session.stopped !== null) throw new DoNotRetry(session.reason, session.spentUsd)
    // Nothing to place on a line, but the pull request has been told: the session wrote the summary
    // that says "This review did not complete". `RetryThis`, not a plain Error, so the one failure a
    // second run can fix — a crash or a CLI error at $0 — reaches `reviewTaskRun` as retryable.
    if (session.retryable) {
      throw new RetryThis(`${session.reason} — nothing was spent, so this attempt may be retried`)
    }
    throw new DoNotRetry(
      `${session.reason} — $${session.spentUsd.toFixed(2)} is already spent, so this run is not retried`,
      session.spentUsd,
    )
  }

  // A budget stop keeps the partial findings the model had already written, and is posted: so is a
  // review the stop caught while it was finishing (Criss, 2026-09-16). Neither is thrown afterwards —
  // a run that fails clears its idempotency key, which would let the next delivery for this same
  // commit pay for the same review all over again. `record.failure` and `record.cutShort` carry it.
  const { published, record, report } = session
  if (published === null || session.verdict === null) {
    // Cannot happen — this runner always posts — and said rather than assumed: the money is spent.
    throw new DoNotRetry('the review ran and the session posted nothing', record.costUsd)
  }
  const reviewed: Extract<ReviewTaskResult, { kind: 'reviewed' }> = {
    kind: 'reviewed', headSha: published.headSha, record,
    reviewId: published.reviewId, summaryCommentId: published.summaryCommentId,
    counts: published.counts,
    verdict: session.verdict,
    checkRun: report === null || report.id === null ? null : { id: report.id, conclusion: report.conclusion },
    comments: session.comments,
  }
  // Criss, 2026-09-14 (answer 16): the finished record goes to the deployment's callback AFTER the
  // review is published and its check run completed, and only here — a review that did not finish
  // sends nothing. It passed runReview's secret scan (Task 1, Step 16) to get this far, and the
  // sender scans the exact bytes again. Whatever the send does, the same result is returned: a
  // failed callback never fails, retries or re-runs a review that has been paid for.
  await sendRecordSafely(deps, reviewed)
  return reviewed
}

/** How many NEW runs a failure that spent nothing may start, one after another. Two, so a request
 *  keeps the three tries it had under trigger.dev's default of three attempts (verified facts,
 *  "Money") — now three runs this file chose to start, not attempts the platform started whatever
 *  had been spent. */
export const MAX_DELIBERATE_RETRIES = 2

/** Criss, 2026-09-18 (reversing answer 13): Task 12's trigger.config.ts allows THREE attempts, so a
 *  crash, a SIGTERM, an eviction or a stall after the model has spent IS repeated by trigger.dev —
 *  nothing is thrown for those, so `DoNotRetry` never sees them. Only a failure that reaches
 *  `trigger-error.ts` as `DoNotRetry` is still never repeated. The failures worth repeating
 *  deliberately are the ones that spent nothing: a GitHub error
 *  before the engine starts, and a crash or CLI error with no output at $0 (`RetryThis`). For those
 *  this run starts ANOTHER run of the same request, deliberately, and then fails with the error
 *  that explains it. Everything after the engine has spent arrives here as `DoNotRetry` (Steps 35
 *  and 40), and so does a misconfigured deployment and a cancelled or stopped run: none of those
 *  starts anything. */
export const reviewTaskRun = async (
  payload: ReviewTaskPayload,
  options: { signal?: AbortSignal; attempt?: number },
  deps: ReviewTaskDeps,
): Promise<ReviewTaskResult> => {
  try {
    return await reviewOnce(payload, options, deps)
  } catch (e) {
    if (!(e instanceof DoNotRetry)) await startAnotherRunFor(payload, e, deps)
    // The original error, unchanged: the run page says what failed. Since 2026-09-18 trigger.dev
    // repeats it up to three times unless it arrives as `DoNotRetry` (MAX_ATTEMPTS).
    throw e
  }
}

const startAnotherRunFor = async (
  payload: ReviewTaskPayload, e: unknown, deps: ReviewTaskDeps,
): Promise<void> => {
  const where = { repo: payload.request.repo, pr: payload.request.pr }
  const error = saidSafely(messageOf(e))
  const before = payload.retry ?? 0
  // Fail closed. A count that is not a whole number from 0 up was not written by this function, and
  // guessing how many runs came before it is how a loop starts. A payload triggered by hand may set
  // it to MAX_DELIBERATE_RETRIES to start none at all, and Task 15's one hosted run does.
  if (!Number.isInteger(before) || before < 0 || before >= MAX_DELIBERATE_RETRIES) {
    deps.log('not started again: this request has used the runs it may start', {
      ...where, retry: payload.retry ?? null, max: MAX_DELIBERATE_RETRIES, error,
    })
    return
  }
  if (deps.startAnotherRun === null) {
    deps.log('not started again: there is no runner here to start one on', { ...where, error })
    return
  }
  const retry = before + 1
  try {
    const started = await deps.startAnotherRun({
      taskId: REVIEW_TASK_ID,
      payload: { ...payload, retry },
      // A key of its own. This run still holds the original key until it has failed, and a second
      // request with a held key returns the original run instead of creating one (verified facts,
      // "Idempotency"). Triggered from inside a run, a raw string key is run-scoped — combined with
      // this run's id (same section) — so it stops a double start from this run and nothing wider.
      idempotencyKey: `${idempotencyKeyFor(payload.request)}:retry-${retry}`,
      tags: tagsFor(payload.request),
    })
    deps.log('started another run: the failure spent nothing', { ...where, retry, runId: started.id, error })
  } catch (again) {
    // Never thrown: this run is failing already, and the error that explains it is the one to keep.
    // An idempotencyKeyFor that refuses the request lands here too, and starts nothing.
    deps.log('another run could not be started', { ...where, retry, error, why: saidSafely(messageOf(again)) })
  }
}

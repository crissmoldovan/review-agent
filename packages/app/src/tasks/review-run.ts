import type { Octokit } from '@octokit/core'
import {
  modelCredentialFromEnv, resolveSettings, SecretLeak,
  type DeploymentConfig, type ReviewRecord, type ReviewRequest,
} from '@review-agent/core'
import {
  checkRunWanted, failureSentence, mayRetry, postedCommentsOf, recheckQuestions, refuseUnbuilt,
  removeCheckout, saidSafely, verdictJson,
  type CheckConclusion, type CheckGate, type CheckOutcome, type closeCheckRunIfInProgress,
  type completeCheckRun, type createCheckRun,
  type fetchPullRequest, type fetchRepoConfig, type findSummaryComment, type FoundSummary,
  type PostedComment, type PublishCounts, type PublishedReview, type publishReview, type runReview,
  type ReviewVia, type RunReviewDeps, type RunReviewResult,
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
  fetchPullRequest: typeof fetchPullRequest
  fetchRepoConfig: typeof fetchRepoConfig
  /** The bot's own summary comment on this pull request, and the marker it carries.
   *
   *  Read HERE, before the review, rather than inside `publishReview` where it used to be read for
   *  the first time — because the re-review pass (Criss, 2026-09-16) is asked about the findings in
   *  that marker, and it runs inside `runReview` so that its cost is recorded with the other two
   *  passes. The same result is then handed to `publishReview`, which reads no marker of its own:
   *  one listing for the whole run, and the rows a judgement addresses are the rows it was computed
   *  about. */
  findSummaryComment: typeof findSummaryComment
  /** Whether `username` may push to the repository — the one question asked before a REQUESTED
   *  review spends anything (Criss, 2026-09-14, decision 3). Live: `pushAccessOf`, review-job.ts. */
  hasPushAccess: (a: { octokit: Octokit; owner: string; repo: string; username: string }) => Promise<boolean>
  runReview: typeof runReview
  /** Handed to `runReview`, with the pull request and the repo config this task already fetched
   *  patched in and the engine wrapped so the task knows whether money has been spent. */
  runReviewDeps: RunReviewDeps
  publishReview: typeof publishReview
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

/** The opposite claim, and it has to be a TYPE rather than a plain Error, because a plain Error is
 *  indistinguishable from the ones Step 40's catch is there to convert. That catch turns anything
 *  thrown after the engine started into a `DoNotRetry`, and the engine HAS started on the one path
 *  that wants a retry — a crash or a CLI error that produced no output and cost $0 (`mayRetry`).
 *  Thrown, it passes Step 40's catch unchanged and `reviewTaskRun` starts a NEW run of the same
 *  request for it (Step 45e). Since 2026-09-18 trigger.dev ALSO repeats the run itself, up to three
 *  attempts (Task 12, `MAX_ATTEMPTS`; Criss, reversing answer 13), and each attempt reaches
 *  `reviewTaskRun`'s catch and asks for another run again. That is safe, not a triple start: the new
 *  run's idempotency key carries the retry count (`startAnotherRunFor`, `:retry-${retry}`), so every
 *  attempt of one run asks for the same key and trigger.dev starts it once.
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

/** The one mapping from the two gate settings to Task 6's `CheckGate`. The setting is
 *  `gateRequiresConfirmed` and the gate's field is `requiresConfirmed`; every `completeCheckRun`
 *  call in this file passes `gateOf(settings.report)`, so the renaming is written once and the
 *  review path and the refusal path cannot drift apart. Both halves together (Criss, decisions 5
 *  and 6). */
const gateOf = (report: DeploymentConfig['report']): CheckGate => ({
  failAtOrAbove: report.failAtOrAbove,
  requiresConfirmed: report.gateRequiresConfirmed,
})

// Whether a failed review may start a NEW run of the whole review, model included (Step 45e), is
// `mayRetry` — `@review-agent/github`'s since 0.2.0, imported above. trigger.dev ALSO retries a
// crashed or evicted attempt itself, up to `MAX_ATTEMPTS` (3, Criss, 2026-09-18), which that rule
// cannot stop: it only classifies what the task throws. `saidSafely` and `failureSentence` came with
// it, for the same reason: the check run here and the report a session writes say the same
// sentences, scanned the same way (design §4.3).

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

/** 30 minutes. Six times the slowest review ever measured (4m40s, design §8). Not a performance
 *  target: it is the point past which something has gone wrong and a human should be told. It must
 *  stay below trigger.config.ts's `maxDuration` (2700 seconds) — the stop that completes the check
 *  run has to fire before the one that skips every lifecycle hook — and below the hour at which an
 *  installation token dies and STALE_AFTER_MS calls a check run abandoned. */
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000

/** Sends the finished record and never throws. It runs after the money is spent, inside Step 40's
 *  catch-all, where a throw would become a DoNotRetry and take a posted review off the run's result.
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

const reviewOnce = async (
  payload: ReviewTaskPayload,
  options: { signal?: AbortSignal; attempt?: number },
  deps: ReviewTaskDeps,
): Promise<ReviewTaskResult> => {
  const attempt = options.attempt ?? 1
  const startedAt = deps.now()

  // trigger.dev can cancel a run while it waits in the queue, and this function is entered anyway.
  // `addEventListener('abort', …)` on a signal that has ALREADY aborted never fires, and the
  // listener below is attached four round trips in — so without this line a cancelled run mints a
  // token, opens a check run and pays the model in full for an answer nobody is waiting for.
  if (options.signal?.aborted === true) {
    throw new DoNotRetry('the review run was cancelled before it started', 0)
  }

  let identity: AppIdentity
  try {
    assertModelCredential(deps.env)
    identity = deps.identity()
  } catch (e) {
    throw new DoNotRetry(messageOf(e), 0)
  }

  const { owner, repo } = splitRepo(payload.request.repo)
  const number = payload.request.pr
  const deployment = deps.deployment()
  // Criss, 2026-09-14 (decision 4), and spec 0.2.0 §14.19: `multi` runs several reviewers, so it is
  // honoured only when somebody asked — a comment or the Re-run button, whose requester must still
  // pass the push-access check below before anything is spent — and only when this deployment allows
  // it. An AUTOMATIC review never runs it, by whatever road it arrived: no doorway puts it on one, and
  // a payload triggered by hand reaches here past every doorway. Stripped before anything is
  // resolved, so the settings, the check run's external_id and runReview all see the request
  // without it — and named in the summary through `refusedByDoorway` below. `thorough` used to be
  // stripped with it; since 0.2.0 it is one reviewer at `high` effort and is honoured (§14.1).
  const unbuilt = refuseUnbuilt(payload.request, {
    allowMulti: deployment.allowMulti, automatic: isAutomatic(payload.request),
  })
  const request: ReviewRequest = {
    ...unbuilt.request,
    repo: payload.request.repo, pr: payload.request.pr, headSha: payload.request.headSha,
  }
  const { repo: _repo, pr: _pr, headSha: _headSha, ...ask } = request

  const minted = await deps.installationToken({
    identity, installationId: payload.installationId, repositories: [repo],
  })
  const octokit = deps.makeOctokit(minted.token)

  const pr = await deps.fetchPullRequest({ octokit, owner, repo, number })
  // The reviewed repository's own file, from the BASE commit, read here for the same reason the
  // pull request is: the report mode decides whether a check run exists at all, and a repository
  // may lower it (config.ts, LOUDNESS). resolveSettings is pure and runReview is handed this same
  // config below, so the settings it resolves are these.
  const repoConfig = await deps.fetchRepoConfig({ octokit, owner, repo, baseRef: pr.baseSha })
  const settings = resolveSettings({
    deployment, repo: repoConfig,
    request: { ...ask, repo: payload.request.repo, pr: number, headSha: pr.headSha },
  })

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

  // Task 10's refusals, carried to the summary (Criss, decision 4): the comment doorway's, and the
  // one refuseUnbuilt made at the top of this function for a `multi` it would not run.
  // A flag the comment doorway dropped never reached resolveSettings, so this is the only road by
  // which it is ever named. De-duplicated, because a hand-built payload can carry a refusal sentence
  // and the flag it refuses.
  const refusals = [...new Set([...(payload.refused ?? []), ...unbuilt.refused])]
  const refusedByDoorway = refusals.length === 0 ? {} : { refused: refusals }

  // Task 6: every mode gets a check run except `silent`. createCheckRun closes a stale run of the
  // same name and sha itself, and completeCheckRun attaches the Re-run button itself, so neither
  // is repeated here.
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

  const check = wantsCheck
    ? await deps.createCheckRun({
        octokit, owner, repo, headSha: pr.headSha, name: settings.report.checkRunName,
        externalId: encodeRequestRefinement(request),
      })
    : null

  // Recorded at once, before any model money is spent, so an attempt killed from here on has left
  // its id where the next attempt will look for it.
  if (check !== null && deps.checkRunMemory !== null) {
    try {
      await deps.checkRunMemory.remember(check.id)
    } catch (e) {
      deps.log('could not remember the check run for a retry to close', { checkRunId: check.id, error: messageOf(e) })
    }
  }

  let completed = false
  const complete = async (outcome: CheckOutcome): Promise<CheckConclusion | null> => {
    // At most once, and it never throws: a GitHub failure while closing the check run must not
    // turn a finished review into a retried one — that pays for the model again.
    if (check === null || completed) return null
    completed = true
    try {
      return await deps.completeCheckRun({
        octokit, owner, repo, checkRunId: check.id, outcome,
        // Both halves of the gate, together, through the one mapping (gateOf; Criss, decisions 5 and 6).
        gate: gateOf(settings.report),
        // What checkRunOutput reads: annotations only in check-only, capped at maxInline, and the
        // bands the hidden verdict counts with (decision 7).
        mode: settings.report.mode,
        maxInline: settings.report.maxInline,
        bands: settings.severity.bands,
      })
    } catch (e) {
      deps.log('the check run could not be completed', { checkRunId: check.id, error: messageOf(e) })
      return null
    }
  }

  /** Wall clock, and the stop that is meant to fire. trigger.dev's `maxDuration` is set — the CLI
   *  refuses a config without it — but at 2700 compute-time seconds in trigger.config.ts it is a
   *  backstop sitting well above this deadline, not the timeout that catches a slow review. It has
   *  to be that way round: `maxDuration` is compute time per attempt, and when it fires `cleanup`,
   *  `onSuccess` and `onFailure` are NOT called, so the check run opened above would sit
   *  `in_progress` for ever — worse for a human than a check that says the review failed. A signal
   *  we hold is one we can catch, complete the check run from, and kill the model's child process
   *  with (EngineInput.signal → spawnClaude → the child). On the one-vCPU machine this task runs on
   *  (`small-2x`), compute time cannot accrue faster than wall-clock time, so 1800s of wall clock
   *  always arrives before 2700 compute-seconds and this deadline always wins — except when the
   *  event loop is wedged and this timer cannot fire at all, which is precisely the case the
   *  backstop exists for. Measured reviews take 55s to 4m40s (design §8), so 30 minutes is about
   *  six times the slowest thing ever observed. */
  const stop = new AbortController()
  // The downloaded code, once `runReview` has returned it: removed in the `finally` below, after
  // publishing has read it, whatever happened in between.
  let checkoutToRemove: string | null = null
  const stopped: { by: 'cancelled' | 'deadline' | null } = { by: null }
  const cancel = (): void => {
    stopped.by ??= 'cancelled'
    stop.abort(new Error('the review run was cancelled'))
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  // Again, immediately: an abort that landed between the check at the top of this function and the
  // line above fired no listener and would otherwise be lost, and everything after this point is
  // the part that spends. That window is four awaited round trips wide — the token, the pull
  // request, the repo config and the check run — so it is not a theoretical one.
  // Truthiness rather than `=== true`: `aborted` is a live getter, but TypeScript narrows it to
  // `false` from the guard at the top of this function and calls the comparison unintentional
  // (TS2367). The narrowing is wrong about the runtime and the check is load-bearing, so the
  // comparison goes rather than the check.
  if (options.signal?.aborted ?? false) cancel()
  const timer = setTimeout(() => {
    stopped.by ??= 'deadline'
    stop.abort(new Error(
      `the review passed its ${Math.round(deps.deadlineMs / 1000)}s deadline and was stopped`,
    ))
  }, deps.deadlineMs)
  // Nothing should be kept alive by a review that already finished.
  timer.unref()

  const failed = (reason: string): CheckOutcome => ({ kind: 'failed', headSha: pr.headSha, reason })

  // What the engine has already been paid, watched from the outside. `runReview` throws SecretLeak
  // and can throw from `runCheckPass` AFTER `runEngine` has spent, and neither error carries a
  // usage or a record — so the only way to know the money is gone is to have seen it go.
  const spend = { engineStarted: false, usd: 0 }
  try {
    const runDeps: RunReviewDeps = {
      ...deps.runReviewDeps,
      fetchPullRequest: async () => pr,
      fetchRepoConfig: async () => repoConfig,
      runEngine: async (input) => {
        spend.engineStarted = true
        const result = await deps.runReviewDeps.runEngine(input)
        spend.usd += result.usage.costUsd
        return result
      },
      runCheckPass: async (a) => {
        const checked = await deps.runReviewDeps.runCheckPass(a)
        spend.usd += checked.usage.costUsd
        return checked
      },
      // Said plainly: NO failure path reaches this increment today. `runReview` catches everything
      // the re-review pass can do and nothing after it throws, so a run that gets this far always
      // reaches `record.costUsd`, which carries the same figure and is what the metric and the
      // public summary print. It is here so the three passes are accounted identically from outside
      // — the moment anything throws after the third pass, its money is already being watched.
      runRecheckPass: async (a) => {
        const judged = await deps.runReviewDeps.runRecheckPass(a)
        spend.usd += judged.usage.costUsd
        return judged
      },
    }

    // The marker, before the review, because the re-review pass's question comes out of it. A
    // refusal here is not a failed review: a listing GitHub would not answer costs the refinement
    // and nothing else — the pass is not bought, and `publishReview` does its own read as it always
    // did. `undefined` is "nobody looked"; `null` is "looked, and there is none".
    let existing: FoundSummary | null | undefined
    try {
      existing = await deps.findSummaryComment({ octokit, owner, repo, number })
    } catch (e) {
      deps.log('the previous review’s marker could not be read; no re-review pass will run', {
        repo: payload.request.repo, pr: number, error: saidSafely(messageOf(e)),
      })
    }
    const publishExisting = existing === undefined ? {} : { existing }
    const previousFindings = existing === undefined
      ? []
      : recheckQuestions(existing?.marker ?? null).questions

    let review: RunReviewResult
    try {
      review = await deps.runReview({
        octokit, owner, repo, number, deployment, ask, deps: runDeps, signal: stop.signal,
        previousFindings,
      })
      checkoutToRemove = review.checkoutDir
    } catch (e) {
      // SecretLeak's own message is names and locations only, never the matched text
      // (packages/core/src/secrets.ts), so it is safe to render as it is. Anything else is an error
      // somebody else threw, and goes through the scanner before it can reach the check run.
      // `stop.signal.reason` is a sentence this file wrote, so it needs no scan; the scanner stays
      // on the branch that renders somebody else's error (Step 35).
      const reason = stop.signal.aborted
        ? messageOf(stop.signal.reason)
        : e instanceof SecretLeak
          ? `the review was withheld: ${e.message}`
          : `the review did not complete: ${saidSafely(messageOf(e))}`
      emitMetrics(
        deps,
        { costUsd: spend.usd, findings: 0, durationMs: deps.now().getTime() - startedAt.getTime() },
        attributesFor(stopped.by ?? (e instanceof SecretLeak ? 'withheld' : 'error')),
      )
      await complete(failed(reason))
      if (spend.engineStarted || stop.signal.aborted || e instanceof SecretLeak) {
        // The engine has run. A retry asks the same model the same question about the same commit
        // and pays again: a withheld review is withheld again, a crashed check pass crashes again.
        throw new DoNotRetry(
          `${reason} — $${spend.usd.toFixed(2)} is known to have been spent, so this run is not retried`,
          spend.usd,
        )
      }
      // Before the engine: a tarball 502, a skill that would not download. Nothing was spent, so let
      // it out unchanged: it is what the new run Step 45e starts is for.
      throw e
    }

    const { record } = review

    // The money is spent by the time this line runs, so it is recorded before anything else can
    // throw — the failure branches below included.
    emitMetrics(deps, {
      costUsd: record.costUsd,
      findings: record.output?.findings.length ?? 0,
      durationMs: record.timings.durationMs,
    }, attributesFor(record.failure?.kind ?? 'reviewed'))
    logRun(deps, record, attempt)

    // A review that is FINISHED is published, even if the stop landed while it was finishing
    // (Criss, 2026-09-16). Before the re-review pass existed, the window between the last model call
    // returning and `runReview` returning was microseconds; the third pass put a whole model call in
    // it, and that pass swallows its own abort and returns normally — so a deadline landing there
    // produced a complete, paid-for review with output, which this branch then threw away without
    // posting anything. Design point 4 is explicit that a deadline in the refinement must not cost
    // the pull request its review, and the asymmetry was absurd: the branch below publishes a review
    // that produced NOTHING, while this one refused to publish one that produced everything.
    const finished = review.result.output !== null && review.result.failure === null
    if (stop.signal.aborted && !finished) {
      // The engine came back after its child was killed, with nothing usable. Whatever it reports,
      // this run was stopped: a deadline means the model ran for the whole deadline, and a
      // cancellation is trigger.dev already ending the run. Neither is retried, whatever the record
      // says it cost.
      const reason = messageOf(stop.signal.reason)
      await complete(failed(reason))
      throw new DoNotRetry(reason, record.costUsd)
    }
    if (stop.signal.aborted) {
      // Posted below, as any other review is, and NOT thrown afterwards: the review reaches the pull
      // request, and a thrown run clears its idempotency key, which would let the next delivery for
      // this same commit pay for the whole review again.
      deps.log('the review was stopped after it had already finished; publishing it anyway', {
        repo: payload.request.repo, pr: number, reason: saidSafely(messageOf(stop.signal.reason)),
      })
    }

    if (review.result.output === null) {
      // Nothing to place on a line, but the pull request is still told. publishReview writes the
      // summary that says "This review did not complete" in Task 7b's own fixed words — never the
      // CLI's unscanned stderr — and carries the previous marker over untouched, because a review
      // that saw nothing cannot say anything was fixed (Task 7b, Steps 34 to 37). This task is that
      // path's only production caller: returning here would leave the LAST review's summary
      // standing as though it were this one's, next to a check run saying the review failed. It
      // spends no model money — publishReview takes a finished result and has no engine in reach.
      // The retryable branch below writes it too, and a retry that succeeds overwrites that same
      // comment in place (Task 5's upsert), so the noise is bounded at the one comment already there.
      const sentence = failureSentence(record)
      try {
        await deps.publishReview({ octokit, owner, repo, number, review, via: VIA_APP, ...refusedByDoorway, ...publishExisting })
      } catch (e) {
        // The reason the review stopped is the more useful thing to say, so a failure to write the
        // summary is logged and does not replace it on the check run.
        deps.log('the unfinished review could not be published', {
          repo: payload.request.repo, pr: number, error: saidSafely(messageOf(e)),
        })
      }
      await complete(failed(sentence))
      if (mayRetry(record)) {
        // `RetryThis`, not a plain Error: Step 40 puts this branch inside a catch that turns any
        // plain Error into a `DoNotRetry` once the engine has started — and it HAS
        // started, because the wrapper above set the flag before `runReview` returned this record.
        // A plain Error here is caught and converted, and the retry this branch exists for never
        // happens in the deployed runner. `asTriggerError` passes a RetryThis through untouched.
        throw new RetryThis(`${sentence} — nothing was spent, so this attempt may be retried`)
      }
      throw new DoNotRetry(
        `${sentence} — $${record.costUsd.toFixed(2)} is already spent, so this run is not retried`,
        record.costUsd,
      )
    }

    // A budget stop keeps the partial findings the model had already written (Global Constraints:
    // "partial findings are kept"), so the test above is whether there is anything to say and not
    // whether the engine finished. Nor is it thrown afterwards: the review WAS posted, and a run that
    // fails clears its idempotency key (verified facts, "Idempotency"), which would let the next
    // delivery for this same commit pay for the same review all over again. `record.failure` and
    // `record.cutShort` carry the cut, and the metric's `outcome` attribute is `budget`.
    let published: PublishedReview
    try {
      published = await deps.publishReview({ octokit, owner, repo, number, review, via: VIA_APP, ...refusedByDoorway, ...publishExisting })
    } catch (e) {
      // Another run repeats the whole review, not the line: one here would re-run the model and pay
      // for it a second time because GitHub had a bad minute, so this is a DoNotRetry and starts no
      // new run. The review is lost; the money is not spent twice. The durable fix is a post-only
      // second task that trigger.dev may retry on its own, and it needs the record to survive between
      // runs — which this product has nowhere to put, by design: re-review state lives in the bot's
      // own comment and there is no database (design §5).
      const reason = `the review ran and could not be posted: ${saidSafely(messageOf(e))}`
      await complete(failed(reason))
      throw new DoNotRetry(
        `${reason} ($${record.costUsd.toFixed(2)} spent, and not spent again)`, record.costUsd,
      )
    }

    const outcome: CheckOutcome = {
      kind: 'reviewed', headSha: published.headSha,
      tier: review.settings.tier, model: review.settings.model, costUsd: record.costUsd,
      // What the review SAID (in check-only, would have said), at the check pass's severity and
      // never a refuted finding — so Task 6's gate cannot fail a build over something the check pass
      // disproved (design §4.6). `record.output.findings` would carry the reviewer's own severities
      // and the refuted ones with them.
      findings: published.findings,
      // The part of it the check pass CONFIRMED (Task 7b), which a gate demanding confirmation reads.
      confirmed: published.confirmed,
      // The hard ceiling fired: the check run says so in every mode (design §4.5, decision 7).
      cutShort: review.result.cutShort,
      // BOTH counts, and Task 7b's Seams section says the same: a summary-only finding — one GitHub
      // refused inline, or one with no changed line to sit on — was still put in front of a person,
      // in the comment at the top of the pull request. Counting only `inline` would under-report
      // what the review said, and most on the pull requests where the anchors had drifted.
      posted: published.counts.inline + published.counts.summaryOnly,
      // `publishReview` hands back GitHub's own link since 0.2.0 (`published.summaryUrl`), and the
      // review session links it. This runner moves onto the session in 0.2.0's Stage 6, and its
      // check runs change then and not before: until that stage it links nothing, as v0 did.
      summaryUrl: null,
    }
    const conclusion = await complete(outcome)
    deps.log('review published', {
      repo: payload.request.repo, pr: number, headSha: published.headSha.slice(0, 12),
      mode: published.mode, conclusion,
      inline: published.counts.inline, summaryOnly: published.counts.summaryOnly,
      // GitHub refused these inline and Task 7b moved them into the summary; a non-zero count here
      // means the anchors are drifting and someone should look at the diff hunks.
      droppedInline: published.counts.droppedInline,
      suppressed: published.counts.suppressed, notInCheckout: published.counts.notInCheckout,
      // Inline comments from an EARLIER review edited to say the finding is no longer reported
      // (Criss, 2026-09-15). A refused edit is not counted here and never fails the review.
      retracted: published.counts.retracted,
      // And the ones where such a note was taken back, because the pass says the defect is there
      // after all. Above zero means an earlier review was wrong in public and this one said so.
      reinstated: published.counts.reinstated,
      // A note this review meant to write and did not: refused, not this pull request's comment, or
      // a finding this same review is reporting again. A number that stays above zero means the two
      // passes are contradicting each other about one commit.
      retractionsWithheld: published.counts.retractionsWithheld,
    })
    const reviewed: Extract<ReviewTaskResult, { kind: 'reviewed' }> = {
      kind: 'reviewed', headSha: published.headSha, record,
      reviewId: published.reviewId, summaryCommentId: published.summaryCommentId,
      counts: published.counts,
      verdict: verdictJson({ outcome, bands: settings.severity.bands }),
      checkRun: check === null ? null : { id: check.id, conclusion },
      comments: postedCommentsOf(published),
    }
    // Criss, 2026-09-14 (answer 16): the finished record goes to the deployment's callback AFTER the
    // review is published and its check run completed, and only here — a review that did not finish
    // sends nothing. It passed runReview's secret scan (Task 1, Step 16) to get this far, and the
    // sender scans the exact bytes again. Whatever the send does, the same result is returned: a
    // failed callback never fails, retries or re-runs a review that has been paid for.
    await sendRecordSafely(deps, reviewed)
    return reviewed
  } catch (e) {
    // Everything inside that block runs after the engine may have spent: the metrics and the log
    // line Step 44 adds, the check-run completion, the publish. In the deployed runner two of
    // those are `logger.info` from @trigger.dev/sdk. The branches above classify the failures
    // somebody wrote a branch for; this one catches the rest, and only once the money is gone —
    // otherwise a throw from bookkeeping is a free-looking failure that starts a new run (Step 45e),
    // which is the whole review bought again, up to twice more. `complete` is at-most-once and
    // never throws, so a check run that is already finished is untouched and one still in progress
    // stops saying "in progress".
    // `RetryThis` is named here for the same reason `DoNotRetry` is: both are this file's own
    // verdict on the money, already reached with the record in hand, and converting either one
    // would overrule it. Without that clause the no-output retry branch above is dead code in the
    // deployed runner — the engine has always started by the time it throws.
    if (e instanceof DoNotRetry || e instanceof RetryThis || !spend.engineStarted) throw e
    // Scanned once, and the one sentence goes to both places it can be read: the check run summary,
    // which is public, and the DoNotRetry this run fails with, which the run page shows. The two
    // sites above (`the review did not complete`, `could not be posted`) already reuse one scanned
    // sentence for both; doing it here too makes the rule one a reader can check in a single pass —
    // nothing this task writes out of somebody else's error goes unscanned — instead of three
    // separate decisions, one of which was different.
    const reason = saidSafely(messageOf(e))
    await complete(failed(reason))
    throw new DoNotRetry(reason, spend.usd)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    if (checkoutToRemove !== null) await removeCheckout(checkoutToRemove)
  }
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

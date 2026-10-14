import type { Octokit } from '@octokit/core'
import {
  assertNoSecrets, buildPrompt, buildReviewRecord, resolveSettings, reviewJsonSchema,
  reviewSystemPrompt, scanForSecrets, SecretLeak, writesSummaryComment,
  type CheckVerdict, type DeploymentConfig, type EngineInput, type EngineResult,
  type MaterialisedSkill, type materialiseSkills, type PreviousFinding, type RecheckPassResult,
  type ResolvedSettings, type ReviewRecord, type ReviewRequest, type runCheckPass,
  type runEngine, type runRecheckPass, type Usage,
} from '@review-agent/core'
import type { downloadArchive } from './archive'
import type { fetchPullRequest, PullRequestContext } from './pr'
import type { fetchRepoConfig } from './repo-config'

export type CheckPassResult = { verdicts: CheckVerdict[]; usage: Usage }

/** What the re-review pass answered, and the list it was asked about.
 *
 *  `asked` travels with the answer because a judgement's `index` is a position in that list and
 *  nothing else. Whoever maps an index back to a marker row re-derives the list from the marker and
 *  compares: if the two are not the same list, the answer is about something else and every
 *  judgement is dropped. Cheap — the live marker holds eight rows.
 *
 *  What it does and does not buy, stated precisely (it used to claim to be "the only thing that makes
 *  a mis-addressed `fixed` impossible", which was false as written). It makes a mis-addressed
 *  QUESTION LIST impossible: an answer computed about one marker cannot be read against another. It
 *  says nothing about whether an ANSWER inside that list is about the row it indexes — a model
 *  answering from 1 instead of 0 produces a list that passes this check and lands every answer on its
 *  neighbour. That second failure is `RecheckJudgement.file`'s: the answer names its row, and one
 *  that names another row is dropped. Two guards, two different mistakes, and neither covers the
 *  other. */
export type RecheckResult = RecheckPassResult & { asked: PreviousFinding[] }

/** Everything a caller asks for that the pull request itself cannot say. `repo`, `pr` and `headSha`
 *  are filled in from what was fetched, so no caller can name a commit that was not the one
 *  reviewed — a webhook payload can be minutes old by the time a task picks it up. */
export type ReviewAsk = Omit<ReviewRequest, 'repo' | 'pr' | 'headSha'>

export type RunReviewDeps = {
  fetchPullRequest: typeof fetchPullRequest
  fetchRepoConfig: typeof fetchRepoConfig
  downloadArchive: typeof downloadArchive
  materialiseSkills: typeof materialiseSkills
  runEngine: typeof runEngine
  runCheckPass: typeof runCheckPass
  runRecheckPass: typeof runRecheckPass
  makeCheckoutDir: () => Promise<string>
  skillCacheDir: () => string
  now: () => Date
  /** Progress somebody is waiting on, written as it happens rather than collected and returned: the
   *  credential-file line has to land before a review that takes minutes, not after it. The CLI
   *  passes its stderr; the trigger.dev task passes its logger. */
  note: (s: string) => void
}

export type RunReviewResult = {
  pr: PullRequestContext
  request: ReviewRequest
  settings: ResolvedSettings
  result: EngineResult
  check: CheckPassResult | null
  /** `null` when no previous findings were passed in — a first review, or a caller that reads no
   *  marker. Never null because the pass failed: a failure is a result with no judgements in it. */
  recheck: RecheckResult | null
  skills: MaterialisedSkill[]
  checkoutDir: string
  removedFromCheckout: string[]
  record: ReviewRecord
}

/** A verdict's `reason` and `evidence` are model-written and both callers put them in front of
 *  people, so they are a posting path in the sense of design §4.3 and get the same scan the review
 *  output gets. `assertNoSecrets` only knows `ReviewOutput`, so the walk over the verdicts lives
 *  here. */
const assertVerdictsCarryNoSecrets = (verdicts: CheckVerdict[]): void => {
  const hits = verdicts.flatMap((v, i) => [
    ...scanForSecrets(v.reason).map((h) => ({ pattern: h.pattern, where: `checkVerdicts[${i}].reason:${h.where}` })),
    ...v.evidence.flatMap((e, j) => scanForSecrets(e).map(
      (h) => ({ pattern: h.pattern, where: `checkVerdicts[${i}].evidence[${j}]:${h.where}` }),
    )),
  ])
  if (hits.length > 0) throw new SecretLeak(hits)
}

/** What a pass that never ran was billed. */
const emptyUsage = (): Usage => ({
  costUsd: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0,
})

/** The review pipeline both callers share: the CLI and the trigger.dev task of design §2.
 *  It takes a ready `Octokit` rather than a token or a factory because the two callers authenticate
 *  differently — a user token from the environment, and an installation token minted from the App's
 *  private key — and `01-ARCHITECTURE.md` §3.1 keeps that key out of everything else. Minting one
 *  here would put it on the CLI's code path too.
 *  It posts nothing: what a review says and where it goes is `post.ts` and `check-run.ts`. */
export const runReview = async (a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  /** Cancels the review, and with it the model. `EngineInput.signal` already exists and `runEngine`
   *  honours it; without this parameter nothing outside the pipeline can reach it. Task 13's
   *  trigger.dev task needs it: a `maxDuration` kill runs no lifecycle hook, so the task owns its own
   *  wall-clock timeout and must be able to stop a review that is still spending. */
  signal?: AbortSignal
  deployment: DeploymentConfig
  ask: ReviewAsk
  /** Everything earlier reviews of this pull request reported, read out of the marker in the bot's
   *  summary comment — `recheckQuestions` in marker.ts builds it. Left out, or empty, means a FIRST
   *  review: no re-review pass runs and nothing is spent on one. The CLI passes nothing, reads no
   *  marker, and so buys no third pass. */
  previousFindings?: PreviousFinding[]
  deps: RunReviewDeps
}): Promise<RunReviewResult> => {
  const { octokit, owner, repo, number, deployment, ask, deps } = a
  // Read before the first network call: the record's duration covers the fetch, the archive, the
  // engine and the check — what a person waited for, which is not usage.durationMs.
  const startedAt = deps.now()
  const pr = await deps.fetchPullRequest({ octokit, owner, repo, number })

  // The reviewed repository's own file, read from the BASE commit. Never `pr.headSha`: a pull
  // request that can edit `.review-agent/review.md` writes the instructions that judge it
  // (design §4.3, §7). Until 2026-09-14 the CLI passed `repo: null` here, so this file — parsed
  // and tested since sub-project 1 — had never applied to a single review.
  const repoConfig = await deps.fetchRepoConfig({ octokit, owner, repo, baseRef: pr.baseSha })

  // Hoisted out of the resolveSettings call so the record can see what was ASKED for, not only
  // what was used: droppedRequestKeys is the difference between the two.
  // The spread comes FIRST and the three fetched fields overwrite it, which is the whole point of
  // `ReviewAsk` omitting them: an ask carrying `repo`, `pr` or `headSha` must not be able to name a
  // commit that was not the one reviewed, and the type that forbids it is gone by the time a
  // webhook payload — minutes old, so possibly a stale head sha — has been parsed into an ask.
  // (Found the other way round by batch 1's verification, 2026-09-14.)
  const request: ReviewRequest = {
    ...ask, repo: `${owner}/${repo}`, pr: number, headSha: pr.headSha,
  }
  const settings = resolveSettings({ deployment, repo: repoConfig, request })
  if (settings.droppedRequestKeys.length > 0) {
    deps.note(`ignored, the deployment does not allow it: ${settings.droppedRequestKeys.join(', ')}`)
  }

  const checkoutDir = await deps.makeCheckoutDir()
  const { removed } = await deps.downloadArchive({
    octokit, owner, repo, ref: pr.headSha, destDir: checkoutDir,
  })
  if (removed.length > 0) {
    const noun = removed.length === 1 ? 'credential file' : 'credential files'
    deps.note(`removed ${removed.length} ${noun} from the checkout before the review: ${removed.join(', ')}`)
  }

  // The whole list, unfiltered: a git source is materialised into a real directory here, and a
  // `filter(s => s.kind === 'dir')` would drop it in silence.
  const skills = await deps.materialiseSkills(settings.skills, deps.skillCacheDir())

  const input: EngineInput = {
    checkoutDir,
    prompt: buildPrompt({ pr, brief: settings.brief }),
    systemPrompt: reviewSystemPrompt({ settings }),
    settings,
    schema: reviewJsonSchema({ maxFindings: settings.report.maxFindings }),
    skillDirs: skills.map((s) => s.path),
    // Optional on EngineInput, and absent for the CLI, which is killed by its own terminal.
    ...(a.signal !== undefined && { signal: a.signal }),
  }

  const result = await deps.runEngine(input)
  if (result.output !== null) assertNoSecrets(result.output)

  // Design §4.6: cheap enough to leave on wherever findings are posted. It runs after the secret
  // scan, never before — a review that cannot be emitted must not buy a second model call.
  let check: CheckPassResult | null = null
  if (settings.check && result.output !== null) {
    check = await deps.runCheckPass({ findings: result.output.findings, input })
    assertVerdictsCarryNoSecrets(check.verdicts)
  }

  // Criss, 2026-09-16: ask the model instead of inferring. ON A RE-REVIEW ONLY — a first review has
  // no previous findings, so the early return in `runRecheckPass` costs nothing and spawns nothing.
  //
  // Here, and not in `publishReview`, for two reasons. This is the only point that already holds a
  // built `EngineInput` — the checkout, the skills, the signal and the budget — and it is upstream
  // of `buildReviewRecord`, so a third pass's money is recorded and labelled like the other two
  // instead of being spent after the record is sealed. An unrecorded cost is not something this
  // product does: `record.costUsd` is the number printed in the public summary.
  //
  // After the check pass, and after the secret scan, for the reason above them: a review that cannot
  // be emitted must not buy another model call, and the pass that decides what is SAID goes first.
  //
  // It fails closed TWICE, and the second time is not redundant. `runRecheckPass` catches its own
  // failures and hands back a result with no judgements — but it arrives here as an injected
  // dependency, and both production callers wrap it (the trigger.dev task wraps it to watch spend
  // from outside). A throw from a wrapper, or from a future one, would otherwise take the review
  // down with it. This is the one place the rule has to hold whatever is on the other side of the
  // call: an outcome refinement must never cost the pull request its review.
  //
  // AND ONLY IN A MODE THAT WRITES THE SUMMARY. Both consumers of the answer are behind that test —
  // the marker write and the comment edits, in `publishReview` — so in `check-only` and `silent` this
  // pass would spawn, spend and be discarded, on every review, for ever. It is reachable: a pull
  // request reviewed in `inline+summary` has a marker, and a repository may lower the mode from its
  // base branch at any time (`resolveSettings`). A deployment that cannot write the answer down does
  // not buy the answer.
  const previousFindings = a.previousFindings ?? []
  let recheck: RecheckResult | null = null
  if (previousFindings.length > 0 && result.output !== null && writesSummaryComment(settings.report.mode)) {
    const asked = { previous: previousFindings, input,
      // What the review and the check have already cost. The pass refuses to start if this leaves
      // less headroom under the review's own ceiling than the pass's own target.
      spentUsd: result.usage.costUsd + (check?.usage.costUsd ?? 0) }
    const answered = await deps.runRecheckPass(asked).catch((): RecheckPassResult => ({
      judgements: [], usage: emptyUsage(), ran: false, skipped: 'error',
    }))
    recheck = { asked: previousFindings, ...answered }
  }

  // Built on every run, not only when somebody asked to see it: it is pure, it costs nothing, and
  // the trigger.dev task returns it whatever the CLI does with it.
  const record = buildReviewRecord({
    request, settings, result, skills, check, recheck, removedFromCheckout: removed,
    startedAt, finishedAt: deps.now(),
  })

  return {
    pr, request, settings, result, check, recheck, skills, checkoutDir,
    removedFromCheckout: removed, record,
  }
}

import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { removeCheckout } from './checkout'
import type { Octokit } from '@octokit/core'
import {
  assertNoSecrets, buildPrompt, buildReviewRecord, combineFocusRuns, DEFAULT_FOCUS_CONCURRENCY,
  resolveSettings, REVIEW_LENSES, reviewJsonSchema, reviewSystemPrompt, runFocusedReviews, scanForSecrets,
  SecretLeak, writesSummaryComment,
  type CheckVerdict, type ClaudeRuntime, type DeploymentConfig, type EngineInput, type EngineResult,
  type FocusRun, type Lens, type MaterialisedSkill, type materialiseSkills, type PreviousFinding,
  type RecheckPassResult, type ResolvedSettings, type ReviewOutput, type ReviewRecord, type ReviewRequest,
  type runCheckPass, type runEngine, type runRecheckPass, type SecretHit, type UnwrittenEntry, type Usage,
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

/** What a focus runner hands back: every focus as it ended, in `REVIEW_LENSES` order, and the secret
 *  patterns any focus's answer matched — names and places, never the text. A focus whose answer
 *  matched one comes back with no output, and the review is then withheld as a whole, exactly as it
 *  is when the answers of focuses run in this process match one (`assertNoSecrets` over their union). */
export type FocusRunsOutcome = { runs: FocusRun[]; withheld: SecretHit[] }

/** Runs the focused reviewers of a multi-reviewer review somewhere other than this process: the App's
 *  runner on trigger.dev, where three Claude processes do not fit one 1 GB machine, starts a child
 *  task per focus and waits for them (spec 0.2.0 §8.3 point 4, decision §14.18 (a)). Every other
 *  caller leaves it out, and the focuses run here, side by side (`runFocusedReviews`).
 *
 *  Called BEFORE this review downloads anything. A runner elsewhere downloads the commit for itself
 *  — `pr.headSha`, the commit this review is of, never a later one — and nothing here has to survive
 *  the wait: a trigger.dev parent waiting on its children is checkpointed and restored, and what is
 *  restored is documented as memory and open file descriptors, not as files written to disk
 *  (trigger.dev 4.5.16 docs, how-it-works). The checkout the check pass reads is downloaded after it
 *  returns.
 *
 *  The contract is `runFocusedReviews`'s, so a review cannot tell where its focuses ran: each focus
 *  is reviewed with what `ask` resolves to over this pull request, with the tier's whole budget; one
 *  that could not run comes back as a `crashed` focus, named through `onFailure`, and the review goes
 *  on without it; only when none could run does it throw, with the first error; a stop that lands
 *  before any focus started throws its reason. */
export type FocusRunner = (a: {
  pr: PullRequestContext
  /** What was asked, as this review was asked it: a runner elsewhere resolves the settings from it,
   *  over the same deployment and the same base commit's settings file, rather than being trusted
   *  with settings someone else resolved. */
  ask: ReviewAsk
  settings: ResolvedSettings
  signal?: AbortSignal
  onFailure?: (lens: Lens, error: unknown) => void
}) => Promise<FocusRunsOutcome>

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
  /** How many focused reviewers of a multi-reviewer review run at once (spec 0.2.0 §8.3 point 4); a
   *  review by one reviewer ignores it. `defaultRunReviewDeps` says 3 — all of them, side by side, on
   *  a laptop, CI or a VPS. A host short of memory says fewer. Left out, `DEFAULT_FOCUS_CONCURRENCY`
   *  (3). Not read when `runFocuses` is given. */
  concurrency?: number
  /** Where the focuses of a multi-reviewer review run, when not in this process (`FocusRunner`). The
   *  App's runner on trigger.dev passes one that starts a child task per focus; left out, they run
   *  here, `concurrency` at a time. */
  runFocuses?: FocusRunner
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

/** A finding's `file` as the repository writes it (spec 0.2.0 §9.3 P11): `\` turned into `/`, a
 *  leading `./` dropped, and an absolute path under the checkout made relative to it. The review
 *  instructions ask for exactly that; this is what makes it true when a model on Windows writes
 *  `src\a.ts`, or quotes the path its Read tool was given. Anything else is left as it is — a path
 *  outside the checkout is not repaired into one inside it — and anchoring drops what is not a file in
 *  the diff, as it always has.
 *
 *  The checkout is compared both as given and resolved, because the model's working directory is the
 *  resolved one (macOS's `/var/folders` is `/private/var/folders`), and both spellings may appear. */
const repositoryPath = (file: string, checkoutRoots: readonly string[]): string => {
  const slashed = file.replace(/\\/g, '/')
  const onDrive = /^[A-Za-z]:\//.test(slashed)
  if (!onDrive && !slashed.startsWith('/')) return slashed.replace(/^(\.\/)+/, '')
  const path = onDrive ? win32 : posix
  for (const root of checkoutRoots) {
    const rel = path.relative(root.replace(/\\/g, '/'), slashed).replace(/\\/g, '/')
    if (rel !== '' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) return rel
  }
  return slashed
}

/** A review's findings with their `file` as the repository writes it (spec 0.2.0 §9.3 P11), against the
 *  checkout the model read. Exported for a focus run elsewhere (`FocusRunner`): its model read a
 *  checkout of its own, which this review never sees, so it is the one that can make an absolute path
 *  under that checkout relative. */
export const withRepositoryPaths = (output: ReviewOutput, checkoutDir: string): ReviewOutput => {
  let resolved = checkoutDir
  try { resolved = realpathSync(checkoutDir) } catch { /* a checkout that is not there resolves to itself */ }
  const roots = resolved === checkoutDir ? [checkoutDir] : [checkoutDir, resolved]
  return { ...output, findings: output.findings.map((f) => ({ ...f, file: repositoryPath(f.file, roots) })) }
}

/** Up to ten names, then a count: a progress line, not the record, which has them all. */
const someOf = (names: string[]): string =>
  names.length <= 10 ? names.join(', ') : `${names.slice(0, 10).join(', ')} and ${names.length - 10} more`

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
  /** The credential, binary and passed-through variables every model pass of this review runs with
   *  (spec 0.2.0 §3.2). Left out, the Claude process takes them from this process's environment, as
   *  before. */
  runtime?: ClaudeRuntime
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

  // The focuses of a multi-reviewer review, run elsewhere (`FocusRunner`): before this review's own
  // checkout exists, so nothing of it has to outlive the wait, and so a review whose focuses all
  // failed downloaded nothing. Run here instead, they are run below, over the checkout.
  let focusRuns: FocusRun[] = []
  const elsewhere = settings.multi ? deps.runFocuses : undefined
  const noteCouldNotRun = (lens: Lens, e: unknown): void => {
    deps.note(`the ${lens} reviewer could not run, and the review goes on without it: ${e instanceof Error ? e.message : String(e)}`)
  }
  const couldNotRun = new Set<string>()
  if (elsewhere !== undefined) {
    deps.note(`running ${REVIEW_LENSES.length} focused reviewers (${REVIEW_LENSES.join(', ')}), each as a task of its own with this tier's budget: up to $${settings.budget.ceilingUsd.toFixed(2)} apiece at per-token API prices`)
    const outcome = await elsewhere({
      pr, ask: a.ask, settings,
      ...(a.signal !== undefined && { signal: a.signal }),
      onFailure: (lens, e) => { couldNotRun.add(lens); noteCouldNotRun(lens, e) },
    })
    focusRuns = outcome.runs
    // What a focus said that matched a secret pattern never reached this process, and the review is
    // withheld as one run here would be: by the same error, after the money is counted.
    if (outcome.withheld.length > 0) throw new SecretLeak(outcome.withheld)
  }

  const checkoutDir = await deps.makeCheckoutDir()
  // From here on the checkout exists. A failure removes it before it propagates: no publish will read
  // it. On success it is the caller's, who removes it once publishing has placed the comments.
  try {
    const { removed, notWritten, caseCollisions } = await deps.downloadArchive({
      octokit, owner, repo, ref: pr.headSha, destDir: checkoutDir,
    })
    if (removed.length > 0) {
      const noun = removed.length === 1 ? 'credential file' : 'credential files'
      deps.note(`removed ${removed.length} ${noun} from the checkout before the review: ${removed.join(', ')}`)
    }
    // Spec 0.2.0 §9.3 P10: the same courtesy for what went missing by accident. The record and the
    // summary carry the whole list; this line is for whoever is watching the review run.
    if (notWritten.length > 0) {
      const noun = notWritten.length === 1 ? 'entry' : 'entries'
      deps.note(`${notWritten.length} archive ${noun} could not be written to the checkout, so the review cannot read ${notWritten.length === 1 ? 'it' : 'them'}: ${someOf(notWritten.map((e: UnwrittenEntry) => `${e.path} (${e.code})`))}`)
    }
    if (caseCollisions.length > 0) {
      deps.note(`${caseCollisions.length} ${caseCollisions.length === 1 ? 'set' : 'sets'} of paths differ only by letter case or Unicode form; where the filesystem ignores that, each was one file in the checkout: ${someOf(caseCollisions.map((g) => g.join(' / ')))}`)
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
      // Optional on EngineInput. The CLI passes one since 0.2.0, from Ctrl-C (spec 0.2.0 §9.3 P14).
      ...(a.signal !== undefined && { signal: a.signal }),
      ...(a.runtime !== undefined && { runtime: a.runtime }),
    }

    // One reviewer, or one per focus (spec 0.2.0 §8.3). Each focus runs through `deps.runEngine`, the
    // same function one reviewer does, so a caller that wraps it to watch the spend sees every focus's;
    // each has the tier's budget and ceiling, and a focus that fails is recorded rather than allowed
    // to fail the review (`runFocusedReviews`). Focuses a `FocusRunner` ran elsewhere already came
    // back above, under the same rules. Their answers are then one engine result
    // (`combineFocusRuns`), and nothing below this line needs to know there were several, or where.
    let ran: EngineResult
    if (settings.multi) {
      if (elsewhere === undefined) {
        const concurrency = deps.concurrency ?? DEFAULT_FOCUS_CONCURRENCY
        deps.note(`running ${REVIEW_LENSES.length} focused reviewers (${REVIEW_LENSES.join(', ')}), ${concurrency} at a time, each with this tier's budget: up to $${settings.budget.ceilingUsd.toFixed(2)} apiece at per-token API prices`)
        focusRuns = await runFocusedReviews({
          input, run: deps.runEngine, concurrency,
          onFailure: (lens, e) => { couldNotRun.add(lens); noteCouldNotRun(lens, e) },
        })
      }
      for (const f of focusRuns) {
        if (f.result.output === null && !couldNotRun.has(f.lens)) {
          deps.note(`the ${f.lens} reviewer returned no answer (${f.result.failure?.kind ?? 'no output'}); the review goes on without it`)
        }
      }
      ran = combineFocusRuns(focusRuns)
    } else {
      ran = await deps.runEngine(input)
    }

    // The paths, before anything reads them (spec 0.2.0 §9.3 P11): the secret scan, the check pass,
    // the record and the anchoring all see one spelling, the repository's.
    const result: EngineResult = ran.output === null
      ? ran
      : { ...ran, output: withRepositoryPaths(ran.output, checkoutDir) }
    if (result.output !== null) assertNoSecrets(result.output)

    // Design §4.6: cheap enough to leave on wherever findings are posted. It runs after the secret
    // scan, never before — a review that cannot be emitted must not buy a second model call.
    // On a multi-reviewer review this is the ONE pass over the union of the focuses' findings, and it
    // also marks duplicates (decision §14.17): told how many focuses reported anything, it is asked to,
    // and its budget grows with them (check-pass.ts says why).
    let check: CheckPassResult | null = null
    if (settings.check && result.output !== null) {
      const reporting = focusRuns.filter((f) => (f.result.output?.findings.length ?? 0) > 0).length
      check = await deps.runCheckPass({
        findings: result.output.findings, input, ...(settings.multi && { focuses: reporting }),
      })
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
        spentUsd: result.usage.costUsd + (check?.usage.costUsd ?? 0),
        // A multi-reviewer review's ceiling is one tier ceiling per focus (spec 0.2.0 §8.3), and
        // `result.usage` above is every focus's spend: measured against one focus's ceiling, this pass
        // would be refused on every multi-reviewer re-review.
        ...(settings.multi && { ceilingUsd: settings.budget.ceilingUsd * focusRuns.length }) }
      const answered = await deps.runRecheckPass(asked).catch((): RecheckPassResult => ({
        judgements: [], usage: emptyUsage(), ran: false, skipped: 'error',
      }))
      recheck = { asked: previousFindings, ...answered }
    }

    // Built on every run, not only when somebody asked to see it: it is pure, it costs nothing, and
    // the trigger.dev task returns it whatever the CLI does with it.
    const record = buildReviewRecord({
      request, settings, result, skills, check, recheck, focuses: focusRuns, removedFromCheckout: removed,
      notWrittenToCheckout: notWritten, caseCollisions,
      startedAt, finishedAt: deps.now(),
    })

    return {
      pr, request, settings, result, check, recheck, skills, checkoutDir,
      removedFromCheckout: removed, record,
    }
  } catch (e) {
    await removeCheckout(checkoutDir)
    throw e
  }
}

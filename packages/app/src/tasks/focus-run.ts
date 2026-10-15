import type { Octokit } from '@octokit/core'
import {
  assertNoSecrets, buildPrompt, modelCredentialFromEnv, resolveSettings, REVIEW_LENSES, reviewJsonSchema,
  reviewSystemPrompt, SecretLeak,
  type DeploymentConfig, type EngineInput, type EngineResult, type FocusRun, type Lens, type ModelCredential,
  type ReviewRequest, type SecretHit, type Usage,
} from '@review-agent/core'
import {
  removeCheckout, saidSafely, withRepositoryPaths,
  type fetchPullRequest, type fetchRepoConfig, type FocusRunner, type RunReviewDeps,
} from '@review-agent/github'
import { z } from 'zod'
import type { AppIdentity, installationToken } from '../credentials'
import { projectPayload } from '../dispatch'
import { DoNotRetry } from './review-run'

// The multi-reviewer mode on trigger.dev (spec 0.2.0 §8.3 point 4; decision §14.18, taken (a)): one
// review peaks around 400 MiB and the runner's machine has 1 GB, so three Claude processes do not fit
// one machine. Each focus runs as a child task of its own instead, on a machine of its own, and the
// review that started them waits — checkpointed, and not billed while it waits (trigger.dev 4.5.16
// docs, how-it-works) — then checks their union and posts it, as one review.
//
// This module is both halves, and imports no `@trigger.dev/sdk`: `focus-task.ts` defines the task and
// the one call that triggers it, so everything that decides what a focus is, what it may spend and
// what the review makes of it is testable here without the trigger.dev runtime.

/** The child task's id. The parent triggers it by its task object, so the id is written once, here. */
export const FOCUS_TASK_ID = 'review-agent-focus'

/** 20 minutes: a focus's own wall-clock deadline. Four times the slowest review ever measured (4m40s,
 *  design §8), and deliberately BELOW the review's 30 (`DEFAULT_DEADLINE_MS`): the review that waits
 *  for its focuses still has to download the commit, run the check pass and post, and a focus allowed
 *  the review's whole deadline would leave it none — the review would then be stopped with every
 *  focus already paid for. Whether the review's own timer counts the time it spends checkpointed is
 *  not verified (trigger.dev documents what a restore brings back as memory and open file
 *  descriptors), so the margin is kept on the side that holds either way. */
export const FOCUS_DEADLINE_MS = 20 * 60 * 1000

/** One focus of one review: ids, not bodies (trigger.dev's payload cap is 3 MB, and a diff is not
 *  sent where the child can read it from GitHub). `request` is the review's own request — the commit
 *  it is of (`headSha`) and what was asked, projected field by field as the receiver projects one —
 *  and `baseSha` the commit whose settings file the review read. The child resolves its settings
 *  from those and the deployment, exactly as the review did, rather than being handed settings: a
 *  payload can be triggered by anyone holding a trigger key, and settings carried in one would let
 *  it name a budget, skills or instructions the deployment never allowed. */
export type FocusTaskPayload = {
  installationId: number
  request: ReviewRequest
  baseSha: string
  lens: Lens
}

/** What a focus hands back: its engine result, and the secret patterns its answer matched — names
 *  and places only. An answer that matched one is not carried at all: a run's output is stored and
 *  shown by trigger.dev, and nothing this product has not scanned goes there. */
export type FocusTaskOutput = {
  lens: Lens
  /** The commit this focus reviewed, which the review checks is the one it asked about. */
  headSha: string
  result: EngineResult
  withheld: SecretHit[]
}

export type FocusTaskDeps = {
  env: Record<string, string | undefined>
  /** Read per run, as the review task reads it. */
  identity: () => AppIdentity
  /** The same deployment the review task reviews under, so the settings resolve the same. */
  deployment: () => DeploymentConfig
  deadlineMs: number
  installationToken: typeof installationToken
  makeOctokit: (token: string) => Octokit
  fetchPullRequest: typeof fetchPullRequest
  fetchRepoConfig: typeof fetchRepoConfig
  /** The checkout, the download, the skills and the engine: the runner's own (`liveRunReviewDeps`). */
  runReviewDeps: Pick<RunReviewDeps, 'makeCheckoutDir' | 'downloadArchive' | 'materialiseSkills' | 'skillCacheDir' | 'runEngine'>
  log: (message: string, fields: Record<string, unknown>) => void
}

/** A commit id: SHA-1, or SHA-256 should a repository ever use it. */
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** The ids a focus is run on, checked before anything is minted, downloaded or spent: a payload can
 *  be triggered by hand from the dashboard, and these decide which code is reviewed and on whose
 *  installation. What was asked is `resolveSettings`'s to judge, as it is for any review. */
const FocusPayloadSchema = z.object({
  installationId: z.number().int().positive(),
  request: z.object({
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    pr: z.number().int().positive(),
    headSha: z.string().regex(SHA),
  }).passthrough(),
  baseSha: z.string().regex(SHA),
  lens: z.enum(REVIEW_LENSES),
})

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One focus, run as a child task. It mints its own token for the one repository, downloads the
 *  commit its review is of — that commit and no other — runs ONE engine pass for its focus, removes
 *  its checkout and hands back what the engine said. It posts nothing and reports nothing: the review
 *  that started it does both, once, for all its focuses.
 *
 *  Its money rule is the review task's (`DoNotRetry` after anything may have been spent), applied to
 *  one focus:
 *  - everything before the engine — the token, the pull request, the settings file, the archive, the
 *    skills — spends nothing, so a failure there is thrown as it is and trigger.dev retries the
 *    attempt (`MAX_ATTEMPTS`, the project's, which this task does not override);
 *  - whatever the engine RETURNS is returned, never thrown — a finished answer, a partial one its
 *    ceiling stopped, or none — so a focus that ran is never run again, and the review records it as
 *    a focus run in one process would be recorded (spec 0.2.0 §8.3 point 2);
 *  - an engine that THREW, a stop, a malformed payload, a misconfigured deployment and a pull request
 *    that moved on are `DoNotRetry`: running it again could pay twice, or could not help. */
export const focusTaskRun = async (
  payload: FocusTaskPayload,
  options: { signal?: AbortSignal },
  deps: FocusTaskDeps,
): Promise<FocusTaskOutput> => {
  if (options.signal?.aborted === true) {
    throw new DoNotRetry('the focused review was cancelled before it started', 0)
  }
  const parsed = FocusPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new DoNotRetry(`not a focused review this runner can run: ${parsed.error.issues.map((i) => i.path.join('.') || 'payload').join(', ')}`, 0)
  }
  const { installationId, baseSha, lens } = parsed.data
  const request = payload.request
  const { repo: full, pr: number, headSha } = parsed.data.request

  let credential: ModelCredential
  let identity: AppIdentity
  try {
    credential = modelCredentialFromEnv(deps.env, { allowLogin: false })
    identity = deps.identity()
  } catch (e) {
    throw new DoNotRetry(messageOf(e), 0)
  }

  const [owner, repo] = full.split('/') as [string, string]
  const where = { repo: full, pr: number, lens, headSha: headSha.slice(0, 12) }
  const minted = await deps.installationToken({ identity, installationId, repositories: [repo] })
  const octokit = deps.makeOctokit(minted.token)

  // The prompt describes the pull request's diff, so the pull request is read again here — and must
  // still be at the commit its review is of. A push in between would describe one diff over the code
  // of another; the review reads this focus's findings against its own commit, so none would be
  // worth its money. Nothing is spent yet, and nothing a retry could change.
  const pr = await deps.fetchPullRequest({ octokit, owner, repo, number })
  if (pr.headSha !== headSha) {
    throw new DoNotRetry(
      `the pull request moved on to ${pr.headSha.slice(0, 12)} after its review started on ${headSha.slice(0, 12)}; ` +
      'this focus reviews only the commit its review is of, so it reviewed nothing',
      0,
    )
  }
  // The settings the review resolved, resolved again from the same three things: the deployment, the
  // base commit's settings file (a commit, so it reads the same), and what was asked.
  const repoConfig = await deps.fetchRepoConfig({ octokit, owner, repo, baseRef: baseSha })
  const settings = resolveSettings({
    deployment: deps.deployment(), repo: repoConfig, request: { ...request, repo: full, pr: number, headSha },
  })

  const checkoutDir = await deps.runReviewDeps.makeCheckoutDir()
  // Its own deadline, as the review task has one: a stop this run holds is one it can kill the
  // engine's child with, before trigger.dev's `maxDuration` ends the run with no cleanup at all.
  const stop = new AbortController()
  const cancel = (): void => { stop.abort(new Error('the focused review was cancelled')) }
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted ?? false) cancel()
  const timer = setTimeout(() => {
    stop.abort(new Error(`the focused review passed its ${Math.round(deps.deadlineMs / 1000)}s deadline and was stopped`))
  }, deps.deadlineMs)
  timer.unref()
  try {
    const { removed } = await deps.runReviewDeps.downloadArchive({ octokit, owner, repo, ref: headSha, destDir: checkoutDir })
    if (removed.length > 0) deps.log('credential files were removed from the checkout before the review', { ...where, removed: removed.length })
    const skills = await deps.runReviewDeps.materialiseSkills(settings.skills, deps.runReviewDeps.skillCacheDir())
    // Stopped while downloading: nothing is spent yet, and nothing should be.
    if (stop.signal.aborted) throw new DoNotRetry(messageOf(stop.signal.reason), 0)

    // The input a focus run in one process gets (`runFocusedReviews` over `runReview`'s input): the
    // same prompt, schema, skills and budget — the tier's whole budget, not a share — with the
    // system prompt naming this focus.
    const input: EngineInput = {
      checkoutDir,
      prompt: buildPrompt({ pr, brief: settings.brief }),
      systemPrompt: reviewSystemPrompt({ settings, lens }),
      settings,
      schema: reviewJsonSchema({ maxFindings: settings.report.maxFindings }),
      skillDirs: skills.map((s) => s.path),
      signal: stop.signal,
      runtime: { credential },
    }
    let ran: EngineResult
    try {
      ran = await deps.runReviewDeps.runEngine(input)
    } catch (e) {
      // The engine was started, so what it spent is not known, and it is not run again. The review
      // records this focus as one that could not run, as it would one that threw in its own process.
      throw new DoNotRetry(
        stop.signal.aborted ? messageOf(stop.signal.reason) : `the ${lens} reviewer could not run: ${saidSafely(messageOf(e))}`,
        0,
      )
    }

    // From here the money is spent: whatever throws is a `DoNotRetry`, never an error trigger.dev
    // would answer by running the engine again — a logger with a bad moment included.
    try {
      // The paths as the repository writes them, against THIS checkout — the review never sees it.
      const result: EngineResult = ran.output === null ? ran : { ...ran, output: withRepositoryPaths(ran.output, checkoutDir) }
      let withheld: SecretHit[] = []
      let answer = result
      if (result.output !== null) {
        try {
          assertNoSecrets(result.output)
        } catch (e) {
          if (!(e instanceof SecretLeak)) throw e
          withheld = e.hits
          answer = { ...result, output: null }
        }
      }
      deps.log('focused review finished', {
        ...where, costUsd: result.usage.costUsd, findings: result.output?.findings.length ?? 0,
        failure: result.failure?.kind ?? null, cutShort: result.cutShort, withheld: withheld.length,
      })
      return { lens, headSha, result: answer, withheld }
    } catch (e) {
      throw new DoNotRetry(`the ${lens} reviewer ran and its answer could not be handed back: ${saidSafely(messageOf(e))}`, ran.usage.costUsd)
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    await removeCheckout(checkoutDir)
  }
}

// ── The review's half: start the focuses, wait, and read what they said ─────────────────────────────

export type FocusBatchItem = { payload: FocusTaskPayload; options: { idempotencyKey: string; tags: string[] } }

/** One child run as trigger.dev's `batchTriggerAndWait` reports it (`TaskRunResult`, @trigger.dev/core
 *  4.5.16, dist/esm/v3/types/tasks.d.ts): `ok` and the task's output, or not `ok` and its error once
 *  every attempt has failed. */
export type FocusBatchRun =
  | { ok: true; id: string; output: FocusTaskOutput }
  | { ok: false; id: string; error: unknown }

/** Triggers the focus task once per item and waits for all of them: the deployed task passes
 *  `focusTask.batchTriggerAndWait`. Its runs come back in the order of the items — read in the
 *  installed SDK, not by a run: `waitForBatch` resolves the item at index `i` through the waitpoint
 *  named `<batchId>_<i>` (@trigger.dev/core 4.5.16, dist/esm/v3/runtime/sharedRuntimeManager.js) —
 *  and each output is checked against the focus it was asked for anyway. */
export type FocusBatchPort = (items: FocusBatchItem[]) => Promise<{ id: string; runs: FocusBatchRun[] }>

/** A child focus run's idempotency key: the focus and the commit. Passed as a raw string from inside
 *  the review's run, which trigger.dev scopes to that run — "`run` scope (default) … the key is
 *  combined with the parent run ID" (trigger.dev docs, idempotency; `makeIdempotencyKey` in
 *  @trigger.dev/core 4.5.16 creates it with `scope: "run"`). So it is one child per review run and
 *  focus: an attempt of the same run that trigger.dev retries gets back the children the first
 *  attempt started, and does not pay for a focus that already answered; a NEW run — the one a free
 *  failure starts — is another parent, and starts its own. The commit is in it for the one case run
 *  scope alone would get wrong: an attempt retried after the pull request moved reviews the new
 *  head, and must not be handed the old head's answers. */
export const focusIdempotencyKey = (lens: Lens, headSha: string): string => `focus:${lens}@${headSha}`

/** Tags a person can find a focus run by, in the receiver's `namespace:value` convention, within
 *  trigger.dev's 10 tags of 1–128 characters; one that cannot fit is dropped, never cut. */
export const focusTagsFor = (a: { repo: string; pr: number; headSha: string; lens: Lens }): string[] => [
  `repo:${a.repo}`, `pr:${a.repo}#${a.pr}`, `sha:${a.headSha.slice(0, 12)}`, `focus:${a.lens}`,
].filter((t) => t.length >= 1 && t.length <= 128).slice(0, 10)

const nothingSpent = (): Usage => ({
  costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0,
})

const isOutputFor = (o: unknown, lens: Lens, headSha: string): o is FocusTaskOutput => {
  if (typeof o !== 'object' || o === null) return false
  const x = o as Partial<FocusTaskOutput>
  return x.lens === lens && x.headSha === headSha && Array.isArray(x.withheld) &&
    typeof x.result === 'object' && x.result !== null && typeof x.result.usage?.costUsd === 'number'
}

/** A child's error as one sentence a log, a note and the record may carry: scanned, because the
 *  error a child failed with is somebody else's text and can quote a request it made. */
const childError = (e: unknown): Error => new Error(saidSafely(messageOf(e)))

/** The review's `FocusRunner` on trigger.dev: one child task per focus, all triggered at once with
 *  `batchTriggerAndWait` and waited for together (decision §14.18 (a)). A focus whose child failed —
 *  every attempt — or answered about another focus or commit is recorded as `crashed`, named through
 *  `onFailure`, and the review goes on without it; only when none answered does this throw (spec
 *  0.2.0 §8.3 point 2, as `runFocusedReviews` does in one process).
 *
 *  A stop that lands while the review waits cannot reach a child from here: the wait cannot be
 *  interrupted, and the review is checkpointed during it. Each child keeps its own deadline instead,
 *  and the review sees the stop when it resumes, with every focus already answered. */
export const focusesAsChildTasks = (a: {
  installationId: number
  batch: FocusBatchPort
  log?: (message: string, fields: Record<string, unknown>) => void
}): FocusRunner => async ({ pr, ask, signal, onFailure }) => {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error('the review was stopped before its focuses started')
  }
  const repo = `${pr.owner}/${pr.repo}`
  // The request projected field by field, under the receiver's own payload budget: the one place a
  // caller's mistake would turn into a megabyte on the wire or a credential in a run's payload.
  const { request } = projectPayload({
    request: { ...ask, repo, pr: pr.number, headSha: pr.headSha }, installationId: a.installationId,
  })
  const items: FocusBatchItem[] = REVIEW_LENSES.map((lens) => ({
    payload: { installationId: a.installationId, request, baseSha: pr.baseSha, lens },
    options: {
      idempotencyKey: focusIdempotencyKey(lens, pr.headSha),
      tags: focusTagsFor({ repo, pr: pr.number, headSha: pr.headSha, lens }),
    },
  }))
  const batch = await a.batch(items)

  const runs: FocusRun[] = []
  const withheld: SecretHit[] = []
  const failed: Error[] = []
  REVIEW_LENSES.forEach((lens, i) => {
    const child = batch.runs[i]
    if (child?.ok === true && isOutputFor(child.output, lens, pr.headSha)) {
      runs.push({ lens, result: child.output.result })
      // Where each one is, prefixed by its focus: three answers share the same field names.
      withheld.push(...child.output.withheld.map((h) => ({ pattern: h.pattern, where: `${lens}:${h.where}` })))
      return
    }
    const error = child === undefined
      ? new Error(`no answer came back for the ${lens} reviewer's task`)
      : child.ok
        ? new Error(`the ${lens} reviewer's task answered about another focus or commit`)
        : childError(child.error)
    failed.push(error)
    try { onFailure?.(lens, error) } catch { /* a progress line must not undo a review */ }
    runs.push({
      lens,
      result: {
        output: null, usage: nothingSpent(), cutShort: false, wrapUpFired: false,
        failure: { kind: 'crashed', code: null, stderr: error.message },
      },
    })
  })
  try {
    a.log?.('focused reviewers answered', {
      repo, pr: pr.number, batchId: batch.id, runs: batch.runs.map((r) => ({ id: r.id, ok: r.ok })),
    })
  } catch { /* a log line must not undo a review */ }
  if (failed.length === REVIEW_LENSES.length) throw failed[0]
  return { runs, withheld }
}

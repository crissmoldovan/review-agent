import {
  defaultRunReviewDeps, prepareReview, removeCheckout, reporterFor, runReviewSession, saidSafely,
  tokenIdentityOf, type Reporter, type SessionFailed,
} from '@review-agent/github'
import { normalise, type Normalised, type ReviewOptions } from './options'
import { progressFor, watchedDeps, watchedPublish, watchedReporter, type Progress } from './progress'
import { resultOf, type FailedResult, type ReviewResult } from './result'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A failure before anything was spent, from a step this package takes itself — reading who the
 *  token is, asking `authorize`. Never retried into paying twice: nothing was paid. */
const failedBeforeModel = (reason: string, cause: unknown): FailedResult => ({
  kind: 'failed', stage: 'before-model', reason, spentUsd: 0, retryable: true, stopped: null,
  record: null, findings: null, report: null, cause,
})

/** The same words the session uses for a review cancelled before it started, so a host sees one
 *  sentence for one thing whichever side of `runReviewSession` the signal landed on. */
const cancelled = (): FailedResult => ({
  kind: 'failed', stage: 'before-model', reason: 'the review was cancelled before it started', spentUsd: 0,
  retryable: false, stopped: 'cancelled', record: null, findings: null, report: null, cause: undefined,
})

const fromPrepare = (f: SessionFailed): FailedResult => ({
  kind: 'failed', stage: f.stage, reason: f.reason, spentUsd: f.spentUsd, retryable: f.retryable,
  stopped: f.stopped, record: null, findings: null, report: null, cause: f.cause,
})

/** Reviews one pull request, and returns what happened (spec 0.2.0 §4): the same review the GitHub
 *  App and the CLI run — `prepareReview` then `runReviewSession`, in `@review-agent/github` — called
 *  from a host's own code.
 *
 *  It RETURNS every outcome — `reviewed`, `unfinished`, `refused`, `failed` — so a host can tell "the
 *  reviewer found nothing" from "the reviewer did not run" (§4.3). It THROWS only what is the
 *  programmer's to fix, before anything is fetched or spent: a missing or wrong-typed option
 *  (`TypeError`), or a process no review can run in — no model credential, two, or
 *  `ANTHROPIC_BASE_URL` set (`Error`). One more `TypeError` can come later, still before anything is
 *  spent: an `authorize` that answers something other than `true` or `false`.
 *
 *  Nothing is shared between calls but the skill cache (§4.4): each builds its own client, credential
 *  and checkout, and this module keeps no state. Every checkout it made is removed before it returns,
 *  whichever way the review ended. */
export async function reviewPullRequest(options: ReviewOptions): Promise<ReviewResult> {
  // Read once, here: the credential rules apply to the environment as it is when the call is made.
  const o = normalise(options, process.env)
  const progress = progressFor({ repo: `${o.owner}/${o.repo}`, pr: o.pr, onProgress: o.onProgress })
  const result = await review(o, progress)
  progress.stage({ stage: 'done', result: result.kind })
  return result
}

const review = async (o: Normalised, progress: Progress): Promise<ReviewResult> => {
  const aborted = (): boolean => o.signal?.aborted === true
  // Checkouts are tracked here and removed here, rather than by the session: a review that was not
  // posted has its findings chosen by reading the checkout (`wouldSay`), after the session returns.
  const made: string[] = []
  try {
    // Before the first request: a host that cancelled has nothing to wait for.
    if (aborted()) return cancelled()
    progress.stage({ stage: 'preparing' })
    const prepared = await prepareReview({
      octokit: o.octokit, owner: o.owner, repo: o.repo, number: o.pr, deployment: o.deployment, ask: o.ask,
    })
    if (prepared.kind === 'failed') return fromPrepare(prepared)
    if (aborted()) return cancelled()

    // The gate, after the pull request is read — so it can be asked about the commit that would be
    // reviewed — and before the archive, the model, or any write (spec 0.2.0 §4.2). As the App asks
    // `pushAccessOf` before a requested review.
    if (o.authorize !== null && o.requestedBy !== null) {
      let allowed: unknown
      try {
        allowed = await o.authorize({
          octokit: o.octokit, owner: o.owner, repo: o.repo, pr: o.pr, username: o.requestedBy,
          headSha: prepared.pr.headSha,
        })
      } catch (e) {
        // Not an answer about the person: `pushAccessOf` throws for a GitHub that did not answer. A
        // failure that cost nothing, and that a second attempt can fix.
        return failedBeforeModel(`the review could not be authorized: ${saidSafely(messageOf(e))}`, e)
      }
      // Only `true` lets a review spend. Anything else that is not `false` is a gate that forgot to
      // answer, which is the programmer's to fix — and a gate that failed open would be no gate.
      if (typeof allowed !== 'boolean') {
        throw new TypeError(`authorize must answer true or false, and answered ${typeof allowed}`)
      }
      if (!allowed) {
        return { kind: 'refused', reason: `authorize did not allow @${o.requestedBy}'s request; nothing was downloaded or spent` }
      }
      if (aborted()) return cancelled()
    }

    // Who this token is, when posting, and only then: it decides the report (`'auto'`, spec 0.2.0
    // §2.2) and which summary comment is this poster's own (decision §14.7). One read; a printed
    // review makes no call it does not need.
    let reporter: Reporter | undefined
    let selfLogin: string | undefined
    if (o.post) {
      try {
        const identity = await tokenIdentityOf(o.octokit)
        reporter = watchedReporter(await reporterFor({ octokit: o.octokit, want: o.report, identity }), progress)
        if (identity.kind === 'user') selfLogin = identity.login
      } catch (e) {
        return failedBeforeModel(`GitHub would not say whose token this is: ${saidSafely(messageOf(e))}`, e)
      }
    }

    const runReviewDeps = watchedDeps(defaultRunReviewDeps({
      note: progress.note,
      ...(o.workDir !== null && { workDir: o.workDir }),
      ...(o.skillCacheDir !== null && { skillCacheDir: o.skillCacheDir }),
      ...(o.focusConcurrency !== null && { concurrency: o.focusConcurrency }),
    }), progress, made)

    const session = await runReviewSession({
      prepared,
      post: o.post,
      ...(reporter !== undefined && { reporter }),
      via: { kind: 'sdk' },
      ...(selfLogin !== undefined && { selfLogin }),
      // The credential travels with this review and no other (spec 0.2.0 §3.2): the Claude process
      // gets it and nothing ambient. Never written to `process.env`, where a concurrent review would
      // read it.
      runtime: { credential: o.credential, ...(o.bin !== null && { bin: o.bin }) },
      ...(o.signal !== null && { signal: o.signal }),
      deadlineMs: o.deadlineMs,
      // Removed below, with every other checkout this review made.
      keepCheckout: true,
      deps: { runReviewDeps, publishReview: watchedPublish(progress), log: progress.log },
    })
    return resultOf(session)
  } finally {
    // Every checkout, on every path — finished, failed, cancelled, thrown (spec 0.2.0 §4.4). One the
    // session already removed is removed again harmlessly: `removeCheckout` never throws.
    for (const dir of made) await removeCheckout(dir)
  }
}

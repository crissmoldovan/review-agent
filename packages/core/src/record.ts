import type { BudgetPolicy } from './budget'
import type { CheckVerdict } from './check-pass'
import type { DeploymentConfig, Effort, ResolvedSettings, ReviewRequest, Tier } from './config'
import type { EngineFailure, EngineResult, Usage } from './engine'
import type { ReviewOutput } from './findings'
import { focusRecords, type FocusRecord, type FocusRun } from './multi'
import { REVIEW_INSTRUCTIONS_DIGEST, REVIEW_INSTRUCTIONS_VERSION } from './prompt'
import type { RecheckJudgement, RecheckPassResult, RecheckSkipped } from './recheck-pass'
import type { MaterialisedSkill } from './skills'

export const RECORD_VERSION = 1 as const

/** The version of this engine, on every record it writes. Kept in step with
 *  `packages/core/package.json` by `record.test.ts` — a record whose engine version is a guess is
 *  worth less than no record at all (design §4.7). */
export const ENGINE_VERSION = '0.2.4'

export type RecordedSkill = { id: string; path: string }

/** An archive entry that is not in the checkout as the archive had it (spec 0.2.0 §9.3 P10): a name the
 *  filesystem refused (`CON`, `*`, a trailing dot on Windows), a symlink Windows would not make, an
 *  entry type nothing extracts. `code` is the filesystem's error code (`EINVAL`, `EPERM`, …) or
 *  node-tar's (`TAR_ENTRY_UNSUPPORTED`, …), or `UNSAFE_PATH` for an absolute or `..` path, which is
 *  never written anywhere. */
export type UnwrittenEntry = { path: string; code: string }

export type ReviewRecord = {
  recordVersion: 1
  engineVersion: string
  instructions: { version: string; digest: string }
  request: {
    repo: string; pr: number; headSha: string
    requestedBy: string | null; requestId: string | null
    droppedRequestKeys: string[]
  }
  settings: {
    tier: Tier; model: string; effort: Effort; check: boolean; multi: boolean
    /** The tier's budget, which a multi-reviewer review gives EACH focus (spec 0.2.0 §8.3): its
     *  reviewers may spend up to `focuses.length` times `ceilingUsd` between them. */
    budget: BudgetPolicy
    report: DeploymentConfig['report']
    severity: DeploymentConfig['severity']
  }
  skills: RecordedSkill[]
  /** The reviewer's bill — on a multi-reviewer review, the sum of every focus's, which `focuses` has
   *  one by one. Its `durationMs` is then process time added up, not the wall clock (`timings`). */
  usage: Usage
  /** One entry per focused reviewer, in `REVIEW_LENSES` order: its bill, whether it answered, whether a
   *  limit stopped it, its failure, and how many findings it reported (spec 0.2.0 §8.3 point 6). Empty
   *  on a review by one reviewer. Added in 0.2.0 without moving `recordVersion`: nothing that was
   *  already here changed meaning. */
  focuses: FocusRecord[]
  checkUsage: Usage | null
  /** The re-review pass's own bill (Criss, 2026-09-16). `null` on a first review, which buys no such
   *  pass at all, and on any caller that reads no marker. NOT null when the pass failed: a failure
   *  reports whatever it was billed, which is zero when it never spawned. */
  recheckUsage: Usage | null
  /** Every figure in this record is model spend at per-token API prices, as the Claude Code CLI
   *  reported it: `usage` + `checkUsage` + `recheckUsage`, every focus included through `usage`. It is not a subscription allowance and
   *  not a price charged to anyone — a deployment running on a subscription token still gets an
   *  API-priced figure here, which is why the public summary says so next to it. */
  costUsd: number
  wrapUpFired: boolean
  cutShort: boolean
  failure: EngineFailure | null
  output: ReviewOutput | null
  checkVerdicts: CheckVerdict[] | null
  /** What the re-review pass said about each finding earlier reviews reported. Empty when the pass
   *  failed, was refused its budget, or answered unusably — which is the same thing to every reader:
   *  no answer, so nothing is repaired. `recheckSkipped` says which. */
  recheckJudgements: RecheckJudgement[] | null
  /** `null` when the pass ran and answered; otherwise why it did not. Recorded rather than logged
   *  because "no outcome changed" and "the pass never ran" look identical from outside. */
  recheckSkipped: RecheckSkipped | null
  /** What the model could not read in the checkout, and why (github/archive.ts). Always present, every
   *  list empty when nothing is missing: a review whose inputs had files taken out of them must say
   *  which.
   *
   *  - `removedCredentialFiles`: deleted on purpose before the model started.
   *  - `notWritten`: entries the extraction did not write (spec 0.2.0 §9.3 P10). Until 0.2.0 these
   *    were missing in silence.
   *  - `caseCollisions`: groups of paths that differ only by letter case or Unicode normalisation. On
   *    a filesystem that ignores the difference (case on macOS and Windows by default, Unicode form on
   *    macOS) each group was ONE file in the checkout, holding whichever was extracted last. Reported
   *    on every OS, because a record is read somewhere other than where it was written. */
  checkout: { removedCredentialFiles: string[]; notWritten: UnwrittenEntry[]; caseCollisions: string[][] }
  timings: { startedAt: string; finishedAt: string; durationMs: number }
}

export const buildReviewRecord = (a: {
  request: ReviewRequest
  settings: ResolvedSettings
  result: EngineResult
  skills: MaterialisedSkill[]
  check: { verdicts: CheckVerdict[]; usage: Usage } | null
  recheck: RecheckPassResult | null
  /** The focused reviewers of a multi-reviewer review, whose combined result is `result`. Absent, or
   *  empty, for a review by one reviewer. */
  focuses?: FocusRun[]
  removedFromCheckout: string[]
  /** Optional, so a caller that downloads no archive of its own need not invent one; absent is "none". */
  notWrittenToCheckout?: UnwrittenEntry[]
  caseCollisions?: string[][]
  startedAt: Date
  finishedAt: Date
}): ReviewRecord => {
  const { request, settings, result, startedAt, finishedAt } = a
  return {
    recordVersion: RECORD_VERSION,
    engineVersion: ENGINE_VERSION,
    instructions: { version: REVIEW_INSTRUCTIONS_VERSION, digest: REVIEW_INSTRUCTIONS_DIGEST },
    request: {
      repo: request.repo, pr: request.pr, headSha: request.headSha,
      requestedBy: request.requestedBy ?? null,
      requestId: request.requestId ?? null,
      droppedRequestKeys: [...settings.droppedRequestKeys],
    },
    settings: {
      tier: settings.tier, model: settings.model, effort: settings.effort,
      check: settings.check, multi: settings.multi,
      budget: { ...settings.budget },
      report: { ...settings.report },
      severity: { bands: { ...settings.severity.bands },
                  postInlineAtOrAbove: settings.severity.postInlineAtOrAbove },
    },
    skills: a.skills.map((s) => ({ id: s.id, path: s.path })),
    usage: { ...result.usage },
    focuses: focusRecords(a.focuses ?? []),
    checkUsage: a.check === null ? null : { ...a.check.usage },
    recheckUsage: a.recheck === null ? null : { ...a.recheck.usage },
    costUsd: result.usage.costUsd + (a.check?.usage.costUsd ?? 0) + (a.recheck?.usage.costUsd ?? 0),
    wrapUpFired: result.wrapUpFired,
    cutShort: result.cutShort,
    failure: result.failure,
    output: result.output,
    checkVerdicts: a.check === null ? null : a.check.verdicts,
    recheckJudgements: a.recheck === null ? null : a.recheck.judgements,
    recheckSkipped: a.recheck?.skipped ?? null,
    checkout: {
      removedCredentialFiles: [...a.removedFromCheckout],
      notWritten: (a.notWrittenToCheckout ?? []).map((e) => ({ path: e.path, code: e.code })),
      caseCollisions: (a.caseCollisions ?? []).map((g) => [...g]),
    },
    timings: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
  }
}

import {
  writesSummaryComment, type Finding, type ReportMode, type ReviewRecord,
} from '@review-agent/core'
import {
  anchorFindings, duplicatesIn, postedCommentsOf, selectForPosting,
  type CheckConclusion, type PostedComment, type PublishCounts, type PublishedReview, type ReportKind,
  type RunReviewResult, type SessionReport, type SessionResult, type SessionStage, type StoppedBy,
} from '@review-agent/github'

/** How the outcome was reported on the reviewed commit (spec 0.2.0 §2.2, §4.3). */
export type ReportResult = {
  /** What actually reported: `report: 'auto'` can start as a check run and fall back to a status. */
  kind: ReportKind
  /** What a check run concluded — for a commit status too, whose own state says it differently: a
   *  review that did not run is `neutral`, which a status says as `success` with a description saying
   *  it is not a verdict (decision §14.2). `null` when the report was opened and could not be
   *  completed: it may still say pending on the commit. */
  conclusion: CheckConclusion | null
  /** The check run's page; for a commit status, the summary comment it links to. */
  url: string | null
  /** The check run's id; null for a commit status. */
  id: number | null
}

/** What was posted on the pull request (spec 0.2.0 §4.3). */
export type PostedSummary = {
  /** The mode it was published in, after the repository's own file and `check-only`-without-a-check-run
   *  (decision §14.3) had their say. */
  mode: ReportMode
  /** The summary comment's page, as GitHub gave it; null when none was written (`check-only`,
   *  `silent`) or GitHub's answer carried none. */
  summaryUrl: string | null
  summaryCommentId: number | null
  /** The review that carries the inline comments; null when none was posted. */
  reviewId: number | null
  /** The inline comment each posted finding became — what a reply hangs off. */
  comments: PostedComment[]
  /** How many findings went where, and what the re-review did to earlier comments. */
  counts: PublishCounts
}

/** The review ran and said something — possibly that it found nothing. */
export type ReviewedResult = {
  kind: 'reviewed'
  /** Everything about the review: request, settings, the model's whole output, every check verdict,
   *  usage and `costUsd` (model spend at per-token API prices, as the Claude Code CLI reports it — on
   *  a subscription token the same figure is drawn from its allowance instead of billed). */
  record: ReviewRecord
  /** What the review SAYS: after the disprove-it pass — a refuted finding is not here, the rest are at
   *  the check's severity — with duplicates said once and paths checked against the code. Posted, it
   *  is what was posted; not posted, what would have been, said as a first review is (no earlier
   *  review is read). An empty list is a review that found nothing, which is a success. The model's
   *  unfiltered list is `record.output.findings`. */
  findings: Finding[]
  /** What was posted; null when not posting. */
  posted: PostedSummary | null
  /** How it was reported on the commit; null when not posting, with `report: 'none'`, or in `silent`. */
  report: ReportResult | null
}

/** The model ran and produced nothing usable, or was stopped before it could (spec 0.2.0 §4.3). */
export type UnfinishedResult = {
  kind: 'unfinished'
  record: ReviewRecord
  /** One sentence, already scanned for secrets: safe to show anyone who can see the pull request. */
  reason: string
  /** `record.costUsd`: what was spent for nothing usable. */
  spentUsd: number
  /** Whether running it again could not pay for the model twice: nothing was spent, and it was not
   *  stopped on purpose. A retry policy reads this. */
  retryable: boolean
  /** Who stopped it: its deadline, or the `signal`. Null when it stopped on its own. */
  stopped: StoppedBy | null
  /** The "This review did not complete" summary, when posting; null otherwise, and for a stopped
   *  review, which says so on its report alone. */
  posted: PostedSummary | null
  report: ReportResult | null
}

/** `authorize` said no. Nothing was downloaded, nothing was written, nothing was spent. */
export type RefusedResult = {
  kind: 'refused'
  reason: string
}

/** The review did not produce one, and `stage` says how far it got (spec 0.2.0 §4.3):
 *  - `before-model`: nothing was spent — GitHub would not answer, the report could not be opened
 *    (`report: 'check-run'` with a token that cannot create one), `authorize` threw, the archive would
 *    not download, or it was cancelled before the model started;
 *  - `model`: the model ran, and the review failed or was stopped after that;
 *  - `withheld`: the output matched a secret pattern, so nothing of it is said anywhere;
 *  - `publish`: the review ran and was paid for, and GitHub would not take it. `record` and `findings`
 *    carry it, so it is not lost. */
export type FailedResult = {
  kind: 'failed'
  stage: SessionStage
  /** One sentence, already scanned for secrets: safe to show anyone who can see the pull request. */
  reason: string
  /** Model spend known to be gone, at per-token API prices: the record's figure where there is one,
   *  what was watched going out where there is not — a lower bound when a pass was cut off. */
  spentUsd: number
  retryable: boolean
  stopped: StoppedBy | null
  /** The finished review that could not be posted (`stage: 'publish'`); null otherwise. */
  record: ReviewRecord | null
  /** What that review would have said, as `ReviewedResult.findings`; null with no `record`. */
  findings: Finding[] | null
  report: ReportResult | null
  /** The error as it was thrown, for the host's own logs. Never scanned and never shown to anyone by
   *  this package: `reason` is the sentence that is safe to repeat. */
  cause: unknown
}

export type ReviewResult = ReviewedResult | UnfinishedResult | RefusedResult | FailedResult

/** What a finished review says, chosen exactly as `publishReview` chooses it — duplicates out by
 *  position, every path checked against the checkout (`anchorFindings`), a refuted finding dropped and
 *  the rest at the check's severity, the low-band cap (`selectForPosting`) — for a review that was not
 *  posted. Read before the checkout is removed: the path check reads it.
 *
 *  As a first review: nothing read an earlier one, and the cap on low-severity findings is the first
 *  review's. A review the engine did not finish says what it had in the summary, so it is selected in
 *  `summary-only`, as `publishReview` does; `silent` and `check-only` say what they WOULD have said.
 *  `review.test.ts` holds this to `publishReview`'s own answer on the same review, so the two cannot
 *  drift apart unnoticed. */
export const wouldSay = (review: RunReviewResult): Finding[] => {
  const output = review.result.output
  if (output === null) return []
  const { findings } = output
  const completed = review.result.failure === null
  const mode = review.settings.report.mode
  const sayingMode: ReportMode = !completed ? 'summary-only' : writesSummaryComment(mode) ? mode : 'inline+summary'
  const checked = review.check === null ? null : { findings, verdicts: review.check.verdicts }
  const duplicates = duplicatesIn(checked)
  const anchored = anchorFindings({
    findings: findings.filter((_, i) => !duplicates.has(i)), pr: review.pr, checkoutDir: review.checkoutDir,
  })
  const plan = selectForPosting({
    anchored,
    settings: { ...review.settings, report: { ...review.settings.report, mode: sayingMode } },
    previous: null,
    check: checked,
  })
  return [...plan.inline.map((x) => x.finding), ...plan.summaryOnly]
}

const reportOf = (r: SessionReport | null): ReportResult | null =>
  r === null ? null : { kind: r.kind, conclusion: r.conclusion, url: r.url, id: r.id }

const postedOf = (p: PublishedReview): PostedSummary => ({
  mode: p.mode,
  summaryUrl: p.summaryUrl,
  summaryCommentId: p.summaryCommentId,
  reviewId: p.reviewId,
  comments: postedCommentsOf(p),
  counts: { ...p.counts },
})

/** The session's outcome, as the SDK returns it (spec 0.2.0 §4.3). Every field is carried over from
 *  `SessionResult` or derived from it; nothing is decided here that the session did not decide. The
 *  session's `review` (its checkout path, its working state) and `verdict` stay inside: the record
 *  is the review, and the findings are what it said.
 *
 *  Called while the checkout still exists, because a review that was not posted has its findings
 *  chosen by reading it (`wouldSay`). */
export const resultOf = (s: SessionResult): ReviewResult => {
  switch (s.kind) {
    case 'reviewed':
      return {
        kind: 'reviewed',
        record: s.record,
        findings: s.published === null ? wouldSay(s.review) : s.published.findings,
        posted: s.published === null ? null : postedOf(s.published),
        report: reportOf(s.report),
      }
    case 'unfinished':
      return {
        kind: 'unfinished',
        record: s.record,
        reason: s.reason,
        spentUsd: s.spentUsd,
        retryable: s.retryable,
        stopped: s.stopped,
        posted: s.published === null ? null : postedOf(s.published),
        report: reportOf(s.report),
      }
    case 'failed':
      return {
        kind: 'failed',
        stage: s.stage,
        reason: s.reason,
        spentUsd: s.spentUsd,
        retryable: s.retryable,
        stopped: s.stopped,
        record: s.review?.record ?? null,
        findings: s.review === null ? null : wouldSay(s.review),
        report: reportOf(s.report),
        cause: s.cause,
      }
  }
}

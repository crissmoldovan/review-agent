import type { Octokit } from '@octokit/core'
import {
  writesSummaryComment,
  type CheckVerdict, type EngineFailure, type Finding, type PreviousFinding,
  type RecheckJudgement, type ReportMode, type ReviewOutput,
} from '@review-agent/core'
import { anchorFindings } from './anchor'
import { inlineBody, reinstatementNote, retractionNote, reviewBody, summaryBody } from './body'
import {
  commentIdsIn, findingId, markerRunFor, nextMarkerState, recheckQuestions, reinstatableComments,
  retractableComments, type MarkerState, type PostedFindings,
} from './marker'
import {
  commentKey, findSummaryComment, postReview, reinstateInlineComment, retractInlineComment,
  upsertSummaryComment, type FoundSummary, type InlineComment, type SummaryCommentResult,
} from './post'
import { selectForPosting } from './report'
import type { RunReviewResult } from './run-review'
import { fetchThreadReplies } from './threads'

export type PublishCounts = {
  /** Inline comments GitHub placed. 0 when no review was posted. */
  inline: number
  /** Findings said in the summary comment. 0 when no summary comment was written. */
  summaryOnly: number
  /** Inline comments GitHub refused (Task 4), which were said in the summary instead. */
  droppedInline: number
  /** Refuted by the check pass, or past the low-band cap: recorded, said nowhere. */
  suppressed: number
  /** Findings whose path is not a file in the checkout (design §4.3): said nowhere. */
  notInCheckout: number
  /** Inline comments edited to say the reviewer no longer finds the issue. 0 when nothing was judged
   *  resolved, when the rows that were had no comment, and when GitHub refused. */
  retracted: number
  /** Inline comments edited to take such a note BACK: a row this product had recorded `fixed` that
   *  the re-review pass now says is still there, or that a person has disputed. 0 on almost every
   *  review, and above 0 exactly when an earlier review was wrong in public. */
  reinstated: number
  /** A note this review meant to write, in either direction, and did not: GitHub refused the read or
   *  the edit, the comment is not on this pull request or is somebody's reply, this very review is
   *  reporting that finding again, or this very review has a comment on the line GitHub holds it at.
   *  NOT a comment that already says what the note would have said — that one needs nothing. A number
   *  that stays above zero is worth a look: the commonest cause is the re-review pass answering
   *  "resolved" for a finding this very review is reporting again, which is the two passes
   *  contradicting each other about one commit. */
  retractionsWithheld: number
}

export type PublishedReview = {
  mode: ReportMode
  headSha: string
  completed: boolean
  reviewId: number | null
  summaryCommentId: number | null
  /** What this review says. In `silent` and `check-only` it is what it WOULD have said. */
  said: PostedFindings
  /** `said`, flattened: at the check's severity, never a refuted finding. Task 6's gate reads this. */
  findings: Finding[]
  /** The part of `findings` the check pass CONFIRMED, or null when no pass ran. Task 6's gate reads
   *  this instead of `findings` when a deployment set `gateRequiresConfirmed` (Criss, decision 6). */
  confirmed: Finding[] | null
  counts: PublishCounts
  marker: MarkerState
  bodies: { review: string | null; inline: InlineComment[]; summary: string }
}

/** The intent line of a review that produced no output. It says the review stopped. It does not
 *  claim to know the answer. */
const NO_INTENT: ReviewOutput['intent'] = {
  verdict: 'unclear',
  note: 'The review stopped before it could judge whether the change does what it says.',
}

/** Why a review stopped, in this product's own words. The CLI's `stderr` and `message` are never
 *  quoted: runReview's secret scan covers the review output and the check verdicts, not those, and
 *  a summary comment is read by everyone who can see the pull request. */
const whyItStopped = (f: EngineFailure | null): string => {
  if (f === null) return 'the reviewer returned no answer'
  switch (f.kind) {
    case 'budget':
      // Labelled, because an unlabelled number in a public pull request reads as a bill.
      return `it reached its budget ceiling after $${f.spentUsd.toFixed(2)} of model spend at per-token API prices`
    case 'schema': return 'its answer did not match the findings schema'
    case 'refusal': return 'the model declined to review this change'
    case 'crashed': return 'the Claude CLI exited before it finished'
    case 'cli-error': return 'the Claude CLI reported an error before the model answered'
  }
}

/** The prose of a summary whose review did not complete. Partial findings are kept (Global
 *  Constraints) and listed in the summary, never placed on a line: a partial review spread across
 *  the diff would read as a complete one. */
const unfinishedSummary = (r: RunReviewResult): string => {
  const stopped = `**This review did not complete:** ${whyItStopped(r.result.failure)}. Nothing was placed on a line.`
  return r.result.output === null
    ? stopped
    : `${stopped} What it had found by then is listed below.\n\n${r.result.output.summary}`
}

/** Are these two asks the same list? A judgement's `index` is a position in the question list the
 *  re-review pass was GIVEN, and the list this function maps it back through is re-derived from the
 *  marker. They come from the same marker on every production path — the caller reads it once and
 *  passes it through as `existing` — but "on every production path" is not a guarantee, and the
 *  failure it guards is the worst one this feature has: a `fixed` written onto a finding nobody
 *  asked about. Eight rows on the live marker, so comparing them costs nothing. A mismatch drops
 *  every judgement, which is the same as a pass that failed: everything stays `open`. */
const sameAsk = (derived: PreviousFinding[], asked: PreviousFinding[]): boolean =>
  derived.length === asked.length &&
  derived.every((q, i) => {
    const b = asked[i]
    // Field by field, not `JSON.stringify`: two objects carrying the same question with their keys
    // in a different order are the same question, and a comparison that said otherwise would drop
    // every judgement of a perfectly good run.
    return b !== undefined && q.file === b.file && q.line === b.line &&
      q.severity === b.severity && q.title === b.title && (q.category ?? null) === (b.category ?? null)
  })

/** A finished review, onto the pull request it reviewed (Task 7b). It composes Tasks 3 to 7 and
 *  sub-project 1's anchoring and posting rules in the one order that works. The order is written
 *  out at the head of Task 7b, and each step below says why it is where it is.
 *
 *  It runs no model and cannot: it takes a finished result — the re-review pass included, which ran
 *  inside `runReview` where the money could be recorded. It scans nothing for secrets either:
 *  `runReview` already scanned the output and the check verdicts, and throws `SecretLeak` rather
 *  than return a result carrying one (Task 1, Step 16); the re-review pass drops its own words if
 *  they carry one, because it may not cost the review its posting. */
export async function publishReview(a: {
  octokit: Octokit; owner: string; repo: string; number: number
  review: RunReviewResult
  /** The App's own login, when the deployment knows it: the tie-break of `findSummaryComment`. */
  selfLogin?: string
  /** What the comment doorway refused before the resolver saw it, already phrased (Task 10, Criss
   *  decision 4). Rendered in the summary after the resolver's own `droppedRequestKeys`.  */
  refused?: string[]
  /** The summary comment the caller already found, and the marker it carries: `null` when it looked
   *  and there is none, left out when it did not look.
   *
   *  It exists because the re-review pass has to be asked BEFORE the review is published — it runs
   *  in `runReview`, so its cost lands in the record — and the question comes out of this marker. A
   *  caller that read the marker to build the ask passes the same marker here, so the rows a
   *  judgement addresses are the rows it was computed about. `sameAsk` above checks that rather than
   *  assuming it. */
  existing?: FoundSummary | null
}): Promise<PublishedReview> {
  const { octokit, owner, repo, number, review } = a
  const { pr, settings, record } = review
  // A review posted onto a pull request it was not about is the one mistake here that no reader
  // can undo, so the address a caller names must be the one the result was fetched from. Checked
  // before any request, so a mismatch writes nothing.
  if (owner !== pr.owner || repo !== pr.repo || number !== pr.number) {
    throw new Error(
      `refusing to publish a review of ${pr.owner}/${pr.repo}#${pr.number} onto ${owner}/${repo}#${number}`,
    )
  }
  // The sha the engine read. It is never taken from a caller: a webhook's sha can be minutes stale,
  // and a /review comment carries Task 10's HEAD_SHA_UNRESOLVED.
  const headSha = pr.headSha
  const output = review.result.output
  const completed = review.result.failure === null && output !== null
  const findings = output?.findings ?? []
  // The mode gates the WRITES, never the reads (Task 7b). It is the RESOLVED mode: a repository
  // can lower it from its base branch (resolveSettings). In `silent` and `check-only`,
  // selectForPosting would suppress everything. That is right for comments and wrong for what
  // comes back: `silent` hands back what it would have said, and a `check-only` check run is the
  // one place its findings are judged. So those two modes select as if every comment were allowed,
  // and only the writes below are withheld. Whether a check run exists is Task 13's call
  // (Task 6's checkRunWanted), not this function's.
  const mode = settings.report.mode
  const writesSummary = writesSummaryComment(mode)
  // A review that did not complete places nothing on a line: what it has is partial, and the
  // summary is the one place that says so next to it.
  const writesInline = mode === 'inline+summary' && completed
  const sayingMode: ReportMode = !completed ? 'summary-only' : writesSummary ? mode : 'inline+summary'

  // 1. The previous review's state, from the one comment that will be overwritten (design §5).
  //    Taken from the caller when the caller already read it — which is how the re-review pass got
  //    its question — and read here otherwise. `null` means "looked, and there is none"; absent
  //    means "did not look", so the two are told apart by `!== undefined` rather than by `??`.
  const found = a.existing !== undefined ? a.existing : await findSummaryComment({
    octokit, owner, repo, number, ...(a.selfLogin !== undefined && { selfLogin: a.selfLogin }),
  })
  const previous = found?.marker ?? null

  // 2. The replies people left under the previous runs' comments (Task 7). Read before anything is
  //    written: the listing then holds no comment of this review's, and a failed read leaves nothing
  //    half-posted. With no previous comments, fetchThreadReplies spends no request.
  // Replies only settle a previous run, and a review that did not complete settles nothing (step 7).
  const replies = !completed ? [] : await fetchThreadReplies(
    { octokit, owner, repo, number, parentIds: commentIdsIn(previous) })

  // 2b. What the re-review pass answered about the findings earlier reviews reported (Criss,
  //     2026-09-16). It has already run — inside `runReview`, where its cost could be recorded — so
  //     nothing here spends money or reaches a model. This is only the join back: a judgement's
  //     `index` is a position in `recheckQuestions(previous).questions`, and that list is derived
  //     here from the same marker the ask was built from.
  //
  //     Every way this can be short of an answer lands on the same empty list, which `diffRuns`
  //     reads as "nothing is repaired": the pass threw, timed out, was refused its budget, answered
  //     unusably, dropped its own words over a secret, was never run because this is a first review,
  //     or answered about a different list than this one. Design point 4, in one expression.
  const judgements: RecheckJudgement[] =
    completed && review.recheck !== null &&
    sameAsk(recheckQuestions(previous).questions, review.recheck.asked)
      ? review.recheck.judgements
      : []

  // 3. Every model-written path checked against the checkout before it is used (design §4.3).
  const anchored = anchorFindings({ findings, pr, checkoutDir: review.checkoutDir })

  // 4. What is said, and where (design §3.1, §5). The verdicts go in with the SAME array
  //    runCheckPass was given, because CheckVerdict.index addresses it. Design §4.6: a refuted
  //    finding is never said, and a confirmed or uncertain one is said at the check's severity.
  //    A MarkerRun is a PreviousReview structurally; the last run is "the last review".
  const checked = review.check === null ? null : { findings, verdicts: review.check.verdicts }
  const plan = selectForPosting({
    anchored,
    settings: { ...settings, report: { ...settings.report, mode: sayingMode } },
    previous: previous?.runs.at(-1) ?? null,
    check: checked,
  })

  // 5. The words (Task 3). `x.finding` already carries the check's severity (selectForPosting).
  const inline: InlineComment[] = plan.inline.map((x) => ({
    findingId: findingId(x.finding), path: x.finding.file, line: x.line, side: x.side,
    body: inlineBody(x.finding),
  }))
  // No inline comment, no review: an empty COMMENT review is noise on the pull request. The body
  // counts nothing, because Task 4 re-sends it with `comments: []` if GitHub refuses them.
  const reviewText = inline.length === 0 ? null : reviewBody({ headSha })

  // 6. One request carrying every comment (Task 4), and the comment ids read back.
  const posted = !writesInline || reviewText === null
    ? null
    : await postReview({ octokit, owner, repo, number, headSha, body: reviewText, comments: inline })
  // GitHub validates comments[] as a unit, and Task 4 re-posts the review WITHOUT them when it
  // refuses one: a push raced the review. Task 4 promises the summary names every finding, so the
  // refused ones join it here. markerRunFor then gives them commentId null, because no comment
  // exists for them. Task 13 logs counts.droppedInline.
  const refused = new Set((posted?.droppedInline ?? []).map((c) => c.findingId))
  const said: PostedFindings = {
    inline: plan.inline.filter((x) => !refused.has(findingId(x.finding))),
    summaryOnly: [
      ...plan.summaryOnly,
      ...plan.inline.filter((x) => refused.has(findingId(x.finding))).map((x) => x.finding),
    ],
  }

  // 7. The next state (Task 7), built AFTER the review exists, because it must carry this review's
  //    comment ids. `at` is the record's finish time, so the marker and the record agree.
  //    Only what was SAID is recorded (`markerRunFor`): a finding suppressed by the low-band cap or
  //    refuted by the check pass was shown to nobody, and a later review must not announce as gone
  //    something a reader was never told about. (The comment here used to describe a `findings`
  //    parameter of `nextMarkerState`, deleted with the matcher, and said the opposite.)
  //    The comment id is looked up by finding AND line: two findings can share a `findingId`.
  const run = markerRunFor({
    headSha, at: record.timings.finishedAt, posted: said,
    commentIdFor: (f, line) => posted?.commentIds.get(commentKey(findingId(f), line)) ?? null,
  })
  // A review that did not complete carries the last state over untouched, and asked the re-review
  // pass nothing: an outcome is a claim about this head, and a review whose engine stopped read only
  // part of it.
  //
  // What this NO LONGER passes is the list of findings this review found. `nextMarkerState` used to
  // take one so it could pair old rows against new ones and infer which had gone; nothing infers any
  // more, so nothing this run reported can move a previous row's outcome. That is the point.
  const marker: MarkerState = completed
    ? nextMarkerState({ previous, run, replies, judgements })
    : previous ?? { version: 1, runs: [] }

  // 8. The summary, rendered last with that marker, onto the comment found in step 1 (Task 5).
  //    Decision 4: what was asked for and not honoured. The resolver's drops are phrased here from
  //    the key it recorded; the comment doorway's refusals arrive phrased, because a flag the parser
  //    dropped never reached the resolver and so is not in droppedRequestKeys.
  const notHonoured = [
    ...settings.droppedRequestKeys.map(
      (key) => `\`${key}\` — this deployment does not let a request set it, so its own value was used.`,
    ),
    ...(a.refused ?? []),
  ]
  const summaryText = summaryBody({
    headSha, tier: settings.tier, model: settings.model, costUsd: record.costUsd,
    summary: review.result.failure === null && output !== null ? output.summary : unfinishedSummary(review),
    intent: output?.intent ?? NO_INTENT,
    summaryOnly: said.summaryOnly, inconclusive: output?.inconclusive ?? [], marker,
    refused: notHonoured,
    checkoutGaps: { notWritten: record.checkout.notWritten, caseCollisions: record.checkout.caseCollisions },
  })
  const summary: SummaryCommentResult | null = !writesSummary ? null : await upsertSummaryComment({
    octokit, owner, repo, number, body: summaryText, existing: found,
  })

  // 9. The inline comments of findings the re-review pass judged resolved (Criss, 2026-09-15; the
  //    judgement is a model's answer rather than an inference since 2026-09-16). Measured: a comment
  //    saying "setTimeout is always 0" was still on the pull request, re-anchored by GitHub onto the
  //    CURRENT head, on a line that now reads `setTimeout(resolve, delayMs)` — the product asserting
  //    a bug in code that contradicts it.
  //
  //    LAST, and after the summary, for two reasons. The marker is the record of the judgement, and
  //    a courtesy edit must not delay or endanger it; and `retractInlineComment` never throws, so a
  //    refusal is counted rather than raised. Gated on `writesSummary` because a run that writes no
  //    marker keeps no record of what it judged — editing somebody's thread on a judgement this
  //    product then forgets is worse than saying nothing.
  //
  //    EVERY previous run, not the last one: `nextMarkerState` now settles them all, so a comment
  //    from three reviews ago is reachable for the first time. `before` is the same runs as this
  //    product last wrote them, aligned from the END because `nextMarkerState` may have trimmed the
  //    oldest away at MAX_RUNS. It is what keeps a comment from being retracted twice, and what
  //    makes a person's `disputed` legible after `applyOutcomes` has overwritten it.
  const settledRuns = completed ? marker.runs.slice(0, -1) : []
  const beforeRuns = settledRuns.length === 0
    ? []
    : (previous?.runs ?? []).slice(-settledRuns.length)
  // Where this review has just put a comment. The path is the model's spelling, but only a spelling
  // GitHub accepted reaches here — `anchorFindings` places a comment inline only on a path that
  // matched the pull request's own file list — so it is the same string GitHub gives back.
  const postedAt = new Set(said.inline.map((x) => `${x.finding.file}:${x.line}`))
  // WHAT THIS REVIEW HAS JUST SAID, by finding rather than by position. The second half of "do not
  // contradict yourself", and the half that does the work (Criss, 2026-09-16, after the first attack
  // on this pass). `postedAt` compares GitHub's CURRENT anchor for the old comment against the line
  // this review's new comment went on, and three ordinary things defeat it: the old comment
  // re-anchored one line off, a finding said in the summary rather than inline, and a 422 — which
  // moves every finding into the summary and leaves `postedAt` empty, so every previous comment would
  // be retracted while the summary re-reports every one of them. This set has no such holes: it is
  // every finding this review said anywhere, and the pass's own prompt tells it to ignore the line
  // number, so the disagreements that trigger a retraction are precisely the ones where the line
  // moved. It is keyed on wording, which fails in the safe direction: a reworded title costs a
  // withheld retraction, never a false one.
  const saidIds = new Set([
    ...said.inline.map((x) => findingId(x.finding)),
    ...said.summaryOnly.map((f) => findingId(f)),
  ])
  let retracted = 0
  let reinstated = 0
  let retractionsWithheld = 0
  if (writesSummary && settledRuns.length > 0) {
    for (const { commentId, file, ids } of retractableComments({ settled: settledRuns, before: beforeRuns })) {
      if (ids.some((id) => saidIds.has(id))) { retractionsWithheld += 1; continue }
      const result = await retractInlineComment({
        octokit, owner, repo, number, commentId, postedAt,
        note: retractionNote({ file, headSha }),
      })
      if (result === 'edited') retracted += 1
      else if (result !== 'already-retracted') retractionsWithheld += 1
    }
    // And the other direction: a comment an earlier review retracted, about a defect this one has
    // just been told is still there. The marker has always been able to undo a wrong `fixed`; until
    // now the comment a person actually reads could not be undone at all.
    for (const { commentId, file } of reinstatableComments({ settled: settledRuns, before: beforeRuns })) {
      const result = await reinstateInlineComment({
        octokit, owner, repo, number, commentId, note: reinstatementNote({ file, headSha }),
      })
      if (result === 'edited') reinstated += 1
      else if (result !== 'already-retracted') retractionsWithheld += 1
    }
  }

  // Decision 6: the subset the check pass CONFIRMED, for a gate that demands confirmation. Read
  // through the SAME array runCheckPass was given, because CheckVerdict.index addresses it, and
  // matched by findingId because selectForPosting has already re-severitied the said findings. A
  // finding two verdicts disagree about is not confirmed, as in selectForPosting's collision rule.
  const saidFindings = [...said.inline.map((x) => x.finding), ...said.summaryOnly]
  const verdictKinds = new Map<string, Set<CheckVerdict['verdict']>>()
  for (const v of review.check?.verdicts ?? []) {
    const f = findings[v.index]
    if (f === undefined) continue
    const kinds = verdictKinds.get(findingId(f)) ?? new Set<CheckVerdict['verdict']>()
    kinds.add(v.verdict)
    verdictKinds.set(findingId(f), kinds)
  }
  const confirmed = review.check === null
    ? null
    : saidFindings.filter((f) => {
        const kinds = verdictKinds.get(findingId(f))
        return kinds !== undefined && kinds.size === 1 && kinds.has('confirmed')
      })

  return {
    mode,
    headSha,
    completed,
    reviewId: posted?.reviewId ?? null,
    summaryCommentId: summary?.commentId ?? null,
    said,
    findings: saidFindings,
    confirmed,
    counts: {
      inline: posted === null ? 0 : said.inline.length,
      summaryOnly: summary === null ? 0 : said.summaryOnly.length,
      droppedInline: posted?.droppedInline.length ?? 0,
      suppressed: plan.suppressed.length,
      notInCheckout: anchored.dropped.length,
      retracted,
      reinstated,
      retractionsWithheld,
    },
    marker,
    bodies: { review: reviewText, inline, summary: summaryText },
  }
}

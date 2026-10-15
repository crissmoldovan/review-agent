import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  judgementAddresses, MAX_RECHECK_ROWS,
  type Finding, type PreviousFinding, type RecheckJudgement, type RecheckState, type Severity,
} from '@review-agent/core'
import type { AnchoredFinding } from './anchor'

export type Outcome = 'open' | 'fixed' | 'disputed' | 'deferred'
export type MarkerFinding = {
  id: string; file: string; line: number; severity: Severity; title: string
  /** What kind of defect this is. It used to be half of what the next review MATCHED on; matching is
   *  gone, and it is kept because it is now one of the five fields the re-review pass is shown —
   *  "correctness" and "security" mean different things to look for. A `string` rather than core's
   *  `Category` because the marker is a wire format other versions of this product read: a category
   *  added after this one was written must not cost the whole history. Optional because a marker
   *  written before 2026-09-15 has none, and the pass is told "unknown" for those. */
  category?: string
  /** HISTORICAL. A hash of the source line a finding was placed on, written by 0.1.0 only.
   *
   *  Nothing reads it and nothing writes it any more (Criss, 2026-09-16). It was the second attempt
   *  at inferring a repair from two snapshots — "fixed when the line is gone" — and it failed on the
   *  first real repair it met: a fix that WRAPS a line rather than deleting it leaves the line
   *  present. Measured: `if (attempt < attempts - 1) { ... }` wrapped two lines and re-indented them;
   *  both survived verbatim, whitespace is normalised before hashing, and a genuine repair read as
   *  unfixed.
   *
   *  The field stays in the type and in the schema because run 4 on the live pull request carries
   *  one, and design point 7 keeps every marker this product has written decodable at version 1. */
  anchor?: string
  commentId: number | null; outcome: Outcome
}
export type MarkerRun = { headSha: string; at: string; findings: MarkerFinding[] }
export type MarkerState = { version: 1; runs: MarkerRun[] }

export const MARKER_OPEN = '<!-- review-agent:state:v1 '
export const MARKER_CLOSE = ' -->'
export const MAX_RUNS = 10       // a GitHub comment body caps at 65,536 characters

const StateSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.object({
    headSha: z.string(),
    at: z.string(),
    findings: z.array(z.object({
      id: z.string(), file: z.string(), line: z.number().int(),
      severity: z.number().int().min(1).max(10), title: z.string(),
      category: z.string().optional(),      // absent in every marker written before 2026-09-15
      anchor: z.string().optional(),        // present only in markers written by 0.1.0; see above
      commentId: z.number().int().nullable(),
      outcome: z.enum(['open', 'fixed', 'disputed', 'deferred']),
    })),
  })),
})

export function encodeMarker(s: MarkerState): string {
  const trimmed: MarkerState = { version: 1, runs: s.runs.slice(-MAX_RUNS) }
  return MARKER_OPEN + Buffer.from(JSON.stringify(trimmed), 'utf8').toString('base64') + MARKER_CLOSE
}

export function decodeMarker(body: string): MarkerState | null {
  const matches = [...body.matchAll(/<!-- review-agent:state:v1 ([A-Za-z0-9+/=]+) -->/g)]
  const last = matches.at(-1)
  if (last === undefined) return null
  try {
    return StateSchema.parse(JSON.parse(Buffer.from(last[1], 'base64').toString('utf8'))) as MarkerState
  } catch {
    return null                  // a human edited the body; run anyway rather than fail the review
  }
}

export function findingId(f: { file: string; category: string; title: string }): string {
  // An ADDRESS, not an identity. It names one entry of one run so a comment body, a check run and
  // `applyOutcomes` can all point at the same row; it does NOT decide whether two runs are looking
  // at the same defect. It cannot: it hashes the title, and the title is the model's prose, which is
  // rewritten every run. Measured on the proving ground on 2026-09-15 — one commit, two reviews,
  // three live defects declared `fixed` because their wording moved.
  //
  // Nothing infers a repair from it any more (Criss, 2026-09-16: ask the model instead). What it
  // still does is correlate a finding to its COMMENT: it is the key on `InlineComment.findingId`,
  // what `readBackCommentIds` maps to a real comment id, and what `commentIdFor` writes into the
  // row. Delete it and a finding judged resolved has no comment to edit. NUL-joined so a file called
  // "a" with category "b" cannot collide with a file called "a b".
  return createHash('sha256').update([f.file, f.category, f.title].join('\0')).digest('hex').slice(0, 12)
}

export type ThreadReply = { commentId: number; body: string }
export type OutcomeChange = {
  id: string
  /** Which row of `previous.findings` this is about. The id cannot say: a run can hold the same
   *  file, category and title twice (report.ts says so out loud), and two rows sharing an id can be
   *  given different outcomes. `applyOutcomes` writes by this index. */
  index: number
  previous: MarkerFinding
  outcome: Outcome
}

/** First line only: a command has to be deliberate. A developer writing "sure, but /dispute later"
 *  in the middle of a sentence is talking, not filing a verdict. */
export function declaredOutcome(body: string): 'disputed' | 'deferred' | null {
  const first = body.trim().split('\n')[0].trim().toLowerCase()
  if (first.startsWith('/dispute')) return 'disputed'
  if (first.startsWith('/defer')) return 'deferred'
  return null
}

/** The verdict standing on each thread: the last reply that FILED ONE, not the last reply.
 *  `fetchThreadReplies` hands over every non-bot comment on the thread in created order, so
 *  "/dispute this is scrubbed downstream" followed by "thanks for flagging it though" used to leave
 *  the thread with no verdict at all — politeness revoking a person's word. A verdict is revoked by
 *  another verdict, or by the finding being judged gone; chatter after one is conversation, and
 *  conversation settles nothing. */
const verdictsByComment = (replies: ThreadReply[]): Map<number, 'disputed' | 'deferred'> => {
  const out = new Map<number, 'disputed' | 'deferred'>()
  for (const r of replies) {
    const said = declaredOutcome(r.body)
    if (said !== null) out.set(r.commentId, said)          // a later verdict overrules an earlier one
  }
  return out
}

/** Which row of which run a question is about. A run index and a row index, because neither alone
 *  addresses a row and `id` addresses nothing. */
export type RowAddress = { run: number; row: number }

/** The ask, and the map back from it. `questions[i]` is what the re-review pass is given at index
 *  `i`; `addresses[i]` is every row of the marker that question answers for. */
export type RecheckAsk = { questions: PreviousFinding[]; addresses: RowAddress[][] }

/** What the re-review pass is asked about (Criss, 2026-09-16), and the single place that order is
 *  defined — `nextMarkerState` re-derives it from the same marker, so a judgement's index cannot
 *  address one row while it was computed about another.
 *
 *  EVERY RUN, not `runs.at(-1)`. The old pairwise limit existed only because matching was pairwise;
 *  one question costs the same whichever run it came from, and reaching back is the only thing that
 *  makes the live pull request's two frozen-wrong rows — in runs 2 and 3 of four — repairable at all.
 *
 *  Two filters, and only two:
 *
 *  - A row a PERSON settled is not asked about. `disputed` and `deferred` are somebody's word, and
 *    design point 5 says the model does not get to answer it. Leaving it out of the ask is cheaper
 *    and safer than asking and then discarding the answer.
 *  - A row already marked `fixed` IS asked about again, deliberately. Run 1 of the live marker
 *    declared three live defects fixed on nothing but the model's silence; skipping those rows would
 *    freeze all three for ever. A judgement is allowed to push a row back to `open`.
 *
 *  And one collapse: two rows whose five visible fields are byte-identical are ONE question. That is
 *  not matching returning by the back door — nothing is compared to anything, and no inference is
 *  drawn. It is the observation that asking the same question twice gets the same answer twice and
 *  costs tokens for the privilege. A row differing anywhere at all is asked about separately, so a
 *  miss costs one duplicate question and never a wrong outcome.
 *
 *  And one cap, which is the pass's (`MAX_RECHECK_ROWS`) applied HERE, where it can choose. A marker
 *  can legitimately hold more: MAX_RUNS is 10 and `maxInline` 15, so 150 rows is the worst honest
 *  case. The pass used to be handed the whole list and take the first 50 of it — which, on a list
 *  built oldest-first, threw away the most recent reviews' findings: the rows whose comments a reader
 *  is looking at right now, and the ones most likely to have been repaired by the push that started
 *  this very re-review. Measured on a synthetic 10-run marker: question 50, the first one never seen,
 *  was run 6 of 10, so four whole reviews were invisible for ever while the oldest 50 were re-asked
 *  and re-billed on every run.
 *
 *  So when the cap bites, the questions kept are the ones whose NEWEST row is newest. A question is
 *  as recent as the most recent run it answers for, which matters because of the collapse above: a
 *  defect first reported in run 0 and re-reported in run 9 is a live question, and ranking it by
 *  where it first appeared would drop it. Dropping a question leaves every row it addressed `open`,
 *  which is safe and is the feature not working — the reason the choice is made deliberately and
 *  written down rather than falling out of a `slice`. */
export function recheckQuestions(previous: MarkerState | null): RecheckAsk {
  const questions: PreviousFinding[] = []
  const addresses: RowAddress[][] = []
  const at = new Map<string, number>()
  ;(previous?.runs ?? []).forEach((run, runIndex) => {
    run.findings.forEach((f, rowIndex) => {
      if (CARRIED_OUTCOMES.includes(f.outcome)) return
      const question: PreviousFinding = {
        file: f.file, line: f.line, severity: f.severity, title: f.title,
        ...(f.category !== undefined && { category: f.category }),
      }
      const key = JSON.stringify([f.file, f.line, f.severity, f.category ?? null, f.title])
      const seen = at.get(key)
      if (seen !== undefined) { addresses[seen].push({ run: runIndex, row: rowIndex }); return }
      at.set(key, questions.length)
      questions.push(question)
      addresses.push([{ run: runIndex, row: rowIndex }])
    })
  })
  if (questions.length <= MAX_RECHECK_ROWS) return { questions, addresses }
  const newest = (rows: RowAddress[]): number => rows.reduce((n, r) => Math.max(n, r.run), -1)
  const kept = questions
    .map((_, i) => i)
    // Newest run first; between two questions of the same age, the later one in the marker. Total
    // and deterministic, so `nextMarkerState` re-deriving this list gets the identical one.
    .sort((x, y) => newest(addresses[y]) - newest(addresses[x]) || y - x)
    .slice(0, MAX_RECHECK_ROWS)
    .sort((x, y) => x - y)                    // back into marker order, which is what an index means
  return { questions: kept.map((i) => questions[i]), addresses: kept.map((i) => addresses[i]) }
}

/** The earlier comments a later review's check pass is shown, and the map back to them (Criss,
 *  2026-10-15): `questions[i]` is what the pass is given at index `i`, and `commentIds[i]` is the
 *  inline comment a finding that repeats it is noted on instead of being posted again.
 *
 *  ONE QUESTION PER COMMENT, offered only while every row pointing at that comment is `open`. A
 *  comment some row stands `fixed` on carries, or is about to carry, "No longer reported", and the
 *  re-review pass already re-asks those rows and reinstates the comment when the defect is back. A
 *  comment a person answered — `disputed` or `deferred` on any of its rows — is theirs: a model does
 *  not get to tell it the defect is still there. Both keep what happens today, a new comment.
 *
 *  The newest row's words stand for the comment: the defect as it was most recently described. Newest
 *  comment first, so the cap (`MAX_RECHECK_ROWS`, the re-review pass's, for the same reason: this text
 *  is read out of a public comment) keeps what a reader is looking at now. Deterministic, because
 *  `publishReview` re-derives this list from the same marker and drops every `repeats` if the pass was
 *  shown a different one. */
export type RepeatAsk = { questions: PreviousFinding[]; commentIds: number[] }

export function repeatCandidates(previous: MarkerState | null): RepeatAsk {
  const newest = new Map<number, { run: number; index: number; row: MarkerFinding }>()
  const closed = new Set<number>()
  ;(previous?.runs ?? []).forEach((run, runIndex) => {
    run.findings.forEach((f, index) => {
      if (f.commentId === null) return
      if (f.outcome !== 'open') closed.add(f.commentId)
      newest.set(f.commentId, { run: runIndex, index, row: f })   // a later row overwrites an earlier one
    })
  })
  const offered = [...newest]
    .filter(([commentId]) => !closed.has(commentId))
    // Newest run first; within a run, the later row first. Total, so the list is the same twice.
    .sort(([, x], [, y]) => y.run - x.run || y.index - x.index)
    .slice(0, MAX_RECHECK_ROWS)
  return {
    questions: offered.map(([, { row: f }]) => ({
      file: f.file, line: f.line, severity: f.severity, title: f.title,
      ...(f.category !== undefined && { category: f.category }),
    })),
    commentIds: offered.map(([commentId]) => commentId),
  }
}

/** The re-review pass's answers, spread back over the rows they are about. Keyed by run index, then
 *  by row index — the two numbers `diffRuns` and `applyOutcomes` write by.
 *
 *  BOTH of the pass's addressing checks are made again here: an index that is not a question is
 *  dropped, and so is an answer whose `file` is not the file of the question at that index.
 *  `runRecheckPass` makes the same two checks — but it reaches production as an INJECTED dependency
 *  (`RunReviewDeps.runRecheckPass`) that both callers wrap, and a wrapper is a place a judgement can
 *  be manufactured or reordered without this module knowing. These two lines are what hold if that
 *  ever happens.
 *
 *  Said precisely, because the old comment here overclaimed and a mutation caught it: the range check
 *  is SUBSUMED by the echo check below it. `addresses` and `questions` are built together and are the
 *  same length, so an index with no address has no question either, and the echo would drop it on its
 *  own. It stays because `rows` has to be narrowed before it is walked, and because a check that
 *  costs one comparison is not worth removing to prove a point. What is tested is the behaviour —
 *  neither an out-of-range index nor a mis-named answer moves any outcome — and breaking both lines
 *  at once reddens both cases. */
const judgedRows = (
  ask: RecheckAsk, judgements: readonly RecheckJudgement[],
): Map<number, Map<number, RecheckState>> => {
  const byRun = new Map<number, Map<number, RecheckState>>()
  for (const j of judgements) {
    const rows = ask.addresses[j.index]
    if (rows === undefined) continue
    if (!judgementAddresses(j, ask.questions[j.index])) continue
    for (const { run, row } of rows) {
      const inRun = byRun.get(run) ?? new Map<number, RecheckState>()
      inRun.set(row, j.state)
      byRun.set(run, inRun)
    }
  }
  return byRun
}

/** One run of the marker, settled against what the re-review pass said and what people replied.
 *
 *  THE VERDICT IS AUTHORITATIVE (Criss, 2026-09-16). There is no pairing of old findings to new ones
 *  any more, and no `current` parameter: that layer existed only to answer "is this still there?" by
 *  inference, and both inference schemes were measured wrong on live output — one on wording, one on
 *  the anchored source line. Nothing this run reported, worded, severitied or placed decides any of
 *  these outcomes.
 *
 *  - still-present -> open
 *  - resolved      -> fixed
 *  - cannot-tell   -> what the row already said
 *  - no answer     -> what the row already said
 *
 *  The last two lines are the whole of "fails closed", and they used to read `open` — which was
 *  wrong in one direction nobody had looked at. Almost every row already says `open`, so for almost
 *  every row it is the same sentence. For a row standing `fixed` it is not: a pass that threw, timed
 *  out or was refused its budget re-opened every `fixed` in the marker, every review, for ever. That
 *  is not caution, it is amnesia — it threw away a judgement a model actually made at a named commit,
 *  and a comment on the pull request has already been edited to say so. Silence is not evidence, and
 *  "cannot-tell" is explicitly not evidence; withdrawing a `fixed` takes a positive `still-present`,
 *  or a person. What has not changed is the direction that matters: a missing answer must never
 *  become a `fixed`, and no row is ever `fixed` here except by an answer that says `resolved`. */
export function diffRuns(a: {
  previous: MarkerRun | null
  replies: ThreadReply[]
  /** The pass's answer for each row of `previous`, by row index. `null`, absent, or a row with no
   *  entry all mean the same: nobody answered, so the row stands as it was. */
  judged?: ReadonlyMap<number, RecheckState> | null
  /** A verdict a person filed on ANOTHER of this finding's threads, by `findingId`. One defect owns
   *  one row per run and gets a new comment each review, so a `/dispute` left on this review's
   *  comment reaches this review's row and no other — and the same finding's older rows would then
   *  be judged by the model and stamped "no longer reported" on threads beside the one the person
   *  wrote on. `nextMarkerState` builds this across every run so a verdict lands on the defect rather
   *  than on the comment. It is a wording-dependent join (`findingId` hashes the title), which is
   *  said out loud there. */
  carried?: ReadonlyMap<string, 'disputed' | 'deferred'> | null
}): OutcomeChange[] {
  const { previous, replies } = a
  if (previous === null) return []
  const lastVerdict = verdictsByComment(replies)
  return previous.findings.map((prev, i) => {
    const onThisThread = prev.commentId === null ? null : lastVerdict.get(prev.commentId) ?? null
    // A person beats the model, exactly as a person used to beat the matcher (design point 5) —
    // including when they wrote under a different one of this finding's comments.
    const declared = onThisThread ?? a.carried?.get(prev.id) ?? null
    const answered = a.judged?.get(i)
    const outcome: Outcome = declared ?? (
      answered === 'resolved' ? 'fixed'
        : answered === 'still-present' ? 'open'
          // Unanswered, or answered "cannot-tell": the row keeps what it already said. `disputed` and
          // `deferred` cannot reach this line — `recheckQuestions` never asks about them — and
          // `applyOutcomes` refuses an `open` over them anyway.
          : prev.outcome === 'fixed' ? 'fixed' : 'open'
    )
    return { id: prev.id, index: i, previous: prev, outcome }
  })
}

/** What a review actually said, in the two places it can say it. `PostingPlan` from report.ts is
 *  assignable to this, so a caller passes its plan straight in; the type is declared here rather
 *  than imported because report.ts already imports this module. */
export type PostedFindings = {
  inline: AnchoredFinding[]
  summaryOnly: Finding[]
  /** Found again: said in the summary as still present, and noted on the earlier comment that first
   *  reported it rather than posted as a new one (Criss, 2026-10-15). Optional, so a `PostingPlan`
   *  — which has none — is still one of these. */
  repeated?: RepeatedFinding[]
}

/** A finding this review found again, and the earlier inline comment it is said on. */
export type RepeatedFinding = { finding: Finding; commentId: number }

const entry = (f: Finding, line: number, commentId: number | null): MarkerFinding => ({
  id: findingId(f), file: f.file, line, severity: f.severity, title: f.title,
  category: f.category, commentId, outcome: 'open',
})

/** The run a review just finished, as the marker keeps it. Only what was SAID is recorded —
 *  inline comments and summary lines. A suppressed finding is deliberately absent: a later
 *  review would otherwise report as "fixed" something nobody was ever told about. */
export function markerRunFor(a: {
  headSha: string; at: string; posted: PostedFindings
  /** The comment GitHub created for this finding ON THIS LINE. The line is a parameter because
   *  `findingId` alone does not name a comment: two findings sharing file, category and title — which
   *  `report.ts` says out loud can happen, at two different lines — would otherwise resolve to one
   *  map entry, one of the two real comment ids would never enter the marker, and the reply a person
   *  left under it would never be read (Criss, 2026-09-16). */
  commentIdFor: (finding: Finding, line: number) => number | null
}): MarkerRun {
  return {
    headSha: a.headSha,
    at: a.at,
    findings: [
      // The anchored line, not the model's: it is where the comment really went, and it is what a
      // person following the row will look at.
      ...a.posted.inline.map((x) => entry(x.finding, x.line, a.commentIdFor(x.finding, x.line))),
      // No comment, so no thread: `commentId: null` is what `diffRuns` reads as "nobody could have
      // answered this". `Finding.line` is a number with 0 meaning file-level.
      ...a.posted.summaryOnly.map((f) => entry(f, f.line, null)),
      // The EARLIER comment's id. That comment is where this defect is being discussed: a reply under
      // it is about this row too, and it is retracted only when every row pointing at it is judged
      // resolved (`retractableComments`), so one live repeat keeps it standing.
      ...(a.posted.repeated ?? []).map((r) => entry(r.finding, r.finding.line, r.commentId)),
    ],
  }
}

/** One comment to write a note on. */
export type Retractable = {
  commentId: number
  /** The file the finding named, spelled the way the MARKER spells it — which is to say, written by
   *  whoever wrote the comment this marker was read out of. It reaches a public note, so body.ts
   *  puts it through `inlineCode` rather than interpolating it. */
  file: string
  /** The `findingId` of every row that points at this comment. The caller compares them against what
   *  THIS review has just said, so the product cannot stamp "no longer reported" on a comment for a
   *  finding it is re-reporting in the same breath. The id is wording-dependent and that is the right
   *  direction here: a miss withholds a retraction, and withholding one costs a stale comment for one
   *  more review, while writing one wrongly costs a reader their trust in the product. */
  ids: string[]
}

/** The inline comments this review should retract: one per comment that a row judged RESOLVED points
 *  at. Criss, 2026-09-15: edit that comment, never delete it — a reply, a `/dispute`, a whole
 *  conversation may hang off it.
 *
 *  ACROSS EVERY RUN, not only the last. That limit was a consequence of only the last run ever being
 *  settled, and run 4 on the live pull request hit it: an older run's comment could never be
 *  retracted by any later review, whatever anyone learned about it since.
 *
 *  Five things are deliberately not retracted:
 *
 *  - a row with no `commentId`, which is most of them: a summary-only finding was never given a
 *    comment, so there is nothing to edit, and a review whose inline comments GitHub refused records
 *    `null` for every row on purpose (post.ts).
 *  - a person's verdict. `disputed` and `deferred` are what somebody SAID. Read off `before`, NOT off
 *    the settled row, because `applyOutcomes` lets a `fixed` overwrite a standing verdict — so by the
 *    time a settled row is read, a verdict filed two reviews ago would already be gone from it.
 *    Belt and braces now, and deliberately kept: `recheckQuestions` no longer even ASKS about a row
 *    a person settled, so through `nextMarkerState` this state is unreachable. It stays because this
 *    function is exported and takes its runs from a caller, and because it is one comparison
 *    standing between a mistake made elsewhere and writing on somebody's conversation.
 *  - a comment any row NOT judged gone also points at. `commentIdFor` keys on `findingId`, so two
 *    findings sharing file, category and title share one id, `readBackCommentIds` writes one map
 *    entry, and BOTH rows carry the same comment id. Retracting on one twin would put "no longer
 *    found" under a defect that is still there. The reason is the live twin, not the sharing, so two
 *    rows that are both gone do retract — once.
 *  - a comment already retracted by an earlier review. Now that every run is settled on every
 *    review, a row that stood `fixed` before this one keeps standing `fixed`, and offering it again
 *    would spend a request per review for ever. Only a row that CHANGED to `fixed` here is offered,
 *    which is what makes "the same comment is never retracted twice" a property of the state rather
 *    than of `retractInlineComment`'s body check alone. That sentence was an overclaim until
 *    2026-09-16 and is now true: it rests on `diffRuns` letting a standing `fixed` survive a pass
 *    that answered nothing, which is exactly what it did not used to do. The two changes are one
 *    change, and separating them would silently re-open this.
 *  - a comment this very review has just commented on. That one is not here: it needs the position
 *    GitHub re-anchored the comment to, which is a fact only the network has. `retractInlineComment`
 *    makes that check with the read it already spends. */
export function retractableComments(a: {
  /** Every run of the marker as this review settled it. */
  settled: readonly MarkerRun[]
  /** The same runs as they stood BEFORE this review settled them. Row for row: `applyOutcomes`
   *  rewrites outcomes and moves nothing. */
  before: readonly MarkerRun[]
}): Retractable[] {
  type Held = { row: MarkerFinding; stood: Outcome | null }
  const rows = new Map<number, Held[]>()
  a.settled.forEach((run, runIndex) => {
    run.findings.forEach((f, rowIndex) => {
      if (f.commentId === null) return
      // By row, as `applyOutcomes` writes: a run can hold one id twice. An index that does not line
      // up is read as no history at all, which withholds nothing and invents nothing.
      const was = a.before[runIndex]?.findings[rowIndex]
      const stood = was !== undefined && was.id === f.id ? was.outcome : null
      rows.set(f.commentId, [...(rows.get(f.commentId) ?? []), { row: f, stood }])
    })
  })
  const out: Retractable[] = []
  // Insertion order, which is the order the runs recorded their findings: a stable order means a
  // failure is reproducible and a log reads the same twice.
  for (const [commentId, held] of rows) {
    if (!held.every((h) => h.row.outcome === 'fixed')) continue
    if (held.some((h) => h.stood !== null && CARRIED_OUTCOMES.includes(h.stood))) continue
    if (held.every((h) => h.stood === 'fixed')) continue          // already retracted, a review ago
    out.push({ commentId, file: held[0].row.file, ids: held.map((h) => h.row.id) })
  }
  return out
}

/** The inline comments this review should take a retraction BACK on: one per comment whose row stood
 *  `fixed` and does not any more (Criss, 2026-09-16, after the first attack on this pass).
 *
 *  It is the other half of design point 3, and without it that point only half holds. `fixed` is
 *  repairable — `recheckQuestions` deliberately re-asks a `fixed` row, and a `still-present` pushes
 *  it back to `open` — but until now the repair reached the MARKER, which is a base64 blob in an HTML
 *  comment, and never the artefact a person reads: the comment went on saying "the reviewer read this
 *  at <sha> and no longer finds this issue there" under a defect the product had just re-confirmed.
 *  A retraction was permanent in public and provisional in private, which is the wrong way round.
 *
 *  ANY row moving off `fixed` reinstates the comment, where a retraction needs EVERY row on it to be
 *  gone. The asymmetry is deliberate and is the same principle both times: the note says nothing is
 *  reported there, so one live finding behind that comment is enough to make it false.
 *
 *  What moves a row off `fixed` is a positive `still-present` or a person's verdict, and nothing
 *  else — `diffRuns` lets a `fixed` stand through silence and through "cannot-tell". That is what
 *  keeps this from firing on every failed pass and turning a thread into a wall of notes. */
export function reinstatableComments(a: {
  settled: readonly MarkerRun[]
  before: readonly MarkerRun[]
}): Retractable[] {
  const rows = new Map<number, MarkerFinding[]>()
  a.settled.forEach((run, runIndex) => {
    run.findings.forEach((f, rowIndex) => {
      if (f.commentId === null) return
      const was = a.before[runIndex]?.findings[rowIndex]
      // Only a row this product itself recorded as `fixed` last time. No history is no claim to undo.
      if (was === undefined || was.id !== f.id || was.outcome !== 'fixed') return
      if (f.outcome === 'fixed') return
      rows.set(f.commentId, [...(rows.get(f.commentId) ?? []), f])
    })
  })
  return [...rows].map(([commentId, held]) => ({
    commentId, file: held[0].file, ids: held.map((f) => f.id),
  }))
}

/** Every comment of ours that a person could still be replying under — across all runs, not only
 *  the last, because a reply to an older thread is still a verdict. This is what
 *  `fetchThreadReplies` takes as `parentIds`. */
export const commentIdsIn = (s: MarkerState | null): number[] => {
  const ids: number[] = []
  for (const run of s?.runs ?? []) {
    for (const f of run.findings) if (f.commentId !== null) ids.push(f.commentId)
  }
  return [...new Set(ids)]
}

/** The two outcomes a person declares out loud. They are not recomputed from a model's answer. */
export const CARRIED_OUTCOMES: readonly Outcome[] = ['disputed', 'deferred']

/** Writes a run of `diffRuns` back onto the run it was computed from, without mutating it.
 *  `open` never overrides a standing `disputed` or `deferred`: `diffRuns` cannot tell "no reply"
 *  from "a reply that declared nothing", and a review is not entitled to withdraw a person's
 *  verdict by failing to hear it again. `fixed` does override — the finding is gone, so there is
 *  nothing left to dispute — and so does a newly declared verdict.
 *
 *  By ROW, not by id. An id names a file, a category and a title, and one run can hold those three
 *  twice — report.ts already says so, and nothing dedupes the model's list. Two rows sharing an id
 *  can be given different outcomes; joining them back by id kept whichever came last, which put one
 *  row's `fixed` onto a live row, and onto a person's `disputed`. */
export function applyOutcomes(run: MarkerRun, changes: OutcomeChange[]): MarkerRun {
  const by = new Map<number, Outcome>()
  for (const c of changes) {
    // A change addresses one row of the run it was computed from. One that does not line up with
    // this run is ignored rather than written onto whatever else sits at that index.
    if (run.findings[c.index]?.id === c.id) by.set(c.index, c.outcome)
  }
  return {
    ...run,
    findings: run.findings.map((f, i) => {
      const next = by.get(i)
      if (next === undefined) return { ...f }
      if (next === 'open' && CARRIED_OUTCOMES.includes(f.outcome)) return { ...f }
      return { ...f, outcome: next }
    }),
  }
}

/** The marker a re-review writes: EVERY previous run settled against what the re-review pass said
 *  and what people replied, and this run appended.
 *
 *  The ask is re-derived here from `previous` with `recheckQuestions`, rather than passed in beside
 *  the judgements. That is deliberate: a judgement's `index` addresses a position in that list, and
 *  deriving it from the same marker in the same function is what makes it impossible for the two to
 *  disagree. `publishReview` checks separately that the list the pass was actually GIVEN is this
 *  list, and drops every judgement if it is not.
 *
 *  The trim is belt as well as braces: `encodeMarker` already keeps the last MAX_RUNS, and a caller
 *  that reads this state without encoding it sees the same bound. */
export function nextMarkerState(a: {
  previous: MarkerState | null; run: MarkerRun; replies: ThreadReply[]
  /** What the re-review pass answered, addressed by position in `recheckQuestions(previous).questions`.
   *  Absent or empty is "no answer": every previous row stays `open` and nothing is repaired. */
  judgements?: readonly RecheckJudgement[]
}): MarkerState {
  const older = a.previous?.runs ?? []
  const judged = judgedRows(recheckQuestions(a.previous ?? null), a.judgements ?? [])
  // A verdict is about a DEFECT, not about a thread. Each review posts a new comment for the same
  // finding, so a `/dispute` filed today hangs off today's comment and reaches today's row — while
  // the same defect's rows in three older runs are still put to the model, and one `resolved` then
  // stamps "no longer reported" on the threads either side of the one the person wrote on. Collected
  // across every run first, so the answer is the same wherever the reply landed. A later run's
  // verdict wins over an earlier run's, which is the same rule as a later reply on one thread.
  const onTheFinding = new Map<string, 'disputed' | 'deferred'>()
  const lastVerdict = verdictsByComment(a.replies)
  for (const run of older) {
    for (const f of run.findings) {
      const said = f.commentId === null ? null : lastVerdict.get(f.commentId) ?? null
      if (said !== null) onTheFinding.set(f.id, said)
    }
  }
  const settled = older.map((run, i) => applyOutcomes(run, diffRuns({
    previous: run, replies: a.replies, judged: judged.get(i) ?? null, carried: onTheFinding,
  })))
  // Each review posts new inline comments, so a verdict left on the previous review's comment is
  // unreachable from the next one. Carrying it onto the same finding's new entry is what keeps
  // "/dispute" meaning what it said for longer than one review.
  //
  // SAID OUT LOUD rather than left to be discovered: this carry keys on `findingId`, which hashes
  // the TITLE. It is the last wording-dependent join in this file, so a reworded finding still loses
  // its carried verdict. Outcomes no longer depend on wording; this one join still does. Out of
  // scope for the outcome change, and not forgotten.
  const standing = new Map<string, Outcome>()
  for (const run of settled) {
    // Every settled run, not only the last: a finding disputed two reviews ago and not re-reported
    // since is still disputed when it comes back. Later runs overwrite earlier ones, so the most
    // recent word stands.
    for (const f of run.findings) {
      if (CARRIED_OUTCOMES.includes(f.outcome)) standing.set(f.id, f.outcome)
    }
  }
  const run: MarkerRun = {
    ...a.run,
    findings: a.run.findings.map((f) => ({ ...f, outcome: standing.get(f.id) ?? f.outcome })),
  }
  return { version: 1, runs: [...settled, run].slice(-MAX_RUNS) }
}

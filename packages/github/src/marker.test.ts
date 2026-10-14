import { describe, expect, it } from 'vitest'
import {
  MAX_RECHECK_ROWS, type Finding, type RecheckJudgement, type RecheckState,
} from '@review-agent/core'
import {
  MARKER_CLOSE, MARKER_OPEN, MAX_RUNS, applyOutcomes, commentIdsIn, declaredOutcome, decodeMarker,
  diffRuns, encodeMarker, findingId, markerRunFor, nextMarkerState, recheckQuestions,
  reinstatableComments, retractableComments,
  type MarkerFinding, type MarkerRun, type MarkerState, type OutcomeChange,
} from './marker'
import type { AnchoredFinding } from './anchor'

const state: MarkerState = {
  version: 1,
  runs: [{
    headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
    at: '2026-09-12T10:00:00.000Z',
    findings: [{
      id: 'a1b2c3d4e5f6', file: '.github/workflows/publish.yml', line: 100,
      severity: 6, title: 'a tag on any branch publishes -- nothing checks the branch',
      commentId: 42, outcome: 'open',
    }],
  }],
}

describe('encodeMarker / decodeMarker', () => {
  it('round-trips through a comment body', () => {
    const body = `### Review of 4f8e2a1\n\nTwo findings.\n\n${encodeMarker(state)}\n`
    expect(decodeMarker(body)).toEqual(state)
  })

  it('is an HTML comment, and its payload cannot close one early', () => {
    const marker = encodeMarker(state)
    expect(marker.startsWith(MARKER_OPEN)).toBe(true)
    expect(marker.endsWith(MARKER_CLOSE)).toBe(true)
    // The title above contains `--`, which is illegal inside an HTML comment and would be mangled
    // by a renderer. Base64 has no `-`, so the payload is clean however the state reads.
    const payload = marker.slice(MARKER_OPEN.length, -MARKER_CLOSE.length)
    expect(payload).not.toContain('--')
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('returns null for a body with no marker', () => {
    expect(decodeMarker('Just a human being helpful.')).toBeNull()
  })

  it('returns null for a mangled marker rather than throwing', () => {
    expect(decodeMarker('<!-- review-agent:state:v1 not-base64!!! -->')).toBeNull()
  })

  it('keeps only the most recent runs', () => {
    const many: MarkerState = {
      version: 1,
      runs: Array.from({ length: 14 }, (_, i) => ({ headSha: `sha${i}`, at: '2026-09-12T10:00:00.000Z', findings: [] })),
    }
    const back = decodeMarker(encodeMarker(many))
    expect(back?.runs).toHaveLength(10)
    expect(back?.runs[0].headSha).toBe('sha4')
    expect(back?.runs.at(-1)?.headSha).toBe('sha13')
  })

  it('reads the last marker when a body carries two', () => {
    const older: MarkerState = { version: 1, runs: [{ headSha: 'old', at: 'x', findings: [] }] }
    const body = `${encodeMarker(older)}\n\nedited\n\n${encodeMarker(state)}`
    expect(decodeMarker(body)?.runs[0].headSha).toBe('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
  })

  // Design point 7 (Criss, 2026-09-16): version 1 stays, and every marker this product has ever
  // written keeps decoding. That is not decoration — four runs are live on the proving ground: three
  // carry no `anchor` and no `category`, and the fourth carries both. Nothing reads either field any
  // more, and both stay optional in the schema so neither shape is a parse failure.
  it('still decodes both shapes this product has written, version 1 throughout', () => {
    const wire = {
      version: 1,
      runs: [
        // Runs 1-3: written before 2026-09-15. No `category`, no `anchor`.
        { headSha: 'aaaaaaa', at: 'x', findings: [
          { id: 'a7ac9b0581f8', file: 'src/retry.ts', line: 24, severity: 8,
            title: 'Computed backoff delay is never used', commentId: 4013307235, outcome: 'open' },
        ] },
        // Run 4: written by 0.1.0, which added both.
        { headSha: 'bbbbbbb', at: 'x', findings: [
          { id: '9b56c45d92f0', file: 'src/retry.ts', line: 23, severity: 8, category: 'correctness',
            title: 'No backoff', anchor: 'cf5d6134e051', commentId: 4013794900, outcome: 'open' },
        ] },
      ],
    }
    const body = MARKER_OPEN + Buffer.from(JSON.stringify(wire), 'utf8').toString('base64') + MARKER_CLOSE
    const back = decodeMarker(body)
    expect(back?.version).toBe(1)
    expect(back?.runs).toHaveLength(2)
    expect(back?.runs[0].findings[0].category).toBeUndefined()
    expect(back?.runs[1].findings[0].anchor).toBe('cf5d6134e051')
  })
})

const base: Finding = {
  file: 'src/a.ts', line: 10, endLine: null, severity: 7, category: 'correctness',
  title: 'off-by-one in the retry loop', explanation: 'e', evidence: [], suggestion: null,
}

describe('findingId', () => {
  it('is stable when the finding moves down the file', () => {
    const moved: Finding = { ...base, line: 99 }
    expect(findingId(moved)).toBe(findingId(base))
  })
  it('differs by file, category and title', () => {
    expect(findingId({ ...base, file: 'src/b.ts' })).not.toBe(findingId(base))
    expect(findingId({ ...base, category: 'security' })).not.toBe(findingId(base))
    expect(findingId({ ...base, title: 'something else' })).not.toBe(findingId(base))
  })
  it('is short enough to sit in a comment body', () => {
    expect(findingId(base)).toMatch(/^[0-9a-f]{12}$/)
  })
})

const a: Finding = { ...base, title: 'A' }
const b: Finding = { ...base, title: 'B' }
const previous: MarkerRun = {
  headSha: 'old', at: '2026-09-12T10:00:00.000Z',
  findings: [
    { id: findingId(a), file: a.file, line: 10, severity: 7, category: 'correctness', title: 'A', commentId: 1, outcome: 'open' },
    { id: findingId(b), file: b.file, line: 20, severity: 5, category: 'correctness', title: 'B', commentId: 2, outcome: 'open' },
  ],
}

/** What the re-review pass answered, addressed by position in `recheckQuestions(marker).questions`
 *  — and NAMING the file of the question at that position, because an answer that does not name its
 *  row is not an answer about it and is dropped. Derived from the marker rather than written out, so
 *  a case cannot accidentally assert on a judgement the real pass would have thrown away. */
const said = (marker: MarkerState | null, ...states: (RecheckState | null)[]): RecheckJudgement[] => {
  const questions = recheckQuestions(marker).questions
  return states.flatMap((state, index) => state === null ? [] : [{
    index, file: questions[index]?.file ?? '(no question at this index)',
    state, reason: 'because the code says so', evidence: [],
  }])
}

describe('declaredOutcome', () => {
  it('reads a command on the first line only', () => {
    expect(declaredOutcome('/dispute this is intended, see ADR 4')).toBe('disputed')
    expect(declaredOutcome('  /Defer — next sprint')).toBe('deferred')
    expect(declaredOutcome('sure, but /dispute later')).toBeNull()
    expect(declaredOutcome('thanks, fixing now')).toBeNull()
  })
})

// ── The ask ──────────────────────────────────────────────────────────────────────────────────────

describe('recheckQuestions', () => {
  it('is empty on a first review, so a first review has nothing to buy', () => {
    expect(recheckQuestions(null)).toEqual({ questions: [], addresses: [] })
    expect(recheckQuestions({ version: 1, runs: [] }).questions).toEqual([])
  })

  it('reaches every run in the marker, oldest first, and says which row each question is', () => {
    // Not `runs.at(-1)`. The pairwise limit existed only because matching was pairwise; asking a
    // model costs the same question whichever run it came from, and the two frozen-wrong rows on the
    // live pull request sit in runs 2 and 3 of four.
    const marker: MarkerState = { version: 1, runs: [
      { headSha: 'r1', at: 'x', findings: [
        { id: 'aaaaaaaaaaaa', file: 'src/one.ts', line: 1, severity: 8, category: 'correctness', title: 'ONE', commentId: 11, outcome: 'open' },
      ] },
      { headSha: 'r2', at: 'x', findings: [
        { id: 'bbbbbbbbbbbb', file: 'src/two.ts', line: 2, severity: 5, category: 'security', title: 'TWO', commentId: 22, outcome: 'open' },
      ] },
    ] }
    const ask = recheckQuestions(marker)
    expect(ask.questions.map((q) => q.title)).toEqual(['ONE', 'TWO'])
    expect(ask.addresses).toEqual([[{ run: 0, row: 0 }], [{ run: 1, row: 0 }]])
  })

  it('carries only the five fields a model can use, and nothing this product uses for bookkeeping', () => {
    const marker: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 24, severity: 8, category: 'correctness',
        title: 'no backoff', anchor: 'cf5d6134e051', commentId: 4013794900, outcome: 'open' },
    ] }] }
    // `id` and `anchor` are hashes and mean nothing to a model; `commentId` and `outcome` are this
    // product's bookkeeping, and `outcome` is also the one thing the model is NOT allowed to answer.
    expect(recheckQuestions(marker).questions).toEqual([
      { file: 'src/retry.ts', line: 24, severity: 8, category: 'correctness', title: 'no backoff' },
    ])
  })

  it('leaves out a row a person settled, because a person’s word is not the model’s to answer', () => {
    const marker: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'f', line: 1, severity: 5, title: 'DISPUTED', commentId: 1, outcome: 'disputed' },
      { id: 'bbbbbbbbbbbb', file: 'f', line: 2, severity: 5, title: 'DEFERRED', commentId: 2, outcome: 'deferred' },
      { id: 'cccccccccccc', file: 'f', line: 3, severity: 5, title: 'OPEN', commentId: 3, outcome: 'open' },
    ] }] }
    const ask = recheckQuestions(marker)
    expect(ask.questions.map((q) => q.title)).toEqual(['OPEN'])
    expect(ask.addresses).toEqual([[{ run: 0, row: 2 }]])
  })

  it('asks again about a row already marked `fixed`, because that is how a wrong `fixed` is undone', () => {
    // Run 1 of the live marker declared three live defects `fixed` on nothing but the model's
    // silence. Skipping a `fixed` row would freeze all three for good.
    const marker: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 24, severity: 8, title: 'WRONGLY FIXED', commentId: 1, outcome: 'fixed' },
    ] }] }
    expect(recheckQuestions(marker).questions.map((q) => q.title)).toEqual(['WRONGLY FIXED'])
  })

  it('keeps the NEWEST questions when there are more than the pass will take', () => {
    // MAX_RUNS is 10 and maxInline is 15, so a marker can legitimately hold far more rows than the
    // pass's 50. The cap used to be applied in the pass, as `slice(0, 50)` over a list built
    // oldest-first: on a 10-run marker of 8 rows each, question 50 — the first one never asked
    // about — was run 6 of 10, so the four most recent reviews' findings could never be judged
    // resolved and their comments could never be retracted, while the oldest 50 were re-asked and
    // re-billed on every single re-review.
    const runAt = (n: number): MarkerRun => ({
      headSha: `sha${n}`, at: 'x',
      findings: Array.from({ length: 8 }, (_, r) => ({
        id: `id${n}-${r}`.padEnd(12, '0'), file: `src/${n}-${r}.ts`, line: r, severity: 5,
        title: `run ${n} finding ${r}`, commentId: n * 100 + r, outcome: 'open' as const,
      })),
    })
    const busy: MarkerState = { version: 1, runs: Array.from({ length: 10 }, (_, n) => runAt(n)) }
    const ask = recheckQuestions(busy)
    expect(ask.questions).toHaveLength(MAX_RECHECK_ROWS)
    // Every row of the newest run is asked about; nothing from run 0 is.
    expect(ask.questions.filter((q) => q.title.startsWith('run 9 '))).toHaveLength(8)
    expect(ask.questions.filter((q) => q.title.startsWith('run 0 '))).toEqual([])
    // Still in marker order, so an index still means a position in the marker.
    expect(ask.addresses.map((rows) => rows[0].run)).toEqual([...ask.addresses.map((rows) => rows[0].run)].sort((x, y) => x - y))
    // And the two lists still line up row for row.
    expect(ask.addresses).toHaveLength(MAX_RECHECK_ROWS)
  })

  it('keeps an old question that a recent run re-reported, because that is a live question', () => {
    // A question is as recent as the most recent row it answers for. Ranking by where it FIRST
    // appeared would drop a defect reported in run 0 and again in run 9 — the longest-standing thing
    // on the pull request — in favour of a one-off from run 5.
    const ancient = (over: Partial<MarkerFinding>): MarkerFinding => ({
      id: 'ancient00000', file: 'src/ancient.ts', line: 1, severity: 9, category: 'security',
      title: 'THE OLD ONE', commentId: 1, outcome: 'open', ...over,
    })
    const filler = (n: number): MarkerRun => ({
      headSha: `sha${n}`, at: 'x',
      findings: Array.from({ length: 8 }, (_, r) => ({
        id: `id${n}-${r}`.padEnd(12, '0'), file: `src/${n}-${r}.ts`, line: r, severity: 5,
        title: `run ${n} finding ${r}`, commentId: n * 100 + r, outcome: 'open' as const,
      })),
    })
    const runs = Array.from({ length: 10 }, (_, n) => filler(n))
    runs[0] = { ...runs[0], findings: [ancient({ commentId: 11 }), ...runs[0].findings] }
    runs[9] = { ...runs[9], findings: [...runs[9].findings, ancient({ commentId: 99 })] }
    const ask = recheckQuestions({ version: 1, runs })
    const old = ask.questions.findIndex((q) => q.title === 'THE OLD ONE')
    expect(old).toBeGreaterThanOrEqual(0)
    // One question, both rows — the collapse — and it survives the cap because run 9 is in it.
    expect(ask.addresses[old].map((r) => r.run)).toEqual([0, 9])
  })

  it('asks a byte-identical question once, and answers every row it came from', () => {
    // NOT matching. Two rows whose five visible fields are identical are the same question: asking
    // twice would spend tokens to get two answers that would then have to be reconciled. Nothing is
    // inferred from the collapse — a row that differs anywhere is asked about separately.
    const row = (over: Partial<MarkerFinding>): MarkerFinding => ({
      id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 24, severity: 8, category: 'correctness',
      title: 'no backoff', commentId: null, outcome: 'open', ...over,
    })
    const marker: MarkerState = { version: 1, runs: [
      { headSha: 'r1', at: 'x', findings: [row({ commentId: 11 })] },
      { headSha: 'r2', at: 'x', findings: [row({ commentId: 22 }), row({ line: 25 })] },
    ] }
    const ask = recheckQuestions(marker)
    expect(ask.questions).toHaveLength(2)
    expect(ask.addresses[0]).toEqual([{ run: 0, row: 0 }, { run: 1, row: 0 }])
    expect(ask.addresses[1]).toEqual([{ run: 1, row: 1 }])
  })
})

// ── The answer becomes the outcome ───────────────────────────────────────────────────────────────

describe('diffRuns', () => {
  it('is the model’s answer, and nothing else', () => {
    const judged = new Map<number, RecheckState>([[0, 'still-present'], [1, 'resolved']])
    expect(diffRuns({ previous, replies: [], judged })).toEqual([
      // `index` addresses the ROW, because an id cannot: one run can hold the same file, category
      // and title twice, and two such rows can be given different outcomes.
      { id: findingId(a), index: 0, previous: previous.findings[0], outcome: 'open' },
      { id: findingId(b), index: 1, previous: previous.findings[1], outcome: 'fixed' },
    ])
  })

  it('reads cannot-tell and a missing answer as `open`, never as `fixed`', () => {
    const judged = new Map<number, RecheckState>([[0, 'cannot-tell']])
    expect(diffRuns({ previous, replies: [], judged }).map((o) => o.outcome)).toEqual(['open', 'open'])
  })

  it('lets a `fixed` stand when nobody answered, rather than re-opening it', () => {
    // The other direction of "fails closed", which used to be wrong. Every failure of the pass —
    // threw, timed out, refused its budget, past the row cap, simply did not mention this row —
    // arrives here as a missing answer, and a missing answer used to re-open every `fixed` in the
    // marker on every review. That is not caution: the row was made `fixed` by a model that read the
    // code at a named commit, and a comment on the pull request has already been edited to say so.
    // Re-opening it silently put the marker and that comment into permanent disagreement, and made
    // "a comment is retracted once, ever" false.
    const settled: MarkerRun = {
      ...previous,
      findings: [{ ...previous.findings[0], outcome: 'fixed' }, previous.findings[1]],
    }
    expect(diffRuns({ previous: settled, replies: [], judged: null }).map((o) => o.outcome))
      .toEqual(['fixed', 'open'])
    // "I cannot tell" is not evidence either.
    expect(diffRuns({
      previous: settled, replies: [], judged: new Map<number, RecheckState>([[0, 'cannot-tell']]),
    }).map((o) => o.outcome)).toEqual(['fixed', 'open'])
  })

  it('takes a `fixed` back when the pass says the defect is there after all', () => {
    // The one thing that moves a row off `fixed` without a person: a positive answer. This is design
    // point 3 — the two frozen-wrong rows on the live pull request are repairable — and it is what
    // keeps the rule above from being a way of freezing a wrong `fixed` for ever.
    const settled: MarkerRun = {
      ...previous,
      findings: [{ ...previous.findings[0], outcome: 'fixed' }, previous.findings[1]],
    }
    expect(diffRuns({
      previous: settled, replies: [], judged: new Map<number, RecheckState>([[0, 'still-present']]),
    }).map((o) => o.outcome)).toEqual(['open', 'open'])
  })

  it('carries a person’s verdict to the same finding’s other threads', () => {
    // One defect owns one row per run and gets a NEW comment each review, so a `/dispute` filed
    // today reaches today's row and no other. The same defect's older rows were still put to the
    // model, and one `resolved` then stamped "no longer reported" on the thread beside the one the
    // person wrote on — the product honouring a dispute and contradicting it in the same review.
    const older: MarkerRun = { ...previous, findings: [{ ...previous.findings[0], commentId: 77 }] }
    const out = diffRuns({
      previous: older, judged: new Map<number, RecheckState>([[0, 'resolved']]),
      replies: [], carried: new Map([[findingId(a), 'disputed' as const]]),
    })
    expect(out[0].outcome).toBe('disputed')
  })

  it('calls nothing fixed when the pass produced no answer at all', () => {
    expect(diffRuns({ previous, replies: [], judged: null }).map((o) => o.outcome)).toEqual(['open', 'open'])
    expect(diffRuns({ previous, replies: [] }).map((o) => o.outcome)).toEqual(['open', 'open'])
  })

  it('lets a reply override the model in both directions', () => {
    const out = diffRuns({
      previous, judged: new Map<number, RecheckState>([[0, 'resolved'], [1, 'still-present']]),
      replies: [{ commentId: 1, body: '/dispute intended' }, { commentId: 2, body: '/defer tracked in ACME-40' }],
    })
    expect(out.map((o) => o.outcome)).toEqual(['disputed', 'deferred'])
  })

  it('takes the last verdict on a thread, so a person may change their mind', () => {
    const out = diffRuns({
      previous, judged: null,
      replies: [{ commentId: 1, body: '/defer' }, { commentId: 1, body: '/dispute changed my mind' }],
    })
    expect(out[0].outcome).toBe('disputed')
  })

  it('does not let a pleasantry after a verdict revoke it', () => {
    // Exactly what fetchThreadReplies returns for a real thread: every non-bot comment on it, in
    // created order. A verdict is revoked by another verdict, never by conversation.
    const out = diffRuns({
      previous, judged: null,
      replies: [
        { commentId: 1, body: '/dispute this logger is scrubbed downstream' },
        { commentId: 1, body: 'thanks for flagging it though' },
      ],
    })
    expect(out[0].outcome).toBe('disputed')
  })

  it('returns nothing when there is no previous run', () => {
    expect(diffRuns({ previous: null, replies: [], judged: null })).toEqual([])
  })
})

describe('markerRunFor', () => {
  const anchored: AnchoredFinding = { finding: a, line: 12, side: 'RIGHT' }

  it('records what was said, with the line it was said on and the comment that said it', () => {
    const run = markerRunFor({
      headSha: 'c0ffee0', at: '2026-09-14T12:00:00.000Z',
      posted: { inline: [anchored], summaryOnly: [b] },
      commentIdFor: (f) => (f === a ? 4242 : null),
    })
    expect(run.headSha).toBe('c0ffee0')
    expect(run.findings).toEqual([
      // `category` is still recorded, for a different reason than it was added: it is no longer
      // matched on, it is one of the five fields the re-review pass is shown.
      { id: findingId(a), file: 'src/a.ts', line: 12, severity: 7, category: 'correctness', title: 'A', commentId: 4242, outcome: 'open' },
      // A summary-only finding has no comment of its own, so no thread and no reply can reach it.
      { id: findingId(b), file: 'src/a.ts', line: 10, severity: 7, category: 'correctness', title: 'B', commentId: null, outcome: 'open' },
    ])
  })

  it('writes no anchor: nothing reads one any more', () => {
    const run = markerRunFor({
      headSha: 'c0ffee0', at: '2026-09-14T12:00:00.000Z',
      posted: { inline: [anchored], summaryOnly: [] }, commentIdFor: () => null,
    })
    expect(run.findings[0]).not.toHaveProperty('anchor')
  })

  it('records nothing that was never said', () => {
    // A suppressed finding — below the low-band cap, or refuted by the check pass — was shown to
    // nobody. Recording it would make a later review announce as "fixed" something a reader was
    // never told about.
    const run = markerRunFor({
      headSha: 'c0ffee0', at: '2026-09-14T12:00:00.000Z',
      posted: { inline: [], summaryOnly: [] },
      commentIdFor: () => null,
    })
    expect(run.findings).toEqual([])
  })
})

describe('commentIdsIn', () => {
  it('collects every comment the bot still has a thread under', () => {
    // Every run, not only the last: a reply on a two-review-old thread is still a person's word.
    const two: MarkerState = { version: 1, runs: [previous, { ...previous, headSha: 'newer',
      findings: [{ ...previous.findings[0], commentId: 3 }] }] }
    expect(commentIdsIn(two)).toEqual([1, 2, 3])
    expect(commentIdsIn(null)).toEqual([])
  })
})

describe('applyOutcomes', () => {
  it('writes each change onto the finding it belongs to', () => {
    const changes = diffRuns({
      previous, replies: [], judged: new Map<number, RecheckState>([[0, 'still-present'], [1, 'resolved']]),
    })
    const updated = applyOutcomes(previous, changes)
    expect(updated.findings.map((f) => f.outcome)).toEqual(['open', 'fixed'])
    expect(previous.findings.map((f) => f.outcome)).toEqual(['open', 'open'])   // unmutated
  })

  it('will not re-open what a person already settled', () => {
    // Each review posts new inline comments, so a /dispute reply hangs off the comment of the review
    // it answered. Two reviews later diffRuns looks the finding up under a newer comment id, finds
    // no reply and says "open". A standing verdict is revoked by another verdict, or by the finding
    // being judged gone — never by silence.
    const settled: MarkerRun = {
      ...previous,
      findings: [{ ...previous.findings[0], outcome: 'disputed' }, previous.findings[1]],
    }
    const stillThere = applyOutcomes(settled, diffRuns({
      previous: settled, replies: [], judged: new Map<number, RecheckState>([[0, 'still-present']]),
    }))
    expect(stillThere.findings[0].outcome).toBe('disputed')

    const gone = applyOutcomes(settled, diffRuns({
      previous: settled, replies: [], judged: new Map<number, RecheckState>([[0, 'resolved']]),
    }))
    expect(gone.findings[0].outcome).toBe('fixed')

    const changedMind = applyOutcomes(settled, diffRuns({
      previous: settled, replies: [{ commentId: 1, body: '/defer next sprint' }], judged: null,
    }))
    expect(changedMind.findings[0].outcome).toBe('deferred')
  })
})

describe('applyOutcomes: two rows can share an id and not share a fate', () => {
  // The model reported one title twice in one file — report.ts already records that this happens and
  // nothing dedupes the list — so both rows carry the same id. Joining outcomes back by id wrote one
  // row's outcome onto the other.
  const DUP = { file: 'src/handlers.ts', category: 'security', title: 'the session id is logged' }
  const dupRow = (line: number, commentId: number | null): MarkerFinding => ({
    id: findingId(DUP), file: DUP.file, line, severity: 6, category: DUP.category, title: DUP.title,
    commentId, outcome: 'open',
  })

  it('keeps one row open while its twin is judged gone', () => {
    const run: MarkerRun = {
      headSha: 'aaaaaaa', at: '2026-09-15T07:55:30.000Z',
      findings: [dupRow(42, 900001), dupRow(210, null)],
    }
    const changes = diffRuns({
      previous: run, replies: [], judged: new Map<number, RecheckState>([[0, 'still-present'], [1, 'resolved']]),
    })
    expect(applyOutcomes(run, changes).findings.map((f) => f.outcome)).toEqual(['open', 'fixed'])
  })

  it('does not let the twin’s repair erase a person’s verdict', () => {
    const run: MarkerRun = {
      headSha: 'aaaaaaa', at: '2026-09-15T07:55:30.000Z',
      findings: [dupRow(42, 900001), dupRow(210, null)],
    }
    const changes = diffRuns({
      previous: run, judged: new Map<number, RecheckState>([[0, 'resolved'], [1, 'resolved']]),
      replies: [{ commentId: 900001, body: '/dispute this logger is scrubbed downstream' }],
    })
    expect(applyOutcomes(run, changes).findings.map((f) => f.outcome)).toEqual(['disputed', 'fixed'])
  })

  it('ignores a change that does not address the row it lands on', () => {
    const run: MarkerRun = { headSha: 'aaaaaaa', at: 'x', findings: [dupRow(42, null)] }
    const stray: OutcomeChange[] = [
      { id: 'notthisrow0', index: 0, previous: dupRow(42, null), outcome: 'fixed' },
    ]
    expect(applyOutcomes(run, stray).findings.map((f) => f.outcome)).toEqual(['open'])
  })
})

// ── The two live failures, through the real state machine ────────────────────────────────────────
// Measured on crissmoldovan/review-agent-proving-ground #1. Both failures came from INFERRING a
// repair from two snapshots; the information is not in them. Criss, 2026-09-16: ask the model.

const SHA_42DACAE = '42dacae94b6a6951a1e797d8d8c7e19f6ad5ed6b'

const runOne: MarkerRun = {
  headSha: SHA_42DACAE, at: '2026-09-15T07:55:30.000Z',
  findings: [{
    id: 'a7ac9b0581f8', file: 'src/retry.ts', line: 24, severity: 8,
    title: 'Computed backoff delay is never used; the wait is always 0ms',
    commentId: 4013307235, outcome: 'open',
  }],
}

/** This run's own findings, which the outcome of a previous row no longer depends on in any way. */
const thisRun = (over: Partial<MarkerRun> = {}): MarkerRun => ({
  headSha: '487f857', at: '2026-09-16T09:00:00.000Z', findings: [], ...over,
})

describe('the wording failure: an outcome does not depend on what this run called anything', () => {
  // THE FIRST LIVE FAILURE. Two reviews, one commit, not a byte changed between them. The model
  // rewrote its own title, `findingId` hashes the title, so one bug read as two and the old row was
  // marked `fixed` on code nobody had touched. Three live defects declared repaired.
  const REWORDED = 'No backoff: computed delay is discarded, setTimeout is always 0'

  it('is `fixed` when the model says resolved', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [runOne] },
      run: thisRun(), replies: [], judgements: said({ version: 1, runs: [runOne] }, 'resolved'),
    })
    expect(state.runs[0].findings[0].outcome).toBe('fixed')
  })

  it('is `open` when the model says still-present, on the very same inputs', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [runOne] },
      run: thisRun(), replies: [], judgements: said({ version: 1, runs: [runOne] }, 'still-present'),
    })
    expect(state.runs[0].findings[0].outcome).toBe('open')
  })

  it('is the same answer however this run worded, severitied or placed its own findings', () => {
    // The old matcher read all three of these. Whatever this run says about the same file, the
    // previous row's outcome is the answer to the question that was actually asked about the code.
    const worded = (title: string, severity: number, line: number): MarkerRun => thisRun({
      findings: [{
        id: 'ffffffffffff', file: 'src/retry.ts', line, severity, category: 'correctness',
        title, commentId: 99, outcome: 'open',
      }],
    })
    for (const run of [
      thisRun(),                                   // this run reported nothing at all
      worded(REWORDED, 8, 23),                     // reported, reworded, one line up
      worded('Computed backoff delay is never used; the wait is always 0ms', 2, 24), // verbatim, downgraded
      worded('something else entirely', 3, 400),
    ]) {
      const state = nextMarkerState({
        previous: { version: 1, runs: [runOne] }, run, replies: [],
        judgements: said({ version: 1, runs: [runOne] }, 'resolved'),
      })
      expect(state.runs[0].findings[0].outcome).toBe('fixed')
    }
  })
})

describe('the wrapped-line failure: a repair that deletes nothing is still a repair', () => {
  // THE SECOND LIVE FAILURE, and the regression lock that matters most. The anchor design said
  // "fixed when the line is gone". Measured: the repair WRAPPED two lines in
  // `if (attempt < attempts - 1) { ... }` and re-indented them. Both lines survive word for word,
  // and whitespace is normalised before hashing — so the anchor was still in the file and a genuine
  // repair read as unfixed. Under both previous designs this produced `open`.
  const BEFORE = [
    '  for (let attempt = 0; attempt < attempts; attempt++) {',
    '    try {',
    '      return await fn()',
    '    } catch (error) {',
    '      lastError = error',
    '      const delayMs = baseDelayMs * 2 ** attempt',
    '      await new Promise((resolve) => setTimeout(resolve, delayMs))',
    '    }',
    '  }',
  ]
  const AFTER = [
    '  for (let attempt = 0; attempt < attempts; attempt++) {',
    '    try {',
    '      return await fn()',
    '    } catch (error) {',
    '      lastError = error',
    '      if (attempt < attempts - 1) {',
    '        const delayMs = baseDelayMs * 2 ** attempt',
    '        await new Promise((resolve) => setTimeout(resolve, delayMs))',
    '      }',
    '    }',
    '  }',
  ]
  const SLEPT_AFTER_THE_LAST_ATTEMPT: MarkerRun = {
    headSha: SHA_42DACAE, at: '2026-09-15T07:55:30.000Z',
    findings: [{
      id: '32bb11dbdd67', file: 'src/retry.ts', line: 20, severity: 4, category: 'correctness',
      title: 'Sleeps after the final failed attempt', commentId: 4013794900, outcome: 'open',
    }],
  }

  it('the repaired lines are still in the file, word for word', () => {
    // The premise, asserted rather than asserted-about: this is why "the line is gone" could not see
    // the repair. Whitespace is all that changed, and the anchor normalised whitespace away.
    const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
    for (const line of BEFORE.slice(5, 7)) {
      expect(AFTER.map(squash)).toContain(squash(line))
    }
  })

  it('is `fixed`, because the model read the guard and said resolved', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [SLEPT_AFTER_THE_LAST_ATTEMPT] },
      run: thisRun(), replies: [],
      judgements: said({ version: 1, runs: [SLEPT_AFTER_THE_LAST_ATTEMPT] }, 'resolved'),
    })
    expect(state.runs[0].findings[0].outcome).toBe('fixed')
  })
})

describe('nextMarkerState', () => {
  const runTwo: MarkerRun = {
    headSha: 'new', at: '2026-09-14T12:00:00.000Z',
    findings: [{ id: findingId(a), file: a.file, line: 11, severity: 7, title: 'A', commentId: 9, outcome: 'open' }],
  }

  it('settles the previous run and appends the new one', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [previous] },
      run: runTwo, replies: [{ commentId: 2, body: 'thanks, fixed' }],
      judgements: said({ version: 1, runs: [previous] }, 'still-present', 'resolved'),
    })
    expect(state.runs).toHaveLength(2)
    expect(state.runs[0].findings.map((f) => f.outcome)).toEqual(['open', 'fixed'])
    expect(state.runs[1]).toEqual(runTwo)
  })

  it('reaches EVERY previous run, not only the last', () => {
    // THE TEST. The old code settled `older.at(-1)` and nothing else, because matching was pairwise.
    // Asking a model is not, so a row frozen wrong two reviews ago is reachable — which is the only
    // way the live marker's rows in runs 1, 2 and 3 are ever repaired.
    const runAt = (n: number, title: string): MarkerRun => ({
      headSha: `sha${n}`, at: 'x',
      findings: [{ id: `id${n}`.padEnd(12, '0'), file: `src/${n}.ts`, line: n, severity: 5, title, commentId: n, outcome: 'open' }],
    })
    const four: MarkerState = { version: 1, runs: [runAt(1, 'ONE'), runAt(2, 'TWO'), runAt(3, 'THREE'), runAt(4, 'FOUR')] }
    // Question 0 is run 1's row. Only it is resolved.
    const state = nextMarkerState({
      previous: four, run: thisRun(), replies: [],
      judgements: said(four, 'resolved', 'still-present', 'still-present', 'still-present'),
    })
    expect(state.runs.slice(0, 4).map((r) => r.findings[0].outcome))
      .toEqual(['fixed', 'open', 'open', 'open'])
  })

  it('undoes a `fixed` an earlier review got wrong', () => {
    const wronglyFixed: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'a7ac9b0581f8', file: 'src/retry.ts', line: 24, severity: 8, title: 'still there', commentId: 1, outcome: 'fixed' },
    ] }] }
    const state = nextMarkerState({
      previous: wronglyFixed, run: thisRun(), replies: [],
      judgements: said(wronglyFixed, 'still-present'),
    })
    expect(state.runs[0].findings[0].outcome).toBe('open')
  })

  it('calls nothing fixed when there are no judgements — a pass that failed repairs nothing', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [previous] }, run: runTwo, replies: [], judgements: [],
    })
    expect(state.runs[0].findings.map((f) => f.outcome)).toEqual(['open', 'open'])
    const noneAtAll = nextMarkerState({
      previous: { version: 1, runs: [previous] }, run: runTwo, replies: [],
    })
    expect(noneAtAll.runs[0].findings.map((f) => f.outcome)).toEqual(['open', 'open'])
  })

  it('addresses judgements through the same question list the pass was given', () => {
    // A judgement's index is a position in `recheckQuestions(previous).questions`, and a row a
    // person settled is not in that list. Index 0 is therefore run 0 row 1, not run 0 row 0.
    const withVerdict: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'f', line: 1, severity: 5, title: 'DISPUTED', commentId: 1, outcome: 'disputed' },
      { id: 'bbbbbbbbbbbb', file: 'f', line: 2, severity: 5, title: 'OPEN', commentId: 2, outcome: 'open' },
    ] }] }
    const state = nextMarkerState({
      previous: withVerdict, run: thisRun(), replies: [], judgements: said(withVerdict, 'resolved'),
    })
    expect(state.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'fixed'])
  })

  it('attaches nothing for an index past the end of the ask', () => {
    // The second of the two places an out-of-range index could attach an answer to the wrong finding
    // — and until now the only one with no test: replacing `if (rows === undefined) continue` with a
    // fallback to `addresses[0]`, which is literally the mis-attribution the comment above it claims
    // to prevent, left all 910 tests green. The pass makes the same check, but it reaches production
    // as an injected dependency that both callers wrap, so this layer is the one that holds if a
    // wrapper ever hands over something the pass did not produce.
    const one: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 1, severity: 5, title: 'ONLY', commentId: 1, outcome: 'open' },
    ] }] }
    const state = nextMarkerState({
      previous: one, run: thisRun(), replies: [],
      judgements: [{ index: 7, file: 'src/retry.ts', state: 'resolved', reason: 'r', evidence: [] }],
    })
    expect(state.runs[0].findings[0].outcome).toBe('open')
  })

  it('attaches nothing for an answer that names a different file than the question', () => {
    // The shape an index check cannot see: a list answered from 1 instead of 0, where every index is
    // still in range and every answer lands on its neighbour. Here the pass's answer about question
    // 0 (`src/one.ts`) is offered for question 1 (`src/two.ts`), and question 1's row would be
    // written `fixed` and its comment retracted on a verdict formed about another file.
    const two: MarkerState = { version: 1, runs: [{ headSha: 'r', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'src/one.ts', line: 1, severity: 5, title: 'ONE', commentId: 1, outcome: 'open' },
      { id: 'bbbbbbbbbbbb', file: 'src/two.ts', line: 2, severity: 5, title: 'TWO', commentId: 2, outcome: 'open' },
    ] }] }
    const state = nextMarkerState({
      previous: two, run: thisRun(), replies: [],
      judgements: [{ index: 1, file: 'src/one.ts', state: 'resolved', reason: 'about ONE', evidence: [] }],
    })
    expect(state.runs[0].findings.map((f) => f.outcome)).toEqual(['open', 'open'])
  })

  it('carries a verdict onto the finding’s new comment', () => {
    const state = nextMarkerState({
      previous: { version: 1, runs: [previous] },
      run: runTwo, replies: [{ commentId: 1, body: '/dispute intended' }],
      judgements: said({ version: 1, runs: [previous] }, 'still-present', 'still-present'),
    })
    expect(state.runs[0].findings[0].outcome).toBe('disputed')
    // The new run posted finding A under comment 9; the dispute is on comment 1 and would be
    // unreachable next time. Carried, it survives the review after this one.
    // NOTE, out loud rather than left to be discovered: this carry keys on `findingId`, which
    // hashes the TITLE. It is the last wording-dependent join in this file — a reworded finding
    // still loses its carried `/dispute`. Out of scope for the outcome change; not forgotten.
    expect(state.runs[1].findings[0].outcome).toBe('disputed')
  })

  it('is the whole state when there was no previous review', () => {
    const state = nextMarkerState({ previous: null, run: runTwo, replies: [], judgements: [] })
    expect(state).toEqual({ version: 1, runs: [runTwo] })
  })

  it('keeps at most MAX_RUNS runs', () => {
    const old = Array.from({ length: MAX_RUNS }, (_, i) => ({
      headSha: `sha${i}`, at: '2026-09-12T10:00:00.000Z', findings: [],
    }))
    const state = nextMarkerState({
      previous: { version: 1, runs: old }, run: runTwo, replies: [], judgements: [],
    })
    expect(state.runs).toHaveLength(MAX_RUNS)
    expect(state.runs[0].headSha).toBe('sha1')
    expect(state.runs.at(-1)).toEqual(runTwo)
  })
})

// ── Retraction ───────────────────────────────────────────────────────────────────────────────────

describe('retractableComments', () => {
  const row = (over: Partial<MarkerFinding> & { id: string }): MarkerFinding => ({
    file: 'src/retry.ts', line: 23, severity: 8, category: 'correctness', title: 't',
    commentId: null, outcome: 'open', ...over,
  })
  const runWith = (...findings: MarkerFinding[]): MarkerRun =>
    ({ headSha: '42dacae', at: 'x', findings })

  it('names the comment of a finding this review judged resolved', () => {
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013794900 }))]
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013794900, outcome: 'fixed' }))]
    expect(retractableComments({ settled, before }))
      .toEqual([{ commentId: 4013794900, file: 'src/retry.ts', ids: ['aaaaaaaaaaaa'] }])
  })

  it('names nothing for a finding that is still open, or that a person settled', () => {
    const rows = [
      row({ id: 'aaaaaaaaaaaa', commentId: 1, outcome: 'open' }),
      row({ id: 'bbbbbbbbbbbb', commentId: 2, outcome: 'disputed' }),
      row({ id: 'cccccccccccc', commentId: 3, outcome: 'deferred' }),
    ]
    expect(retractableComments({ settled: [runWith(...rows)], before: [runWith(...rows)] })).toEqual([])
  })

  it('skips a finding with no comment of its own', () => {
    // Most rows. Three of run 1's four findings were summary-only, so there is nothing to edit.
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: null }))]
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: null, outcome: 'fixed' }))]
    expect(retractableComments({ settled, before })).toEqual([])
  })

  it('will not retract a comment a still-open finding also points at', () => {
    // `commentIdFor` keys on `findingId`, and two findings sharing file, category and title share one
    // id — so `readBackCommentIds` writes ONE map entry and both rows carry the same comment id.
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 900001 }), row({ id: 'aaaaaaaaaaaa', commentId: 900001 }))]
    const settled = [runWith(
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'open' }),
    )]
    expect(retractableComments({ settled, before })).toEqual([])
  })

  it('retracts once when both twins on one comment are gone', () => {
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 900001 }), row({ id: 'aaaaaaaaaaaa', commentId: 900001 }))]
    const settled = [runWith(
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
    )]
    // Both ids travel with the comment: the caller checks them against what THIS review said.
    expect(retractableComments({ settled, before }))
      .toEqual([{ commentId: 900001, file: 'src/retry.ts', ids: ['aaaaaaaaaaaa', 'aaaaaaaaaaaa'] }])
  })

  it('reaches a comment from an OLDER run, not only the last one', () => {
    // Its own former limit, which run 4 hit on the live pull request: only the last run was ever
    // settled, so an older run's comment could never be retracted by any later review.
    const before = [
      runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013307235 })),
      runWith(row({ id: 'bbbbbbbbbbbb', commentId: 4013794900 })),
    ]
    const settled = [
      runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013307235, outcome: 'fixed' })),
      runWith(row({ id: 'bbbbbbbbbbbb', commentId: 4013794900, outcome: 'open' })),
    ]
    expect(retractableComments({ settled, before }))
      .toEqual([{ commentId: 4013307235, file: 'src/retry.ts', ids: ['aaaaaaaaaaaa'] }])
  })

  it('never retracts the same comment twice across runs', () => {
    // A row that was ALREADY `fixed` before this review settled anything has already had its one
    // retraction. Offering it again would spend a request per review for ever, and a marker write
    // that lands after the edit would keep re-appending the note but for the body's own guard.
    const already = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }))]
    expect(retractableComments({ settled: already, before: already })).toEqual([])
  })

  it('never retracts a comment on a finding a person had settled, even two reviews later', () => {
    // THE CARRY. A `/dispute` is filed on run 1's comment; run 2 posts a NEW comment for the same
    // finding and `nextMarkerState` carries the verdict onto it, where nobody has replied. When the
    // model then says resolved, `applyOutcomes` lets `fixed` overwrite the carried `disputed` —
    // deliberately, the finding is gone so there is nothing left to dispute — and by the time the
    // settled row is read, the verdict it is supposed to protect is no longer in it. Reading the row
    // as it stood BEFORE is the only place it is legible.
    const disputed = row({ id: 'aaaaaaaaaaaa', commentId: 1002, outcome: 'disputed' })
    const before = [runWith(disputed)]
    const settled = [runWith({ ...disputed, outcome: 'fixed' })]
    expect(retractableComments({ settled, before })).toEqual([])
    // A row that stood `open` is retracted as before: the guard is the verdict, not the carry.
    expect(retractableComments({
      settled, before: [runWith({ ...disputed, outcome: 'open' })],
    })).toHaveLength(1)
  })

  it('reads the before-state by row, and ignores one that does not line up', () => {
    // Same rule as `applyOutcomes`: an index whose id disagrees is not this row's history, so it
    // decides nothing. It withholds nothing and invents nothing.
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 1, outcome: 'fixed' }))]
    const mismatched = [runWith(row({ id: 'zzzzzzzzzzzz', commentId: 1, outcome: 'disputed' }))]
    expect(retractableComments({ settled, before: mismatched })).toHaveLength(1)
  })

  it('has nothing to say about a pull request with no previous run', () => {
    expect(retractableComments({ settled: [], before: [] })).toEqual([])
  })
})

describe('reinstatableComments', () => {
  const row = (over: Partial<MarkerFinding> & { id: string }): MarkerFinding => ({
    file: 'src/retry.ts', line: 23, severity: 8, category: 'correctness', title: 't',
    commentId: null, outcome: 'open', ...over,
  })
  const runWith = (...findings: MarkerFinding[]): MarkerRun =>
    ({ headSha: '42dacae', at: 'x', findings })

  it('names the comment of a row that stood `fixed` and does not any more', () => {
    // The other half of design point 3, and the half that reaches a reader. The marker could always
    // push a wrong `fixed` back to `open`; the comment went on saying "the reviewer read this at
    // <sha> and no longer finds this issue there" under a defect the product had just re-confirmed.
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013794900, outcome: 'fixed' }))]
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 4013794900, outcome: 'open' }))]
    expect(reinstatableComments({ settled, before }))
      .toEqual([{ commentId: 4013794900, file: 'src/retry.ts', ids: ['aaaaaaaaaaaa'] }])
  })

  it('names it when a person disputes it, too', () => {
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 9, outcome: 'fixed' }))]
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 9, outcome: 'disputed' }))]
    expect(reinstatableComments({ settled, before })).toHaveLength(1)
  })

  it('names nothing for a row that is still `fixed`, or that never was', () => {
    const stays = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 9, outcome: 'fixed' }))]
    expect(reinstatableComments({ settled: stays, before: stays })).toEqual([])
    const neverWas = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 9, outcome: 'open' }))]
    expect(reinstatableComments({ settled: neverWas, before: neverWas })).toEqual([])
  })

  it('reinstates on ANY live row behind the comment, where a retraction needs every row gone', () => {
    // Two findings sharing a comment. The note says nothing is reported there, so one live finding
    // is enough to make it false — the mirror of the retraction rule, and the same principle.
    const before = [runWith(
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
    )]
    const settled = [runWith(
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'open' }),
      row({ id: 'aaaaaaaaaaaa', commentId: 900001, outcome: 'fixed' }),
    )]
    expect(reinstatableComments({ settled, before })).toHaveLength(1)
  })

  it('says nothing about a row with no comment, or a history that does not line up', () => {
    const before = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: null, outcome: 'fixed' }))]
    const settled = [runWith(row({ id: 'aaaaaaaaaaaa', commentId: null, outcome: 'open' }))]
    expect(reinstatableComments({ settled, before })).toEqual([])
    // Same rule as `retractableComments`: an index whose id disagrees is not this row's history, so
    // there is no recorded `fixed` to take back.
    expect(reinstatableComments({
      settled: [runWith(row({ id: 'aaaaaaaaaaaa', commentId: 5, outcome: 'open' }))],
      before: [runWith(row({ id: 'zzzzzzzzzzzz', commentId: 5, outcome: 'fixed' }))],
    })).toEqual([])
  })

  it('fires only on a real repair, not on a pass that failed', () => {
    // The two changes are one change: because `diffRuns` lets a `fixed` stand through silence, a
    // failed pass produces nothing to reinstate. Without that rule every failed pass would re-open
    // every `fixed` row and append a "reported again" note to every retracted comment.
    const fixedRow: MarkerState = { version: 1, runs: [runWith(
      row({ id: 'aaaaaaaaaaaa', commentId: 4013794900, outcome: 'fixed' }),
    )] }
    const after = nextMarkerState({
      previous: fixedRow, run: { headSha: 'new', at: 'x', findings: [] }, replies: [], judgements: [],
    })
    expect(reinstatableComments({ settled: after.runs.slice(0, -1), before: fixedRow.runs })).toEqual([])
  })
})

describe('the carried verdict a retraction must not stamp on, end to end', () => {
  it('keeps a person out of it through three runs of nextMarkerState', () => {
    // Through the real state machine rather than by hand, so the fixture cannot drift away from what
    // `nextMarkerState` actually writes.
    const finding: Finding = { ...base, file: 'src/retry.ts', line: 13, title: 'no backoff' }
    const runOf = (commentId: number): MarkerRun => ({
      headSha: 'h', at: 'x',
      findings: [{
        id: findingId(finding), file: 'src/retry.ts', line: 13, severity: 7,
        category: 'correctness', title: 'no backoff', commentId, outcome: 'open',
      }],
    })
    // Run 2: the person disputes run 1's comment (1001), and run 2 posts a new comment (1002).
    const two = nextMarkerState({
      previous: { version: 1, runs: [runOf(1001)] }, run: runOf(1002),
      replies: [{ commentId: 1001, body: '/dispute the caller waits' }],
      judgements: said({ version: 1, runs: [runOf(1001)] }, 'still-present'),
    })
    expect(two.runs.map((r) => r.findings[0].outcome)).toEqual(['disputed', 'disputed'])

    // Run 3: nobody has replied to 1002. Once a person has spoken, neither row is put to the model
    // at all — `recheckQuestions` leaves both out — so there is no question 0 for this judgement to
    // be about, it addresses nothing, and both rows keep the verdict. This is STRICTLY stronger than
    // the rule it replaces: under the matcher a carried `disputed` could be overwritten by an
    // inferred `fixed`, and the retraction guard existed to catch what that let through.
    const three = nextMarkerState({
      previous: two, run: runOf(1003), replies: [], judgements: said(two, 'resolved'),
    })
    expect(recheckQuestions(two).questions).toEqual([])
    expect(three.runs.slice(0, 2).map((r) => r.findings[0].outcome)).toEqual(['disputed', 'disputed'])
    expect(retractableComments({ settled: three.runs.slice(0, 2), before: two.runs })).toEqual([])
  })

  it('and a settled row is never put back to the model', () => {
    // Renamed 2026-09-16: this said "a person who changes their mind is asked about again" and
    // asserted the opposite — that a settled row is never asked about. It is the right assertion
    // under the wrong name. Changing one's mind is the case below.
    const settled: MarkerState = { version: 1, runs: [{ headSha: 'h', at: 'x', findings: [
      { id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 13, severity: 7, title: 'no backoff', commentId: 1001, outcome: 'disputed' },
    ] }] }
    expect(recheckQuestions(settled).questions).toEqual([])
  })

  it('and a person who changes their mind changes the outcome, through the state machine', () => {
    // The verdict is theirs to withdraw and theirs to replace, and only theirs. `/dispute` today,
    // `/defer` tomorrow: the later word stands, and the model is never consulted about either.
    const runOf = (commentId: number, outcome: 'open' | 'disputed'): MarkerRun => ({
      headSha: 'h', at: 'x',
      findings: [{
        id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 13, severity: 7, category: 'correctness',
        title: 'no backoff', commentId, outcome,
      }],
    })
    const disputed = nextMarkerState({
      previous: { version: 1, runs: [runOf(1001, 'open')] }, run: runOf(1002, 'open'),
      replies: [{ commentId: 1001, body: '/dispute the caller waits' }], judgements: [],
    })
    expect(disputed.runs.map((r) => r.findings[0].outcome)).toEqual(['disputed', 'disputed'])
    const changedMind = nextMarkerState({
      previous: disputed, run: runOf(1003, 'open'),
      replies: [
        { commentId: 1001, body: '/dispute the caller waits' },
        { commentId: 1001, body: '/defer fair enough, next sprint' },
      ],
      judgements: [],
    })
    expect(changedMind.runs.map((r) => r.findings[0].outcome)).toEqual(['deferred', 'deferred', 'deferred'])
  })

  it('and a dispute filed on one thread protects the same finding’s other threads', () => {
    // A defect reported twice owns two rows and two comments. The `/dispute` hangs off the newer
    // one; the older one is still `open` in the marker, is still asked about, and one `resolved`
    // stamped "no longer reported" on it — the product honouring a person's objection on one thread
    // and contradicting it on another, in the same review.
    const runOf = (commentId: number): MarkerRun => ({
      headSha: 'h', at: 'x',
      findings: [{
        id: 'aaaaaaaaaaaa', file: 'src/retry.ts', line: 13, severity: 7, category: 'correctness',
        title: 'no backoff', commentId, outcome: 'open',
      }],
    })
    const twoRuns: MarkerState = { version: 1, runs: [runOf(1001), runOf(1002)] }
    const state = nextMarkerState({
      previous: twoRuns, run: runOf(1003),
      // Filed under the SECOND review's comment only.
      replies: [{ commentId: 1002, body: '/dispute the caller waits' }],
      judgements: said(twoRuns, 'resolved'),
    })
    expect(state.runs.map((r) => r.findings[0].outcome)).toEqual(['disputed', 'disputed', 'disputed'])
    expect(retractableComments({ settled: state.runs.slice(0, 2), before: twoRuns.runs })).toEqual([])
  })
})

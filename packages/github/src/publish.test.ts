import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  buildReviewRecord, defaultDeploymentConfig, resolveSettings,
  type CheckVerdict, type EngineFailure, type EngineResult, type Finding, type RecheckSkipped,
  type RecheckState, type ReportMode, type ReviewOutput, type ReviewRequest, type Usage,
} from '@review-agent/core'
import { describe, expect, it } from 'vitest'
import {
  commentIdsIn, decodeMarker, encodeMarker, findingId, recheckQuestions, type MarkerState,
} from './marker'
import type { PullRequestContext } from './pr'
import { publishReview } from './publish'
import type { RecheckResult, RunReviewResult } from './run-review'

// The same two shas run-review.test.ts uses, so base and head are told apart by eye in a failure.
const HEAD_SHA = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const BASE_SHA = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'
const OLD_SHA = '1'.repeat(40)

const BOT = { login: 'review-agent[bot]' }
const HUMAN = { login: 'crissmoldovan' }

// A real directory, because anchorFindings checks every model-written path against the files that
// are really there (design §4.3) AND reads the line each finding points at, to hash it. A one-line
// fixture would leave every anchor absent and the identity rule untested here: the findings below
// point at lines 100, 101, 12, 30 and 200, so the files have to be at least that long. Every line
// differs from every other, so a hash tells them apart.
const lines = (n: number, text: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => text(i + 1)).join('\n') + '\n'
const CHECKOUT = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'ra-publish-'))
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(dir, '.github/workflows/publish.yml'), lines(130, (i) => `    - run: step-${i}`))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/release.ts'), lines(220, (i) => `export const release${i} = () => {}`))
  return dir
})()

// One hunk whose new side is lines 98 to 103, so line 100 can carry an inline comment.
const PATCH = '@@ -98,2 +98,6 @@\n context\n+a\n+b\n+c\n+d\n context\n'

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16, headSha: HEAD_SHA, baseSha: BASE_SHA,
  title: 'ci(publish): refuse a tag that does not match package.json', body: '',
  changedFiles: [{ path: '.github/workflows/publish.yml', status: 'modified', patch: PATCH }],
  diff: '',
}
const REQUEST: ReviewRequest = { repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA }

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: '.github/workflows/publish.yml', line: 100, endLine: null,
  severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes',
  explanation: 'A tag pushed from any branch publishes that branch.',
  evidence: [], suggestion: null, ...over,
})
// In the diff, and at or above the inline threshold of 5: it goes on its line.
const INLINE = finding()
// Real, but in a file the pull request does not touch: it can only be said in the summary.
const ELSEWHERE = finding({
  file: 'src/release.ts', line: 30, severity: 7, category: 'correctness',
  title: 'the release token is logged on failure',
})
// A path that climbs out of the checkout. It addresses nothing, so it is said nowhere.
const OUTSIDE = finding({ file: '../outside.txt', line: 1, title: 'a path that is not in the checkout' })

// A real basic-tier run and its check pass (design §8), as run-review.test.ts records them.
const USAGE: Usage = {
  costUsd: 0.9412, inputTokens: 32, outputTokens: 19350,
  cacheReadTokens: 514625, cacheWriteTokens: 50190, turns: 18, durationMs: 279107,
}
const CHECK_USAGE: Usage = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104,
  cacheReadTokens: 61230, cacheWriteTokens: 18944, turns: 8, durationMs: 41022,
}

const output = (findings: Finding[]): ReviewOutput => ({
  summary: 'Adds a tag check to publish.yml.',
  intent: { verdict: 'matches', note: 'It does what the description says.' },
  findings,
  inconclusive: [],
})

const RECHECK_USAGE: Usage = {
  costUsd: 0.0968, inputTokens: 4, outputTokens: 1264,
  cacheReadTokens: 8493, cacheWriteTokens: 9206, turns: 4, durationMs: 41200,
}

/** What the re-review pass answered, positionally, over the questions a marker produces. `null` in
 *  a slot is a row it did not answer at all — the fail-closed case, which must read as `open`.
 *  Each answer NAMES the file of the question it is about, as a real answer has to: one that does
 *  not is dropped on the way back in, so a helper that left it out would be asserting on judgements
 *  the product would have thrown away. */
const said = (marker: MarkerState | null, ...states: (RecheckState | null)[]): RecheckResult => {
  const questions = recheckQuestions(marker).questions
  return {
    asked: questions,
    judgements: states.flatMap((state, index) => state === null ? [] : [{
      index, file: questions[index]?.file ?? '(no question at this index)',
      state, reason: 'the code says so', evidence: [],
    }]),
    usage: RECHECK_USAGE, ran: true, skipped: null,
  }
}

/** A pass that produced nothing: it threw, timed out, could not be afforded, or answered unusably.
 *  All four are one shape to every reader — no judgements. */
const answeredNothing = (marker: MarkerState | null, skipped: RecheckSkipped): RecheckResult => ({
  asked: recheckQuestions(marker).questions, judgements: [],
  usage: skipped === 'unreadable' ? RECHECK_USAGE : {
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turns: 0, durationMs: 0,
  },
  ran: false, skipped,
})

/** A finished review, built the way runReview builds one: settings resolved, never hand-written,
 *  and a real record, so these tests read the same values the pipeline hands over. */
const reviewed = (over: {
  findings?: Finding[]; output?: ReviewOutput | null; failure?: EngineFailure | null
  verdicts?: CheckVerdict[]; mode?: ReportMode; recheck?: RecheckResult | null
} = {}): RunReviewResult => {
  const deployment = defaultDeploymentConfig()
  if (over.mode !== undefined) deployment.report.mode = over.mode
  const settings = resolveSettings({ deployment, repo: null, request: REQUEST })
  const out = over.output !== undefined ? over.output : output(over.findings ?? [INLINE, ELSEWHERE, OUTSIDE])
  const result: EngineResult = {
    output: out, usage: USAGE, cutShort: over.failure?.kind === 'budget', wrapUpFired: false,
    failure: over.failure ?? null,
  }
  const check = over.verdicts === undefined ? null : { verdicts: over.verdicts, usage: CHECK_USAGE }
  const recheck = over.recheck ?? null
  const record = buildReviewRecord({
    request: REQUEST, settings, result, skills: [], check, recheck, removedFromCheckout: [],
    startedAt: new Date('2026-09-14T10:00:00.000Z'), finishedAt: new Date('2026-09-14T10:04:39.000Z'),
  })
  return {
    pr: PR, request: REQUEST, settings, result, check, recheck, skills: [], checkoutDir: CHECKOUT,
    removedFromCheckout: [], record,
  }
}

type Call = { route: string; params: Record<string, unknown> }
/** The fields of GET .../pulls/{n}/comments that Task 4's read-back and Task 7's reply reader parse. */
type ReviewCommentOnWire = {
  id: number; path: string; line: number | null; body: string
  pull_request_review_id: number | null; in_reply_to_id: number | null; user: { login: string } | null
  /** Which pull request the comment is on. Only the retraction read parses it — it is the one thing
   *  that says so, because the edit route carries no pull number. Left out here means this one. */
  pull_request_url?: string
}
/** The fields of GET .../issues/{n}/comments that Task 5's finder parses. */
type IssueCommentOnWire = { id: number; body: string | null; user: { login: string } | null }

const REVIEW_CREATE = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews'
const REVIEW_COMMENTS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments'
const SUMMARY_LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_CREATE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_EDIT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
const RETRACT_READ = 'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}'
const RETRACT_EDIT = 'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}'

/** A small GitHub that remembers what is written to it. A created review adds its comments to the
 *  pull request's comment list with fresh ids from 5001, as GitHub does. A route this task should
 *  not call throws, rather than quietly answering undefined. */
const fakeGitHub = (seed: {
  issueComments?: IssueCommentOnWire[]; reviewComments?: ReviewCommentOnWire[]
  /** An HTTP status the first review that carries comments is refused with. */
  refuseInlineWith?: number
  /** An HTTP status every retraction edit is refused with. */
  refuseRetractionWith?: number
} = {}) => {
  const calls: Call[] = []
  const issueComments = [...(seed.issueComments ?? [])]
  const reviewComments = [...(seed.reviewComments ?? [])]
  let nextCommentId = 5001
  let nextReviewId = 900
  let refused = false
  const pageOf = <T>(all: T[], params: Record<string, unknown>): T[] => {
    const page = Number(params.page ?? 1)
    const size = Number(params.per_page ?? 30)
    return all.slice((page - 1) * size, page * size)
  }
  const request = async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params })
    if (route === SUMMARY_LIST) return { status: 200, headers: {}, data: pageOf(issueComments, params) }
    if (route === SUMMARY_CREATE) {
      issueComments.push({ id: 8100, body: String(params.body), user: BOT })
      return { status: 201, headers: {}, data: { id: 8100 } }
    }
    if (route === SUMMARY_EDIT) {
      const edited = issueComments.find((c) => c.id === params.comment_id)
      if (edited !== undefined) edited.body = String(params.body)
      return { status: 200, headers: {}, data: { id: params.comment_id } }
    }
    if (route === REVIEW_CREATE) {
      const comments = params.comments as { path: string; line: number; body: string }[]
      if (seed.refuseInlineWith !== undefined && !refused && comments.length > 0) {
        refused = true
        throw Object.assign(new Error('Validation Failed'), { status: seed.refuseInlineWith })
      }
      const reviewId = nextReviewId++
      for (const c of comments) {
        reviewComments.push({
          id: nextCommentId++, path: c.path, line: c.line, body: c.body,
          pull_request_review_id: reviewId, in_reply_to_id: null, user: BOT,
        })
      }
      return { status: 200, headers: {}, data: { id: reviewId } }
    }
    if (route === REVIEW_COMMENTS) return { status: 200, headers: {}, data: pageOf(reviewComments, params) }
    if (route === RETRACT_READ) {
      const found = reviewComments.find((c) => c.id === params.comment_id)
      if (found === undefined) throw Object.assign(new Error('Not Found'), { status: 404 })
      return {
        status: 200, headers: {},
        data: {
          id: found.id, body: found.body, path: found.path, line: found.line,
          in_reply_to_id: found.in_reply_to_id,
          // GitHub's own answer for a comment on this pull request, unless the fixture put it
          // somewhere else on purpose.
          pull_request_url: found.pull_request_url
            ?? 'https://api.github.com/repos/acme/widgets/pulls/16',
        },
      }
    }
    if (route === RETRACT_EDIT) {
      if (seed.refuseRetractionWith !== undefined) {
        throw Object.assign(new Error('Forbidden'), { status: seed.refuseRetractionWith })
      }
      const found = reviewComments.find((c) => c.id === params.comment_id)
      if (found !== undefined) found.body = String(params.body)
      return { status: 200, headers: {}, data: { id: params.comment_id } }
    }
    // No COMPARE branch, deliberately: `changedFilesBetween` is deleted, so any call to it lands on
    // the throw below and names itself. It existed only to license a `fixed` inferred from silence.
    throw new Error(`the fake was asked for a route publishReview should not call: ${route}`)
  }
  return { octokit: { request } as unknown as Octokit, calls }
}

const only = (calls: Call[], route: string): Call[] => calls.filter((c) => c.route === route)
/** Every request that changes something on GitHub, in the order it was made. */
const writes = (calls: Call[]): string[] => calls.map((c) => c.route).filter((r) => !r.startsWith('GET '))

const publish = (octokit: Octokit, review: RunReviewResult) =>
  publishReview({ octokit, owner: 'acme', repo: 'widgets', number: 16, review })

/** How the app calls it on a re-review: the marker was read BEFORE the review, to build the
 *  re-review pass's question, and the same one is handed on here so a judgement's index addresses
 *  the rows it was computed about. */
const publishWith = (octokit: Octokit, review: RunReviewResult, marker: MarkerState | null) =>
  publishReview({
    octokit, owner: 'acme', repo: 'widgets', number: 16, review,
    existing: marker === null ? null : { commentId: 9002, marker },
  })

/** The bot's summary comment from an earlier review, carrying that review's state. */
const previousSummary = (state: MarkerState): IssueCommentOnWire => ({
  id: 9002, body: `### Review of \`1111111\`\n\n${encodeMarker(state)}\n`, user: BOT,
})

describe('publishReview: from a finished review to a posted one', () => {
  it('places the placeable finding on its line, on the sha that was reviewed, and says the rest in the summary', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed())

    const create = only(gh.calls, REVIEW_CREATE)
    expect(create).toHaveLength(1)
    // The sha the engine read, taken from the result. A caller's sha could be a stale webhook
    // head, or Task 10's HEAD_SHA_UNRESOLVED for a /review comment. publishReview takes none.
    expect(create[0].params.commit_id).toBe(HEAD_SHA)
    expect(create[0].params.comments).toEqual([{
      path: '.github/workflows/publish.yml', line: 100, side: 'RIGHT',
      body: expect.stringContaining('**Severity 6/10**'),
    }])
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain('`src/release.ts:30`')
    expect(out).toMatchObject({
      mode: 'inline+summary', headSha: HEAD_SHA, completed: true, reviewId: 900, summaryCommentId: 8100,
      counts: { inline: 1, summaryOnly: 1, droppedInline: 0, suppressed: 0, notInCheckout: 1 },
    })
    expect(out.findings.map((f) => f.title)).toEqual([INLINE.title, ELSEWHERE.title])
  })

  it('keeps both comment ids when one review reports the same title twice in one file', async () => {
    // `findingId` hashes file, category and title, and report.ts says out loud that two findings can
    // share all three — the same defect at two call sites, which nothing dedupes. Keyed by that id
    // alone, the read-back map held one entry: the second comment overwrote the first, BOTH marker
    // rows carried the survivor, and the other real comment was invisible to the product for ever —
    // `commentIdsIn` never listed it, so a `/dispute` written under it was never read, and it could
    // never be retracted. With the model's verdict now authoritative, that is a person's objection
    // going unheard rather than a bookkeeping smudge.
    const TWIN = { category: 'correctness' as const, title: 'the delay is discarded' }
    const first = finding({ ...TWIN, line: 100, severity: 6 })
    const second = finding({ ...TWIN, line: 101, severity: 6 })
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ findings: [first, second] }))

    expect(only(gh.calls, REVIEW_CREATE)[0].params.comments).toHaveLength(2)
    expect(findingId(first)).toBe(findingId(second))       // one id, two comments: the whole problem
    const rows = out.marker.runs[0].findings
    expect(rows.map((f) => [f.line, f.commentId])).toEqual([[100, 5001], [101, 5002]])
    expect(commentIdsIn(out.marker)).toEqual([5001, 5002])
  })

  it('posts the review before it writes the summary, so the marker carries the ids of this review\'s comments', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed())

    expect(writes(gh.calls)).toEqual([REVIEW_CREATE, SUMMARY_CREATE])
    const marker = decodeMarker(String(only(gh.calls, SUMMARY_CREATE)[0].params.body))
    // 5001 is the id GitHub gave the inline comment, read back once the review existed. A summary
    // rendered before the review could only say null here, and the next review could then never
    // find the replies a person left under that comment.
    expect(marker?.runs[0]).toEqual({
      headSha: HEAD_SHA,
      // When the review finished, from the record: the marker and the record agree on it.
      at: '2026-09-14T10:04:39.000Z',
      findings: [
        // The five fields the re-review pass is shown, plus the comment id that finds the thread
        // again. No `anchor`: the source-line hash is gone.
        { id: findingId(INLINE), file: INLINE.file, line: 100, severity: 6, category: 'security', title: INLINE.title, commentId: 5001, outcome: 'open' },
        { id: findingId(ELSEWHERE), file: ELSEWHERE.file, line: 30, severity: 7, category: 'correctness', title: ELSEWHERE.title, commentId: null, outcome: 'open' },
      ],
    })
    expect(out.marker).toEqual(marker)
  })

  it('puts the marker on the summary comment only, never on the review', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed())
    const reviewText = only(gh.calls, REVIEW_CREATE)[0].params.body
    expect(decodeMarker(String(reviewText))).toBeNull()
    expect(out.bodies.review).toBe(reviewText)
  })

  it('says nothing, anywhere, about a finding whose path is not a file in the checkout', async () => {
    const gh = fakeGitHub()
    await publish(gh.octokit, reviewed())
    expect(JSON.stringify(gh.calls)).not.toContain(OUTSIDE.title)
  })

  it('refuses to put a review onto a pull request it was not about, before asking GitHub anything', async () => {
    const gh = fakeGitHub()
    await expect(publishReview({
      octokit: gh.octokit, owner: 'acme', repo: 'widgets', number: 17, review: reviewed(),
    })).rejects.toThrow('refusing to publish a review of acme/widgets#16 onto acme/widgets#17')
    expect(gh.calls).toEqual([])
  })
})

describe('publishReview: the check pass decides what is said (design §4.6)', () => {
  it('never says a refuted finding, on a line or in the summary', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({
      verdicts: [{ index: 0, verdict: 'refuted', severity: 2, reason: 'The job already guards on github.actor.', evidence: [] }],
    }))
    expect(only(gh.calls, REVIEW_CREATE)).toEqual([])
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).not.toContain(INLINE.title)
    // The gate reads `findings`, so a refuted finding cannot fail a build either.
    expect(out.findings.map((f) => f.title)).toEqual([ELSEWHERE.title])
    expect(out.counts.suppressed).toBe(1)
  })

  it('says a confirmed finding at the check\'s severity, not the reviewer\'s', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({
      verdicts: [{ index: 0, verdict: 'confirmed', severity: 8, reason: 'Reproduced from the workflow file.', evidence: [] }],
    }))
    const [comment] = only(gh.calls, REVIEW_CREATE)[0].params.comments as { body: string }[]
    expect(comment.body.startsWith('**Severity 8/10**')).toBe(true)
    expect(out.findings.find((f) => f.title === INLINE.title)?.severity).toBe(8)
  })
})

describe('publishReview: a re-review', () => {
  // The last review said INLINE under comment 101 and GONE under comment 103, and a person
  // disputed INLINE in its thread.
  const GONE = finding({ file: 'src/release.ts', line: 12, category: 'impact', title: 'the old retry never waits' })
  const lastState: MarkerState = {
    version: 1,
    runs: [{
      headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
      findings: [
        { id: findingId(INLINE), file: INLINE.file, line: 100, severity: 6, title: INLINE.title, commentId: 101, outcome: 'open' },
        { id: findingId(GONE), file: GONE.file, line: 12, severity: 6, title: GONE.title, commentId: 103, outcome: 'open' },
      ],
    }],
  }
  const thread = (): ReviewCommentOnWire[] => [
    { id: 101, path: INLINE.file, line: 100, body: '**Severity 6/10** · security', pull_request_review_id: 700, in_reply_to_id: null, user: BOT },
    { id: 102, path: INLINE.file, line: 100, body: '/dispute only maintainers can push tags', pull_request_review_id: 701, in_reply_to_id: 101, user: HUMAN },
    { id: 103, path: GONE.file, line: 12, body: '**Severity 6/10** · impact', pull_request_review_id: 700, in_reply_to_id: null, user: BOT },
  ]

  it('edits the summary it wrote last time, without listing the conversation a second time', async () => {
    // The caller read the marker before the review — that is where the re-review pass's question
    // came from — and hands the same one back. One listing for the whole pipeline, and the comment
    // the state was read out of is the comment overwritten.
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const out = await publishWith(gh.octokit, reviewed(), lastState)
    expect(out.summaryCommentId).toBe(9002)
    expect(only(gh.calls, SUMMARY_CREATE)).toEqual([])
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9002)
    expect(only(gh.calls, SUMMARY_LIST)).toEqual([])
  })

  it('still reads the marker itself when the caller did not', async () => {
    // The CLI, and anything else that publishes without having asked the re-review pass anything.
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const out = await publish(gh.octokit, reviewed())
    expect(only(gh.calls, SUMMARY_LIST)).toHaveLength(1)
    expect(out.summaryCommentId).toBe(9002)
  })

  it('settles the last review by what the pass said, and appends this one', async () => {
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const out = await publishWith(gh.octokit, reviewed({
      recheck: said(lastState, 'still-present', 'resolved'),
    }), lastState)
    const written = decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
    expect(written).toEqual(out.marker)
    expect(written?.runs).toHaveLength(2)
    // The person's /dispute stands over the model; the finding the pass says is gone is fixed.
    expect(written?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'fixed'])
    // The dispute is carried onto the finding's new comment, so it survives the review after this.
    expect(written?.runs[1].findings[0]).toMatchObject({ id: findingId(INLINE), commentId: 5001, outcome: 'disputed' })
  })

  // ── THE FIRST LIVE FAILURE: matching on wording ─────────────────────────────────────────────────
  // Measured on crissmoldovan/review-agent-proving-ground #1: one commit, two reviews, not a byte
  // changed. The model rephrased itself, `findingId` hashes the title, so one bug read as two and the
  // old row was marked `fixed` on code nobody had touched. Three live defects declared repaired.

  it('is `fixed` when the pass says resolved, and `open` when it says still-present', async () => {
    const BACKOFF = 'Computed backoff delay is never used; the wait is always 0ms'
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: BACKOFF, commentId: 4013307235, outcome: 'open',
        }],
      }],
    }
    const bot: ReviewCommentOnWire = {
      id: 4013307235, path: 'src/release.ts', line: 24, body: `**Severity 8/10**\n\n${BACKOFF}`,
      pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
    }
    // This run rephrases the finding, moves it a line and lowers it — the three things the old
    // matcher read. None of them decide anything now.
    const reworded = finding({
      file: 'src/release.ts', line: 23, severity: 5, category: 'correctness',
      title: 'No backoff: computed delay is discarded, setTimeout is always 0',
    })

    const repaired = fakeGitHub({ issueComments: [previousSummary(state)], reviewComments: [bot] })
    await publishWith(repaired.octokit, reviewed({
      findings: [reworded], recheck: said(state, 'resolved'),
    }), state)
    expect(decodeMarker(String(only(repaired.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('fixed')

    const live = fakeGitHub({ issueComments: [previousSummary(state)], reviewComments: [bot] })
    await publishWith(live.octokit, reviewed({
      findings: [reworded], recheck: said(state, 'still-present'),
    }), state)
    expect(decodeMarker(String(only(live.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('open')
    // And the comment of a live finding is not touched.
    expect(only(live.calls, RETRACT_EDIT)).toEqual([])
  })

  it('gives the same outcome whatever this run reported, worded or severitied', async () => {
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: 'the delay is discarded', commentId: null, outcome: 'open',
        }],
      }],
    }
    const reported: Finding[][] = [
      [],                                                                  // said nothing
      [finding({ file: 'src/release.ts', line: 24, severity: 8, category: 'correctness', title: 'the delay is discarded' })],
      [finding({ file: 'src/release.ts', line: 200, severity: 2, category: 'impact', title: 'something else' })],
    ]
    for (const findings of reported) {
      const gh = fakeGitHub({ issueComments: [previousSummary(state)] })
      await publishWith(gh.octokit, reviewed({ findings, recheck: said(state, 'resolved') }), state)
      expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
        ?.runs[0].findings[0].outcome).toBe('fixed')
    }
  })

  // ── THE SECOND LIVE FAILURE: "fixed when the anchored line is gone" ─────────────────────────────

  it('is `fixed` for a repair that WRAPS the line instead of deleting it', async () => {
    // THE REGRESSION LOCK THAT MATTERS MOST. `src/release.ts:30` reads `export const release30 = () => {}`
    // in this checkout and read exactly that when the finding was filed — the repair guarded the
    // call rather than removing it. Under "the line is gone" this produced `open`, every time,
    // because the line is right there. The pass read the guard and said resolved.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'aaaaaaaaaaaa', file: 'src/release.ts', line: 30, severity: 4, category: 'correctness',
          title: 'Sleeps after the final failed attempt', commentId: 4013794900, outcome: 'open',
        }],
      }],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [{
        id: 4013794900, path: 'src/release.ts', line: 30, body: '**Severity 4/10**\n\nSleeps after the final failed attempt',
        pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
      }],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('fixed')
    expect(out.counts.retracted).toBe(1)
  })

  // ── Every previous run is reached ───────────────────────────────────────────────────────────────

  it('repairs a row from run 1 of four, not only the last run', async () => {
    // The old code settled `runs.at(-1)` and nothing else, so the live marker's rows in runs 1, 2
    // and 3 were frozen wherever the two failures left them. Asking a model is not pairwise.
    const runAt = (n: number, title: string, commentId: number | null): MarkerRun => ({
      headSha: `${n}`.repeat(40), at: `2026-09-1${n}T10:00:00.000Z`,
      findings: [{
        id: `id${n}`.padEnd(12, '0'), file: 'src/release.ts', line: n * 10, severity: 6,
        category: 'correctness', title, commentId, outcome: 'open',
      }],
    })
    const four: MarkerState = {
      version: 1,
      runs: [runAt(1, 'ONE', 4013307235), runAt(2, 'TWO', null), runAt(3, 'THREE', null), runAt(4, 'FOUR', null)],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(four)],
      reviewComments: [{
        id: 4013307235, path: 'src/release.ts', line: 10, body: '**Severity 6/10**\n\nONE',
        pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
      }],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [],
      recheck: said(four, 'resolved', 'still-present', 'still-present', 'still-present'),
    }), four)
    const written = decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
    expect(written?.runs.slice(0, 4).map((r) => r.findings[0].outcome))
      .toEqual(['fixed', 'open', 'open', 'open'])
    // And run 1's comment — three reviews old, unreachable before — is the one that gets the note.
    expect(only(gh.calls, RETRACT_EDIT).map((c) => c.params.comment_id)).toEqual([4013307235])
    expect(out.counts.retracted).toBe(1)
  })

  it('pushes a wrongly-`fixed` row from an earlier review back to open', async () => {
    // Run 1 of the live marker declared three live defects fixed on nothing but the model's silence.
    // This is the only way any of them is ever undone.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: 'wrongly declared fixed', commentId: null, outcome: 'fixed',
        }],
      }],
    }
    const gh = fakeGitHub({ issueComments: [previousSummary(state)] })
    await publishWith(gh.octokit, reviewed({ findings: [], recheck: said(state, 'still-present') }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('open')
  })

  it('leaves every outcome open and posts the review anyway, however the pass failed', async () => {
    // The pass threw; it was stopped at the deadline; it answered unusably; it could not be afforded.
    // All four arrive here as one shape — no judgements — and all four must publish exactly the
    // review this pull request was owed.
    for (const skipped of ['error', 'error', 'unreadable', 'budget'] as RecheckSkipped[]) {
      const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
      const out = await publishWith(gh.octokit, reviewed({
        recheck: answeredNothing(lastState, skipped),
      }), lastState)

      const written = decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      // The dispute is a person's and stands; nothing else moved, and nothing is `fixed`.
      expect(written?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'open'])
      // THE REVIEW POSTED. This is the half that matters: an outcome refinement must never cost the
      // pull request its review.
      expect(only(gh.calls, REVIEW_CREATE)).toHaveLength(1)
      expect(out.summaryCommentId).toBe(9002)
      expect(out.counts.inline).toBe(1)
      expect(String(only(gh.calls, SUMMARY_EDIT)[0].params.body)).toContain('`src/release.ts:30`')
      // No retraction is attempted: not the edit, and not the read before it.
      expect(only(gh.calls, RETRACT_READ)).toEqual([])
      expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
      expect(out.counts.retracted).toBe(0)
    }
  })

  it('leaves a row open when the pass answered about the others and not it', async () => {
    // Partial output. The rows that were answered get their answer; a row with no answer is `open`,
    // which is the same rule as no answer at all. A missing answer never becomes a `fixed`.
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    await publishWith(gh.octokit, reviewed({ recheck: said(lastState, null, 'resolved') }), lastState)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'fixed'])
  })

  it('drops every judgement when the pass was asked about a different list', async () => {
    // The one mis-addressing this feature could produce, and the worst thing it could do: a `fixed`
    // written onto a finding nobody asked about. A judgement's index addresses the question list the
    // pass was GIVEN; publishReview re-derives that list and refuses the lot if they differ.
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const stale = said(lastState, 'resolved', 'resolved')
    const out = await publishWith(gh.octokit, reviewed({
      recheck: { ...stale, asked: [{ file: 'src/other.ts', line: 1, severity: 5, title: 'a different question' }] },
    }), lastState)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'open'])
    expect(out.counts.retracted).toBe(0)
  })

  it('does nothing with a pass that ran on a review that did not complete', async () => {
    // Belt and braces: `runReview` does not buy the pass at all when the engine produced nothing,
    // and if one arrived anyway it decides nothing. A review that saw part of a commit has not
    // judged it.
    const crashed: EngineFailure = { kind: 'crashed', code: 1, stderr: 'the CLI exited' }
    const gh = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const out = await publishWith(gh.octokit, reviewed({
      output: null, failure: crashed, recheck: said(lastState, 'resolved', 'resolved'),
    }), lastState)
    expect(out.marker).toEqual(lastState)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
  })

  it('a person beats the model', async () => {
    // Design point 5. The pass says both are resolved; a person has filed a verdict on each thread.
    const gh = fakeGitHub({
      issueComments: [previousSummary(lastState)],
      reviewComments: [
        ...thread(),
        { id: 104, path: GONE.file, line: 12, body: '/defer tracked in ACME-40', pull_request_review_id: 702, in_reply_to_id: 103, user: HUMAN },
      ],
    })
    const out = await publishWith(gh.octokit, reviewed({
      recheck: said(lastState, 'resolved', 'resolved'),
    }), lastState)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'deferred'])
    // Neither thread is stamped on.
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('counts the last review as a previous one, so the first-review allowance of minor findings is not spent twice', async () => {
    // Severity 2 is below severity.bands.medium (4): a first review mentions up to
    // firstReviewLowBandCap (3) of these, and a later review none (design §3.1).
    const MINOR = finding({ line: 101, severity: 2, category: 'correctness', title: 'a comment says three retries, the code does two' })
    const first = fakeGitHub()
    await publish(first.octokit, reviewed({ findings: [MINOR] }))
    expect(String(only(first.calls, SUMMARY_CREATE)[0].params.body)).toContain(MINOR.title)

    const again = fakeGitHub({ issueComments: [previousSummary(lastState)], reviewComments: thread() })
    const out = await publishWith(again.octokit, reviewed({ findings: [MINOR] }), lastState)
    expect(String(only(again.calls, SUMMARY_EDIT)[0].params.body)).not.toContain(MINOR.title)
    expect(out.counts.suppressed).toBe(1)
  })
})

describe('publishReview: report.mode decides what reaches GitHub, and nothing else', () => {
  it('in silent mode writes nothing, and hands back what it would have said', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ mode: 'silent' }))
    expect(writes(gh.calls)).toEqual([])
    expect(out).toMatchObject({ mode: 'silent', reviewId: null, summaryCommentId: null, counts: { inline: 0, summaryOnly: 0 } })
    expect(out.bodies.inline.map((c) => c.path)).toEqual([INLINE.file])
    expect(out.bodies.summary).toContain('`src/release.ts:30`')
    expect(out.findings.map((f) => f.title)).toEqual([INLINE.title, ELSEWHERE.title])
  })

  it('in check-only mode writes no comment, and still hands back the findings its check run gates on', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ mode: 'check-only' }))
    expect(writes(gh.calls)).toEqual([])
    // selectForPosting suppresses everything in this mode. That is right for comments and wrong
    // for the gate: a check-only deployment's check run is the one place its findings are judged.
    expect(out.findings.map((f) => f.title)).toEqual([INLINE.title, ELSEWHERE.title])
  })

  it('in summary-only mode writes the summary and no review', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ mode: 'summary-only' }))
    expect(writes(gh.calls)).toEqual([SUMMARY_CREATE])
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain('`.github/workflows/publish.yml:100`')
    expect(out).toMatchObject({ reviewId: null, summaryCommentId: 8100, counts: { inline: 0, summaryOnly: 2 } })
  })

  it('creates no empty review when nothing could be placed on a line', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ findings: [ELSEWHERE] }))
    expect(writes(gh.calls)).toEqual([SUMMARY_CREATE])
    expect(out.reviewId).toBeNull()
  })
})

describe('publishReview: when GitHub refuses the inline comments', () => {
  it('says the refused finding in the summary instead, and records that it has no comment', async () => {
    const gh = fakeGitHub({ refuseInlineWith: 422 })
    const out = await publish(gh.octokit, reviewed())
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('`.github/workflows/publish.yml:100`')
    expect(out.counts).toMatchObject({ inline: 0, summaryOnly: 2, droppedInline: 1 })
    // No comment exists for it, so no thread, and no reply can ever reach it.
    const entry = decodeMarker(summary)?.runs[0].findings.find((f) => f.id === findingId(INLINE))
    expect(entry?.commentId).toBeNull()
  })

  it('leaves the review that GitHub did take saying nothing untrue about itself', async () => {
    // Task 4 re-posts the refused review with `comments: []` and the SAME body. The body this
    // task writes carries no count for exactly that reason: the second call is the one a reader
    // actually sees, and it is a review with no inline comments under it.
    const gh = fakeGitHub({ refuseInlineWith: 422 })
    const out = await publish(gh.octokit, reviewed())
    const retried = String(only(gh.calls, REVIEW_CREATE)[1].params.body)
    // `bodies.review` is `string | null`, so it is compared as a string: the retry sends the very
    // body publishReview reports, not a second one written for the failure path.
    expect(retried).toBe(String(out.bodies.review))
    expect(retried).not.toMatch(/\d+ findings? (is|are) placed/)
    expect(retried).toContain('summary comment')
  })
})

describe('publishReview: a review that did not complete', () => {
  // 36 characters after the prefix, which is what the scanner's pattern matches (Task 1, Step 14).
  const CRASHED: EngineFailure = { kind: 'crashed', code: 1, stderr: `token ghp_${'A'.repeat(36)} rejected` }

  it('places nothing on a line and says in the summary, in words of its own, that it did not complete', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ output: null, failure: CRASHED }))
    expect(writes(gh.calls)).toEqual([SUMMARY_CREATE])
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('This review did not complete')
    // runReview scans the review output and the verdicts, never the CLI's stderr, so none of it
    // may reach a comment everyone on the pull request can read.
    expect(summary).not.toContain('ghp_')
    expect(out.completed).toBe(false)
  })

  it('quotes none of a CLI error\'s own text either, only the fact that the CLI errored', async () => {
    // The other half of the same rule, and it was unlocked: changing the `cli-error` branch to
    // interpolate `${f.message}` left the ENTIRE suite green, while the `crashed`/`stderr` half
    // above was guarded. `EngineFailure.message` is the CLI's `resultText` — runReview's secret
    // scan covers the review output and the check verdicts, never this — and a summary comment is
    // read by everyone who can see the pull request.
    const gh = fakeGitHub()
    const failure: EngineFailure = {
      kind: 'cli-error', terminalReason: 'api_error',
      // 36 characters after the prefix, the shape the scanner matches (Task 1, Step 14).
      message: `Authentication failed for token ghp_${'B'.repeat(36)}`,
    }
    await publish(gh.octokit, reviewed({ output: null, failure }))
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('This review did not complete')
    expect(summary).toContain('the Claude CLI reported an error')
    expect(summary).not.toContain('ghp_')
    expect(summary).not.toContain('api_error')
  })

  it('leaves the last review\'s state as it was, because a review that saw nothing cannot say anything was fixed', async () => {
    const before: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [{ id: findingId(ELSEWHERE), file: ELSEWHERE.file, line: 30, severity: 7, title: ELSEWHERE.title, commentId: null, outcome: 'open' }],
      }],
    }
    const gh = fakeGitHub({ issueComments: [previousSummary(before)] })
    const out = await publish(gh.octokit, reviewed({ output: null, failure: CRASHED }))
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))).toEqual(before)
    expect(out.marker).toEqual(before)
  })

  it('keeps the findings a budget-stopped review had, in the summary and never on a line', async () => {
    // Global Constraints: partial findings are kept if the ceiling fires.
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({ failure: { kind: 'budget', spentUsd: 0.94 } }))
    expect(writes(gh.calls)).toEqual([SUMMARY_CREATE])
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('`.github/workflows/publish.yml:100`')
    expect(summary).toContain('$0.94 of model spend at per-token API prices')
    expect(out.said.inline).toEqual([])
  })

  it('writes nothing at all when the mode allows no summary', async () => {
    const gh = fakeGitHub()
    await publish(gh.octokit, reviewed({ output: null, failure: CRASHED, mode: 'check-only' }))
    expect(writes(gh.calls)).toEqual([])
  })
})

describe('publishReview: what the gate and the summary are handed (Criss, decisions 4 and 6)', () => {
  it('reports no confirmed set when no check pass ran', async () => {
    const out = await publish(fakeGitHub().octokit, reviewed())
    // null, not []: "nothing confirmed" and "nobody checked" are different facts, and Task 6 says
    // the second one out loud.
    expect(out.confirmed).toBeNull()
  })

  it('reports as confirmed only what the pass confirmed, at the check severity', async () => {
    const out = await publish(fakeGitHub().octokit, reviewed({
      verdicts: [
        { index: 0, verdict: 'confirmed', severity: 8, reason: 'Reproduced from the workflow file.', evidence: [] },
        { index: 1, verdict: 'uncertain', severity: 7, reason: 'Could not find the logger config.', evidence: [] },
      ],
    }))
    // Both are said; only INLINE was confirmed, and it carries the check's 8.
    expect(out.findings.map((f) => f.title)).toEqual([INLINE.title, ELSEWHERE.title])
    expect(out.confirmed?.map((f) => [f.title, f.severity])).toEqual([[INLINE.title, 8]])
  })

  it('names in the summary what the comment asked for and did not get', async () => {
    const gh = fakeGitHub()
    await publishReview({
      octokit: gh.octokit, owner: 'acme', repo: 'widgets', number: 16, review: reviewed(),
      refused: ['`--multi` — the multi-reviewer fan-out is not built yet, so one reviewer ran.'],
    })
    const body = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(body).toContain('Not honoured')
    expect(body).toContain('`--multi` — the multi-reviewer fan-out is not built yet')
  })

  it('names what the resolver dropped as well, from the settings it recorded', async () => {
    const review = reviewed()
    const gh = fakeGitHub()
    await publish(gh.octokit, { ...review, settings: { ...review.settings, droppedRequestKeys: ['budgetUsd'] } })
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body))
      .toContain('`budgetUsd` — this deployment does not let a request set it')
  })
})

import { REINSTATED_MARKER, RETRACTED_MARKER } from './body'
import type { MarkerFinding, MarkerRun } from './marker'

// ── What the marker keeps, and the comment a resolved finding leaves behind ──────────────────────
// Criss, 2026-09-16. Measured on crissmoldovan/review-agent-proving-ground #1: a genuine repair went
// unnoticed twice — once because the model reworded itself, once because the repair wrapped the
// anchored line instead of deleting it — and the comment that named the repaired defect is still on
// the pull request asserting it. The outcome is now a model's answer about the current checkout.

describe('publishReview: what the marker records', () => {
  it('records the file, the line said on, the severity, the category and the title — and no hash', async () => {
    // Exactly the five fields the re-review pass is shown, plus the bookkeeping that finds the
    // comment again. No `anchor`: the source-line hash is gone, and with it the only field that ever
    // needed a checkout to compute.
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed())
    const [inlineRow, summaryRow] = out.marker.runs[0].findings
    expect(inlineRow).toEqual({
      id: findingId(INLINE), file: '.github/workflows/publish.yml', line: 100, severity: 6,
      category: 'security', title: INLINE.title, commentId: 5001, outcome: 'open',
    })
    expect('anchor' in summaryRow).toBe(false)
    // The marker is a public comment body. None of the source may be readable out of it — it never
    // held any, and now it does not hold a hash of any either.
    const body = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(body).not.toContain('release30 = ()')
    expect(body).not.toContain('run: step-100')
  })

  it('keeps no row for a path outside the checkout', async () => {
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed())
    expect(out.marker.runs[0].findings).toHaveLength(2)      // OUTSIDE was dropped
    expect(out.marker.runs[0].findings.map((f) => f.file))
      .toEqual(['.github/workflows/publish.yml', 'src/release.ts'])
  })

  it('records a finding on a line the file does not have, like any other', async () => {
    // It used to matter that this row carried no anchor. Nothing about it is special now: the
    // re-review pass is told the line may have moved and is asked to find the defect.
    const gh = fakeGitHub()
    const out = await publish(gh.octokit, reviewed({
      findings: [finding({ file: 'src/release.ts', line: 9999, severity: 7 })],
    }))
    expect(out.marker.runs[0].findings[0]).toMatchObject({ file: 'src/release.ts', line: 9999 })
  })
})

describe('publishReview: retracting the comment of a finding judged resolved', () => {
  /** A previous run with one commented finding in `src/release.ts`. */
  const stateWith = (over: Partial<MarkerFinding> = {}, extra: MarkerFinding[] = []): MarkerState => ({
    version: 1,
    runs: [{
      headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
      findings: [{
        id: 'aaaaaaaaaaaa', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
        title: 'the delay is discarded', commentId: 4013794900, outcome: 'open', ...over,
      }, ...extra],
    }],
  })
  const botComment = (id: number, line: number, body = '**Severity 8/10**'): ReviewCommentOnWire => ({
    id, path: 'src/release.ts', line, body,
    pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
  })

  it('edits the comment once, keeping what it said, and naming the file and the sha it read', async () => {
    const state = stateWith()
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24, '**Severity 8/10** · correctness\n\nNo backoff: the computed delay is discarded')],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)

    const edits = only(gh.calls, RETRACT_EDIT)
    expect(edits).toHaveLength(1)
    expect(edits[0].params.comment_id).toBe(4013794900)
    const edited = String(edits[0].params.body)
    // What it said is kept: a reply, a /dispute, a conversation may hang off it.
    expect(edited).toContain('No backoff: the computed delay is discarded')
    expect(edited).toContain(RETRACTED_MARKER)
    // The unit test of `retractionNote` proves the template interpolates; only this proves the
    // caller hands it the right two facts. They are a public sentence on somebody's thread.
    expect(edited).toContain('`src/release.ts`')
    expect(edited).toContain(HEAD_SHA.slice(0, 7))
    expect(edited).not.toContain(OLD_SHA.slice(0, 7))
    // A model looked, so the note may say the reviewer no longer finds it. It still may not say a
    // person fixed anything.
    expect(edited).toContain('no longer finds this issue')
    expect(edited).toContain('not proof that a person fixed it')
    expect(out.counts.retracted).toBe(1)
  })

  it('leaves the comment of a finding the pass says is still present alone', async () => {
    const state = stateWith()
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'still-present'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('open')
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('treats cannot-tell exactly as it treats no answer', async () => {
    const state = stateWith()
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'cannot-tell'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('open')
    expect(out.counts.retracted).toBe(0)
  })

  it('has nothing to retract for a finding that never got a comment', async () => {
    // Most rows: a summary-only finding was shown to nobody on a line, so there is no thread to
    // correct. It must be skipped, and skipped without an error.
    const state = stateWith({ commentId: null })
    const gh = fakeGitHub({ issueComments: [previousSummary(state)] })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('fixed')
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('still publishes the review when GitHub refuses the retraction', async () => {
    // A comment somebody deleted, a permission a deployment narrowed. A courtesy edit must never
    // cost the pull request its review, or its marker.
    const state = stateWith()
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24)], refuseRetractionWith: 403,
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    expect(out.summaryCommentId).toBe(9002)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('fixed')
    // Attempted, refused, counted as not done — and the review is unharmed.
    expect(only(gh.calls, RETRACT_EDIT)).toHaveLength(1)
    expect(out.counts.retracted).toBe(0)
    expect(out.counts.retractionsWithheld).toBe(1)
  })

  it('writes nothing on a comment when the mode forbids writing', async () => {
    // The comment really is there and really would be edited — the review is what refuses to.
    // `silent` writes no marker either, and editing somebody's thread on a judgement this product
    // then forgets is worse than saying nothing.
    const state = stateWith()
    const loud = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    expect((await publishWith(loud.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)).counts.retracted).toBe(1)

    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    await publishWith(gh.octokit, reviewed({
      findings: [], mode: 'silent', recheck: said(state, 'resolved'),
    }), state)
    expect(writes(gh.calls)).toEqual([])
    expect(only(gh.calls, RETRACT_READ)).toEqual([])      // not even the read before the edit
  })

  it('does not contradict itself: no note on a line this very review has just commented on', async () => {
    // The two passes disagreeing about one commit. The re-review pass says the finding is resolved;
    // the reviewer reports it again, on the line its old comment sits on. Whoever is right, the
    // product must not stamp "no longer found" three requests after saying it found it.
    const EDITED = { file: '.github/workflows/publish.yml', category: 'security', title: INLINE.title }
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [{
          id: findingId(EDITED), file: EDITED.file, line: 100, severity: 6, category: EDITED.category,
          title: EDITED.title, commentId: 4013794900, outcome: 'open',
        }],
      }],
    }
    const stale = (line: number): ReviewCommentOnWire => ({
      id: 4013794900, path: '.github/workflows/publish.yml', line,
      body: '**Severity 6/10** · security\n\na tag on an unmerged branch still publishes',
      pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
    })
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      // GitHub re-anchors the comment onto the CURRENT head.
      reviewComments: [stale(100)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [INLINE], recheck: said(state, 'resolved'),
    }), state)

    // The finding IS reported again, on that line.
    expect(only(gh.calls, REVIEW_CREATE)[0].params.comments).toEqual([
      { path: '.github/workflows/publish.yml', line: 100, side: 'RIGHT', body: expect.any(String) },
    ])
    // And nothing is written on the comment sitting there.
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
    expect(out.counts.retractionsWithheld).toBe(1)
    // Said plainly, because it is the honest edge: the MARKER still reads `fixed`. This guard stops
    // the product SAYING so on a thread it is contradicting in the same run; it does not adjudicate
    // between two passes, and nothing here can.
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('fixed')

    // ONE LINE OF DRIFT, and the guard used to miss it entirely. GitHub has re-anchored the old
    // comment to 101 while this review's new comment goes on 100 — so `path:line` does not match,
    // and the product posted "this defect is here" and, three requests later, "no longer reported"
    // on the comment beside it. The pass's own system prompt says "Look for the defect, not for that
    // line number", so the disagreements that reach here are precisely the ones where the line moved:
    // keying the guard on the line was keying it on the one fact the pass is told to disregard.
    const drifted = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [stale(101)],
    })
    const withheld = await publishWith(drifted.octokit, reviewed({
      findings: [INLINE], recheck: said(state, 'resolved'),
    }), state)
    expect(only(drifted.calls, RETRACT_EDIT)).toEqual([])
    expect(withheld.counts.retracted).toBe(0)
    expect(withheld.counts.retractionsWithheld).toBe(1)

    // The control: the same everything, and this review does NOT report that finding. The retraction
    // the feature exists for still lands.
    const elsewhere = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [stale(101)],
    })
    const landed = await publishWith(elsewhere.octokit, reviewed({
      findings: [ELSEWHERE], recheck: said(state, 'resolved'),
    }), state)
    expect(only(elsewhere.calls, RETRACT_EDIT)).toHaveLength(1)
    expect(landed.counts.retracted).toBe(1)
  })

  it('does not contradict itself about a finding it said in the SUMMARY either', async () => {
    // The same contradiction with no inline comment in it at all. `postedAt` is built from what went
    // on a line, so a finding below the inline threshold, past `maxInline`, or in a file the pull
    // request does not touch was invisible to the guard: the summary re-reported it in the same
    // breath as the note said it was gone. `src/release.ts` is untouched by this pull request, so
    // ELSEWHERE can only ever be said in the summary.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [{
          id: findingId(ELSEWHERE), file: ELSEWHERE.file, line: 30, severity: 7,
          category: ELSEWHERE.category, title: ELSEWHERE.title, commentId: 4013794900, outcome: 'open',
        }],
      }],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [{
        id: 4013794900, path: 'src/release.ts', line: 30, body: '**Severity 7/10** · correctness',
        pull_request_review_id: 700, in_reply_to_id: null, user: BOT,
      }],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [ELSEWHERE], recheck: said(state, 'resolved'),
    }), state)
    expect(String(only(gh.calls, SUMMARY_EDIT)[0].params.body)).toContain(ELSEWHERE.title)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ retracted: 0, retractionsWithheld: 1 })
  })

  it('does not contradict itself when GitHub refuses the inline comments', async () => {
    // The total case, and the one where the old guard was not merely leaky but empty. A 422 moves
    // EVERY finding into the summary, so `said.inline` is empty and `postedAt` is the empty set:
    // every previous comment was retracted while the summary re-reported every one of them, and
    // `retractionsWithheld` stayed 0 — silent in exactly the run where the contradiction is total.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [{
          id: findingId(INLINE), file: INLINE.file, line: 100, severity: 6, category: INLINE.category,
          title: INLINE.title, commentId: 4013794900, outcome: 'open',
        }],
      }],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [{
        id: 4013794900, path: '.github/workflows/publish.yml', line: 100,
        body: '**Severity 6/10** · security', pull_request_review_id: 700, in_reply_to_id: null,
        user: BOT,
      }],
      refuseInlineWith: 422,
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [INLINE], recheck: said(state, 'resolved'),
    }), state)
    expect(out.counts.droppedInline).toBe(1)
    expect(String(only(gh.calls, SUMMARY_EDIT)[0].params.body)).toContain(INLINE.title)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ retracted: 0, retractionsWithheld: 1 })
  })

  it('will not write on a comment that is not on this pull request', async () => {
    // The marker is read out of a pull-request comment, and `findSummaryComment` takes the first one
    // carrying a marker that decodes — it filters by author only when a deployment passes
    // `selfLogin`, and none does. So `commentId` is a number from whoever commented first, and
    // `PATCH /repos/{o}/{r}/pulls/comments/{id}` is scoped to the REPOSITORY: nothing in that
    // request names a pull request. One planted comment aimed this edit at any review comment in the
    // repository, including a person's, on a pull request this review never read.
    const state = stateWith({ id: 'deadbeefdead', line: 1, severity: 5, title: 't', commentId: 777000777 })
    const gh = fakeGitHub({
      // Not the bot's: anybody's.
      issueComments: [{ id: 9500, body: `look at this\n\n${encodeMarker(state)}\n`, user: HUMAN }],
      reviewComments: [{
        id: 777000777, path: 'src/release.ts', line: 3, body: '**Severity 9/10** — the token is logged',
        pull_request_review_id: 44, in_reply_to_id: null, user: HUMAN,
        pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/9',
      }],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    // It was judged gone and looked at — and then refused, before anything was written.
    expect(only(gh.calls, RETRACT_READ)).toHaveLength(1)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
    expect(out.counts.retractionsWithheld).toBe(1)
  })

  it('never stamps a note on a thread where a person filed a verdict', async () => {
    // The row stands `disputed` — a person said so, one review ago, on the comment this review would
    // write on. `recheckQuestions` does not even ASK about such a row, so the pass's answer (here,
    // deliberately, "resolved" at index 0, which is about some other row entirely) can never reach
    // it, and `retractableComments` reads the before-state as a second line of defence.
    const state = stateWith({ outcome: 'disputed' }, [{
      id: 'bbbbbbbbbbbb', file: 'src/release.ts', line: 30, severity: 5, category: 'correctness',
      title: 'a second, open finding', commentId: null, outcome: 'open',
    }])
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    const written = decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
    // The disputed row keeps the person's word; the question at index 0 was the OTHER row.
    expect(written?.runs[0].findings.map((f) => f.outcome)).toEqual(['disputed', 'fixed'])
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('retracts EVERY comment it judged resolved, not the first', async () => {
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [
          { id: 'aaaaaaaaaaaa', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness', title: 'gone one', commentId: 4013794900, outcome: 'open' },
          { id: 'bbbbbbbbbbbb', file: 'src/release.ts', line: 40, severity: 8, category: 'correctness', title: 'gone two', commentId: 4013794901, outcome: 'open' },
        ],
      }],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24), botComment(4013794901, 40)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved', 'resolved'),
    }), state)
    expect(only(gh.calls, RETRACT_EDIT).map((c) => c.params.comment_id)).toEqual([4013794900, 4013794901])
    expect(out.counts.retracted).toBe(2)
    expect(out.counts.retractionsWithheld).toBe(0)
  })

  it('never retracts the same comment twice across reviews', async () => {
    // Every run is settled on every review now, so a row that was `fixed` last time is `fixed`
    // again. Offering it again would spend a request per review for ever, and `already-retracted`
    // would be the only thing stopping a second note. The state stops it first.
    const state = stateWith({ outcome: 'fixed' })
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('fixed')
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ retracted: 0, retractionsWithheld: 0 })
  })

  it('takes the note back off the comment, not only the `fixed` off the row', async () => {
    // THE OTHER HALF OF DESIGN POINT 3. A wrong `fixed` was always repairable in the marker — a
    // base64 blob inside an HTML comment — and never in the artefact a person reads: the comment went
    // on saying "the reviewer read this at <sha> and no longer finds this issue there" under a defect
    // the product had just re-confirmed. A retraction was permanent in public and provisional in
    // private, which is the wrong way round.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: 'wrongly declared fixed', commentId: 4013794900, outcome: 'fixed',
        }],
      }],
    }
    const retractedBody = `**Severity 8/10**\n\n---\n${RETRACTED_MARKER}\n**No longer reported.**`
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24, retractedBody)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'still-present'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('open')
    const edited = String(only(gh.calls, RETRACT_EDIT)[0].params.body)
    expect(edited).toContain('**Reported again.**')
    expect(edited).toContain(HEAD_SHA.slice(0, 7))
    // Appended, never replaced: the retraction it corrects stays visible, because a note that
    // vanishes is a note nobody can check.
    expect(edited).toContain('**No longer reported.**')
    expect(out.counts).toMatchObject({ reinstated: 1, retracted: 0, retractionsWithheld: 0 })
  })

  it('writes no second note when the comment already says it', async () => {
    // Idempotent in both directions: the LAST of the two hidden markers is what the comment claims,
    // so a comment already reinstated needs nothing and a comment never retracted has nothing to
    // correct.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: 'wrongly declared fixed', commentId: 4013794900, outcome: 'fixed',
        }],
      }],
    }
    const already = `**Severity 8/10**\n\n---\n${RETRACTED_MARKER}\n**No longer reported.**`
      + `\n\n---\n${REINSTATED_MARKER}\n**Reported again.**`
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24, already)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'still-present'),
    }), state)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ reinstated: 0, retractionsWithheld: 0 })
  })

  it('leaves a standing `fixed` alone when the pass answers nothing, and writes on nobody', async () => {
    // A `fixed` row, a pass that failed. It used to go back to `open` — on every review, for ever —
    // which threw away a judgement a model made at a named commit, put the marker permanently at
    // odds with the comment already edited to match it, and re-offered that comment to the retraction
    // path every single run. Now: nothing moves and nothing is written.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-15T07:55:30.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
          title: 'settled by an earlier review', commentId: 4013794900, outcome: 'fixed',
        }],
      }],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: answeredNothing(state, 'error'),
    }), state)
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
      ?.runs[0].findings[0].outcome).toBe('fixed')
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ retracted: 0, reinstated: 0, retractionsWithheld: 0 })
  })

  // ── Fails closed, four ways, and the review still posts every time ──────────────────────────────

  it('counts a comment that already carries the note as neither done nor withheld', async () => {
    // A run whose marker write failed after the edit landed: the row is still `open` in the state,
    // so it is offered again, and the comment itself is what says there is nothing to do.
    const state = stateWith()
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)],
      reviewComments: [botComment(4013794900, 24, `**Severity 8/10**\n\n---\n${RETRACTED_MARKER}\n**No longer reported.**`)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'resolved'),
    }), state)
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts).toMatchObject({ retracted: 0, retractionsWithheld: 0 })
  })

  it('a review that did not complete retracts nothing', async () => {
    // `completed` gates this as well as the marker, and for the same reason: a review whose engine
    // stopped judged nothing. It still writes a summary in `inline+summary` mode, so without that
    // gate it would reach runs some EARLIER review settled and edit people's threads on a judgement
    // this run never made.
    const state: MarkerState = {
      version: 1,
      runs: [
        {
          headSha: OLD_SHA, at: '2026-09-12T10:00:00.000Z',
          findings: [{
            id: 'aaaaaaaaaaaa', file: 'src/release.ts', line: 24, severity: 8, category: 'correctness',
            title: 'settled by an earlier review', commentId: 4013794900, outcome: 'fixed',
          }],
        },
        { headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z', findings: [] },
      ],
    }
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    const crashed: EngineFailure = { kind: 'crashed', code: 1, stderr: 'the CLI exited' }
    const out = await publishWith(gh.octokit, reviewed({ output: null, failure: crashed }), state)
    expect(String(only(gh.calls, SUMMARY_EDIT)[0].params.body)).toContain('did not complete')
    expect(only(gh.calls, RETRACT_READ)).toEqual([])
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('reads a marker written before this product had anchors or categories', async () => {
    // Design point 7: the three runs live on the proving ground carry no `anchor` and no `category`,
    // and they still decode, still get asked about, and still settle. `unknown` is what the pass is
    // told a missing category is — a row is never dropped for lacking one.
    const state: MarkerState = {
      version: 1,
      runs: [{
        headSha: OLD_SHA, at: '2026-09-13T10:00:00.000Z',
        findings: [{
          id: 'a7ac9b0581f8', file: 'src/release.ts', line: 200, severity: 6,
          title: 'Computed backoff delay is never used; the wait is always 0ms',
          commentId: 4013794900, outcome: 'open',
        }],
      }],
    }
    expect(recheckQuestions(state).questions).toEqual([{
      file: 'src/release.ts', line: 200, severity: 6,
      title: 'Computed backoff delay is never used; the wait is always 0ms',
    }])
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 200)],
    })
    const out = await publishWith(gh.octokit, reviewed({
      findings: [], recheck: said(state, 'still-present'),
    }), state)
    const written = decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))
    expect(written?.version).toBe(1)
    expect(written?.runs[0].findings[0].outcome).toBe('open')
    expect(only(gh.calls, RETRACT_EDIT)).toEqual([])
    expect(out.counts.retracted).toBe(0)
  })

  it('finds a marker’s own file however the marker spelled it', async () => {
    // `MarkerFinding.file` is the model's prose: `./src/release.ts` and `src/release.ts` name one
    // file. Nothing here resolves it any more — the model is given the string and goes and looks —
    // so the spelling reaches the pass and the retraction note exactly as the marker holds it, and
    // `inlineCode` is what makes that safe to print.
    const state = stateWith({ file: './src/release.ts' })
    const gh = fakeGitHub({
      issueComments: [previousSummary(state)], reviewComments: [botComment(4013794900, 24)],
    })
    await publishWith(gh.octokit, reviewed({ findings: [], recheck: said(state, 'resolved') }), state)
    expect(recheckQuestions(state).questions[0].file).toBe('./src/release.ts')
    expect(String(only(gh.calls, RETRACT_EDIT)[0].params.body)).toContain('`./src/release.ts`')
  })
})

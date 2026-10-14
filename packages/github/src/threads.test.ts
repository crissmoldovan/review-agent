import type { Octokit } from '@octokit/core'
import { describe, expect, it } from 'vitest'
import { REPLY_PAGE_SIZE, fetchThreadReplies } from './threads'

type Call = { route: string; params: Record<string, unknown> }

/** The shape GitHub returns from GET /repos/{owner}/{repo}/pulls/{pull_number}/comments, cut to
 *  the fields this module reads. */
type WireComment = {
  id: number; body: string; in_reply_to_id?: number | null; user: { login: string } | null
}

function fakeOctokit(pages: WireComment[][]) {
  const calls: Call[] = []
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params })
      const page = typeof params.page === 'number' ? params.page : 1
      return { status: 200, headers: {}, data: pages[page - 1] ?? [] }
    },
  } as unknown as Octokit
  return { octokit, calls }
}

const BOT = { login: 'review-agent[bot]' }
const HUMAN = { login: 'crissmoldovan' }

describe('fetchThreadReplies', () => {
  it('reads the replies under the bot’s own comments, keyed by the comment answered', async () => {
    const { octokit, calls } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10 — the token is logged', user: BOT },
      { id: 102, body: '/dispute intended, see ADR 4', in_reply_to_id: 101, user: HUMAN },
      { id: 103, body: 'Severity 5/10 — unhandled rejection', user: BOT },
      { id: 104, body: '/defer tracked in ACME-40', in_reply_to_id: 103, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101, 103],
    })
    // diffRuns matches a reply against MarkerFinding.commentId — the id of the comment being
    // replied TO. A reply keyed by its own id would match nothing and every dispute would be lost.
    expect(replies).toEqual([
      { commentId: 101, body: '/dispute intended, see ADR 4' },
      { commentId: 103, body: '/defer tracked in ACME-40' },
    ])
    expect(calls[0].route).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')
    // diffRuns takes the LAST reply on a thread, so the order is behaviour and not presentation,
    // and no default for sort or direction is documented. Say which order is meant.
    expect(calls[0].params.sort).toBe('created')
    expect(calls[0].params.direction).toBe('asc')
    expect(calls[0].params.per_page).toBe(REPLY_PAGE_SIZE)
    // No `since`: a /dispute filed three reviews ago is still the person's word.
    expect(calls[0].params.since).toBeUndefined()
  })

  it('never reads the bot’s own writing as a human verdict, when the caller names the bot', async () => {
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10 — the token is logged', user: BOT },
      { id: 105, body: '/dispute my own finding', in_reply_to_id: 101, user: BOT },
      { id: 106, body: 'fixing now', in_reply_to_id: 101, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101], ignoreRepliesFrom: BOT.login,
    })
    expect(replies).toEqual([{ commentId: 101, body: 'fixing now' }])
  })

  it('matches the named bot whatever the case, as GitHub matches logins', async () => {
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10', user: BOT },
      { id: 105, body: '/dispute my own finding', in_reply_to_id: 101, user: BOT },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101], ignoreRepliesFrom: 'Review-Agent[BOT]',
    })
    expect(replies).toEqual([])
  })

  it('hears the person who posted the review dispute its finding (spec 0.2.0 §3.3, decision §14.6)', async () => {
    // A person posting a review as themselves (`review-agent review --post`) is the author of every
    // comment it placed. Until 0.2.0 the author of the parent comments was treated as the bot, so
    // their own `/dispute` under their own review's finding was dropped in silence. Only an explicit
    // bot login is ignored now, and a person posting passes none.
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10 — the token is logged', user: HUMAN },
      { id: 102, body: '/dispute this logger is scrubbed downstream', in_reply_to_id: 101, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    expect(replies).toEqual([{ commentId: 101, body: '/dispute this logger is scrubbed downstream' }])
  })

  it('ignores nobody when it is told nobody, the bot included', async () => {
    // This product never replies under its own comments — it posts top-level comments and edits them
    // — so a bot reply is somebody else's automation, and an App that does not know its own login
    // passes nothing rather than guessing one.
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10', user: BOT },
      { id: 105, body: 'a note', in_reply_to_id: 101, user: BOT },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101], ignoreRepliesFrom: '',
    })
    expect(replies).toEqual([{ commentId: 101, body: 'a note' }])
  })

  it('counts a reply to a reply against the thread it is in', async () => {
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10', user: BOT },
      { id: 107, body: 'is this really 8?', in_reply_to_id: 101, user: HUMAN },
      { id: 108, body: '/dispute it is intended', in_reply_to_id: 107, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    expect(replies).toEqual([
      { commentId: 101, body: 'is this really 8?' },
      { commentId: 101, body: '/dispute it is intended' },
    ])
  })

  it('ignores comments on threads this review never opened', async () => {
    const { octokit } = fakeOctokit([[
      { id: 200, body: 'a human review comment of their own', user: HUMAN },
      { id: 201, body: '/dispute', in_reply_to_id: 200, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    expect(replies).toEqual([])
  })

  it('asks GitHub for nothing when the last run left no comments to answer', async () => {
    const { octokit, calls } = fakeOctokit([[]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [],
    })
    expect(replies).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('pages until a short page, as the file list does', async () => {
    const full: WireComment[] = Array.from({ length: REPLY_PAGE_SIZE }, (_, i) => ({
      id: 1_000 + i, body: `chatter ${i}`, in_reply_to_id: 101, user: HUMAN,
    }))
    const { octokit, calls } = fakeOctokit([
      [{ id: 101, body: 'Severity 8/10', user: BOT }, ...full.slice(1)],
      [{ id: 2_000, body: '/dispute the last word', in_reply_to_id: 101, user: HUMAN }],
    ])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    expect(calls).toHaveLength(2)
    expect(replies.at(-1)).toEqual({ commentId: 101, body: '/dispute the last word' })
  })
})

import type { Finding } from '@review-agent/core'
import {
  commentIdsIn, decodeMarker, encodeMarker, findingId, markerRunFor, nextMarkerState,
  recheckQuestions, type MarkerState,
} from './marker'

const token: Finding = {
  file: 'src/token.ts', line: 42, endLine: null, severity: 8, category: 'security',
  title: 'the installation token is logged at info', explanation: 'e', evidence: [], suggestion: null,
}
const retry: Finding = {
  file: 'src/retry.ts', line: 7, endLine: null, severity: 5, category: 'correctness',
  title: 'off-by-one in the retry loop', explanation: 'e', evidence: [], suggestion: null,
}

describe('a pull request reviewed three times', () => {
  it('marks each earlier finding fixed, still open or disputed', async () => {
    // Review 1: both findings posted inline, as comments 101 and 103.
    const first = markerRunFor({
      headSha: 'aaaaaaa', at: '2026-09-14T09:00:00.000Z',
      posted: {
        inline: [{ finding: token, line: 42, side: 'RIGHT' }, { finding: retry, line: 7, side: 'RIGHT' }],
        summaryOnly: [],
      },
      commentIdFor: (f) => (f === token ? 101 : 103),
    })
    const afterFirst = nextMarkerState({ previous: null, run: first, replies: [] })
    const body = `### Review of aaaaaaa\n\n${encodeMarker(afterFirst)}\n`

    // The author disputes one and repairs the other, then pushes.
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10 — the installation token is logged at info', user: BOT },
      { id: 102, body: '/dispute this logger is scrubbed downstream', in_reply_to_id: 101, user: HUMAN },
      { id: 103, body: 'Severity 5/10 — off-by-one in the retry loop', user: BOT },
    ]])

    // Review 2 of the new head reads the marker out of the comment body, then the replies under
    // the comments it names.
    const carried = decodeMarker(body)
    expect(carried).not.toBeNull()
    const state = carried as MarkerState
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: commentIdsIn(state),
    })
    expect(replies).toEqual([{ commentId: 101, body: '/dispute this logger is scrubbed downstream' }])

    const second = markerRunFor({
      headSha: 'bbbbbbb', at: '2026-09-14T11:00:00.000Z',
      posted: { inline: [{ finding: token, line: 44, side: 'RIGHT' }], summaryOnly: [] },
      commentIdFor: () => 201,
    })
    // Review 2 asks the re-review pass about both of review 1's rows, in the order the marker
    // holds them, and is told the retry loop is repaired. Nothing about what review 2 itself
    // reported is consulted: the answer is about the code at `bbbbbbb`.
    const asked = recheckQuestions(state).questions
    expect(asked.map((q) => q.title)).toEqual([token.title, retry.title])
    const afterSecond = nextMarkerState({
      previous: state, run: second, replies,
      judgements: [
        // Each answer names the file of the question it is about: `asked[0]` is the token finding,
        // `asked[1]` the retry one. An answer that named the other file would be dropped.
        { index: 0, file: token.file, state: 'still-present', reason: 'still logged at :42', evidence: ['src/token.ts:42'] },
        { index: 1, file: retry.file, state: 'resolved', reason: 'the loop now runs attempts times', evidence: ['src/retry.ts:7'] },
      ],
    })

    const settled = afterSecond.runs[0].findings
    expect(settled.find((f) => f.id === findingId(token))?.outcome).toBe('disputed')
    expect(settled.find((f) => f.id === findingId(retry))?.outcome).toBe('fixed')
    expect(afterSecond.runs[1].findings[0]).toMatchObject({
      id: findingId(token), line: 44, commentId: 201, outcome: 'disputed',
    })

    // Review 3, with nothing new said: the dispute is on comment 101 and the finding now lives
    // under comment 201, so only the carry keeps a person's word from being quietly withdrawn.
    const third = markerRunFor({
      headSha: 'ccccccc', at: '2026-09-14T13:00:00.000Z',
      posted: { inline: [{ finding: token, line: 44, side: 'RIGHT' }], summaryOnly: [] },
      commentIdFor: () => 301,
    })
    // Review 3 asks about ONE row of the two runs it can see. The token finding is disputed in both
    // of them, and a `/dispute` takes a finding out of the model's reach until the person says
    // otherwise. The retry row already stands `fixed` and is asked about ALL THE SAME — that is what
    // makes a wrong `fixed` undoable, and it is the only question this review buys.
    expect(recheckQuestions(afterSecond).questions.map((q) => q.title)).toEqual([retry.title])
    // Asked, and not answered: the pass produced nothing this time, so nothing moves.
    const afterThird = nextMarkerState({
      previous: afterSecond, run: third,
      replies: await fetchThreadReplies({
        octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: commentIdsIn(afterSecond),
      }),
      judgements: [],
    })
    expect(afterThird.runs).toHaveLength(3)
    expect(afterThird.runs[2].findings[0].outcome).toBe('disputed')
    // "Nothing moves" asserted rather than asserted-about: the retry row stood `fixed`, and it still
    // does. It used to go back to `open` here — the comment said nothing moved and the row moved —
    // which re-offered its already-edited comment to the retraction path on this review and every
    // review after it.
    expect(afterThird.runs[0].findings.find((f) => f.id === findingId(retry))?.outcome).toBe('fixed')
    expect(afterThird.runs[0].findings.find((f) => f.id === findingId(token))?.outcome).toBe('disputed')

    // And the whole thing still survives the round trip through a comment body.
    expect(decodeMarker(`### Review of ccccccc\n\n${encodeMarker(afterThird)}`)).toEqual(afterThird)
  })
})

import { MAX_REPLY_PAGES, MAX_THREAD_HOPS } from './threads'

// Neither bound below was a step. Both were found by mutating code the plan wrote and did not
// test — the pattern this build log has now recorded four times: a constant that reads as care
// and, unread by any case, buys nothing.
describe('fetchThreadReplies, bounded', () => {
  it('stops at a page cap rather than following a list that never ends', async () => {
    // Pinned rather than read out of the module, per this log's MAX_SUGGESTION_LINES finding: a
    // page cap is a product decision, not an API fact, and moving it should cost a deliberate edit.
    expect(MAX_REPLY_PAGES).toBe(30)
    const noise = (n: number): WireComment[] => Array.from({ length: REPLY_PAGE_SIZE }, (_, i) => ({
      id: n * 1_000 + i, body: 'a conversation of their own', in_reply_to_id: null, user: HUMAN,
    }))
    const { octokit, calls } = fakeOctokit(
      Array.from({ length: MAX_REPLY_PAGES + 1 }, (_, n) => noise(n + 1)),
    )
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    expect(calls).toHaveLength(MAX_REPLY_PAGES)
    expect(replies).toEqual([])
  })

  it('walks out of a reply chain that points back at itself', async () => {
    // What MAX_THREAD_HOPS is for, in the words of its own comment: a malformed chain must not
    // hang a review. 301 and 302 answer each other, so an uncapped walk up never reaches a root
    // and never ends. Without the cap this case does not fail with a message — it times out.
    expect(MAX_THREAD_HOPS).toBe(50)
    const { octokit } = fakeOctokit([[
      { id: 101, body: 'Severity 8/10', user: BOT },
      { id: 301, body: 'round', in_reply_to_id: 302, user: HUMAN },
      { id: 302, body: 'and round', in_reply_to_id: 301, user: HUMAN },
      { id: 303, body: '/dispute intended', in_reply_to_id: 101, user: HUMAN },
    ]])
    const replies = await fetchThreadReplies({
      octokit, owner: 'acme', repo: 'widgets', number: 16, parentIds: [101],
    })
    // The cycle belongs to no thread this review opened, so it is dropped, and the real reply
    // beside it still lands.
    expect(replies).toEqual([{ commentId: 101, body: '/dispute intended' }])
  })
})

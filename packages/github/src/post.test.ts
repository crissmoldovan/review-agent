import type { Octokit } from '@octokit/core'
import { describe, expect, it } from 'vitest'
import { commentKey, type InlineComment, MAX_COMMENT_PAGES, postReview } from './post'

type Call = { route: string; params: Record<string, unknown> }

type Canned = {
  /** The review the create call returns. Its `id` is what ties listed comments back to it. */
  review?: { id: number }
  /** One array per page of GET .../pulls/{n}/comments. */
  commentPages?: unknown[][]
  /** An HTTP status the FIRST create call throws, to stand in for a refused comment. */
  failCreateWith?: number
  /** An HTTP status the summary-comment EDIT is refused with. */
  failIssueEditWith?: number
  /** An HTTP status EVERY create call throws. The only way to exercise a *repeated* refusal, which
   *  is what tells a bounded retry from an unbounded one. */
  failEveryCreateWith?: number
  /** One array per page of GET .../issues/{n}/comments — the pull request's conversation. */
  issueCommentPages?: unknown[][]
  /** The id POST .../issues/{n}/comments hands back for a newly created summary comment. */
  newIssueCommentId?: number
}

/** A fake Octokit: a real object with a `request` method that records what it was asked for and
 *  answers with canned data. No network and no mocking library — these tests assert the EXACT
 *  requests the product makes, so the recording has to be the plain readable thing, and a route the
 *  product should not be calling has to blow up rather than quietly return undefined. */
const fakeOctokit = (canned: Canned = {}) => {
  const calls: Call[] = []
  let creates = 0
  const request = async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params })
    if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
      creates += 1
      if (canned.failEveryCreateWith !== undefined) {
        throw Object.assign(new Error('Validation Failed'), { status: canned.failEveryCreateWith })
      }
      if (canned.failCreateWith !== undefined && creates === 1) {
        throw Object.assign(new Error('Validation Failed'), { status: canned.failCreateWith })
      }
      return { status: 200, headers: {}, data: canned.review ?? { id: 900 } }
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') {
      const page = Number(params.page ?? 1)
      return { status: 200, headers: {}, data: (canned.commentPages ?? [[]])[page - 1] ?? [] }
    }
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      const page = Number(params.page ?? 1)
      return { status: 200, headers: {}, data: (canned.issueCommentPages ?? [[]])[page - 1] ?? [] }
    }
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      return { status: 200, headers: {}, data: { id: canned.newIssueCommentId ?? 8000 } }
    }
    if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
      if (canned.failIssueEditWith !== undefined) {
        throw Object.assign(new Error('Not Found'), { status: canned.failIssueEditWith })
      }
      return { status: 200, headers: {}, data: { id: params.comment_id } }
    }
    throw new Error(`the fake was asked for a route the product should not call: ${route}`)
  }
  return { octokit: { request } as unknown as Octokit, calls }
}

const routeCalls = (calls: Call[], route: string) => calls.filter((c) => c.route === route)

const comment = (over: Partial<InlineComment> = {}): InlineComment => ({
  findingId: 'a1b2c3d4e5f6',
  path: '.github/workflows/publish.yml',
  line: 100,
  side: 'RIGHT',
  body: '**Severity 7/10** · security',
  ...over,
})

const post = (octokit: Octokit, comments: InlineComment[], body = '### Review of `4f8e2a1`') =>
  postReview({
    octokit,
    owner: 'acme',
    repo: 'widgets',
    number: 16,
    headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
    body,
    comments,
  })

describe('postReview: one request, whatever the comment count', () => {
  it('sends every inline comment inside the single create-review call', async () => {
    // The documented secondary limit is 80 content-generating requests a minute and 500 an hour.
    // One POST /reviews carrying N comments costs 1 of that budget; N separate
    // POST .../pulls/{n}/comments calls would cost N. This test is that budget, locked.
    const { octokit, calls } = fakeOctokit()
    const comments = [
      comment({ findingId: 'aaa', line: 100 }),
      comment({ findingId: 'bbb', line: 104 }),
      comment({ findingId: 'ccc', line: 110 }),
    ]
    await post(octokit, comments)
    const creates = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')
    expect(creates).toHaveLength(1)
    expect(creates[0].params.comments).toHaveLength(3)
  })

  it('sends each comment at the path, line, side and body it was given', async () => {
    // The whole payload, not its length. Batch 2's verifiers rewrote the map to
    // `{ path, line: 1, side: 'LEFT', body: 'redacted' }` and all 19 cases stayed green: every
    // comment would have landed on line 1 of the old side of the file carrying no text.
    // The second failure it hides is worse: readBackCommentIds correlates on the body this module
    // INTENDED to send, so any drift between sent and intended mis-maps the comment ids that
    // Task 7's marker uses to find a person's reply.
    const { octokit, calls } = fakeOctokit()
    await post(octokit, [
      comment({ findingId: 'aaa', path: 'src/release.ts', line: 30, body: 'first' }),
      comment({ findingId: 'bbb', line: 104, body: 'second' }),
    ])
    const creates = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')
    expect(creates[0].params.comments).toEqual([
      { path: 'src/release.ts', line: 30, side: 'RIGHT', body: 'first' },
      { path: '.github/workflows/publish.yml', line: 104, side: 'RIGHT', body: 'second' },
    ])
  })
})

describe('postReview: which pull request it writes to', () => {
  it('addresses the create and the read-back at the repository and pull request it was given', async () => {
    // Nothing asserted this before: mutating `owner` to 'WRONG-ORG' and `pull_number` to 1 left all
    // 19 cases green, and a review is the one write on this pull request that cannot be taken back
    // by the person it lands on. The route template carries the placeholders, so these params ARE
    // the address.
    const { octokit, calls } = fakeOctokit({ review: { id: 900 }, commentPages: [[listed()]] })
    await post(octokit, [comment({ findingId: 'aaa', line: 100, body: '**Severity 7/10** · security' })])
    const create = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')[0]
    expect(create.params).toMatchObject({ owner: 'acme', repo: 'widgets', pull_number: 16 })
    const read = routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')[0]
    expect(read.params).toMatchObject({ owner: 'acme', repo: 'widgets', pull_number: 16 })
  })

  it('addresses the retry after a refusal at that same pull request', async () => {
    const { octokit, calls } = fakeOctokit({ failCreateWith: 422, review: { id: 901 } })
    await post(octokit, [comment()])
    for (const create of routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')) {
      expect(create.params).toMatchObject({ owner: 'acme', repo: 'widgets', pull_number: 16 })
    }
  })
})

describe('postReview: what kind of review it is', () => {
  it('submits a COMMENT review, because this product advises and does not vote', async () => {
    const { octokit, calls } = fakeOctokit()
    await post(octokit, [comment()])
    const create = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')[0]
    expect(create.params.event).toBe('COMMENT')
  })

  it('never approves and never requests changes, on any call it makes', async () => {
    // EVERY create, not just the first. The 422 retry below is a second create, and it is the one
    // taken when a push races the review — the moment a bot that voted APPROVE would be approving a
    // diff that has already moved. Batch 2's verifiers proved this: making the retry APPROVE left
    // all 19 cases green, because nothing asserted the event on the second call.
    const happy = fakeOctokit()
    await post(happy.octokit, [comment()])
    const raced = fakeOctokit({ failCreateWith: 422, review: { id: 901 } })
    await post(raced.octokit, [comment()])
    const events = [...happy.calls, ...raced.calls]
      .filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')
      .map((c) => c.params.event)
    expect(events).toHaveLength(3)
    expect(events).toEqual(['COMMENT', 'COMMENT', 'COMMENT'])
  })

  it('submits the empty review as a COMMENT too, because an empty review is not an approval', async () => {
    // A review with no inline comments is a review whose placements GitHub refused, or one that had
    // none to make. Neither is a verdict. Asserting only that the event is DEFINED let a mutation
    // to `comments.length === 0 ? 'APPROVE' : 'COMMENT'` pass every case in this file.
    const { octokit, calls } = fakeOctokit()
    await post(octokit, [])
    const create = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')[0]
    expect(create.params.event).toBe('COMMENT')
  })

  it('pins the review to the head sha it reviewed', async () => {
    const { octokit, calls } = fakeOctokit()
    await post(octokit, [comment()])
    const create = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')[0]
    expect(create.params.commit_id).toBe('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
  })

  it('sends the summary text as the review body', async () => {
    const { octokit, calls } = fakeOctokit()
    await post(octokit, [], 'the whole summary')
    const create = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')[0]
    expect(create.params.body).toBe('the whole summary')
  })

  it('returns the review id GitHub assigned', async () => {
    const { octokit } = fakeOctokit({ review: { id: 777 } })
    expect((await post(octokit, [])).reviewId).toBe(777)
  })
})

const listed = (over: Record<string, unknown> = {}) => ({
  id: 5001,
  path: '.github/workflows/publish.yml',
  line: 100,
  side: 'RIGHT',
  body: '**Severity 7/10** · security',
  pull_request_review_id: 900,
  ...over,
})

describe('postReview: reading the created comment ids back', () => {
  it('maps each finding to the comment id GitHub created for it', async () => {
    // The create response carries the REVIEW id only — never the ids of the comments it made — so
    // the ids come from the list endpoint, tied back on `pull_request_review_id`.
    // `MarkerFinding.commentId` is what needs them: without it a re-review cannot read the replies
    // in its own threads.
    const { octokit } = fakeOctokit({
      review: { id: 900 },
      commentPages: [[
        listed({ id: 5001, line: 100, body: 'first' }),
        listed({ id: 5002, line: 104, body: 'second' }),
      ]],
    })
    const out = await post(octokit, [
      comment({ findingId: 'aaa', line: 100, body: 'first' }),
      comment({ findingId: 'bbb', line: 104, body: 'second' }),
    ])
    // Keyed by the finding AND the line it went on: two findings can share a `findingId`, and
    // keyed by the id alone the second comment's id overwrote the first.
    expect(out.commentIds.get(commentKey('aaa', 100))).toBe(5001)
    expect(out.commentIds.get(commentKey('bbb', 104))).toBe(5002)
  })

  it('keeps both ids when two findings on different lines share one findingId', async () => {
    // The live shape: one title reported twice in one file. `report.ts` says two findings can share
    // an id and nothing dedupes them, so this is not hypothetical — and the id that used to be lost
    // took a whole thread with it, replies included.
    const { octokit } = fakeOctokit({
      review: { id: 900 },
      commentPages: [[
        listed({ id: 5001, line: 24, body: 'same words' }),
        listed({ id: 5002, line: 40, body: 'same words' }),
      ]],
    })
    const out = await post(octokit, [
      comment({ findingId: 'twin', line: 24, body: 'same words' }),
      comment({ findingId: 'twin', line: 40, body: 'same words' }),
    ])
    expect(out.commentIds.get(commentKey('twin', 24))).toBe(5001)
    expect(out.commentIds.get(commentKey('twin', 40))).toBe(5002)
    expect(out.commentIds.size).toBe(2)
  })

  it('ignores comments that belong to another review, or to a person', async () => {
    const { octokit } = fakeOctokit({
      review: { id: 900 },
      commentPages: [[
        listed({ id: 4000, line: 100, body: 'first', pull_request_review_id: 42 }),
        listed({ id: 4001, line: 100, body: 'first', pull_request_review_id: null }),
        listed({ id: 5001, line: 100, body: 'first', pull_request_review_id: 900 }),
      ]],
    })
    const out = await post(octokit, [comment({ findingId: 'aaa', line: 100, body: 'first' })])
    expect(out.commentIds.get(commentKey('aaa', 100))).toBe(5001)
    expect(out.commentIds.size).toBe(1)
  })

  it('tells two findings on the same line apart by the body GitHub stored', async () => {
    const { octokit } = fakeOctokit({
      review: { id: 900 },
      commentPages: [[
        listed({ id: 5002, line: 100, body: 'the second one' }),
        listed({ id: 5001, line: 100, body: 'the first one' }),
      ]],
    })
    const out = await post(octokit, [
      comment({ findingId: 'aaa', line: 100, body: 'the first one' }),
      comment({ findingId: 'bbb', line: 100, body: 'the second one' }),
    ])
    expect(out.commentIds.get(commentKey('aaa', 100))).toBe(5001)
    expect(out.commentIds.get(commentKey('bbb', 100))).toBe(5002)
  })

  it('pages the comment list and stops on a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      listed({ id: 6000 + i, line: 1000 + i, body: `noise ${i}` }))
    const { octokit, calls } = fakeOctokit({
      review: { id: 900 },
      commentPages: [page1, [listed({ id: 7000, line: 100, body: 'mine' })]],
    })
    const out = await post(octokit, [comment({ findingId: 'aaa', line: 100, body: 'mine' })])
    expect(out.commentIds.get(commentKey('aaa', 100))).toBe(7000)
    expect(routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')).toHaveLength(2)
  })

  it('asks for a hundred comments a page, so a long review is two requests not thirty', async () => {
    const { octokit, calls } = fakeOctokit({ review: { id: 900 }, commentPages: [[listed()]] })
    await post(octokit, [comment({ findingId: 'aaa', line: 100, body: '**Severity 7/10** · security' })])
    const get = routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')[0]
    expect(get.params.per_page).toBe(100)
  })

  it('stops at a page cap rather than following a list that never ends', async () => {
    // The cap is ours, not GitHub's: nothing in the API documents a limit on this list, so the loop
    // is unbounded unless something stops it — and nothing but this case would notice if the bound
    // were removed or raised. Pinned to 30, the way SUGGESTION_FENCE is, so moving it is deliberate.
    expect(MAX_COMMENT_PAGES).toBe(30)
    const full = Array.from({ length: 100 }, (_, i) =>
      listed({ id: 8000 + i, line: 2000 + i, body: `noise ${i}` }))
    const { octokit, calls } = fakeOctokit({
      review: { id: 900 },
      commentPages: Array.from({ length: MAX_COMMENT_PAGES + 1 }, () => full),
    })
    const out = await post(octokit, [comment({ findingId: 'aaa', line: 100, body: 'never listed' })])
    expect(routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments'))
      .toHaveLength(MAX_COMMENT_PAGES)
    expect(out.commentIds.size).toBe(0)
  })

  it('spends no request at all when the review had no inline comments', async () => {
    const { octokit, calls } = fakeOctokit()
    const out = await post(octokit, [])
    expect(routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')).toHaveLength(0)
    expect(out.commentIds.size).toBe(0)
  })
})

describe('postReview: when GitHub refuses a comment', () => {
  it('posts the review without its inline comments, rather than not at all', async () => {
    // GitHub validates comments[] as a unit: a comment whose line is not in the diff takes the
    // whole review down with it. `anchorFindings` only ever offers lines it read out of the pull
    // request's own patch, so a 422 here means the diff moved under us — a push that raced the
    // review. Decision (Criss's rule that a review must still be readable): drop the placement,
    // keep the review. The summary body already names every finding, so nothing is lost but where
    // it is said.
    const { octokit, calls } = fakeOctokit({ failCreateWith: 422, review: { id: 901 } })
    const comments = [comment({ findingId: 'aaa', line: 100 }), comment({ findingId: 'bbb', line: 104 })]
    const out = await post(octokit, comments)
    const creates = routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')
    expect(creates).toHaveLength(2)
    expect(creates[1].params.comments).toEqual([])
    expect(out.reviewId).toBe(901)
    expect(out.droppedInline.map((c) => c.findingId)).toEqual(['aaa', 'bbb'])
  })

  it('reports no comment ids when nothing was placed inline', async () => {
    const { octokit, calls } = fakeOctokit({ failCreateWith: 422, review: { id: 901 } })
    const out = await post(octokit, [comment()])
    expect(out.commentIds.size).toBe(0)
    expect(routeCalls(calls, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments')).toHaveLength(0)
  })

  it('retries once and only once, so a repeated refusal is not a loop', async () => {
    // The fake refuses EVERY create here, which is the only way to tell a bounded retry from an
    // unbounded one: with a fake that refuses just the first call, an implementation that retried
    // forever would still resolve on the second and nothing would notice (build log, Task 4).
    // Two attempts, then the refusal escapes.
    const { octokit, calls } = fakeOctokit({ failEveryCreateWith: 422 })
    await expect(post(octokit, [comment()])).rejects.toThrow('Validation Failed')
    expect(routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')).toHaveLength(2)
  })

  it('rethrows a failure that is not a refused comment, because a 500 is not our business', async () => {
    const { octokit, calls } = fakeOctokit({ failCreateWith: 500 })
    await expect(post(octokit, [comment()])).rejects.toThrow('Validation Failed')
    expect(routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')).toHaveLength(1)
  })

  it('rethrows a 422 on a review that had no comments, because then it is not the comments', async () => {
    const { octokit, calls } = fakeOctokit({ failCreateWith: 422 })
    await expect(post(octokit, [])).rejects.toThrow('Validation Failed')
    expect(routeCalls(calls, 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')).toHaveLength(1)
  })
})

import { MARKER_OPEN, decodeMarker, encodeMarker } from './marker'
import { MAX_ISSUE_COMMENT_PAGES, upsertSummaryComment } from './post'

const CREATE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
const EDIT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
const LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'

const botBody = (headSha: string) =>
  `### Review of \`${headSha.slice(0, 7)}\`\n\nnothing alarming.\n\n` +
  encodeMarker({ version: 1, runs: [{ headSha, at: '2026-09-14T10:00:00.000Z', findings: [] }] })

const issueComment = (over: Record<string, unknown> = {}) => ({
  id: 9001, body: 'looks good to me', user: { login: 'criss' }, ...over,
})

const upsert = (octokit: Octokit, body: string, selfLogin?: string) =>
  upsertSummaryComment({
    octokit, owner: 'acme', repo: 'widgets', number: 16, body,
    ...(selfLogin !== undefined && { selfLogin }),
  })

describe('upsertSummaryComment: a pull request never collects a wall of bot comments', () => {
  it('creates the summary comment on a first review', async () => {
    const { octokit, calls } = fakeOctokit({ issueCommentPages: [[]], newIssueCommentId: 8100 })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(out).toEqual({ commentId: 8100, created: true })
    expect(routeCalls(calls, CREATE)).toHaveLength(1)
    expect(routeCalls(calls, EDIT)).toHaveLength(0)
  })

  it('sends the body it was given, unchanged', async () => {
    const body = botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
    const { octokit, calls } = fakeOctokit({ issueCommentPages: [[]] })
    await upsert(octokit, body)
    expect(routeCalls(calls, CREATE)[0].params.body).toBe(body)
  })

  it('sends the body it was given unchanged on an edit too, not only on a create', async () => {
    // The edit path is the one every push after the first takes, and it had no verbatim lock:
    // batch 2's verifiers cut the PATCH body down to `body.slice(body.indexOf(MARKER_OPEN))` —
    // keeping the hidden state and throwing away the entire human-readable review — and all 29
    // cases stayed green, because the only assertion on this body was that its marker still decoded.
    const body = botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9002, body: botBody('0'.repeat(40)) })]],
    })
    await upsert(octokit, body)
    expect(routeCalls(calls, EDIT)[0].params.body).toBe(body)
  })

  it('lists, creates and edits on the pull request it was given and no other', async () => {
    // A summary comment posted onto a stranger's pull request would have passed this suite:
    // mutating `owner` to 'WRONG-ORG' and `issue_number` to 1 on both the list and the create left
    // all 29 cases green. Note the two path shapes — an issue comment is EDITED at
    // /issues/comments/{id} with no issue number, so `owner` and `repo` are its whole address.
    const fresh = fakeOctokit({ issueCommentPages: [[]], newIssueCommentId: 8100 })
    await upsert(fresh.octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(routeCalls(fresh.calls, LIST)[0].params)
      .toMatchObject({ owner: 'acme', repo: 'widgets', issue_number: 16 })
    expect(routeCalls(fresh.calls, CREATE)[0].params)
      .toMatchObject({ owner: 'acme', repo: 'widgets', issue_number: 16 })

    const again = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9002, body: botBody('0'.repeat(40)) })]],
    })
    await upsert(again.octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(routeCalls(again.calls, EDIT)[0].params)
      .toMatchObject({ owner: 'acme', repo: 'widgets', comment_id: 9002 })
  })

  it('edits its own earlier comment on a re-review, and posts no second one', async () => {
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[
        issueComment({ id: 9001, body: 'looks good to me', user: { login: 'criss' } }),
        issueComment({ id: 9002, body: botBody('0'.repeat(40)), user: { login: 'review-agent[bot]' } }),
      ]],
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(out).toEqual({ commentId: 9002, created: false })
    expect(routeCalls(calls, CREATE)).toHaveLength(0)
    expect(routeCalls(calls, EDIT)).toHaveLength(1)
    expect(routeCalls(calls, EDIT)[0].params.comment_id).toBe(9002)
  })

  it('finds its comment on the second page of a long conversation', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issueComment({ id: 9100 + i, body: `noise ${i}` }))
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [page1, [issueComment({ id: 9500, body: botBody('0'.repeat(40)) })]],
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(out.commentId).toBe(9500)
    expect(routeCalls(calls, LIST)).toHaveLength(2)
    expect(routeCalls(calls, LIST)[0].params.per_page).toBe(100)
  })

  it('is not fooled by a person quoting the marker text', async () => {
    // A developer complaining about the bot pastes the marker's opening into their own comment.
    // It contains MARKER_OPEN and decodes to nothing. Editing it would silently rewrite a person's
    // words with the product's, which is the worst thing this function could do.
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[
        issueComment({ id: 9300, body: `what is this \`${MARKER_OPEN}\` thing in my PR?` }),
        issueComment({ id: 9301, body: `${MARKER_OPEN}notbase64!!!${' -->'}` }),
      ]],
      newIssueCommentId: 8200,
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(out).toEqual({ commentId: 8200, created: true })
    expect(routeCalls(calls, EDIT)).toHaveLength(0)
  })

  it('takes the login as a secondary signal when two comments carry a real marker', async () => {
    // Someone pasted the whole bot comment, marker and all, to quote it. The login is what breaks
    // the tie — and only the tie: it never identifies the comment on its own.
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[
        issueComment({ id: 9400, body: botBody('0'.repeat(40)), user: { login: 'criss' } }),
        issueComment({ id: 9401, body: botBody('0'.repeat(40)), user: { login: 'review-agent[bot]' } }),
      ]],
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'), 'review-agent[bot]')
    expect(out.commentId).toBe(9401)
    expect(routeCalls(calls, EDIT)[0].params.comment_id).toBe(9401)
  })

  it('still works when the login is unknown, because the convention is not documented', async () => {
    const { octokit } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9402, body: botBody('0'.repeat(40)), user: null })]],
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(out).toEqual({ commentId: 9402, created: false })
  })

  it('ignores a login that matches nothing, rather than posting a second comment', async () => {
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9403, body: botBody('0'.repeat(40)), user: { login: 'someone-else' } })]],
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'), 'review-agent[bot]')
    expect(out.commentId).toBe(9403)
    expect(routeCalls(calls, CREATE)).toHaveLength(0)
  })

  it('leaves a body whose marker the next review can read, whether it created or edited', async () => {
    // The loop this closes: post → find by marker → edit → the edited body still carries a marker
    // the NEXT review will find. A body written back without one would orphan the comment forever.
    const body = botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9600, body: botBody('0'.repeat(40)) })]],
    })
    await upsert(octokit, body)
    const written = routeCalls(calls, EDIT)[0].params.body
    expect(typeof written).toBe('string')
    expect(decodeMarker(String(written))?.runs[0].headSha).toBe('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
  })

  it('stops at a page cap rather than reading a conversation that never ends', async () => {
    // The cap is ours, not GitHub's: nothing we verified documents a limit on the issue-comment
    // list, so this loop is unbounded unless something stops it. Not in the plan: removing the
    // bound entirely left all 28 cases green, exactly as the build log records for
    // MAX_COMMENT_PAGES in Task 4. Pinned to 30, the way SUGGESTION_FENCE is, so moving it is
    // deliberate rather than incidental.
    expect(MAX_ISSUE_COMMENT_PAGES).toBe(30)
    const full = Array.from({ length: 100 }, (_, i) => issueComment({ id: 9700 + i, body: `noise ${i}` }))
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: Array.from({ length: MAX_ISSUE_COMMENT_PAGES + 1 }, () => full),
      newIssueCommentId: 8300,
    })
    const out = await upsert(octokit, botBody('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'))
    expect(routeCalls(calls, LIST)).toHaveLength(MAX_ISSUE_COMMENT_PAGES)
    // Nothing carrying a marker was found in the pages it did read, so it posts a new summary.
    expect(out).toEqual({ commentId: 8300, created: true })
  })
})

import { findSummaryComment } from './post'

const HEAD = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const where = { owner: 'acme', repo: 'widgets', number: 16 } as const

describe('findSummaryComment: the previous review, read back', () => {
  it('returns its own summary comment with the state its marker carries', async () => {
    const { octokit } = fakeOctokit({
      issueCommentPages: [[
        issueComment({ id: 9001, body: 'looks good to me' }),
        issueComment({ id: 9002, body: botBody('0'.repeat(40)), user: { login: 'review-agent[bot]' } }),
      ]],
    })
    const found = await findSummaryComment({ octokit, ...where })
    expect(found?.commentId).toBe(9002)
    expect(found?.marker.runs[0].headSha).toBe('0'.repeat(40))
  })

  it('finds nothing on a pull request it has never reviewed', async () => {
    const { octokit } = fakeOctokit({ issueCommentPages: [[issueComment({ id: 9001 })]] })
    expect(await findSummaryComment({ octokit, ...where })).toBeNull()
  })

  it('does not take a person quoting the marker text for its own comment', async () => {
    const { octokit } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9300, body: `what is this \`${MARKER_OPEN}\` thing?` })]],
    })
    expect(await findSummaryComment({ octokit, ...where })).toBeNull()
  })
})

describe('upsertSummaryComment: with the comment the caller already found', () => {
  it('edits that comment without listing the conversation a second time', async () => {
    // The comment whose marker a re-review built on must be the comment it overwrites. A second
    // listing could pick another one if a person pasted the bot's comment in between.
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[issueComment({ id: 9002, body: botBody('0'.repeat(40)) })]],
    })
    const found = await findSummaryComment({ octokit, ...where })
    const out = await upsertSummaryComment({ octokit, ...where, body: botBody(HEAD), existing: found })
    expect(out).toEqual({ commentId: 9002, created: false })
    expect(routeCalls(calls, LIST)).toHaveLength(1)
    expect(routeCalls(calls, EDIT)[0].params.comment_id).toBe(9002)
  })

  it('creates one when the caller looked and found none, without looking again', async () => {
    const { octokit, calls } = fakeOctokit({ issueCommentPages: [[]], newIssueCommentId: 8300 })
    const out = await upsertSummaryComment({ octokit, ...where, body: botBody(HEAD), existing: null })
    expect(out).toEqual({ commentId: 8300, created: true })
    expect(routeCalls(calls, LIST)).toHaveLength(0)
    expect(routeCalls(calls, CREATE)).toHaveLength(1)
  })

  it('posts the review anyway when the comment it was told to edit has been deleted', async () => {
    // The caller's `existing` can be MINUTES old: since 2026-09-16 the marker is read before the
    // review, because the re-review pass's question comes out of it, and a review takes minutes.
    // Somebody deleting the bot's summary in that window used to turn a finished, paid-for review
    // into a 404 out of publishReview, a DoNotRetry, and a review nobody ever saw. A missing comment
    // is not a reason to lose a review: write a new one.
    const { octokit, calls } = fakeOctokit({
      issueCommentPages: [[]], newIssueCommentId: 8400, failIssueEditWith: 404,
    })
    const out = await upsertSummaryComment({
      octokit, ...where, body: botBody(HEAD),
      existing: { commentId: 9002, marker: { version: 1, runs: [] } },
    })
    expect(out).toEqual({ commentId: 8400, created: true })
    expect(routeCalls(calls, EDIT)).toHaveLength(1)
    expect(routeCalls(calls, CREATE)).toHaveLength(1)
    expect(routeCalls(calls, LIST)).toHaveLength(0)
  })

  it('does not paper over an edit GitHub refused for any other reason', async () => {
    // A 403 is a permission this deployment does not have, and a second comment would neither fix
    // it nor be wanted. Only "it is not there" earns a create.
    const { octokit, calls } = fakeOctokit({ issueCommentPages: [[]], failIssueEditWith: 403 })
    await expect(upsertSummaryComment({
      octokit, ...where, body: botBody(HEAD),
      existing: { commentId: 9002, marker: { version: 1, runs: [] } },
    })).rejects.toThrow('Not Found')
    expect(routeCalls(calls, CREATE)).toHaveLength(0)
  })
})

import { reinstateInlineComment, retractInlineComment } from './post'
import { REINSTATED_MARKER, RETRACTED_MARKER } from './body'

// ── Retracting one inline comment ────────────────────────────────────────────────────────────────
// Criss, 2026-09-15: a finding this review no longer reports leaves a comment behind that still
// asserts a bug, on the current commit, in code that may now contradict it. Measured: comment
// 4013794900 says "setTimeout is always 0" and GitHub re-anchored it onto a line that reads
// `setTimeout(resolve, delayMs)`.
//
// EDIT, never delete: a reply, a /dispute, a whole conversation may hang off the comment.
// `PATCH /repos/{o}/{r}/pulls/comments/{id}` — note the path shape; the ISSUE comment route has no
// pull number and mixing the two 404s. Permission: Pull requests (write), which manifest.ts already
// declares, so there is no re-registration and no re-consent.

const REVIEW_COMMENT = 'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}'
const REVIEW_COMMENT_EDIT = 'PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}'

/** The comment as GitHub really answers for it. `pull_request_url` is what says which pull request
 *  it is on — the edit route carries no pull number at all — and `path`/`line` are where GitHub has
 *  re-anchored it onto the current head. */
const fakeComment = (seed: {
  body?: string; getThrows?: unknown; patchThrows?: unknown
  pullRequestUrl?: string; inReplyTo?: number | null; path?: string; line?: number | null
  /** Drop a field from the answer entirely, to see what a refusal depends on. */
  omit?: string[]
} = {}) => {
  const calls: Call[] = []
  const request = async (route: string, params: Record<string, unknown>) => {
    calls.push({ route, params })
    if (route === REVIEW_COMMENT) {
      if (seed.getThrows !== undefined) throw seed.getThrows
      const data: Record<string, unknown> = {
        id: params.comment_id,
        body: seed.body ?? '**Severity 8/10** · correctness\n\nNo backoff.',
        pull_request_url: seed.pullRequestUrl ?? 'https://api.github.com/repos/acme/widgets/pulls/16',
        in_reply_to_id: seed.inReplyTo ?? null,
        path: seed.path ?? 'src/retry.ts',
        line: seed.line === undefined ? 24 : seed.line,
      }
      for (const key of seed.omit ?? []) delete data[key]
      return { status: 200, headers: {}, data }
    }
    if (route === REVIEW_COMMENT_EDIT) {
      if (seed.patchThrows !== undefined) throw seed.patchThrows
      return { status: 200, headers: {}, data: { id: params.comment_id } }
    }
    throw new Error(`the fake was asked for a route retraction should not call: ${route}`)
  }
  return { octokit: { request } as unknown as Octokit, calls }
}

const retract = (octokit: Octokit, over: { commentId?: number; postedAt?: Set<string> } = {}) =>
  retractInlineComment({
    octokit, owner: 'acme', repo: 'widgets', number: 16,
    commentId: over.commentId ?? 4013794900,
    ...(over.postedAt !== undefined && { postedAt: over.postedAt }),
    note: `x\n${RETRACTED_MARKER}\nno longer reported`,
  })

describe('retractInlineComment', () => {
  it('edits the comment in place, keeping everything it already said', async () => {
    const gh = fakeComment()
    expect(await retract(gh.octokit)).toBe('edited')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT, REVIEW_COMMENT_EDIT])
    const edit = gh.calls[1]
    expect(edit.params.comment_id).toBe(4013794900)
    // The original is kept. A person replying "/dispute" under it is answering THAT text, and a
    // thread whose first comment has been overwritten reads as a different conversation.
    expect(String(edit.params.body)).toContain('No backoff.')
    expect(String(edit.params.body)).toContain('no longer reported')
    // `body` only. Nothing else about the comment is ours to move.
    expect(Object.keys(edit.params).sort()).toEqual(['body', 'comment_id', 'owner', 'repo'])
  })

  it('never DELETEs, whatever else it does', async () => {
    const gh = fakeComment()
    await retract(gh.octokit)
    expect(gh.calls.some((c) => c.route.startsWith('DELETE'))).toBe(false)
  })

  it('leaves a comment it has already retracted alone', async () => {
    // A review whose marker write failed after the edit succeeded would otherwise append the note
    // again on the next run, and again on the one after that.
    const gh = fakeComment({ body: `**Severity 8/10**\n\n---\n${RETRACTED_MARKER}\nNo longer reported.` })
    expect(await retract(gh.octokit)).toBe('already-retracted')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('does not throw when GitHub refuses the edit', async () => {
    // A comment somebody deleted, a permission a deployment narrowed, a network failure. A courtesy
    // edit must never cost the pull request its review — the same posture as changedFilesBetween.
    const gh = fakeComment({ patchThrows: Object.assign(new Error('Not Found'), { status: 404 }) })
    expect(await retract(gh.octokit)).toBe('failed')
  })

  it('does not throw when it cannot even read the comment', async () => {
    const gh = fakeComment({ getThrows: Object.assign(new Error('Not Found'), { status: 404 }) })
    expect(await retract(gh.octokit)).toBe('failed')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('will not edit a comment on another pull request, whatever the marker says', async () => {
    // The edit route is scoped to the REPOSITORY: owner, repo, comment id, body — nothing in it
    // names a pull request. The comment id comes out of a marker, a marker is read from a
    // pull-request comment, and anyone who can comment can write one. Unchecked, one planted
    // comment aims this edit at any review comment in the repository, including a person's.
    const gh = fakeComment({ pullRequestUrl: 'https://api.github.com/repos/acme/widgets/pulls/9' })
    expect(await retract(gh.octokit, { commentId: 777000777 })).toBe('not-ours-to-edit')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('will not edit a comment in another repository either', async () => {
    const gh = fakeComment({ pullRequestUrl: 'https://api.github.com/repos/acme/other-repo/pulls/16' })
    expect(await retract(gh.octokit)).toBe('not-ours-to-edit')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('reads the owner and repo the way GitHub does, so a spelling is not a refusal', async () => {
    // Logins and repository names are case-insensitive on GitHub, and the caller's spelling comes
    // from a webhook rather than from this URL.
    const gh = fakeComment({ pullRequestUrl: 'https://api.github.com/repos/ACME/Widgets/pulls/16' })
    expect(await retract(gh.octokit)).toBe('edited')
  })

  it('refuses when the answer does not say which pull request the comment is on', async () => {
    // The one field that AUTHORISES the edit. Missing, the safe answer is not to write.
    const gh = fakeComment({ omit: ['pull_request_url'] })
    expect(await retract(gh.octokit)).toBe('failed')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('will not edit a reply somebody left under a thread', async () => {
    // This product never posts a reply — `postReview` creates top-level comments — so a marker
    // naming a reply's id is naming a comment that is not ours, and on this pull request the scope
    // check above would have waved it through.
    const gh = fakeComment({ inReplyTo: 4013794900 })
    expect(await retract(gh.octokit, { commentId: 4013799999 })).toBe('not-ours-to-edit')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('leaves a comment alone when THIS review has just commented on its line', async () => {
    // The anchor rule hashes the line's TEXT, so an edited line reads as a gone line: a `// TODO`
    // appended to it makes the row `fixed` while the defect, and the model, are still there. Without
    // this the run posts the finding and then stamps "no longer reported" on the comment beside it.
    const gh = fakeComment({ path: 'src/retry.ts', line: 13 })
    expect(await retract(gh.octokit, { postedAt: new Set(['src/retry.ts:13']) })).toBe('still-reported')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('retracts when this review commented somewhere else', async () => {
    // The measured repair: the stale comment is at line 24 and this review's comments are at 13 and
    // 21. No collision, so the retraction the whole feature exists for still lands.
    const gh = fakeComment({ path: 'src/retry.ts', line: 24 })
    expect(await retract(gh.octokit, { postedAt: new Set(['src/retry.ts:13', 'src/retry.ts:21']) }))
      .toBe('edited')
  })

  it('retracts a comment GitHub has given up placing', async () => {
    // An outdated comment has no line, so there is no collision to find and nothing to withhold.
    const gh = fakeComment({ line: null })
    expect(await retract(gh.octokit, { postedAt: new Set(['src/retry.ts:24']) })).toBe('edited')
  })
})

// ── And taking one back ──────────────────────────────────────────────────────────────────────────
// A retraction used to be permanent in public: the marker could push a wrong `fixed` back to `open`
// and the comment went on saying the reviewer no longer found the issue, under a defect the product
// had just re-confirmed. Same route, same refusals, same never-throws posture; the state test is
// inverted, and the two hidden markers make the comment a two-state ledger rather than a one-way
// flag.

const reinstate = (octokit: Octokit, commentId = 4013794900) =>
  reinstateInlineComment({
    octokit, owner: 'acme', repo: 'widgets', number: 16, commentId,
    note: `x\n${REINSTATED_MARKER}\nreported again`,
  })

const RETRACTED_BODY = `**Severity 8/10** · correctness\n\nNo backoff.\n\n---\n${RETRACTED_MARKER}\nNo longer reported.`

describe('reinstateInlineComment', () => {
  it('appends the correction, keeping both the finding and the note it corrects', async () => {
    const gh = fakeComment({ body: RETRACTED_BODY })
    expect(await reinstate(gh.octokit)).toBe('edited')
    const body = String(gh.calls[1].params.body)
    expect(body).toContain('No backoff.')            // what it always said
    expect(body).toContain('No longer reported.')    // the note it is correcting, left standing
    expect(body).toContain('reported again')
    expect(Object.keys(gh.calls[1].params).sort()).toEqual(['body', 'comment_id', 'owner', 'repo'])
  })

  it('has nothing to correct on a comment that was never retracted', async () => {
    const gh = fakeComment()
    expect(await reinstate(gh.octokit)).toBe('already-retracted')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('writes no second correction on a comment already reinstated', async () => {
    const gh = fakeComment({ body: `${RETRACTED_BODY}\n\n---\n${REINSTATED_MARKER}\nReported again.` })
    expect(await reinstate(gh.octokit)).toBe('already-retracted')
    expect(gh.calls.map((c) => c.route)).toEqual([REVIEW_COMMENT])
  })

  it('lets a comment be retracted again after it was reinstated', async () => {
    // The LAST marker in the body is what the comment claims. Reading only "does it contain a
    // retraction" would leave a reinstated comment un-retractable for ever — and a defect that came
    // back and went away again is an ordinary thing for a pull request to do.
    const gh = fakeComment({ body: `${RETRACTED_BODY}\n\n---\n${REINSTATED_MARKER}\nReported again.` })
    expect(await retract(gh.octokit)).toBe('edited')
  })

  it('refuses everything the retraction refuses, and never throws', async () => {
    const elsewhere = fakeComment({
      body: RETRACTED_BODY, pullRequestUrl: 'https://api.github.com/repos/acme/widgets/pulls/9',
    })
    expect(await reinstate(elsewhere.octokit, 777000777)).toBe('not-ours-to-edit')
    const reply = fakeComment({ body: RETRACTED_BODY, inReplyTo: 4013794900 })
    expect(await reinstate(reply.octokit, 4013799999)).toBe('not-ours-to-edit')
    const unauthorised = fakeComment({ body: RETRACTED_BODY, omit: ['pull_request_url'] })
    expect(await reinstate(unauthorised.octokit)).toBe('failed')
    const refused = fakeComment({
      body: RETRACTED_BODY, patchThrows: Object.assign(new Error('Forbidden'), { status: 403 }),
    })
    expect(await reinstate(refused.octokit)).toBe('failed')
  })
})

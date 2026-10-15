import type { Octokit } from '@octokit/core'
import { z } from 'zod'
import { REINSTATED_MARKER, RETRACTED_MARKER, reinstatementNote, stillPresentMarker, stillPresentNote } from './body'
import { MARKER_OPEN, decodeMarker, type MarkerState } from './marker'

export type InlineComment = {
  /** `findingId(finding)` — the key Task 7 writes back into the marker. */
  findingId: string
  path: string
  line: number
  side: 'RIGHT'
  body: string
}

export type PostedReview = {
  reviewId: number
  /** `commentKey(findingId, line)` -> the id GitHub gave the inline comment it created there.
   *
   *  Keyed by the finding AND the line, not by the finding alone (Criss, 2026-09-16). `findingId`
   *  hashes file, category and title, and `report.ts` says out loud that two findings can share all
   *  three — the same title twice in one file, at two different lines, which nothing dedupes. Keyed
   *  by the id alone, the second one overwrote the first: one of the two real comments never entered
   *  the marker at all, so `commentIdsIn` never listed it, `fetchThreadReplies` never fetched its
   *  thread, a `/dispute` written under it was never read, and it could never be retracted. */
  commentIds: Map<string, number>
  /** Inline comments GitHub refused. Empty on the happy path. */
  droppedInline: InlineComment[]
}

/** The key of `PostedReview.commentIds`. One function, because the half that writes the map and the
 *  half that reads it live in different modules. */
export const commentKey = (findingId: string, line: number): string => `${findingId}:${line}`

const ReviewSchema = z.object({ id: z.number().int() })

/** Ours, not GitHub's: the research found NO documented cap on this list, so this is a guard
 *  against an unbounded loop rather than an API fact. 30 x 100 = 3,000 review comments on one pull
 *  request, which is far past anything a human conversation reaches. */
export const MAX_COMMENT_PAGES = 30

const CommentSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  line: z.number().int().nullable(),
  body: z.string(),
  pull_request_review_id: z.number().int().nullable(),
})

const key = (path: string, line: number): string => `${path}:${line}`

/** The create response carries the REVIEW id only — the ids of the comments it made are not in it —
 *  so they are listed back and tied to the review through `pull_request_review_id`. Within one
 *  review, `path` + `line` identifies a comment unless two findings landed on the same line; the
 *  `body`, which GitHub stores verbatim, breaks that tie. */
const readBackCommentIds = async (a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  reviewId: number
  posted: InlineComment[]
}): Promise<Map<string, number>> => {
  const out = new Map<string, number>()
  if (a.posted.length === 0) return out // nothing to correlate: do not spend a request
  const pending = new Map<string, InlineComment[]>()
  for (const c of a.posted) {
    const bucket = pending.get(key(c.path, c.line)) ?? []
    bucket.push(c)
    pending.set(key(c.path, c.line), bucket)
  }
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await a.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner: a.owner,
      repo: a.repo,
      pull_number: a.number,
      per_page: 100,
      page,
    })
    const listed = z.array(CommentSchema).parse(res.data)
    for (const c of listed) {
      // Another review's comment, or a person's reply. Not ours to claim.
      if (c.pull_request_review_id !== a.reviewId) continue
      if (c.line === null) continue
      const bucket = pending.get(key(c.path, c.line))
      if (bucket === undefined || bucket.length === 0) continue
      const exact = bucket.findIndex((mine) => mine.body === c.body)
      const mine = bucket.splice(exact === -1 ? 0 : exact, 1)[0]
      out.set(commentKey(mine.findingId, mine.line), c.id)
    }
    if (listed.length < 100) break
  }
  return out
}

/** Octokit throws a RequestError carrying the HTTP status. Read narrowly and without `any`, so a
 *  thrown string or a plain Error cannot be mistaken for a status we recognise. */
const statusOf = (e: unknown): number | null =>
  typeof e === 'object' &&
  e !== null &&
  'status' in e &&
  typeof (e as { status: unknown }).status === 'number'
    ? (e as { status: number }).status
    : null

export async function postReview(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  headSha: string
  body: string
  comments: InlineComment[]
}): Promise<PostedReview> {
  const { octokit, owner, repo, number } = a
  // ONE content-generating request, whatever the comment count. The documented secondary limit is
  // 80 a minute and 500 an hour: a review with 15 inline comments spends 1 here, where 15 separate
  // POST /repos/{o}/{r}/pulls/{n}/comments calls would spend 15.
  const send = (comments: InlineComment[]) =>
    octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: number,
      // Explicit, not left to GitHub: the docs warn that "not using the latest commit SHA may
      // render your review comment outdated", and the head we reviewed is the only sha this review
      // is true of.
      commit_id: a.headSha,
      body: a.body,
      // COMMENT, never APPROVE or REQUEST_CHANGES: this product advises, it does not vote — the
      // gate is the check run, and only when the deployment turns it on (design §5). Omitting
      // `event` is not an option either: the review would stay PENDING and nobody would ever see it.
      event: 'COMMENT',
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
    })

  const first = await send(a.comments).then(
    (res) => ({ reviewId: ReviewSchema.parse(res.data).id, droppedInline: [] as InlineComment[] }),
    async (e: unknown) => {
      // GitHub validates `comments[]` as a unit, so ONE comment on a line that is not in the diff
      // refuses the whole review. `anchorFindings` only offers lines from the pull request's own
      // patch, so a 422 means the diff moved under us — a push racing the review. Post the review
      // WITHOUT its inline comments rather than not at all: the summary already names every
      // finding, so only the placement is lost. Exactly one retry; a second refusal is a real error.
      if (statusOf(e) !== 422 || a.comments.length === 0) throw e
      const res = await send([])
      return { reviewId: ReviewSchema.parse(res.data).id, droppedInline: [...a.comments] }
    },
  )

  const commentIds = await readBackCommentIds({
    octokit,
    owner,
    repo,
    number,
    reviewId: first.reviewId,
    posted: first.droppedInline.length > 0 ? [] : a.comments,
  })
  return { reviewId: first.reviewId, commentIds, droppedInline: first.droppedInline }
}

export type SummaryCommentResult = {
  commentId: number
  created: boolean
  /** The comment's page, as GitHub gave it (`html_url`), or null when the answer did not carry one.
   *  Read rather than assembled: a commit status links to it (spec 0.2.0 §14.2), and a URL built from
   *  a format string would be an invented one. */
  url: string | null
}

const IssueCommentSchema = z.object({ id: z.number().int(), html_url: z.string().optional() })

/** What GitHub answered about a summary comment it created or edited. Only an http(s) URL is kept:
 *  it is put in front of people as a link. */
const summaryCommentOf = (data: unknown, created: boolean): SummaryCommentResult => {
  const c = IssueCommentSchema.parse(data)
  const url = c.html_url !== undefined && /^https?:\/\//.test(c.html_url) ? c.html_url : null
  return { commentId: c.id, created, url }
}

/** Ours, not GitHub's: no cap on this list is documented in what we verified, so this is a loop
 *  guard. 30 x 100 = 3,000 conversation comments on one pull request. */
export const MAX_ISSUE_COMMENT_PAGES = 30

const ListedIssueCommentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
})

/** A summary comment of ours, and the re-review state its marker carries. Returned together so
 *  that the state a re-review builds on is read out of the very comment it will overwrite
 *  (Task 7b). */
export type FoundSummary = { commentId: number; marker: MarkerState }

/** Which comment on this pull request is the bot's own summary, and what its marker says.
 *
 *  There is no author filter on the list endpoint, so the filtering is ours. The comment is
 *  identified by the MARKER it carries — a string this product writes and nothing else has a reason
 *  to write — and the marker must DECODE, so a person quoting the marker's opening text in a
 *  question about the bot is not mistaken for the bot. The decode is needed to identify the
 *  comment anyway, so its result is kept rather than decoded a second time by the caller.
 *
 *  `selfLogin` is the login about to post: a marker comment it wrote is PREFERRED, and any decodable
 *  marker is the fallback (spec 0.2.0 §3.3, decision §14.7). Since 0.2.0 more than one way in can
 *  post on one pull request — the App, and a person with the CLI — and each would otherwise edit the
 *  other's summary. It never identifies a comment on its own: a comment without a marker is not a
 *  summary whoever wrote it, and the `<slug>[bot]` login convention is NOT VERIFIED (research,
 *  2026-09-14). */
export async function findSummaryComment(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  selfLogin?: string
}): Promise<FoundSummary | null> {
  const candidates: { id: number; login: string | null; marker: MarkerState }[] = []
  for (let page = 1; page <= MAX_ISSUE_COMMENT_PAGES; page++) {
    const res = await a.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: a.owner,
      repo: a.repo,
      issue_number: a.number,
      per_page: 100,
      page,
    })
    const listed = z.array(ListedIssueCommentSchema).parse(res.data)
    for (const c of listed) {
      if (c.body === null) continue
      if (!c.body.includes(MARKER_OPEN)) continue
      // The decode is the real test. Quoting the opening text is easy; producing a payload that
      // base64-decodes into a valid MarkerState is not something a person does by accident.
      const marker = decodeMarker(c.body)
      if (marker === null) continue
      candidates.push({ id: c.id, login: c.user?.login ?? null, marker })
    }
    if (listed.length < 100) break
  }
  if (candidates.length === 0) return null
  const byLogin = a.selfLogin === undefined
    ? []
    : candidates.filter((c) => c.login === a.selfLogin)
  const pool = byLogin.length > 0 ? byLogin : candidates
  // First as GitHub returned it. Deliberately NOT dressed up as "the oldest": the default ordering
  // of this list is not something the research verified, so this is a tie-break and nothing more.
  // A deployment that passes `selfLogin` never reaches the ambiguous case.
  return { commentId: pool[0].id, marker: pool[0].marker }
}

/** Design §5: ONE summary comment per pull request, updated in place. A pull request that collects
 *  a fresh bot comment on every push is a pull request nobody reads. */
export async function upsertSummaryComment(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  body: string
  /** The App's own login, when the deployment knows it. Secondary signal only — see findSummaryComment. */
  selfLogin?: string
  /** What the caller already found with `findSummaryComment`: `null` when it looked and there is
   *  none, left out when it did not look. Passing it means the comment edited is the one whose
   *  marker the caller built the new state on. A second listing could pick a different one, and
   *  it costs a request for an answer the caller already has (Task 7b). */
  existing?: FoundSummary | null
}): Promise<SummaryCommentResult> {
  const found = a.existing !== undefined ? a.existing : await findSummaryComment(a)
  if (found === null) {
    // A pull request IS an issue for comment purposes: the conversation comments live under the
    // issues endpoints, and only the line-anchored review comments live under pulls.
    const res = await a.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: a.owner,
      repo: a.repo,
      issue_number: a.number,
      body: a.body,
    })
    return summaryCommentOf(res.data, true)
  }
  // Note the path shape: an ISSUE comment is edited at /issues/comments/{id} with no issue number,
  // while a review comment is edited at /pulls/comments/{id}. Mixing the two 404s.
  let edited: unknown
  try {
    edited = (await a.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: a.owner,
      repo: a.repo,
      comment_id: found.commentId,
      body: a.body,
    })).data
  } catch (e) {
    // Two answers earn a NEW comment instead of a failed review, and nothing else does.
    //
    // 404 — the comment is gone. `existing` can be MINUTES old: since 2026-09-16 the caller reads the
    // marker BEFORE the review, because the re-review pass's question comes out of it, and a review
    // takes minutes. Somebody deleting the bot's summary in that window would otherwise turn a
    // finished, paid-for review into a 404 out of publishReview, a DoNotRetry, and a review nobody
    // ever saw. A comment that is not there is not a reason to lose a review: write a new one.
    //
    // 403 — the comment is somebody else's to edit (spec 0.2.0 §3.3, decision §14.7). Since 0.2.0 a
    // person can post a review as themselves, and the marker comment found may be the App's, or
    // another person's: GitHub lets them comment and refuses the edit. That is not a broken review;
    // the review is already paid for, and their own comment carries it. `findSummaryComment` prefers
    // the poster's own comment when it knows their login, so the next review by the same person
    // edits this new one instead of adding another. If the 403 means they cannot comment at all,
    // the create below is refused too, and that failure is the one surfaced.
    //
    // Anything else is a fault worth surfacing. Narrow on purpose: the failure mode of getting this
    // wrong is a pull request collecting a wall of bot comments, which is the thing this whole
    // function exists to prevent.
    const status = statusOf(e)
    if (status !== 404 && status !== 403) throw e
    const res = await a.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: a.owner, repo: a.repo, issue_number: a.number, body: a.body,
    })
    return summaryCommentOf(res.data, true)
  }
  // The edit's own answer carries the comment's page. A fake or a proxy that answers with less is
  // not a failed edit: the id is the one that was edited, and the link is simply unknown.
  const parsed = IssueCommentSchema.safeParse(edited)
  const url = parsed.success && parsed.data.html_url !== undefined && /^https?:\/\//.test(parsed.data.html_url)
    ? parsed.data.html_url
    : null
  return { commentId: found.commentId, created: false, url }
}

/** What `retractInlineComment` did. `failed` covers every refusal and every network fault alike:
 *  the caller's only decision is whether to count it, never whether to retry. The three between it
 *  and `edited` are refusals of this product's own, and each says which one. */
export type RetractionResult =
  | 'edited'
  /** The comment already says what this edit would say. Nothing to do, and not a failure. */
  | 'already-retracted'
  /** The comment is not on the pull request this review is about, or it is a reply under somebody's
   *  thread rather than a comment this product posted. Not ours to write on. */
  | 'not-ours-to-edit'
  /** GitHub has this comment on a line THIS review has just commented on. */
  | 'still-reported'
  | 'failed'

const RetractableSchema = z.object({
  body: z.string(),
  /** Which pull request the comment is on: ".../repos/{owner}/{repo}/pulls/{number}". REQUIRED, and
   *  a missing one is a parse failure and therefore a refusal — the safe direction, because this is
   *  the only field that authorises the edit. */
  pull_request_url: z.string(),
  /** Set when the comment is a reply under another comment's thread. Optional here, not because
   *  GitHub omits it, but because a refusal to retract must not depend on a field going missing. */
  in_reply_to_id: z.number().int().nullable().optional(),
  /** Where GitHub has the comment NOW — re-anchored onto the current head, and null once it has
   *  given up ("outdated"). Both optional for the same reason: they only ever withhold an edit. */
  path: z.string().optional(),
  line: z.number().int().nullable().optional(),
})

/** What a comment body currently CLAIMS, out of the two hidden markers this product may have left on
 *  it. The LAST one wins, because the notes are appended and never removed: a comment retracted, then
 *  reinstated, then retracted again reads as three notes in order and one standing claim. Reading
 *  only "does it contain a retraction" would leave a reinstated comment un-retractable for ever, and
 *  a retracted one reinstatable twice. */
const noteStanding = (body: string): 'retracted' | 'reinstated' | 'none' => {
  const retracted = body.lastIndexOf(RETRACTED_MARKER)
  const reinstated = body.lastIndexOf(REINSTATED_MARKER)
  if (retracted === -1 && reinstated === -1) return 'none'
  return retracted > reinstated ? 'retracted' : 'reinstated'
}

/** The pull request a review comment's `pull_request_url` names, or null if that is not what the
 *  string is. Owner and repo are compared case-insensitively because GitHub treats them that way
 *  and the caller's spelling comes from a webhook, not from this URL. */
const pullRequestIn = (url: string): { owner: string; repo: string; number: number } | null => {
  const m = /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url)
  return m === null ? null : { owner: m[1], repo: m[2], number: Number(m[3]) }
}

/** Say on an inline comment that the review no longer reports the finding it was written for
 *  (Criss, 2026-09-15). Measured: comment 4013794900 on the proving ground still asserts
 *  "setTimeout is always 0", re-anchored by GitHub onto the CURRENT head at a line that now reads
 *  `setTimeout(resolve, delayMs)` — the product contradicting the code it is looking at.
 *
 *  EDIT, never delete. A reply, a `/dispute`, a conversation may hang off this comment, and deleting
 *  it would take the thread with it. The note is appended to what the comment already says.
 *
 *  Note the path shape, as `upsertSummaryComment` does: an ISSUE comment is edited at
 *  `/issues/comments/{id}`, a REVIEW comment at `/pulls/comments/{id}`, and mixing the two 404s.
 *  The permission is Pull requests (write), already one of the App's five (`manifest.ts`).
 *
 *  Two requests, one of them content-generating: a read for what the comment says now, then the
 *  edit. There is no batch form — unlike `POST /reviews`, which carries N comments in one request —
 *  so retracting k comments spends k edits against the documented 80-a-minute ceiling. Whether a
 *  PATCH counts towards that ceiling is NOT VERIFIED; the method list is not published.
 *
 *  HOW BIG k IS, corrected 2026-09-16. It used to say "the number of findings one review judged gone,
 *  which is small", written when only `runs.at(-2)` was ever settled. Every run is settled now, so
 *  the honest bound is every comment in a 10-run marker: up to MAX_RUNS x maxInline = 150 comments,
 *  300 requests, if one review judged the lot resolved at once. In practice it is small again for the
 *  same reason the doc gives in `retractableComments`: only a row that CHANGED to `fixed` this review
 *  is offered, and a standing `fixed` is not re-offered. The first re-review after this ships on a
 *  marker full of `open` rows is the shape that can exercise the top of that range, once. It fails
 *  safe when it does: the summary is already written by then, this function never throws, and every
 *  refusal lands in `retractionsWithheld` rather than in a reader's face.
 *
 *  It never throws. A courtesy edit must not cost a pull request its review — the same posture as
 *  `changedFilesBetween`. Every failure comes back as a value the caller can count and log. */
export async function retractInlineComment(a: {
  octokit: Octokit
  owner: string
  repo: string
  /** The pull request this review is about, and the reason the read below is not just for the body.
   *
   *  `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}` is scoped to the REPOSITORY: its
   *  parameters are owner, repo, comment id and body, and nothing in it names a pull request. The
   *  comment id arrives from a marker, a marker is read out of a pull-request comment, and anyone
   *  who can comment on a pull request can write one — so an id in a marker is a string from
   *  somebody else, and unchecked it aims this edit at any review comment in the repository. This is
   *  the same refusal `publishReview` makes before it posts a review onto a pull request it was not
   *  about, at the one other place a model- or marker-written string addresses a resource. */
  number: number
  commentId: number
  /** `retractionNote` from body.ts, which carries `RETRACTED_MARKER`. */
  note: string
  /** `path:line` of every inline comment THIS review just posted, by the path GitHub itself uses.
   *
   *  A comment GitHub has re-anchored onto a line this review has just commented on is left alone.
   *  The anchor rule reads an EDITED line as a gone line — it hashes the line's text — so a partial
   *  fix that leaves the defect standing (a rename, a semicolon, a `// TODO`) makes the row `fixed`
   *  while the model reports the defect again on that same line. Without this the run posts the
   *  finding and, three requests later, stamps "no longer reported" on the comment beside it.
   *
   *  It only ever WITHHOLDS an edit. When GitHub has no line for the comment — outdated, unanchored
   *  — there is no collision to find and the retraction goes ahead. */
  postedAt?: ReadonlySet<string>
}): Promise<RetractionResult> {
  const { octokit, owner, repo, commentId } = a
  try {
    const got = await octokit.request('GET /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId,
    })
    const comment = RetractableSchema.parse(got.data)
    const on = pullRequestIn(comment.pull_request_url)
    if (
      on === null ||
      on.number !== a.number ||
      on.owner.toLowerCase() !== owner.toLowerCase() ||
      on.repo.toLowerCase() !== repo.toLowerCase()
    ) return 'not-ours-to-edit'
    // A reply is somebody else's sentence. This product never posts one — `postReview` creates
    // top-level comments — so a marker naming a reply's id is naming a comment that is not ours,
    // and on this pull request the scope check above would have let it through.
    if ((comment.in_reply_to_id ?? null) !== null) return 'not-ours-to-edit'
    // Already said. A run whose marker write failed after the edit landed would otherwise append
    // the note again, and again on the run after that.
    if (noteStanding(comment.body) === 'retracted') return 'already-retracted'
    const at = comment.path === undefined || comment.line === undefined || comment.line === null
      ? null
      : `${comment.path}:${comment.line}`
    if (at !== null && (a.postedAt?.has(at) ?? false)) return 'still-reported'
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId, body: `${comment.body}\n\n${a.note}`,
    })
    return 'edited'
  } catch {
    return 'failed'
  }
}

/** Take back a retraction this product wrote and should not have (Criss, 2026-09-16).
 *
 *  The same shape, the same refusals and the same never-throws posture as `retractInlineComment`,
 *  with the state test inverted: a comment that does not currently carry a retraction has nothing to
 *  correct, so `already-retracted` here means "already reinstated, or never retracted". It takes no
 *  `postedAt`: this note agrees with a comment this review has just posted rather than contradicting
 *  it, so there is no self-contradiction to withhold. */
export async function reinstateInlineComment(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  commentId: number
  /** `reinstatementNote` from body.ts, which carries `REINSTATED_MARKER`. */
  note: string
}): Promise<RetractionResult> {
  const { octokit, owner, repo, commentId } = a
  try {
    const got = await octokit.request('GET /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId,
    })
    const comment = RetractableSchema.parse(got.data)
    const on = pullRequestIn(comment.pull_request_url)
    if (
      on === null ||
      on.number !== a.number ||
      on.owner.toLowerCase() !== owner.toLowerCase() ||
      on.repo.toLowerCase() !== repo.toLowerCase()
    ) return 'not-ours-to-edit'
    if ((comment.in_reply_to_id ?? null) !== null) return 'not-ours-to-edit'
    if (noteStanding(comment.body) !== 'retracted') return 'already-retracted'
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId, body: `${comment.body}\n\n${a.note}`,
    })
    return 'edited'
  } catch {
    return 'failed'
  }
}

/** What `noteStillPresent` did. Like `RetractionResult`, every failure is a value and none is thrown. */
export type StillPresentResult =
  | 'edited'
  /** The comment already says so about this commit: a second run on it writes nothing. */
  | 'already-noted'
  | 'not-ours-to-edit'
  | 'failed'

/** Tell an earlier inline comment that this review found its defect again (Criss, 2026-10-15), rather
 *  than post the defect a second time. The same read, the same scope refusals and the same
 *  never-throws posture as `retractInlineComment`, for the same reasons: the comment id comes out of a
 *  marker anyone can edit, so the comment must be on this pull request and be a comment this product
 *  posted, not a reply.
 *
 *  A comment that currently stands RETRACTED gets the reinstatement note instead, and the hidden
 *  still-present marker with it: the defect is back, and "Reported again" is what this product says
 *  about a retraction that turned out wrong. It is not offered such a comment through `publishReview`
 *  — `repeatCandidates` offers only comments whose rows are all `open` — so this is the case of a
 *  marker and a comment that disagree, and it is resolved in the direction the comment can be read. */
export async function noteStillPresent(a: {
  octokit: Octokit
  owner: string
  repo: string
  number: number
  commentId: number
  headSha: string
  /** The finding's file, for the reinstatement note when that is the one written. */
  file: string
}): Promise<StillPresentResult> {
  const { octokit, owner, repo, commentId } = a
  try {
    const got = await octokit.request('GET /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId,
    })
    const comment = RetractableSchema.parse(got.data)
    const on = pullRequestIn(comment.pull_request_url)
    if (
      on === null ||
      on.number !== a.number ||
      on.owner.toLowerCase() !== owner.toLowerCase() ||
      on.repo.toLowerCase() !== repo.toLowerCase()
    ) return 'not-ours-to-edit'
    if ((comment.in_reply_to_id ?? null) !== null) return 'not-ours-to-edit'
    if (comment.body.includes(stillPresentMarker(a.headSha))) return 'already-noted'
    const note = noteStanding(comment.body) === 'retracted'
      ? `${reinstatementNote({ file: a.file, headSha: a.headSha })}\n${stillPresentMarker(a.headSha)}`
      : stillPresentNote({ headSha: a.headSha })
    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner, repo, comment_id: commentId, body: `${comment.body}\n\n${note}`,
    })
    return 'edited'
  } catch {
    return 'failed'
  }
}

import type { Octokit } from '@octokit/core'
import { z } from 'zod'
import type { ThreadReply } from './marker'

export const REPLY_PAGE_SIZE = 100          // GitHub's maximum; the default of 30 triples the calls
export const MAX_REPLY_PAGES = 30           // 3,000 comments, the cap pr.ts puts on the file list
export const MAX_THREAD_HOPS = 50           // a malformed reply chain must not hang a review

/** Only the fields this module reads. `user` is nullable because GitHub returns null for a
 *  deleted account, and a review must not fail because somebody left the company. */
const CommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  in_reply_to_id: z.number().int().nullish(),
  user: z.object({ login: z.string() }).nullable(),
})
type WireComment = z.infer<typeof CommentSchema>

/** The replies people wrote under this review's own inline comments, in the shape `diffRuns`
 *  reads: `commentId` is the id of the comment being REPLIED TO, because that is what
 *  `MarkerFinding.commentId` holds and what `diffRuns` matches on. */
export async function fetchThreadReplies(a: {
  octokit: Octokit; owner: string; repo: string; number: number; parentIds: number[]
  /** The one login whose replies are not a person's answer: the App's own bot account, when the
   *  caller knows it. Nobody else's replies are skipped — in particular not the replies of whoever
   *  posted the reviewed comments (spec 0.2.0 §3.3, decision §14.6).
   *
   *  Until 0.2.0 the author of the parent comments was observed and treated as "self", which was
   *  right while only the App posted. A person posting a review as themselves (the CLI's `--post`)
   *  is the author of every parent, so their own `/dispute` under their own review's finding was
   *  silently dropped — the one reply that review most needs to hear. Left out, nothing is skipped:
   *  this product never replies under its own comments (it posts top-level comments and edits them),
   *  so there is no bot reply for the rule to catch unless something else posts as the same App. */
  ignoreRepliesFrom?: string
}): Promise<ThreadReply[]> {
  const { octokit, owner, repo, number } = a
  const parents = new Set(a.parentIds)
  if (parents.size === 0) return []          // nothing to answer; do not spend a request finding out

  const comments: WireComment[] = []
  for (let page = 1; page <= MAX_REPLY_PAGES; page++) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner, repo, pull_number: number,
      // `diffRuns` takes the LAST reply on a thread, so this order decides which verdict stands.
      // The docs give no default for either parameter, so both are sent.
      sort: 'created', direction: 'asc',
      per_page: REPLY_PAGE_SIZE, page,
    })
    const batch = z.array(CommentSchema).parse(res.data)
    comments.push(...batch)
    if (batch.length < REPLY_PAGE_SIZE) break
  }

  const byId = new Map(comments.map((c) => [c.id, c]))
  // GitHub logins are case-insensitive, and the caller's spelling need not be the listing's.
  const ignored = a.ignoreRepliesFrom === undefined || a.ignoreRepliesFrom === ''
    ? null
    : a.ignoreRepliesFrom.toLowerCase()

  /** The ancestor of this comment that the review actually opened, or null. The docs say
   *  `in_reply_to_id` points at "the comment it answers", which is either the thread root or the
   *  previous reply depending on how it is read; walking up satisfies both readings. */
  const threadRootOf = (c: WireComment): number | null => {
    let up = c.in_reply_to_id ?? null
    for (let hops = 0; up !== null && hops < MAX_THREAD_HOPS; hops++) {
      if (parents.has(up)) return up
      up = byId.get(up)?.in_reply_to_id ?? null
    }
    return null
  }

  const replies: ThreadReply[] = []
  for (const c of comments) {
    // The bot does not file verdicts on itself — the bot named by the caller, and no one else.
    if (ignored !== null && c.user !== null && c.user.login.toLowerCase() === ignored) continue
    const root = threadRootOf(c)
    if (root === null) continue
    replies.push({ commentId: root, body: c.body })
  }
  return replies
}

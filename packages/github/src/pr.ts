import type { Octokit } from '@octokit/core'
import { z } from 'zod'

export type PullRequestContext = {
  owner: string; repo: string; number: number
  headSha: string; baseSha: string; title: string; body: string
  changedFiles: { path: string; status: string; patch?: string }[]
  diff: string
}

export const MAX_FILE_PAGES = 30          // 30 x 100 = 3,000 files, GitHub's own cap on this list

const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),            // design §4.5: GitHub sends null for an empty description
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
})
const FileSchema = z.object({ filename: z.string(), status: z.string(), patch: z.string().optional() })

// `changedFilesBetween` was here and is deleted (Criss, 2026-09-16), with `sameCommit` and
// `CompareSchema`, which had no other caller.
//
// It read `compare/{base}...{head}` for the files an author had pushed since the previous review,
// and it existed for exactly one purpose: to LICENSE a `fixed` that had been inferred from the
// model's silence. "The model stopped mentioning it AND the file changed" was as close as inference
// could get to evidence of a repair. It is not needed once a reviewer has been asked and has
// answered — a finding can be resolved in a file this push never touched (its caller changed), and
// a finding in a file that did change can be as live as it ever was. Keeping it would mean a second,
// weaker opinion sitting beside an authoritative one, waiting for somebody to consult it.
//
// Its posture is kept, because it is the right one and this feature needed it too. From its own
// doc comment: an outcome refinement must not cost the pull request its review. That sentence is now
// implemented by `runRecheckPass`, which catches everything it can fail at and answers with no
// judgements rather than throwing.
//
// It also cost a request per re-review, on a route with a merge-base subtlety that took a measured
// force-push to find. That goes with it.

export async function fetchPullRequest(a: {
  octokit: Octokit; owner: string; repo: string; number: number
}): Promise<PullRequestContext> {
  const { octokit, owner, repo, number } = a
  const pull = PullSchema.parse(
    (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: number })).data,
  )
  const diff = String(
    (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: number, mediaType: { format: 'diff' },
    })).data,
  )
  const changedFiles: PullRequestContext['changedFiles'] = []
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner, repo, pull_number: number, per_page: 100, page,
    })
    const files = z.array(FileSchema).parse(res.data)
    for (const f of files) changedFiles.push({ path: f.filename, status: f.status, patch: f.patch })
    if (files.length < 100) break
  }
  return {
    owner, repo, number,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    title: pull.title,
    body: pull.body ?? '',
    changedFiles,
    diff,
  }
}

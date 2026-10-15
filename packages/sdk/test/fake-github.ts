import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Octokit } from '@octokit/core'
import { create } from 'tar'

export const HEAD_SHA = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
export const BASE_SHA = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'
export const RETRY_FILE = 'src/retry.ts'

/** The reviewed file: forty lines, so a finding can point at a line inside the diff (20–30) and at
 *  one outside it. */
export const RETRY_SOURCE = Array.from({ length: 40 }, (_, i) => `export const step${i + 1} = ${i + 1}`).join('\n') + '\n'

/** One hunk whose new side is lines 20 to 30: a finding on line 24 can be placed inline, one on line
 *  10 only in the summary. */
export const RETRY_PATCH = '@@ -20,2 +20,11 @@\n c\n' + '+a\n'.repeat(9) + ' c\n'

export const LIST_RUNS = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs'
export const CREATE_RUN = 'POST /repos/{owner}/{repo}/check-runs'
export const COMPLETE_RUN = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
export const STATUS = 'POST /repos/{owner}/{repo}/statuses/{sha}'
export const USER = 'GET /user'
export const PERMISSION = 'GET /repos/{owner}/{repo}/collaborators/{username}/permission'
export const PULL = 'GET /repos/{owner}/{repo}/pulls/{pull_number}'
export const PULL_FILES = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files'
export const CONTENTS = 'GET /repos/{owner}/{repo}/contents/{path}'
export const TARBALL = 'GET /repos/{owner}/{repo}/tarball/{ref}'
export const SUMMARY_LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'
export const SUMMARY_CREATE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
export const SUMMARY_EDIT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
export const REVIEW_CREATE = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews'
export const REVIEW_COMMENTS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments'

export type Call = { route: string; params: Record<string, unknown> }

/** The archive GitHub's tarball endpoint serves: everything under one top directory, gzipped. */
const tarballOf = async (files: Record<string, string>): Promise<ArrayBuffer> => {
  const src = await mkdtemp(join(tmpdir(), 'ra-sdk-tarball-'))
  try {
    const top = 'acme-widgets-4f8e2a1'
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(src, top, path)), { recursive: true })
      await writeFile(join(src, top, path), text)
    }
    const chunks: Buffer[] = []
    for await (const c of create({ gzip: true, cwd: src }, [top])) chunks.push(Buffer.from(c as Uint8Array))
    const bytes = Buffer.concat(chunks)
    // A real ArrayBuffer of exactly these bytes: `downloadArchive` takes one as the archive itself.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  } finally {
    await rm(src, { recursive: true, force: true })
  }
}

/** A small GitHub, at the `octokit.request` level, that remembers every call: enough for a whole
 *  review — the pull request, its files and diff, the tarball, the token's identity, a push-access
 *  question, check runs, statuses, the summary comment and a review with inline comments.
 *
 *  `user`: the login `GET /user` answers, or null for an installation token, which GitHub answers
 *  with 403. `fail`: a route answered with that HTTP status instead. */
export const fakeGitHub = async (seed: {
  user?: string | null
  push?: boolean
  fail?: Partial<Record<string, number>>
} = {}) => {
  const tarball = await tarballOf({ [RETRY_FILE]: RETRY_SOURCE, 'README.md': '# widgets\n' })
  const calls: Call[] = []
  const issueComments: { id: number; body: string; user: { login: string } }[] = []
  const reviewComments: {
    id: number; path: string; line: number; body: string; pull_request_review_id: number
    in_reply_to_id: null; user: { login: string }
  }[] = []
  let nextId = 5001
  const login = seed.user === undefined ? 'alice' : seed.user
  const poster = login ?? 'review-agent[bot]'

  const request = async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params })
    const status = seed.fail?.[route]
    if (status !== undefined) throw Object.assign(new Error(`HTTP ${status} from the fake`), { status })
    const ok = (data: unknown) => ({ status: 200, headers: {}, data })
    const number = Number(params.pull_number ?? params.issue_number ?? 0)
    switch (route) {
      case PULL:
        if ((params.mediaType as { format?: string } | undefined)?.format === 'diff') {
          return ok(`diff --git a/${RETRY_FILE} b/${RETRY_FILE}\n${RETRY_PATCH}`)
        }
        return ok({
          number, title: `Retry with a delay (#${number})`, body: null,
          head: { sha: HEAD_SHA }, base: { sha: BASE_SHA },
        })
      case PULL_FILES: return ok([{ filename: RETRY_FILE, status: 'modified', patch: RETRY_PATCH }])
      case CONTENTS: throw Object.assign(new Error('Not Found'), { status: 404 })
      case TARBALL: return { status: 200, headers: {}, data: tarball }
      case USER:
        if (login === null) throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
        return ok({ login })
      case PERMISSION: return ok({ user: { permissions: { push: seed.push ?? false } } })
      case LIST_RUNS: return ok({ total_count: 0, check_runs: [] })
      case CREATE_RUN: return ok({ id: 4242, html_url: 'https://github.com/acme/widgets/runs/4242' })
      case COMPLETE_RUN: return ok({ id: 4242 })
      case STATUS: return ok({ id: 1 })
      case SUMMARY_LIST: return ok(issueComments)
      case SUMMARY_CREATE: {
        const id = nextId++
        issueComments.push({ id, body: String(params.body), user: { login: poster } })
        return ok({ id, html_url: `https://github.com/acme/widgets/pull/${number}#issuecomment-${id}` })
      }
      case SUMMARY_EDIT:
        return ok({ id: params.comment_id, html_url: `https://github.com/acme/widgets/pull/${number}#issuecomment-${String(params.comment_id)}` })
      case REVIEW_CREATE: {
        for (const c of params.comments as { path: string; line: number; body: string }[]) {
          reviewComments.push({
            id: nextId++, path: c.path, line: c.line, body: c.body, pull_request_review_id: 900,
            in_reply_to_id: null, user: { login: poster },
          })
        }
        return ok({ id: 900 })
      }
      case REVIEW_COMMENTS: return ok(reviewComments)
      default: throw new Error(`the fake was asked for a route a review should not call: ${route}`)
    }
  }

  return {
    octokit: { request } as unknown as Octokit,
    calls,
    /** Every call that was not a read. */
    writes: (): string[] => calls.map((c) => c.route).filter((r) => !r.startsWith('GET ')),
    only: (route: string): Call[] => calls.filter((c) => c.route === route),
  }
}

export type FakeGitHub = Awaited<ReturnType<typeof fakeGitHub>>

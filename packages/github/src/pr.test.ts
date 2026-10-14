import type { Octokit } from '@octokit/core'
import { describe, expect, it, vi } from 'vitest'
import { fetchPullRequest } from './pr'

const PULL = {
  number: 16,
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and **nothing** checks them.',
  head: { sha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f' },
  base: { sha: '0'.repeat(40) },
}
const FILES = [{ filename: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -88,6 +88,37 @@\n context\n' }]

function fakeOctokit(over: Record<string, unknown> = {}) {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route.endsWith('/files')) return { status: 200, headers: {}, data: FILES }
    if (params.mediaType !== undefined) return { status: 200, headers: {}, data: 'diff --git a/x b/x\n' }
    return { status: 200, headers: {}, data: { ...PULL, ...over } }
  })
  return { octokit: { request } as unknown as Octokit, request }
}

describe('fetchPullRequest', () => {
  it('returns the PR, its file list and its diff', async () => {
    const { octokit } = fakeOctokit()
    const pr = await fetchPullRequest({ octokit, owner: 'acme', repo: 'widgets', number: 16 })
    expect(pr.owner).toBe('acme')
    expect(pr.number).toBe(16)
    expect(pr.headSha).toBe('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
    expect(pr.title).toBe('ci(publish): refuse a tag that does not match package.json')
    expect(pr.changedFiles).toEqual([
      { path: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -88,6 +88,37 @@\n context\n' },
    ])
    expect(pr.diff).toContain('diff --git')
  })

  it('turns a null PR body into an empty string', async () => {
    const { octokit } = fakeOctokit({ body: null })
    const pr = await fetchPullRequest({ octokit, owner: 'acme', repo: 'widgets', number: 16 })
    expect(pr.body).toBe('')
  })

  it('pages the file list and stops on a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `a/${i}.ts`, status: 'modified', patch: '@@' }))
    const page2 = [{ filename: 'b/last.ts', status: 'added', patch: '@@' }]
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.endsWith('/files')) return { status: 200, headers: {}, data: params.page === 1 ? page1 : page2 }
      if (params.mediaType !== undefined) return { status: 200, headers: {}, data: '' }
      return { status: 200, headers: {}, data: PULL }
    })
    const pr = await fetchPullRequest({
      octokit: { request } as unknown as Octokit, owner: 'acme', repo: 'widgets', number: 16,
    })
    expect(pr.changedFiles).toHaveLength(101)
    expect(request.mock.calls.filter(([r]) => r.endsWith('/files'))).toHaveLength(2)
  })
})

// `changedFilesBetween` was tested from here to the end of this file and is gone (Criss,
// 2026-09-16), with its tests. It read what an author had pushed since the previous review, for one
// purpose: to LICENSE a `fixed` that had been inferred from the model's silence. A reviewer is now
// asked directly, so there is nothing left for a weaker second opinion to license — and the request
// it spent per re-review, on a route with a merge-base subtlety that took a force-push to find,
// goes with it.

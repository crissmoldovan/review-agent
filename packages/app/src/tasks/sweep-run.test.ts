import type { Octokit } from '@octokit/core'
import { describe, expect, it, vi } from 'vitest'
import type { AppIdentity } from '../credentials'
import { MAX_OPEN_PULL_PAGES, listOpenPullHeads, sweepRun, type SweepDeps } from './sweep-run'

type Call = { route: string; params: Record<string, unknown> }

/** A real object, as in Task 6's check-run tests: it records each request and answers from a function. */
const fakeOctokit = (answer: (params: Record<string, unknown>) => unknown) => {
  const calls: Call[] = []
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params })
      return { status: 200, headers: {}, data: answer(params) }
    },
  } as unknown as Octokit
  return { octokit, calls }
}

const sha = (n: number): string => n.toString(16).padStart(40, '0')
const pulls = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ number: from + i, head: { sha: sha(from + i) } }))

describe('listOpenPullHeads', () => {
  it('lists the head of every open pull request, a page at a time, until a short page', async () => {
    const { octokit, calls } = fakeOctokit((p) => (p.page === 1 ? pulls(1, 100) : pulls(101, 1)))
    const listed = await listOpenPullHeads({ octokit, owner: 'acme', repo: 'widgets' })
    expect(listed.complete).toBe(true)
    expect(listed.heads).toHaveLength(101)
    expect(calls.map((c) => c.route)).toEqual(['GET /repos/{owner}/{repo}/pulls', 'GET /repos/{owner}/{repo}/pulls'])
    // A closed pull request's check run blocks no merge: only open ones are asked for.
    expect(calls[0].params).toMatchObject({ owner: 'acme', repo: 'widgets', state: 'open', per_page: 100, page: 1 })
    expect(calls[1].params.page).toBe(2)
  })

  it('gives each head once, however many pull requests share it', async () => {
    const { octokit } = fakeOctokit(() => [
      { number: 1, head: { sha: sha(7) } }, { number: 2, head: { sha: sha(7) } },
    ])
    expect((await listOpenPullHeads({ octokit, owner: 'acme', repo: 'widgets' })).heads).toEqual([sha(7)])
  })

  it('stops after MAX_OPEN_PULL_PAGES pages and says the list is not complete', async () => {
    const { octokit, calls } = fakeOctokit((p) => pulls(Number(p.page) * 1000, 100))
    const listed = await listOpenPullHeads({ octokit, owner: 'acme', repo: 'widgets' })
    expect(calls).toHaveLength(MAX_OPEN_PULL_PAGES)
    expect(listed.complete).toBe(false)
  })

  it('fails closed on a page it cannot read, keeping only the heads it could', async () => {
    const { octokit } = fakeOctokit((p) => (p.page === 1 ? pulls(1, 100) : { message: 'Server Error' }))
    const listed = await listOpenPullHeads({ octokit, owner: 'acme', repo: 'widgets' })
    expect(listed.complete).toBe(false)
    expect(listed.heads).toHaveLength(100)
  })
})

const IDENTITY: AppIdentity = { clientId: 'Iv23liR3v13wAg3nt', privateKeyPem: 'FAKE-PEM-DO-NOT-LOG-5R8W' }
const TOKEN = { token: 'ghs_installation_FAKE_DO_NOT_LOG', expiresAt: '2026-09-14T11:00:00Z', repositories: ['widgets'] }
const NOW = new Date('2026-09-14T12:00:00.000Z')

type Logged = { message: string; fields: Record<string, unknown> }

const sweepDeps = (over: Partial<SweepDeps> = {}): SweepDeps & { logs: Logged[] } => {
  const logs: Logged[] = []
  return {
    logs,
    targets: () => [{ installationId: 12_345_678, repositories: ['acme/widgets'] }],
    identity: vi.fn(() => IDENTITY),
    checkRunName: () => 'review-agent',
    installationToken: vi.fn(async () => TOKEN),
    makeOctokit: vi.fn(() => ({}) as Octokit),
    listOpenPullHeads: vi.fn(async () => ({ heads: [sha(1), sha(2)], complete: true })),
    closeStaleCheckRuns: vi.fn(async () => 0),
    now: () => NOW,
    log: (message: string, fields: Record<string, unknown>) => { logs.push({ message, fields }) },
    ...over,
  }
}

describe('sweepRun (Criss, answer 14)', () => {
  it('sweeps nothing and reads no credential when the deployment names no repository', async () => {
    const d = sweepDeps({ targets: () => [] })
    expect(await sweepRun(d)).toEqual({ repositories: 0, heads: 0, closed: 0, skipped: [] })
    expect(d.identity).not.toHaveBeenCalled()
    expect(d.installationToken).not.toHaveBeenCalled()
  })

  it('closes what an abandoned review left open on every open pull request, with a token for that one repository', async () => {
    const d = sweepDeps({
      closeStaleCheckRuns: vi.fn(async (a: { headSha: string }) => (a.headSha === sha(1) ? 1 : 0)),
    })
    expect(await sweepRun(d)).toEqual({ repositories: 1, heads: 2, closed: 1, skipped: [] })
    // Global Constraints: scoped to the one repository, by name — never the installation.
    expect(d.installationToken).toHaveBeenCalledWith({
      identity: IDENTITY, installationId: 12_345_678, repositories: ['widgets'],
    })
    expect(d.makeOctokit).toHaveBeenCalledWith(TOKEN.token)
    expect(vi.mocked(d.closeStaleCheckRuns).mock.calls.map((c) => c[0])).toEqual([
      { octokit: {}, owner: 'acme', repo: 'widgets', headSha: sha(1), name: 'review-agent', now: NOW },
      { octokit: {}, owner: 'acme', repo: 'widgets', headSha: sha(2), name: 'review-agent', now: NOW },
    ])
  })

  it('never shortens the one-hour rule, because it can know a run is old and never that it is dead', async () => {
    const d = sweepDeps()
    await sweepRun(d)
    for (const [call] of vi.mocked(d.closeStaleCheckRuns).mock.calls) expect('staleAfterMs' in call).toBe(false)
  })

  it('fails closed repository by repository, and still sweeps the rest', async () => {
    const d = sweepDeps({
      targets: () => [{
        installationId: 12_345_678,
        repositories: ['not-a-repository', 'acme/locked', 'acme/unlisted', 'acme/widgets'],
      }],
      installationToken: vi.fn(async (a: { repositories: string[] }) => {
        if (a.repositories[0] === 'locked') {
          throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
        }
        return TOKEN
      }),
      listOpenPullHeads: vi.fn(async (a: { repo: string }) => {
        if (a.repo === 'unlisted') throw new Error('GitHub responded 502')
        return { heads: [sha(1)], complete: true }
      }),
      closeStaleCheckRuns: vi.fn(async () => 1),
    })
    const result = await sweepRun(d)
    expect(result).toMatchObject({ repositories: 1, heads: 1, closed: 1 })
    expect(result.skipped.map((s) => s.repo)).toEqual(['not-a-repository', 'acme/locked', 'acme/unlisted'])
    expect(d.closeStaleCheckRuns).toHaveBeenCalledTimes(1)
  })

  it('says when it could not see every open pull request, and sweeps the heads it did see', async () => {
    const d = sweepDeps({
      listOpenPullHeads: vi.fn(async () => ({ heads: [sha(1)], complete: false })),
      closeStaleCheckRuns: vi.fn(async () => 1),
    })
    const result = await sweepRun(d)
    expect(result.closed).toBe(1)
    expect(result.skipped).toEqual([
      { repo: 'acme/widgets', why: 'open pull requests not fully listed; the heads that were listed were swept' },
    ])
  })

  it('keeps going past a check run it could not close, and says which commit', async () => {
    const d = sweepDeps({
      closeStaleCheckRuns: vi.fn(async (a: { headSha: string }) => {
        if (a.headSha === sha(1)) throw new Error('GitHub responded 422')
        return 1
      }),
    })
    const result = await sweepRun(d)
    expect(result.closed).toBe(1)
    expect(result.skipped).toEqual([{ repo: `acme/widgets@${sha(1).slice(0, 12)}`, why: 'GitHub responded 422' }])
  })

  it('throws, before any GitHub call, when repositories are named and the App identity is not set', async () => {
    const d = sweepDeps({
      identity: vi.fn(() => { throw new Error('the App identity is not set: REVIEW_AGENT_APP_CLIENT_ID') }),
    })
    await expect(sweepRun(d)).rejects.toThrow(/REVIEW_AGENT_APP_CLIENT_ID/)
    expect(d.installationToken).not.toHaveBeenCalled()
  })

  it('never writes a token, or error text that carries one, into its result or its log — from any of the three calls it makes', async () => {
    // Task 13b repair: the sweep hands somebody else's error text to its result in three places, and a
    // case that fails only one of them leaves the other two free to be "simplified" back to raw text.
    // One repository per place, because a failed mint skips the rest of that repository's sweep.
    const leak = `ghs_${'A'.repeat(36)}`
    const withheld = 'its text is withheld because it matched a secret pattern'
    const d = sweepDeps({
      targets: () => [{
        installationId: 12_345_678,
        repositories: ['acme/mint-fails', 'acme/list-fails', 'acme/close-fails'],
      }],
      // The mint is the one call holding the App private key, so it is the likeliest of the three to
      // throw with credential material in the text.
      installationToken: vi.fn(async (a: { repositories: string[] }) => {
        if (a.repositories[0] === 'mint-fails') throw new Error(`POST access_tokens failed for ${leak}`)
        return TOKEN
      }),
      listOpenPullHeads: vi.fn(async (a: { repo: string }) => {
        if (a.repo === 'list-fails') throw new Error(`GET failed for ${leak}`)
        return { heads: [sha(1)], complete: true }
      }),
      closeStaleCheckRuns: vi.fn(async (a: { repo: string }) => {
        if (a.repo === 'close-fails') throw new Error(`PATCH failed for ${leak}`)
        return 0
      }),
    })
    const result = await sweepRun(d)
    const everything = JSON.stringify({ result, logs: d.logs })
    expect(everything).not.toContain(leak)
    expect(everything).not.toContain(TOKEN.token)
    // Read back whole, so a failure names which of the three let the text through, and the kept prefix
    // still says which call failed.
    expect(result.skipped.map((s) => `${s.repo}: ${s.why}`)).toEqual([
      `acme/mint-fails: no token for this repository: ${withheld}`,
      `acme/list-fails: open pull requests not listed: ${withheld}`,
      `acme/close-fails@${sha(1).slice(0, 12)}: ${withheld}`,
    ])
  })
})

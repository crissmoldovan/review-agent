import { describe, expect, it, vi } from 'vitest'
import { UsageError } from './flags'
import { findGitHubToken, findOnPath, resolveGitHubToken, type GhAnswer, type GhCli } from './github-token'

/** Values shaped like nothing GitHub issues, so a hit in any output is this file's and nobody's. */
const FROM_ENV = 'fake-token-from-GITHUB_TOKEN-0001'
const FROM_GH_ENV = 'fake-token-from-GH_TOKEN-0002'
const FROM_GH = 'fake-token-from-gh-auth-token-0003'

/** A GitHub CLI that answers what the case says, in order, and records every call. */
const fakeGh = (answers: GhAnswer[], loginExit: number | null = 0) => {
  const queue = [...answers]
  const gh = {
    authToken: vi.fn(async (_host: string): Promise<GhAnswer> => queue.shift() ?? { kind: 'not-logged-in' }),
    authLogin: vi.fn(async (_host: string) => loginExit),
  } satisfies GhCli
  return gh
}

const resolve = (over: {
  env?: Record<string, string | undefined>; gh?: GhCli; interactive?: boolean; answer?: boolean; host?: string
} = {}) => {
  const said: string[] = []
  const confirm = vi.fn(async (_question: string, _signal?: AbortSignal) => over.answer ?? false)
  const run = resolveGitHubToken({
    env: over.env ?? {}, host: over.host ?? 'github.com', gh: over.gh ?? fakeGh([]), need: 'post',
    repo: 'acme/widgets', interactive: over.interactive ?? false, confirm, stderr: (s) => { said.push(s) },
  })
  return { run, said, confirm }
}

// Spec 0.2.0 §5.3, in order.
describe('where the GitHub token comes from', () => {
  it('takes GITHUB_TOKEN first, and asks gh nothing', async () => {
    const gh = fakeGh([{ kind: 'token', token: FROM_GH }])
    expect(await findGitHubToken({ env: { GITHUB_TOKEN: FROM_ENV, GH_TOKEN: FROM_GH_ENV }, host: 'github.com', gh }))
      .toEqual({ kind: 'found', token: FROM_ENV, source: 'GITHUB_TOKEN' })
    expect(gh.authToken).not.toHaveBeenCalled()
  })

  it('takes GH_TOKEN when GITHUB_TOKEN is unset or empty, and asks gh nothing', async () => {
    const gh = fakeGh([{ kind: 'token', token: FROM_GH }])
    for (const env of [{ GH_TOKEN: FROM_GH_ENV }, { GITHUB_TOKEN: '', GH_TOKEN: FROM_GH_ENV }]) {
      expect(await findGitHubToken({ env, host: 'github.com', gh }))
        .toEqual({ kind: 'found', token: FROM_GH_ENV, source: 'GH_TOKEN' })
    }
    expect(gh.authToken).not.toHaveBeenCalled()
  })

  it('asks gh for its login on the named host when neither variable holds a token', async () => {
    const gh = fakeGh([{ kind: 'token', token: FROM_GH }])
    expect(await findGitHubToken({ env: { GITHUB_TOKEN: '', GH_TOKEN: '' }, host: 'github.example.com', gh }))
      .toEqual({ kind: 'found', token: FROM_GH, source: 'gh' })
    expect(gh.authToken).toHaveBeenCalledWith('github.example.com')
  })
})

describe('resolveGitHubToken: when there is none', () => {
  it('without a terminal, stops with exactly what to set, and asks nobody anything', async () => {
    const gh = fakeGh([{ kind: 'not-logged-in' }])
    const { run, confirm } = resolve({ gh, interactive: false })
    const e = await run.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(UsageError)
    const said = (e as Error).message
    expect(said).toContain('Set GITHUB_TOKEN (or GH_TOKEN)')
    expect(said).toContain('Pull requests: Read and Write, and Commit statuses: Write on acme/widgets')
    expect(said).toContain('`gh auth login --web --hostname github.com`')
    expect(said).toContain('the GitHub CLI is not logged in to github.com')
    expect(confirm).not.toHaveBeenCalled()
    expect(gh.authLogin).not.toHaveBeenCalled()
  })

  it('says gh is not installed when it is not, and offers no login it cannot run', async () => {
    const gh = fakeGh([{ kind: 'not-installed' }])
    const { run, confirm } = resolve({ gh, interactive: true, answer: true })
    await expect(run).rejects.toThrow('the GitHub CLI (gh) is not installed')
    expect(confirm).not.toHaveBeenCalled()
    expect(gh.authLogin).not.toHaveBeenCalled()
  })

  it('on a terminal, offers gh auth login --web, runs it on a yes, and asks gh again', async () => {
    const gh = fakeGh([{ kind: 'not-logged-in' }, { kind: 'token', token: FROM_GH }])
    const { run, confirm, said } = resolve({ gh, interactive: true, answer: true, host: 'github.example.com' })
    expect(await run).toEqual({ token: FROM_GH, source: 'gh' })
    expect(confirm.mock.calls[0][0]).toContain('Run `gh auth login --web --hostname github.example.com` now?')
    expect(confirm.mock.calls[0][0]).toContain('[y/N]')
    expect(gh.authLogin).toHaveBeenCalledWith('github.example.com')
    expect(gh.authToken).toHaveBeenCalledTimes(2)
    // It says it logged in; it never says the token.
    expect(said.join('\n')).toContain("using the GitHub CLI's login")
    expect(said.join('\n')).not.toContain(FROM_GH)
  })

  it('runs nothing when the person says no, and says what to set instead', async () => {
    const gh = fakeGh([{ kind: 'not-logged-in' }])
    const { run } = resolve({ gh, interactive: true, answer: false })
    await expect(run).rejects.toThrow('Set GITHUB_TOKEN (or GH_TOKEN)')
    expect(gh.authLogin).not.toHaveBeenCalled()
  })

  it('stops when the login did not finish, rather than asking gh for a token it has not got', async () => {
    const gh = fakeGh([{ kind: 'not-logged-in' }], 1)
    const { run } = resolve({ gh, interactive: true, answer: true })
    await expect(run).rejects.toThrow('did not finish (exit 1)')
    expect(gh.authToken).toHaveBeenCalledTimes(1)
  })
})

describe('findOnPath: gh is never started by a bare name', () => {
  const on = (paths: string[]) => (p: string) => paths.includes(p)

  it('looks only in absolute PATH directories, never the working directory', () => {
    // '' and '.' and a relative entry all mean "here", which may be a clone of a repository nobody
    // vetted — the Windows lookup a bare name would get, made explicit.
    expect(findOnPath('gh', { PATH: ':.:bin:/usr/local/bin' }, 'linux', on(['gh', './gh', 'bin/gh', '/usr/local/bin/gh'])))
      .toBe('/usr/local/bin/gh')
    expect(findOnPath('gh', { PATH: ':.:bin' }, 'linux', () => true)).toBeNull()
  })

  it('finds gh.exe on Windows under whatever case PATH is spelled in', () => {
    expect(findOnPath('gh', { Path: '.;C:\\Program Files\\GitHub CLI' }, 'win32', on(['C:\\Program Files\\GitHub CLI\\gh.exe'])))
      .toBe('C:\\Program Files\\GitHub CLI\\gh.exe')
  })

  it('is null when there is no gh at all', () => {
    expect(findOnPath('gh', {}, 'linux', () => false)).toBeNull()
  })
})

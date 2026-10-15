import { readFileSync } from 'node:fs'
import type { Octokit } from '@octokit/core'
import { describe, expect, it, vi } from 'vitest'
import { runDoctorCommand, type DoctorDeps } from './doctor-command'
import type { GhAnswer } from './github-token'

/** Values shaped like no real credential, so any hit in the output is this file's. */
const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE-doctor-key-0001',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKE-doctor-token-0002',
  GITHUB_TOKEN: 'fake-doctor-github-token-0003',
  GH_TOKEN: 'fake-doctor-gh-token-0004',
}
const FROM_GH = 'fake-doctor-token-from-gh-0005'

type Answer = unknown | { status: number; message?: string }
const USER = 'GET /user'
const REPO = 'GET /repos/{owner}/{repo}'
const PERMISSION = 'GET /repos/{owner}/{repo}/collaborators/{username}/permission'

/** A GitHub that answers only reads, as the case says. Doctor writes nothing: a write throws. */
const fakeGitHub = (answers: Record<string, Answer>, headers: Record<string, string> = { 'x-oauth-scopes': 'repo, read:org' }) => {
  const routes: string[] = []
  const octokit = {
    request: async (route: string) => {
      routes.push(route)
      if (!route.startsWith('GET ')) throw new Error(`doctor must never write: ${route}`)
      if (!(route in answers)) throw new Error(`the fake was asked for a route this case did not expect: ${route}`)
      const a = answers[route]
      if (typeof a === 'object' && a !== null && 'status' in a) {
        const { status, message } = a as { status: number; message?: string }
        throw Object.assign(new Error(message ?? `HTTP ${status}`), { status })
      }
      return { status: 200, headers, data: a }
    },
  } as unknown as Octokit
  return { octokit, routes }
}

const READY = {
  [USER]: { login: 'alice' },
  [REPO]: { private: true },
  [PERMISSION]: { user: { permissions: { push: true } } },
}

const doctor = async (over: Partial<DoctorDeps> & { github?: ReturnType<typeof fakeGitHub>; repo?: string; host?: string } = {}) => {
  const out: string[] = []
  const err: string[] = []
  const github = over.github ?? fakeGitHub(READY)
  const deps: DoctorDeps = {
    env: { ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, GITHUB_TOKEN: SECRETS.GITHUB_TOKEN },
    nodeVersion: '22.12.0',
    platform: 'linux',
    resolveClaudeBinary: () => '/usr/local/bin/claude',
    claudeVersion: async () => '2.1.300 (Claude Code)',
    gh: { authToken: vi.fn(async (): Promise<GhAnswer> => ({ kind: 'not-installed' })), authLogin: vi.fn(async () => null) },
    makeOctokit: vi.fn(() => github.octokit),
    stdout: (s) => { out.push(s) },
    stderr: (s) => { err.push(s) },
    ...over,
  }
  const code = await runDoctorCommand({
    ...(over.repo !== undefined && { repo: over.repo }), ...(over.host !== undefined && { githubHost: over.host }),
  }, deps)
  return { code, text: out.join(''), err: err.join('\n'), deps, github }
}

describe('review-agent doctor (spec 0.2.0 §5.1)', () => {
  it('is ready, exit 0, when everything `review --post` needs is in place', async () => {
    const r = await doctor({ repo: 'acme/widgets' })
    expect(r.code).toBe(0)
    expect(r.text).toContain('✓ Node.js 22.12.0')
    expect(r.text).toContain('✓ Claude Code: /usr/local/bin/claude')
    expect(r.text).toContain('✓ Claude Code version: 2.1.300 (Claude Code)')
    expect(r.text).toContain('✓ model credential: ANTHROPIC_API_KEY — an Anthropic API key, billed at per-token API prices')
    expect(r.text).toContain('✓ GitHub token: from GITHUB_TOKEN')
    expect(r.text).toContain('✓ GitHub identity: @alice — scopes: repo, read:org')
    expect(r.text).toContain('✓ acme/widgets: readable (private)')
    expect(r.text).toContain('✓ @alice has push access to acme/widgets')
    // The soft gate, said where the status is (spec 0.2.0 §5.4) — a warning, not a failure.
    expect(r.text).toContain('! report: a commit status "review-agent" — a soft gate')
    expect(r.text).toContain('Ready for `review-agent review --post`.')
    expect(r.text).not.toContain('✗')
  })

  it('reads and never writes', async () => {
    const r = await doctor({ repo: 'acme/widgets' })
    expect(r.github.routes.every((route) => route.startsWith('GET '))).toBe(true)
  })

  it('exits 2 with a fix under every ✗', async () => {
    const r = await doctor({
      nodeVersion: '20.18.0',
      env: { ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: SECRETS.CLAUDE_CODE_OAUTH_TOKEN },
      resolveClaudeBinary: () => { throw new Error('Claude Code was not found: no executable `claude` in an absolute PATH directory.') },
    })
    expect(r.code).toBe(2)
    const lines = r.text.split('\n')
    const failures = lines.flatMap((l, i) => (l.startsWith('✗ ') ? [i] : []))
    // Node, Claude Code, two credentials, no GitHub token.
    expect(failures).toHaveLength(4)
    for (const i of failures) expect(lines[i + 1]).toMatch(/^ {2}fix: \S/)
    expect(r.text).toContain('Not ready for `review-agent review --post`: 4 problems above.')
  })
})

describe('review-agent doctor: this machine', () => {
  it('needs Node 22 or newer', async () => {
    const r = await doctor({ nodeVersion: '20.18.0' })
    expect(r.text).toContain('✗ Node.js 20.18.0: review-agent needs 22 or newer')
    expect(r.code).toBe(2)
  })

  it('says why there is no Claude Code, with the installer for this OS, and asks no version of nothing', async () => {
    const claudeVersion = vi.fn(async () => 'never')
    const r = await doctor({
      platform: 'win32', claudeVersion,
      resolveClaudeBinary: () => { throw new Error("Claude Code's native binary is not installed — npm skipped its install script.") },
    })
    expect(r.text).toContain("✗ Claude Code's native binary is not installed")
    expect(r.text).toContain('irm https://claude.ai/install.ps1 | iex')
    expect(claudeVersion).not.toHaveBeenCalled()
    expect(r.code).toBe(2)
  })

  it('fails a Claude Code that does not answer --version', async () => {
    const r = await doctor({ claudeVersion: async () => { throw new Error('it did not answer within 10 seconds') } })
    expect(r.text).toContain('✗ Claude Code did not answer --version: it did not answer within 10 seconds')
    expect(r.code).toBe(2)
  })
})

// Spec 0.2.0 §2.3, decision §14.4.
describe('review-agent doctor: the model credential, by name and kind', () => {
  it('names a subscription token as one', async () => {
    const r = await doctor({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRETS.CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN: SECRETS.GITHUB_TOKEN } })
    expect(r.text).toContain("✓ model credential: CLAUDE_CODE_OAUTH_TOKEN — a subscription token, drawn from that subscription's allowance")
  })

  it('warns, and does not fail, when only `claude login` is left, which it cannot check', async () => {
    const r = await doctor({ env: { GITHUB_TOKEN: SECRETS.GITHUB_TOKEN } })
    expect(r.text).toContain("! model credential: none set, so Claude Code's own login (`claude login`) will be used")
    expect(r.code).toBe(0)
  })

  it('fails both at once, and ANTHROPIC_BASE_URL at all', async () => {
    const both = await doctor({ env: { ...SECRETS } })
    expect(both.text).toContain('✗ model credential: ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are both set')
    expect(both.code).toBe(2)
    const gateway = await doctor({ env: { ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, GITHUB_TOKEN: SECRETS.GITHUB_TOKEN, ANTHROPIC_BASE_URL: 'https://gateway.example/v1' } })
    expect(gateway.text).toContain('✗ ANTHROPIC_BASE_URL is set')
    expect(gateway.text).not.toContain('gateway.example')
    expect(gateway.code).toBe(2)
  })
})

describe('review-agent doctor: the GitHub token, by where it came from', () => {
  it('says which variable, or gh', async () => {
    expect((await doctor({ env: { GH_TOKEN: SECRETS.GH_TOKEN } })).text).toContain('✓ GitHub token: from GH_TOKEN (GITHUB_TOKEN is not set)')
    const viaGh = await doctor({
      env: {}, host: 'github.example.com',
      gh: { authToken: vi.fn(async (): Promise<GhAnswer> => ({ kind: 'token', token: FROM_GH })), authLogin: vi.fn(async () => null) },
    })
    expect(viaGh.text).toContain("✓ GitHub token: from the GitHub CLI's login for github.example.com (gh auth token)")
    expect(viaGh.text).toContain('✓ GitHub identity on github.example.com: @alice')
    expect(viaGh.deps.makeOctokit).toHaveBeenCalledWith({ token: FROM_GH, baseUrl: 'https://github.example.com/api/v3' })
    expect(viaGh.text).not.toContain(FROM_GH)
  })

  it('fails when there is none, saying what to set and never offering a login it would have to run', async () => {
    const r = await doctor({ env: {} })
    expect(r.text).toContain('✗ GitHub token: none found')
    expect(r.text).toContain('fix: no GitHub token: GITHUB_TOKEN and GH_TOKEN are not set, and the GitHub CLI (gh) is not installed')
    expect(r.text).toContain('gh auth login --web --hostname github.com')
    expect(r.deps.gh.authLogin).not.toHaveBeenCalled()
    expect(r.code).toBe(2)
  })

  it('fails a token GitHub refuses', async () => {
    const r = await doctor({ github: fakeGitHub({ [USER]: { status: 401 } }) })
    expect(r.text).toContain('✗ GitHub refused the token from GITHUB_TOKEN (401): it is wrong, expired or revoked')
    expect(r.code).toBe(2)
  })

  it('names an installation token as one, and its check run', async () => {
    const r = await doctor({ github: fakeGitHub({ [USER]: { status: 403 }, [REPO]: { private: false } }), repo: 'acme/widgets' })
    expect(r.text).toContain("✓ GitHub identity: an App installation token (GitHub Actions' GITHUB_TOKEN is one)")
    expect(r.text).toContain('! an installation token\'s permissions are not listed by GitHub')
    expect(r.text).toContain('✓ report: a check run "review-agent" (a commit status if the token cannot create check runs)')
    expect(r.code).toBe(0)
  })
})

describe('review-agent doctor --repo', () => {
  it('says nothing was checked on a repository when none was named', async () => {
    const r = await doctor()
    expect(r.text).toContain('! no --repo given')
    expect(r.code).toBe(0)
  })

  it('fails a repository the token cannot read', async () => {
    const r = await doctor({ github: fakeGitHub({ ...READY, [REPO]: { status: 404 } }), repo: 'acme/widgets' })
    expect(r.text).toContain('✗ acme/widgets: not found, or this token cannot read it')
    expect(r.code).toBe(2)
  })

  it('fails a person without push access, whom a commit status needs, and says how to post without one', async () => {
    const r = await doctor({ github: fakeGitHub({ ...READY, [PERMISSION]: { user: { permissions: { push: false } } } }), repo: 'acme/widgets' })
    expect(r.text).toContain('✗ @alice has no push access to acme/widgets, and a commit status needs it')
    expect(r.text).toContain('--report none')
    expect(r.code).toBe(2)
  })

  it('fails a classic token whose scopes cannot post there', async () => {
    const r = await doctor({ github: fakeGitHub(READY, { 'x-oauth-scopes': 'read:org' }), repo: 'acme/widgets' })
    expect(r.text).toContain("✗ this token's scopes (read:org) cannot post to acme/widgets")
    expect(r.code).toBe(2)
    // public_repo is enough for a public repository.
    const pub = await doctor({ github: fakeGitHub({ ...READY, [REPO]: { private: false } }, { 'x-oauth-scopes': 'public_repo' }), repo: 'acme/widgets' })
    expect(pub.code).toBe(0)
  })

  it('warns that a token with no scopes listed cannot be checked without writing', async () => {
    const r = await doctor({ github: fakeGitHub(READY, {}), repo: 'acme/widgets' })
    expect(r.text).toContain('GitHub lists no scopes for this token')
    expect(r.text).toContain('! GitHub does not list what this token may do')
    expect(r.code).toBe(0)
  })

  it('refuses a malformed --repo with exit 2 and checks nothing', async () => {
    const r = await doctor({ repo: 'widgets' })
    expect(r.code).toBe(2)
    expect(r.err).toContain('--repo must be owner/name')
    expect(r.text).toBe('')
  })
})

// Spec 0.2.0 §5.1: "which model credential is in use (by name, never value)", and §5.3: the GitHub
// token is never printed.
describe('review-agent doctor never prints a secret', () => {
  it('names every credential and prints none of their values, however many are set', async () => {
    const r = await doctor({ env: { ...SECRETS, ANTHROPIC_AUTH_TOKEN: 'fake-doctor-auth-token-0006' }, repo: 'acme/widgets' })
    for (const value of [...Object.values(SECRETS), 'fake-doctor-auth-token-0006']) {
      expect(r.text).not.toContain(value)
      expect(r.err).not.toContain(value)
    }
    expect(r.text).toContain('ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('takes a token out of an error message that quotes it, wherever the token came from', async () => {
    for (const env of [{ GITHUB_TOKEN: SECRETS.GITHUB_TOKEN }, {}]) {
      const token = env.GITHUB_TOKEN ?? FROM_GH
      const r = await doctor({
        env,
        gh: { authToken: vi.fn(async (): Promise<GhAnswer> => ({ kind: 'token', token: FROM_GH })), authLogin: vi.fn(async () => null) },
        github: fakeGitHub({ [USER]: { status: 502, message: `upstream said: Authorization: token ${token}` } }),
      })
      expect(r.text).toContain('Authorization: token [redacted]')
      expect(r.text).not.toContain(token)
    }
  })
})

// The example in docs/cli.md is this run's output, not a capture of a real machine: the test keeps the
// two from drifting apart.
describe('the example layout docs/cli.md shows', () => {
  it('is what doctor prints for these fakes', async () => {
    const r = await doctor({ repo: 'acme/widgets' })
    const docs = readFileSync(new URL('../../../docs/cli.md', import.meta.url), 'utf8')
    const example = /<!-- doctor-example:start -->\n```text\n([\s\S]*?)```\n<!-- doctor-example:end -->/.exec(docs)
    expect(example, 'docs/cli.md has no doctor example between its markers').not.toBeNull()
    expect(example?.[1]).toBe(r.text)
  })
})

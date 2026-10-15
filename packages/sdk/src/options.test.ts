import { inspect } from 'node:util'
import type { Octokit } from '@octokit/core'
import { defaultDeploymentConfig, SecretValue } from '@review-agent/core'
import { DEFAULT_SESSION_DEADLINE_MS, GITHUB_API_VERSION } from '@review-agent/github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialOf, mergeSettings, normalise } from './options'

const octokit = { request: async () => ({ data: null }) } as unknown as Octokit
const ENV = { ANTHROPIC_API_KEY: 'environment-key' }
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'acme/widgets', pr: 16, github: { octokit }, ...over,
})

afterEach(() => { vi.unstubAllGlobals() })

describe('normalise: what a call runs on, when it is well formed', () => {
  it('fills in the defaults the spec names (§4.2)', () => {
    const n = normalise(valid(), ENV)
    expect(n).toMatchObject({
      owner: 'acme', repo: 'widgets', pr: 16, octokit, post: false, report: 'auto', ask: {},
      requestedBy: null, authorize: null, bin: null, workDir: null, skillCacheDir: null, focusConcurrency: null,
      deadlineMs: DEFAULT_SESSION_DEADLINE_MS, signal: null, onProgress: null,
    })
    expect(n.deadlineMs).toBe(30 * 60 * 1000)
    expect(n.deployment).toEqual(defaultDeploymentConfig())
  })

  it('carries this request as the ask, and only true for multi', () => {
    const n = normalise(valid({
      tier: 'normal', effort: 'high', model: 'claude-opus-5', check: false, brief: 'look at the parser',
      budgetUsd: 1.5, multi: { concurrency: 2 }, requestedBy: 'alice',
    }), ENV)
    expect(n.ask).toEqual({
      tier: 'normal', effort: 'high', model: 'claude-opus-5', check: false, brief: 'look at the parser',
      budgetUsd: 1.5, multi: true, requestedBy: 'alice',
    })
    expect(n.focusConcurrency).toBe(2)
    expect(normalise(valid({ multi: true }), ENV)).toMatchObject({ ask: { multi: true }, focusConcurrency: null })
    expect(normalise(valid({ multi: false }), ENV).ask).toEqual({})
  })

  it("builds a client from a token that sends it, and the pinned API version, to the server's baseUrl", async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ login: 'alice' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetch)
    const n = normalise(valid({ github: { token: 'test-github-token', baseUrl: 'https://ghe.example.test/api/v3' } }), ENV)
    await n.octokit.request('GET /user')
    const [url, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://ghe.example.test/api/v3/user')
    expect(init.headers.authorization).toBe('token test-github-token')
    expect(init.headers['x-github-api-version']).toBe(GITHUB_API_VERSION)
  })
})

describe('normalise: a programmer error throws a TypeError, before anything is fetched (spec 0.2.0 §4.3)', () => {
  const MALFORMED: [string, unknown][] = [
    ['not an object', 'acme/widgets#16'],
    ['an option that does not exist — a misspelt credential would bill the environment', valid({ credentials: { apiKey: 'k' } })],
    ['repo without an owner', valid({ repo: 'widgets' })],
    ['repo with a path', valid({ repo: 'acme/widgets/tree' })],
    ['repo as dot-dot', valid({ repo: 'acme/..' })],
    ['repo not a string', valid({ repo: 42 })],
    ['pr zero', valid({ pr: 0 })],
    ['pr fractional', valid({ pr: 1.5 })],
    ['pr as text', valid({ pr: '16' })],
    ['github missing', { repo: 'acme/widgets', pr: 16 }],
    ['github empty', valid({ github: {} })],
    ['github token empty', valid({ github: { token: '' } })],
    ['github token and octokit both', valid({ github: { token: 't', octokit } })],
    ['github octokit not a client', valid({ github: { octokit: {} } })],
    ['github baseUrl not a URL', valid({ github: { token: 't', baseUrl: 'ghe' } })],
    ['github baseUrl not http', valid({ github: { token: 't', baseUrl: 'ftp://ghe.example.test' } })],
    ['github with an unknown key', valid({ github: { token: 't', host: 'ghe' } })],
    ['credential empty', valid({ credential: { apiKey: '' } })],
    ['credential with two kinds', valid({ credential: { apiKey: 'a', oauthToken: 'b' } })],
    ['credential as a kind name', valid({ credential: 'api-key' })],
    ['credential with an unknown key', valid({ credential: { key: 'a' } })],
    ['credential not a string', valid({ credential: { apiKey: 42 } })],
    ['post as text', valid({ post: 'yes' })],
    ["report as the CLI's word", valid({ report: 'status' })],
    ['tier unknown', valid({ tier: 'extreme' })],
    ['effort unknown', valid({ effort: 'huge' })],
    ['model empty', valid({ model: '' })],
    ['check as text', valid({ check: 'yes' })],
    ['brief not text', valid({ brief: 3 })],
    ['budgetUsd zero', valid({ budgetUsd: 0 })],
    ['budgetUsd not a number', valid({ budgetUsd: Number.NaN })],
    ['multi as text', valid({ multi: 'yes' })],
    ['multi concurrency zero', valid({ multi: { concurrency: 0 } })],
    ['multi concurrency fractional', valid({ multi: { concurrency: 1.5 } })],
    ['multi with an unknown key', valid({ multi: { concurrency: 2, lenses: 3 } })],
    ['settings not an object', valid({ settings: 'strict' })],
    ['a misspelt setting', valid({ settings: { reprot: {} } })],
    ['a setting of the wrong type', valid({ settings: { report: { checkRunName: 3 } } })],
    ['a report mode that does not exist', valid({ settings: { report: { mode: 'loud' } } })],
    ['a tier that does not exist', valid({ settings: { tiers: { extreme: { budgetUsd: 1 } } } })],
    ["a tier's effort that does not exist", valid({ settings: { tiers: { basic: { effort: 'huge' } } } })],
    ['skills not a list', valid({ settings: { skills: 'all' } })],
    ['a gate as text', valid({ settings: { report: { failAtOrAbove: '7' } } })],
    ['instructions not text', valid({ settings: { instructions: 5 } })],
    ['a band as text', valid({ settings: { severity: { bands: { high: '7' } } } })],
    ['a nested object replaced by a value', valid({ settings: { report: 'silent' } })],
    ['a __proto__ key from JSON', valid({ settings: JSON.parse('{"__proto__": {"allowMulti": false}}') as unknown })],
    ['requestedBy empty', valid({ requestedBy: '' })],
    ['authorize not a function', valid({ authorize: true, requestedBy: 'alice' })],
    ['authorize asked about nobody', valid({ authorize: async () => true })],
    ['claude.bin relative — it could resolve inside the reviewed code', valid({ claude: { bin: 'claude' } })],
    ['claude with an unknown key', valid({ claude: { passEnv: ['HTTPS_PROXY'] } })],
    ['workDir relative', valid({ workDir: 'tmp' })],
    ['skillCacheDir relative', valid({ skillCacheDir: '.cache' })],
    ['deadlineMs zero', valid({ deadlineMs: 0 })],
    ['deadlineMs infinite', valid({ deadlineMs: Number.POSITIVE_INFINITY })],
    ["deadlineMs past setTimeout's limit, which would fire at once", valid({ deadlineMs: 2 ** 31 })],
    ['signal not a signal', valid({ signal: {} })],
    ['onProgress not a function', valid({ onProgress: 'console' })],
  ]

  it.each(MALFORMED)('%s', (_label, options) => {
    expect(() => normalise(options, ENV)).toThrow(TypeError)
  })

  it('never puts a credential or a token in the message', () => {
    const key = 'sk-very-secret-value'
    const thrown = (o: unknown): string => {
      try { normalise(o, ENV) } catch (e) { return String(e) }
      throw new Error('expected a throw')
    }
    expect(thrown(valid({ credential: { apiKey: key, oauthToken: key } }))).not.toContain(key)
    expect(thrown(valid({ credential: { apiKey: 42, note: key } }))).not.toContain(key)
    expect(thrown(valid({ github: { token: key, baseUrl: 'ghe' } }))).not.toContain(key)
  })

  it('accepts the settings at the deadline limit and a whole deployment object', () => {
    expect(normalise(valid({ deadlineMs: 2 ** 31 - 1 }), ENV).deadlineMs).toBe(2 ** 31 - 1)
    expect(normalise(valid({ settings: defaultDeploymentConfig() }), ENV).deployment).toEqual(defaultDeploymentConfig())
  })
})

describe('the model credential (spec 0.2.0 §2.3, §3.2)', () => {
  it('wraps a key so nothing prints it, and hands the value on unchanged', () => {
    const c = credentialOf({ apiKey: 'test-key' }, {})
    if (c.kind !== 'api-key') throw new Error(c.kind)
    expect(c.value.reveal()).toBe('test-key')
    expect(String(c.value)).toBe('[redacted]')
    expect(JSON.stringify(c)).not.toContain('test-key')
    expect(inspect(c)).not.toContain('test-key')
  })

  it('passes a subscription token straight through, and takes a SecretValue as it is', () => {
    const t = credentialOf({ oauthToken: 'test-subscription-token' }, {})
    expect(t.kind === 'oauth-token' && t.value.reveal()).toBe('test-subscription-token')
    const held = new SecretValue('held-key')
    const c = credentialOf({ apiKey: held }, {})
    expect(c.kind === 'api-key' && c.value).toBe(held)
    expect(() => credentialOf({ apiKey: new SecretValue('') }, {})).toThrow(TypeError)
  })

  it("passes 'claude-login' through", () => {
    expect(credentialOf('claude-login', {})).toEqual({ kind: 'claude-login' })
  })

  it('reads exactly one from the environment when none is passed, and never falls back to claude login', () => {
    expect(credentialOf(undefined, { CLAUDE_CODE_OAUTH_TOKEN: 't' })).toMatchObject({ kind: 'oauth-token' })
    // An SDK host is a service until it says otherwise: no `claude login` by default.
    expect(() => credentialOf(undefined, {})).toThrow(/no model credential/)
    expect(() => credentialOf(undefined, { ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b' })).toThrow(/2 model credentials/)
  })

  it('refuses ANTHROPIC_BASE_URL whichever way the credential came (decision §14.5)', () => {
    const gateway = { ANTHROPIC_BASE_URL: 'https://gateway.example.test' }
    for (const c of [{ apiKey: 'k' }, { oauthToken: 't' }, 'claude-login', undefined]) {
      expect(() => credentialOf(c, { ...gateway, ANTHROPIC_API_KEY: 'k' })).toThrow(/ANTHROPIC_BASE_URL/)
    }
  })

  it('throws an Error, not a TypeError, for an environment no review can run in — after every option is checked', () => {
    let thrown: unknown
    try { normalise(valid(), {}) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(TypeError)
    // A malformed option is reported first: it is the one the programmer can see in the call.
    expect(() => normalise(valid({ pr: 0 }), {})).toThrow(TypeError)
  })
})

describe('mergeSettings: the defaults, with the host’s settings over them (spec 0.2.0 §4.2)', () => {
  it('changes one nested setting and keeps every other one beside it', () => {
    const merged = mergeSettings({ report: { checkRunName: 'review' }, tiers: { normal: { budgetUsd: 5 } }, severity: { bands: { high: 8 } } })
    const defaults = defaultDeploymentConfig()
    expect(merged.report).toEqual({ ...defaults.report, checkRunName: 'review' })
    expect(merged.tiers).toEqual({ ...defaults.tiers, normal: { ...defaults.tiers.normal, budgetUsd: 5 } })
    expect(merged.severity).toEqual({ ...defaults.severity, bands: { ...defaults.severity.bands, high: 8 } })
    expect({ ...merged, report: defaults.report, tiers: defaults.tiers, severity: defaults.severity }).toEqual(defaults)
  })

  it('replaces a list whole — an allowed skill can be removed — and copies it', () => {
    const skills = [{ kind: 'dir' as const, path: '/opt/skills/security-pass' }]
    const merged = mergeSettings({ skills })
    expect(merged.skills).toEqual(skills)
    skills.push({ kind: 'dir', path: '/opt/skills/added-later' })
    expect(merged.skills).toHaveLength(1)
    expect(mergeSettings({ skills: [] }).skills).toEqual([])
  })

  it('reads null as a value and undefined as "not set"', () => {
    expect(mergeSettings({ report: { failAtOrAbove: 7 } }).report.failAtOrAbove).toBe(7)
    expect(mergeSettings({ report: { failAtOrAbove: null } }).report.failAtOrAbove).toBeNull()
    expect(mergeSettings({ report: { maxInline: undefined } }).report.maxInline).toBe(defaultDeploymentConfig().report.maxInline)
  })

  it('takes the settings the defaults leave out', () => {
    expect(mergeSettings({ instructions: 'Prefer early returns.' }).instructions).toBe('Prefer early returns.')
    expect(mergeSettings({ allowMulti: false }).allowMulti).toBe(false)
  })

  it('shares nothing with the defaults or with an earlier call', () => {
    const first = mergeSettings({ report: { checkRunName: 'a' } })
    first.report.maxInline = 0
    first.tiers.basic.budgetUsd = 99
    expect(mergeSettings(undefined)).toEqual(defaultDeploymentConfig())
  })
})

import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runEngine } from './engine'
import type { EngineInput } from './engine'
import { fixturePath } from '../test/fixture'
import { CHILD_ENV_ALLOWLIST, childEnv, gatewayBaseUrlRefusal } from './cli-process'
import { inputFixture as baseInputFixture } from '../test/helpers/engine-input'

const fakeCli = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url))

let record: string
let checkout: string

// Task 5's helper defaults `checkoutDir` to '/tmp/checkout', which does not exist; `spawn` rejects
// with ENOENT when its `cwd` is missing, before the binary is ever reached. Every case here gets a
// real empty directory instead — the engine only ever uses it as a working directory.
const inputFixture = (over: Partial<EngineInput> = {}): EngineInput =>
  baseInputFixture({ checkoutDir: checkout, ...over })

beforeEach(() => {
  record = join(mkdtempSync(join(tmpdir(), 'review-agent-')), 'record.json')
  checkout = mkdtempSync(join(tmpdir(), 'checkout-'))
  // The engine spawns whatever REVIEW_AGENT_CLAUDE_BIN names, defaulting to `claude`. This is the
  // single seam that keeps unit tests off the real binary and off a real bill.
  process.env.REVIEW_AGENT_CLAUDE_BIN = fakeCli
  process.env.FAKE_CLAUDE_RECORD = record
})

afterEach(() => {
  for (const k of ['REVIEW_AGENT_CLAUDE_BIN', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_FIXTURE',
                   'FAKE_CLAUDE_EXIT', 'FAKE_CLAUDE_STDERR', 'FAKE_CLAUDE_SLEEP_MS']) {
    delete process.env[k]
  }
})

describe('runEngine — a run that completed', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })

  it('returns the parsed review output', async () => {
    const r = await runEngine(inputFixture())
    expect(r.failure).toBeNull()
    expect(r.cutShort).toBe(false)
    expect(r.output?.findings).toHaveLength(4)
    expect(r.output?.intent.verdict).toBe('matches')
    expect(r.output?.inconclusive).toHaveLength(2)
    // The CLI emits snake_case; the Finding type is camelCase and `end_line` was absent on all
    // four of these findings, so parseReviewOutput must be supplying null rather than undefined.
    expect(r.output?.findings[0].endLine).toBeNull()
    expect(r.output?.findings[0].file).toBe('src/cache/lru.ts')
  })

  it('reports the usage the run really cost', async () => {
    const r = await runEngine(inputFixture())
    expect(r.usage.costUsd).toBeCloseTo(1.2494105, 6)
    expect(r.usage.inputTokens).toBe(32)
    expect(r.usage.outputTokens).toBe(19350)
    expect(r.usage.cacheReadTokens).toBe(514625)
    expect(r.usage.cacheWriteTokens).toBe(50190)
    expect(r.usage.turns).toBe(18)
    expect(r.usage.durationMs).toBe(279107)
  })

  it('sends the prompt on stdin and runs in the checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'checkout-'))
    await runEngine(inputFixture({ checkoutDir: dir, prompt: 'Review this pull request.' }))
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    expect(seen.stdin).toBe('Review this pull request.')
    // realpathSync, not `dir`: on macOS — the platform this is being built on — os.tmpdir() is
    // /var/folders/…, a symlink to /private/var/folders/…, and a child's process.cwd() reports the
    // resolved path. Asserting the unresolved path passes on Linux and fails on every developer
    // machine here.
    expect(seen.cwd).toBe(realpathSync(dir))
    expect(seen.argv[0]).toBe('-p')
  })
})

describe('runEngine — isolation', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })

  // Design §4.3. The reviewer can Read any file in the checkout and, if it were given one, could
  // read its own /proc/self/environ. In the App deployment the parent process holds the GitHub
  // installation token; in CI it holds everything the workflow declared.
  // Criss, 2026-09-13. On macOS the Claude CLI finds a `claude` login in the keychain through USER;
  // without it the end-to-end run answered "Not logged in" for $0 and never reached the model. USER is
  // the account name, not a secret, and the model still has no shell and no file access outside the
  // checkout, so the keychain stays out of its reach.
  it('passes USER, so an existing claude login in the keychain is found', async () => {
    process.env.USER = 'reviewer-test-user'
    await runEngine(inputFixture())
    expect(JSON.parse(readFileSync(record, 'utf8')).env.USER).toBe('reviewer-test-user')
  })

  // The boundary itself, pinned: the child sees the allow-list and nothing else. The test above only
  // checked that one token is absent; a variable added to the parent's environment by anything — a
  // CI runner, a shell profile — must not reach a process that reads a pull request's code.
  it('gives the child only allow-listed variables, whatever the parent has', async () => {
    const planted = {
      GITHUB_TOKEN: 'ghs_x', NPM_TOKEN: 'npm_x', AWS_SECRET_ACCESS_KEY: 'aws_x',
      SSH_AUTH_SOCK: '/tmp/ssh.sock', SUPABASE_SERVICE_KEY: 'sb_x', GH_REVIEWER_PRIVATE_KEY: 'pem',
    }
    Object.assign(process.env, planted)
    try {
      await runEngine(inputFixture())
      const seen = Object.keys(JSON.parse(readFileSync(record, 'utf8')).env)
      // Named, not pattern-matched: macOS CoreFoundation sets __CF_USER_TEXT_ENCODING inside every
      // process at startup, whatever it was launched with, so the child acquires it itself. It holds a
      // text-encoding id. A broad exemption here would hide exactly the leak this test exists to catch.
      const OS_INJECTED = ['__CF_USER_TEXT_ENCODING']
      const unexpected = seen.filter((k) =>
        !CHILD_ENV_ALLOWLIST.includes(k) && !k.startsWith('FAKE_CLAUDE_') && !OS_INJECTED.includes(k))
      expect(unexpected).toEqual([])
      for (const k of Object.keys(planted)) expect(seen).not.toContain(k)
    } finally {
      for (const k of Object.keys(planted)) delete process.env[k]
    }
  })

  it('gives the child the model credential and nothing else', async () => {
    process.env.GITHUB_TOKEN = 'ghs_should_never_reach_the_reviewer'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    try {
      await runEngine(inputFixture())
      const seen = JSON.parse(readFileSync(record, 'utf8'))
      expect(seen.env.GITHUB_TOKEN).toBeUndefined()
      expect(seen.env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
      expect(seen.env.PATH).toBeDefined()
    } finally {
      delete process.env.GITHUB_TOKEN
      delete process.env.ANTHROPIC_API_KEY
    }
  })
})

describe('runEngine — failures that really happened', () => {
  // Four of six measured runs died on the hard ceiling and returned nothing at all, costing
  // $9.54 between them (design §4.4). The cost is still real and must still be recorded and
  // reported, or a deployment cannot see what its ceiling is costing it.
  it('reports a budget failure with what was spent, and keeps the usage', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/failure-budget.json')
    process.env.FAKE_CLAUDE_EXIT = '1'
    const r = await runEngine(inputFixture())
    expect(r.failure).toEqual({ kind: 'budget', spentUsd: 2.3241860000000005 })
    expect(r.output).toBeNull()
    expect(r.cutShort).toBe(true)
    expect(r.usage.costUsd).toBeCloseTo(2.324186, 6)
    expect(r.usage.turns).toBe(36)
    expect(r.usage.cacheReadTokens).toBe(1484382)
  })

  // The second real shape: the model wrote null where the schema demanded a string and never
  // recovered in five attempts (design §4.5).
  it('reports a schema failure', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/failure-schema.json')
    process.env.FAKE_CLAUDE_EXIT = '1'
    const r = await runEngine(inputFixture())
    expect(r.failure).toEqual({ kind: 'schema' })
    expect(r.output).toBeNull()
    expect(r.usage.costUsd).toBeCloseTo(0.254643, 6)
  })

  // The third real shape, found by the end-to-end run of 2026-09-13: the CLI could not find a login,
  // answered "Not logged in" for $0, and the engine reported it as a REFUSAL — telling a user the
  // model declined a review it was never asked to do. The envelope says subtype "success" and
  // is_error true; the field to trust is is_error.
  it('reports a login failure as an error a user can act on, never as a refusal', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/failure-not-logged-in.json')
    process.env.FAKE_CLAUDE_EXIT = '1'
    const r = await runEngine(inputFixture())
    expect(r.failure).toEqual({
      kind: 'cli-error', terminalReason: 'api_error', message: 'Not logged in · Please run /login',
    })
    expect(r.output).toBeNull()
    expect(r.cutShort).toBe(false)     // nothing ran, so nothing was cut short
    expect(r.usage.costUsd).toBe(0)
  })

  it('reports a crash when the binary produces no JSON at all', async () => {
    delete process.env.FAKE_CLAUDE_FIXTURE
    process.env.FAKE_CLAUDE_EXIT = '127'
    process.env.FAKE_CLAUDE_STDERR = 'claude: command not found'
    const r = await runEngine(inputFixture())
    expect(r.failure).toEqual({ kind: 'crashed', code: 127, stderr: 'claude: command not found' })
    expect(r.usage.costUsd).toBe(0)
  })

  it('keeps the findings when the ceiling fires mid-write', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/failure-budget-partial.json')
    process.env.FAKE_CLAUDE_EXIT = '1'
    const r = await runEngine(inputFixture())
    expect(r.failure?.kind).toBe('budget')
    expect(r.cutShort).toBe(true)
    // The whole point: a failure does not throw the work away.
    expect(r.output?.findings).toHaveLength(4)
  })
})

describe('the model credential the child may see', () => {
  it('is one of exactly two kinds, and the gateway pair is not in the list', () => {
    // Criss, 2026-09-14 (decision 10). An Anthropic API key or a `claude setup-token` subscription
    // token. ANTHROPIC_AUTH_TOKEN is a gateway bearer token and ANTHROPIC_BASE_URL is the gateway
    // it points at: together they send the reviewed code to a third party this product cannot
    // name, so "two kinds" would stop meaning what it says.
    expect(CHILD_ENV_ALLOWLIST).not.toContain('ANTHROPIC_AUTH_TOKEN')
    expect(CHILD_ENV_ALLOWLIST).not.toContain('ANTHROPIC_BASE_URL')
    expect(CHILD_ENV_ALLOWLIST.filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')))
      .toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('does not forward a base URL even when one is set in this process', () => {
    const before = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/v1'
    try {
      expect(childEnv().ANTHROPIC_BASE_URL).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = before
    }
  })

  it('names the variable and never its value, and says nothing when it is unset', () => {
    const sentence = gatewayBaseUrlRefusal({ ANTHROPIC_BASE_URL: 'https://gateway.example/v1' })
    expect(sentence).toMatch(/^ANTHROPIC_BASE_URL is set:/)
    expect(sentence).not.toContain('gateway.example')
    expect(gatewayBaseUrlRefusal({})).toBeNull()
    expect(gatewayBaseUrlRefusal({ ANTHROPIC_BASE_URL: '' })).toBeNull()
  })

  it('refuses to start the model at all when ANTHROPIC_BASE_URL is set, whoever called it', async () => {
    // spawnClaude is the one road to the model for the review AND the check pass, from the CLI, the
    // Action (which runs the CLI) and the trigger.dev task alike. A refusal here cannot be skipped
    // by a caller that forgot to check.
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json')
    const before = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/v1'
    try {
      const e = await runEngine(inputFixture()).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).message).toMatch(/^ANTHROPIC_BASE_URL is set:/)
      expect((e as Error).message).not.toContain('gateway.example')
      // The fake CLI writes FAKE_CLAUDE_RECORD on every invocation; nothing written, nothing spawned.
      expect(existsSync(record)).toBe(false)
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = before
    }
  })
})

describe('runEngine — abort', () => {
  it('kills the run when the caller aborts', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json')
    process.env.FAKE_CLAUDE_SLEEP_MS = '5000'
    const ac = new AbortController()
    const p = runEngine(inputFixture({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toThrow(/abort/i)
  }, 10_000)
})

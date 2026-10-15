import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCheckPass } from './check-pass'
import { runClaude, runEngine, SYSTEM_PROMPT_FILE_THRESHOLD } from './engine'
import type { EngineInput } from './engine'
import { fixturePath } from '../test/fixture'
import { CHILD_ENV_ALLOWLIST, childEnv } from './cli-process'
import { gatewayBaseUrlRefusal, SecretValue, type ClaudeRuntime } from './runtime'
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

/** Sets these variables for one case and puts back whatever was there, so a case never leaks into
 *  the next — or into a developer's own credential, if their shell holds one. */
const withEnv = async (vars: Record<string, string>, body: () => Promise<void>): Promise<void> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    await body()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const seenEnv = (): Record<string, string> => JSON.parse(readFileSync(record, 'utf8')).env

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
      // Windows: libuv adds these from the parent to ANY child environment that lacks them
      // (deps/uv/src/win/process.c, `required_vars`) — "winsock will fail to initialize if SYSTEMROOT
      // is not defined". None is a secret. Named for the same reason.
      const OS_INJECTED = ['__CF_USER_TEXT_ENCODING',
        ...(process.platform === 'win32'
          ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN',
             'USERNAME', 'USERPROFILE', 'WINDIR']
          : [])]
      // Windows variable names are case-insensitive and keep their own spelling (`Path`, `SystemRoot`).
      const norm = (k: string): string => (process.platform === 'win32' ? k.toUpperCase() : k)
      const allowed = new Set([...CHILD_ENV_ALLOWLIST, ...OS_INJECTED].map(norm))
      const unexpected = seen.filter((k) => !allowed.has(norm(k)) && !k.startsWith('FAKE_CLAUDE_'))
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
    // Every Anthropic or Claude name on the list, pinned: the two credentials, and since 0.2.0 one
    // path (spec 0.2.0 §9.3 P7). CLAUDE_CONFIG_DIR is where a relocated login lives, not a login.
    expect(CHILD_ENV_ALLOWLIST.filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')))
      .toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'])
  })

  it('passes the two settings a relocated or Alpine Claude Code needs, which are not secrets (P7)', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json')
    await withEnv({ CLAUDE_CONFIG_DIR: '/srv/claude-config', USE_BUILTIN_RIPGREP: '0' }, async () => {
      await runEngine(inputFixture())
      expect(seenEnv().CLAUDE_CONFIG_DIR).toBe('/srv/claude-config')
      expect(seenEnv().USE_BUILTIN_RIPGREP).toBe('0')
    })
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

// Spec 0.2.0 §3.2: a credential passed with the review is the ONLY one the Claude process sees, so an
// embedding service can run two reviews on two accounts in one process, and nothing ambient rides along.
describe('runtime.credential — the given credential and no other', () => {
  const AMBIENT_KEY = 'sk-ant-api03-AMBIENT-FAKE'
  const AMBIENT_TOKEN = 'sk-ant-oat01-AMBIENT-FAKE'
  const GIVEN = 'sk-ant-api03-GIVEN-FAKE'
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })

  it('hands the child the given API key, and removes both ambient credentials', async () => {
    await withEnv({ ANTHROPIC_API_KEY: AMBIENT_KEY, CLAUDE_CODE_OAUTH_TOKEN: AMBIENT_TOKEN }, async () => {
      await runEngine(inputFixture({ runtime: { credential: { kind: 'api-key', value: new SecretValue(GIVEN) } } }))
      expect(seenEnv().ANTHROPIC_API_KEY).toBe(GIVEN)
      expect(seenEnv().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    })
  })

  it('hands the child the given subscription token, and no API key', async () => {
    await withEnv({ ANTHROPIC_API_KEY: AMBIENT_KEY }, async () => {
      await runEngine(inputFixture({ runtime: { credential: { kind: 'oauth-token', value: new SecretValue(GIVEN) } } }))
      expect(seenEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe(GIVEN)
      expect(seenEnv().ANTHROPIC_API_KEY).toBeUndefined()
    })
  })

  it('hands the child no credential variable at all for a claude login, whatever the parent holds', async () => {
    await withEnv({ ANTHROPIC_API_KEY: AMBIENT_KEY, CLAUDE_CODE_OAUTH_TOKEN: AMBIENT_TOKEN }, async () => {
      await runEngine(inputFixture({ runtime: { credential: { kind: 'claude-login' } } }))
      expect(seenEnv().ANTHROPIC_API_KEY).toBeUndefined()
      expect(seenEnv().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    })
  })

  it('reaches the check pass too, so every pass of one review is billed to one account', async () => {
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/check-verdicts.json')
    await withEnv({ ANTHROPIC_API_KEY: AMBIENT_KEY }, async () => {
      await runCheckPass({
        findings: [{
          file: 'src/a.ts', line: 1, endLine: null, severity: 5, category: 'correctness', title: 't',
          explanation: 'e', evidence: [], suggestion: null,
        }],
        input: inputFixture({ runtime: { credential: { kind: 'oauth-token', value: new SecretValue(GIVEN) } } }),
      })
      expect(seenEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe(GIVEN)
      expect(seenEnv().ANTHROPIC_API_KEY).toBeUndefined()
    })
  })

  it('still refuses an ambient ANTHROPIC_BASE_URL the child would never see (decision §14.5)', async () => {
    await withEnv({ ANTHROPIC_BASE_URL: 'https://gateway.example/v1' }, async () => {
      const e = await runEngine(inputFixture({
        runtime: { credential: { kind: 'api-key', value: new SecretValue(GIVEN) } },
      })).catch((x: unknown) => x)
      expect((e as Error).message).toMatch(/^ANTHROPIC_BASE_URL is set:/)
      expect(existsSync(record)).toBe(false)
    })
  })
})

// Spec 0.2.0 §9.3 P8, decision §14.13: a deployment names further variables — a proxy, a CA bundle —
// by name. Never by value, and never one that is a credential or decides where the code goes.
describe('runtime.passEnv — more variables, by name, never a secret', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })

  it('passes a named variable from this process to the child', async () => {
    await withEnv({ HTTPS_PROXY: 'http://proxy.internal.example:3128', NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' }, async () => {
      await runEngine(inputFixture({ runtime: { passEnv: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY'] } }))
      expect(seenEnv().HTTPS_PROXY).toBe('http://proxy.internal.example:3128')
      expect(seenEnv().NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp.pem')
      // Named but unset: nothing invented.
      expect(Object.keys(seenEnv())).not.toContain('NO_PROXY')
    })
  })

  it.each([
    ['a model credential', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['a gateway token', 'ANTHROPIC_AUTH_TOKEN'],
    ['the App key', 'REVIEW_AGENT_APP_PRIVATE_KEY'],
    ['the record secret', 'REVIEW_AGENT_RECORD_SECRET'],
    ['the skills token', 'REVIEW_AGENT_SKILLS_TOKEN'],
    ['a GitHub token', 'GITHUB_TOKEN'],
    ['a GitHub CLI token', 'GH_TOKEN'],
    ['the trigger.dev key', 'TRIGGER_SECRET_KEY'],
    ['a switch to another provider', 'CLAUDE_CODE_USE_BEDROCK'],
    ['a lower-case name', 'https_proxy'],
  ])('refuses %s before anything is started', async (_what, name) => {
    const e = await runEngine(inputFixture({ runtime: { passEnv: ['HTTPS_PROXY', name] } })).catch((x: unknown) => x)
    expect((e as Error).message).toMatch(/^runtime\.passEnv names variables the Claude process may never see/)
    // The fake CLI writes FAKE_CLAUDE_RECORD on every invocation; nothing written, nothing spawned.
    expect(existsSync(record)).toBe(false)
  })

  it('names a refused variable, and never repeats an entry that may be a value', async () => {
    const pasted = 'sk-ant-api03-pasted-where-a-name-belonged'
    const e = await runEngine(inputFixture({ runtime: { passEnv: ['GITHUB_TOKEN', pasted] } })).catch((x: unknown) => x)
    expect((e as Error).message).toContain('GITHUB_TOKEN')
    expect((e as Error).message).toContain('1 entry that is not a variable name')
    expect((e as Error).message).not.toContain(pasted)
  })

  it('cannot bring an ambient credential back alongside a given one', () => {
    const runtime: ClaudeRuntime = { credential: { kind: 'claude-login' }, passEnv: ['ANTHROPIC_API_KEY'] }
    expect(() => childEnv({}, runtime)).toThrow(/ANTHROPIC_API_KEY \(a model credential or endpoint\)/)
  })
})

// Spec 0.2.0 §3.2: `bin` per review, in place of REVIEW_AGENT_CLAUDE_BIN, by the same rules.
describe('runtime.bin', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })

  it('wins over REVIEW_AGENT_CLAUDE_BIN', async () => {
    process.env.REVIEW_AGENT_CLAUDE_BIN = join(tmpdir(), 'no-such-claude-here')
    const r = await runEngine(inputFixture({ runtime: { bin: fakeCli } }))
    expect(r.failure).toBeNull()
    expect(existsSync(record)).toBe(true)
  })

  it('is refused when relative, or inside the checkout, before anything runs', async () => {
    const relative = await runEngine(inputFixture({ runtime: { bin: 'claude' } })).catch((x: unknown) => x)
    expect((relative as Error).message).toMatch(/^runtime\.bin must be an absolute path/)
    const planted = await runEngine(inputFixture({ runtime: { bin: join(checkout, 'claude') } })).catch((x: unknown) => x)
    expect((planted as Error).message).toMatch(/^runtime\.bin points inside the checkout/)
    expect(existsSync(record)).toBe(false)
  })
})

// Spec 0.2.0 §9.3 P3. Windows caps a command line at 32,767 characters, and the system prompt grows with
// what a deployment and a repository add, so on Windows — and anywhere it is long — it goes in a file.
describe('the system prompt through a file', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json') })
  const seen = (): { argv: string[]; systemPromptFile: { path: string; text: string; mode: number; dirMode: number } | null } =>
    JSON.parse(readFileSync(record, 'utf8'))

  it('stays on the command line when it is short and this is not Windows', async () => {
    await runClaude(inputFixture(), { platform: 'linux' })
    expect(seen().argv).toContain('--append-system-prompt')
    expect(seen().argv).not.toContain('--append-system-prompt-file')
    expect(seen().systemPromptFile).toBeNull()
  })

  it('goes in a private file on Windows, budget sentence included, and the file is gone afterwards', async () => {
    await runClaude(inputFixture({ systemPrompt: 'You are the Acme PR reviewer.' }), { platform: 'win32' })
    const s = seen()
    expect(s.argv).not.toContain('--append-system-prompt')
    expect(s.argv[s.argv.indexOf('--append-system-prompt-file') + 1]).toBe(s.systemPromptFile?.path)
    expect(s.systemPromptFile?.text).toBe(
      'You are the Acme PR reviewer.\n\nBudget: the budget for this review is about $2.00. ' +
      'Read what you need and no more. If you have been exploring for a long time, stop opening ' +
      'new files and write up the findings you can already support with evidence you have read.')
    // Outside the checkout, where the model could otherwise be pointed at it.
    const file = s.systemPromptFile?.path ?? ''
    expect(file.startsWith(checkout) || file.startsWith(realpathSync(checkout))).toBe(false)
    if (process.platform !== 'win32') {
      expect(s.systemPromptFile?.mode).toBe(0o600)
      expect(s.systemPromptFile?.dirMode).toBe(0o700)
    }
    expect(existsSync(dirname(s.systemPromptFile?.path ?? ''))).toBe(false)
  })

  it('goes in a file on any OS once it is longer than the threshold, through runEngine itself', async () => {
    const long = 'x'.repeat(SYSTEM_PROMPT_FILE_THRESHOLD + 1)
    await runEngine(inputFixture({ systemPrompt: long }))
    expect(seen().argv).toContain('--append-system-prompt-file')
    expect(seen().systemPromptFile?.text.startsWith(long)).toBe(true)
    // And never both: a prompt passed twice would be read twice.
    expect(seen().argv).not.toContain('--append-system-prompt')
  })

  it('is removed when the run is aborted, too', async () => {
    process.env.FAKE_CLAUDE_SLEEP_MS = '5000'
    const ac = new AbortController()
    const p = runClaude(inputFixture({ signal: ac.signal }), { platform: 'win32' })
    // The fake writes its record before it sleeps, so the file's path is known while it is running.
    // Wait for the record to be COMPLETE, not merely to exist: under a loaded suite the file can be seen
    // half-written, and an empty path would make `dirname` answer '.', which always exists.
    const promptPath = (): string | undefined => {
      try { return seen().systemPromptFile?.path } catch { return undefined }
    }
    const deadline = Date.now() + 4000
    while (promptPath() === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    const path = promptPath()
    expect(path, 'the fake recorded the prompt file it was given').toBeTypeOf('string')
    const dir = dirname(path as string)
    expect(existsSync(dir)).toBe(true)
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(existsSync(dir)).toBe(false)
  }, 10_000)
})

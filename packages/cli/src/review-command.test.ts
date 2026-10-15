import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Octokit } from '@octokit/core'
import {
  REVIEW_INSTRUCTIONS_VERSION, runEngine,
  type CheckVerdict, type EngineResult, type Finding, type RecheckPassResult, type ReviewOutput,
  type ReviewRecord, type Usage,
} from '@review-agent/core'
import { encodeMarker, findingId, type MarkerState, type PullRequestContext } from '@review-agent/github'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { EXIT_BAD_USAGE, EXIT_ENGINE_FAILURE, EXIT_OK, EXIT_POST_FAILED } from './exit-codes'
import type { GhAnswer, GhCli } from './github-token'
import { describePosting, runReviewCommand, type PostedJson, type ReviewCommandDeps } from './review-command'

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16,
  headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f', baseSha: '0'.repeat(40),
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and nothing checks them.',
  // One hunk whose new side is lines 98 to 103, so line 100 can carry an inline comment.
  changedFiles: [{ path: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -98,2 +98,6 @@\n context\n+a\n+b\n+c\n+d\n context\n' }],
  diff: 'diff --git a/.github/workflows/publish.yml b/.github/workflows/publish.yml\n',
}
const FINDING: Finding = {
  file: '.github/workflows/publish.yml', line: 100, endLine: null,
  severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes',
  explanation: 'A tag pushed from any branch publishes that branch.',
  evidence: ['.github/workflows/publish.yml:100'], suggestion: null,
}
const OUTPUT: ReviewOutput = {
  summary: 'Adds a tag check to publish.yml.',
  intent: { verdict: 'matches', note: 'It does what the brief says.' },
  findings: [FINDING],
  inconclusive: [],
}
// The usage numbers are a real basic-tier run: design §8, Opus 5 at low effort.
const USAGE: Usage = {
  costUsd: 0.9412, inputTokens: 32, outputTokens: 19350,
  cacheReadTokens: 514625, cacheWriteTokens: 50190, turns: 18, durationMs: 279107,
}
const RESULT: EngineResult = { output: OUTPUT, usage: USAGE, cutShort: false, wrapUpFired: false, failure: null }
const CHECK_USAGE: Usage = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104,
  cacheReadTokens: 61230, cacheWriteTokens: 18944, turns: 8, durationMs: 41022,
}
const VERDICT: CheckVerdict = {
  index: 0, verdict: 'refuted', severity: 2,
  reason: 'The job already guards on github.actor.',
  evidence: ['.github/workflows/publish.yml:104'],
}
/** Shaped like no token GitHub issues, so a hit anywhere is this file's: "ghp_" would also trip the
 *  secret scanner and hide what this file is asking. */
const GITHUB_TOKEN = 'fake-github-token-for-the-cli-tests-0001'

type Harness = ReviewCommandDeps & { out: string[]; err: string[] }

/** A checkout with nothing taken out and nothing missing: the ordinary download. */
const NOTHING_MISSING = { removed: [] as string[], notWritten: [] as { path: string; code: string }[], caseCollisions: [] as string[][] }

/** The re-review pass's answer when nothing is asked of it. */
const NO_RECHECK: RecheckPassResult = {
  judgements: [], ran: false, skipped: 'nothing-to-ask',
  usage: {
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turns: 0, durationMs: 0,
  },
}

// Every real checkout this file makes lives under one directory, so nothing is left behind.
const ROOT = mkdtempSync(join(tmpdir(), 'ra-cli-review-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

/** A GitHub CLI that must not be reached: every case below that has a token in its environment. */
const noGh = (): GhCli => ({
  authToken: vi.fn(async (): Promise<GhAnswer> => ({ kind: 'not-installed' })),
  authLogin: vi.fn(async () => null),
})

const deps = (over: Partial<ReviewCommandDeps> = {}): Harness => {
  const out: string[] = []
  const err: string[] = []
  // Two readings, so durationMs is a number a test can recognise: 4m39s, the measured wall clock of
  // a basic-tier review (design §8).
  const clock = ['2026-09-13T09:00:00.000Z', '2026-09-13T09:04:39.000Z']
  let tick = 0
  return {
    out, err,
    now: vi.fn(() => new Date(clock[Math.min(tick++, clock.length - 1)])),
    stdout: (s: string) => { out.push(s) },
    stderr: (s: string) => { err.push(s) },
    env: { GITHUB_TOKEN },
    makeOctokit: vi.fn(() => ({}) as Octokit),
    makeCheckoutDir: vi.fn(async () => '/tmp/ra-fake-checkout'),
    skillCacheDir: vi.fn(() => '/tmp/ra-fake-skill-cache'),
    fetchPullRequest: vi.fn(async () => PR),
    fetchRepoConfig: vi.fn(async () => null),
    downloadArchive: vi.fn(async (a: { destDir: string }) => ({ dir: a.destDir, ...NOTHING_MISSING })),
    materialiseSkills: vi.fn(async () => []),
    runEngine: vi.fn(async () => RESULT),
    runCheckPass: vi.fn(async () => ({ verdicts: [] as CheckVerdict[], usage: CHECK_USAGE })),
    runRecheckPass: vi.fn(async () => NO_RECHECK),
    gh: noGh(),
    // No terminal unless a case says so: nothing is ever asked, as in CI.
    interactive: false,
    confirm: vi.fn(async (_question: string, _signal?: AbortSignal) => false),
    ...over,
  } as Harness
}

describe('runReviewCommand', () => {
  it('exits 2 on a bad flag and touches nothing', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'widgets', pr: '16' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('--repo must be owner/name')
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
  })

  it('exits 2 when there is no GitHub token, naming what to set', async () => {
    const d = deps({ env: {} })
    expect(await runReviewCommand({ repo: 'a/b', pr: '1' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('Set GITHUB_TOKEN (or GH_TOKEN)')
    expect(d.err.join('\n')).toContain('Contents: Read and Pull requests: Read on a/b')
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
  })

  it('reviews, prints JSON and exits 0', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    const printed = JSON.parse(d.out.join('')) as EngineResult
    expect(printed.output?.summary).toBe('Adds a tag check to publish.yml.')
    expect(printed.usage.costUsd).toBe(0.9412)
    expect(printed.cutShort).toBe(false)

    const input = vi.mocked(d.runEngine).mock.calls[0][0]
    expect(input.checkoutDir).toBe('/tmp/ra-fake-checkout')
    expect(input.settings.tier).toBe('basic')
    expect(input.settings.effort).toBe('low')
    expect(input.prompt).toContain('widgets')
    expect(input.systemPrompt).toContain('pull request reviewer')
    // report.maxFindings (50) caps what the MODEL may return; report.maxInline (15) caps what
    // GitHub is shown. Using maxInline here would tell the reviewer to stop finding things at 15.
    const schema = input.schema as { properties: { findings: { maxItems?: number } } }
    expect(schema.properties.findings.maxItems).toBe(50)
  })

  it('prints a human summary when --json is absent, its cost labelled', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(0)
    const text = d.out.join('')
    expect(text).toContain('acme/widgets#16 at 4f8e2a1')
    expect(text).toContain('Adds a tag check to publish.yml.')
    expect(text).toContain('[6/10 security] .github/workflows/publish.yml:100')
    // Criss, 2026-09-14 (decision 2): `basic` runs the disprove-it check pass by default, so a review
    // with no --check pays for it and prints it: 0.9412 review + 0.1131 check, to the cent.
    expect(text).toContain('$1.05 model spend at per-token API prices')
    expect(text).toContain('check $0.11')
    expect(text).not.toContain('"usage"')
    // A review that only prints says nothing about posting.
    expect(text).not.toContain('posted')
  })

  it('mounts every skill materialiseSkills hands back, git sources included', async () => {
    const d = deps({
      materialiseSkills: vi.fn(async () => [
        { id: '/opt/review-agent/skills/security-pass', path: '/opt/review-agent/skills/security-pass' },
        { id: 'crissmoldovan/review-skills@v0.3.0#test-coverage',
          path: '/home/r/.cache/review-agent/skills/review-skills-9f2c1a4b7e10/test-coverage' },
      ]),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    // The whole list goes in, and the cache directory comes from the deps, not from this module.
    expect(d.materialiseSkills).toHaveBeenCalledWith([], '/tmp/ra-fake-skill-cache')
    const input = vi.mocked(d.runEngine).mock.calls[0][0]
    expect(input.skillDirs).toEqual([
      '/opt/review-agent/skills/security-pass',
      '/home/r/.cache/review-agent/skills/review-skills-9f2c1a4b7e10/test-coverage',
    ])
  })

  it('exits 1 on an engine failure but still prints the usage numbers', async () => {
    const failed: EngineResult = {
      output: null, usage: { ...USAGE, costUsd: 2.3241860 },
      cutShort: true, wrapUpFired: true,
      failure: { kind: 'budget', spentUsd: 2.3241860 },   // the shape measured on 2026-09-12
    }
    const d = deps({ runEngine: vi.fn(async () => failed) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(1)
    expect((JSON.parse(d.out.join('')) as EngineResult).failure)
      .toEqual({ kind: 'budget', spentUsd: 2.3241860 })
  })

  // spawnClaude rejects when the binary is not there (Task 6 wires child.on('error', reject)), so
  // this is the ordinary "claude is not installed" path, not a hypothetical.
  it('exits 1 when the engine throws instead of returning a failure', async () => {
    const d = deps({ runEngine: vi.fn(async () => { throw new Error('spawn claude ENOENT') }) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(1)
    expect(d.err.join('\n')).toContain('spawn claude ENOENT')
    expect(d.out).toEqual([])
  })

  it('exits 3, prints nothing and pays for no check pass when the review carries a secret', async () => {
    const token = 'ghp_' + 'A'.repeat(36)     // 36 characters: what Task 8's pattern actually matches
    const leaky: EngineResult = { ...RESULT, output: { ...OUTPUT, summary: `the workflow used ${token} directly` } }
    const d = deps({ runEngine: vi.fn(async () => leaky) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true, json: true }, d)).toBe(3)
    expect(d.out).toEqual([])
    expect(d.runCheckPass).not.toHaveBeenCalled()
    expect(d.err.join('\n')).toContain('github-token')
    expect(d.err.join('\n')).toContain('summary:line 1')
    // The message goes into logs and possibly an alert; it must not spread the leak.
    expect(d.err.join('\n')).not.toContain(token)
  })

  it('runs the check pass on the same checkout when the flag asks for it', async () => {
    const d = deps({ runCheckPass: vi.fn(async () => ({ verdicts: [VERDICT], usage: CHECK_USAGE })) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true }, d)).toBe(0)

    const call = vi.mocked(d.runCheckPass).mock.calls[0][0]
    expect(call.findings).toEqual([FINDING])
    // The same checkout and the same engine input: the check must not download the tree again.
    expect(call.input.checkoutDir).toBe('/tmp/ra-fake-checkout')
    expect(d.downloadArchive).toHaveBeenCalledTimes(1)

    const text = d.out.join('')
    expect(text).toContain('[check: refuted]')
    expect(text).toContain('$1.05')          // 0.9412 review + 0.1131 check, to the cent
  })

  // tier `normal` presets check: true (Task 3), so this proves --skip-check reaches settings.check
  // rather than proving the default is off.
  it('does not run the check pass when --skip-check overrides the tier', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', tier: 'normal', skipCheck: true }, d)).toBe(0)
    expect(d.runCheckPass).not.toHaveBeenCalled()
  })

  it('exits 3 when a check verdict carries a secret', async () => {
    const token = 'ghp_' + 'A'.repeat(36)
    const d = deps({
      runCheckPass: vi.fn(async () => ({
        verdicts: [{ ...VERDICT, reason: `the workflow used ${token}` }], usage: CHECK_USAGE,
      })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true, json: true }, d)).toBe(3)
    expect(d.out).toEqual([])
    expect(d.err.join('\n')).toContain('checkVerdicts[0].reason')
    expect(d.err.join('\n')).not.toContain(token)
  })

  it('says which credential files it removed, and puts them on the record', async () => {
    const d = deps({
      downloadArchive: vi.fn(async (a: { destDir: string }) => ({ dir: a.destDir, ...NOTHING_MISSING, removed: ['.npmrc'] })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    expect(d.err.join('\n')).toContain('removed 1 credential file from the checkout before the review: .npmrc')
    expect((JSON.parse(d.out.join('')) as ReviewRecord).checkout.removedCredentialFiles).toEqual(['.npmrc'])
  })

  it('--json emits the bare review record without --post, with the settings and skills that produced it', async () => {
    const d = deps({
      materialiseSkills: vi.fn(async () => [
        { id: 'crissmoldovan/review-skills@v0.3.0#test-coverage', path: '/cache/x/test-coverage' },
      ]),
      runCheckPass: vi.fn(async () => ({ verdicts: [VERDICT], usage: CHECK_USAGE })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true, json: true }, d)).toBe(0)

    const record = JSON.parse(d.out.join('')) as ReviewRecord
    // Decision §14.8: the envelope is --post's. Without it, the record is the document, as before.
    expect(record).not.toHaveProperty('record')
    expect(record).not.toHaveProperty('posted')
    expect(record.recordVersion).toBe(1)
    expect(record.settings.tier).toBe('basic')
    expect(record.settings.model).toBe('claude-opus-5')
    expect(record.settings.effort).toBe('low')
    expect(record.settings.check).toBe(true)
    expect(record.instructions.version).toBe(REVIEW_INSTRUCTIONS_VERSION)
    expect(record.skills.map((s) => s.id)).toEqual(['crissmoldovan/review-skills@v0.3.0#test-coverage'])
    expect(record.request.headSha).toBe(PR.headSha)
    expect(record.checkVerdicts).toEqual([VERDICT])
    expect(record.usage.costUsd).toBe(0.9412)
    expect(record.costUsd).toBeCloseTo(1.0543, 6)
    expect(record.timings).toEqual({
      startedAt: '2026-09-13T09:00:00.000Z',
      finishedAt: '2026-09-13T09:04:39.000Z',
      durationMs: 279_000,
    })
  })

  it('lets the reviewed repository’s base-branch instructions into the review', async () => {
    const d = deps({
      fetchRepoConfig: vi.fn(async () => ({ instructions: 'Care about the order of the migrations.' })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    // The CLI passed repo: null until this task, so .review-agent/review.md reached no review.
    // The base sha, never PR.headSha: the file must not be written by the change it judges.
    expect(vi.mocked(d.fetchRepoConfig).mock.calls[0][0].baseRef).toBe(PR.baseSha)
    expect(vi.mocked(d.runEngine).mock.calls[0][0].systemPrompt)
      .toContain('Care about the order of the migrations.')
  })

  it('exits 2 when ANTHROPIC_BASE_URL is set, before any GitHub call, naming no value (Criss, decision 10)', async () => {
    const d = deps({ env: { GITHUB_TOKEN, ANTHROPIC_BASE_URL: 'https://gateway.example/v1' } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('ANTHROPIC_BASE_URL is set')
    expect(d.err.join('\n')).not.toContain('gateway.example')
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
    expect(d.runEngine).not.toHaveBeenCalled()
  })

  it('asks for three focused reviewers with --multi (spec 0.2.0 §8.3, decision §14.16)', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', multi: true, json: true }, d)).toBe(0)
    expect((JSON.parse(d.out.join('')) as ReviewRecord).settings.multi).toBe(true)
    expect(d.runEngine).toHaveBeenCalledTimes(3)
  })

  it('talks to GitHub Enterprise Server at its /api/v3 with --github-host', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', githubHost: 'github.example.com' }, d)).toBe(0)
    expect(d.makeOctokit).toHaveBeenCalledWith({ token: GITHUB_TOKEN, baseUrl: 'https://github.example.com/api/v3' })
  })
})

// Decision §14.4 and spec 0.2.0 §3.2: exactly one credential, or this machine's `claude login` — and
// whichever it is, the Claude process gets that one and no other.
describe('runReviewCommand: the model credential', () => {
  const KEY = 'sk-ant-api03-FAKE-not-a-real-key'
  const TOKEN = 'sk-ant-oat01-FAKE-not-a-real-token'

  it('exits 2 when both credentials are set, naming both and neither value, before any GitHub call', async () => {
    const d = deps({ env: { GITHUB_TOKEN, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(EXIT_BAD_USAGE)
    const said = d.err.join('\n')
    expect(said).toContain('ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN')
    expect(said).toContain('set exactly one')
    expect(said).not.toContain(KEY)
    expect(said).not.toContain(TOKEN)
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
    expect(d.runEngine).not.toHaveBeenCalled()
  })

  it('hands the review the one credential that is set, wrapped so it never prints', async () => {
    const d = deps({ env: { GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    const credential = vi.mocked(d.runEngine).mock.calls[0][0].runtime?.credential
    expect(credential?.kind).toBe('oauth-token')
    expect(credential?.kind === 'oauth-token' && credential.value.reveal()).toBe(TOKEN)
    expect(JSON.stringify(credential)).not.toContain(TOKEN)
    // Nor in anything the command printed.
    expect([...d.out, ...d.err].join('\n')).not.toContain(TOKEN)
  })

  it('uses this machine’s claude login when neither is set, as it always has', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    expect(vi.mocked(d.runEngine).mock.calls[0][0].runtime?.credential).toEqual({ kind: 'claude-login' })
  })
})

// Spec 0.2.0 §5.3 and §10: "The token is never printed, logged, put in the Claude process's
// environment or written to disk."
describe('runReviewCommand: the GitHub token', () => {
  it('takes GITHUB_TOKEN before GH_TOKEN before gh, and builds the client with the first it finds', async () => {
    const order = async (env: Record<string, string>, gh: GhAnswer): Promise<string> => {
      const d = deps({
        env, gh: { authToken: vi.fn(async () => gh), authLogin: vi.fn(async () => null) },
      })
      expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(0)
      return vi.mocked(d.makeOctokit).mock.calls[0][0].token
    }
    const fromGh: GhAnswer = { kind: 'token', token: 'fake-token-from-gh-0003' }
    expect(await order({ GITHUB_TOKEN: 'fake-token-from-GITHUB_TOKEN-0001', GH_TOKEN: 'fake-token-from-GH_TOKEN-0002' }, fromGh))
      .toBe('fake-token-from-GITHUB_TOKEN-0001')
    expect(await order({ GITHUB_TOKEN: '', GH_TOKEN: 'fake-token-from-GH_TOKEN-0002' }, fromGh)).toBe('fake-token-from-GH_TOKEN-0002')
    expect(await order({}, fromGh)).toBe('fake-token-from-gh-0003')
  })

  it('never prints the token, even when an error message from GitHub quotes it', async () => {
    const d = deps({
      fetchPullRequest: vi.fn(async () => { throw new Error(`Bad credentials for ${GITHUB_TOKEN}`) }),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(EXIT_ENGINE_FAILURE)
    const said = [...d.out, ...d.err].join('\n')
    expect(said).toContain('Bad credentials for [redacted]')
    expect(said).not.toContain(GITHUB_TOKEN)
  })

  it('never reaches the Claude process — not its environment, its arguments or its input', async () => {
    // The real engine, against the fake Claude, which records everything it was given. The token is
    // put where a person's shell would have it — in this process's environment — and, in the second
    // run, held only in memory after `gh` handed it over.
    const fakeCli = fileURLToPath(new URL('../../core/test/fake-claude.mjs', import.meta.url))
    const fixture = fileURLToPath(new URL('../../core/test/fixtures/cli/success-opus-low.json', import.meta.url))
    const vars = ['REVIEW_AGENT_CLAUDE_BIN', 'FAKE_CLAUDE_FIXTURE', 'FAKE_CLAUDE_RECORD', 'GITHUB_TOKEN'] as const
    const before = Object.fromEntries(vars.map((k) => [k, process.env[k]]))
    try {
      for (const source of ['GITHUB_TOKEN', 'gh'] as const) {
        const record = join(mkdtempSync(join(ROOT, 'record-')), 'claude.json')
        Object.assign(process.env, { REVIEW_AGENT_CLAUDE_BIN: fakeCli, FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_RECORD: record })
        if (source === 'GITHUB_TOKEN') process.env.GITHUB_TOKEN = GITHUB_TOKEN
        else delete process.env.GITHUB_TOKEN
        const d = deps({
          env: { ...process.env },
          gh: { authToken: vi.fn(async (): Promise<GhAnswer> => ({ kind: 'token', token: GITHUB_TOKEN })), authLogin: vi.fn(async () => null) },
          makeCheckoutDir: vi.fn(async () => mkdtempSync(join(ROOT, 'checkout-'))),
          runEngine,
        })
        expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', skipCheck: true, json: true }, d)).toBe(0)
        const seen = readFileSync(record, 'utf8')
        expect(JSON.parse(seen).env.GITHUB_TOKEN).toBeUndefined()
        expect(seen).not.toContain(GITHUB_TOKEN)
        expect([...d.out, ...d.err].join('\n')).not.toContain(GITHUB_TOKEN)
      }
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

// Spec 0.2.0 §9.3 P14: Ctrl-C stops the review — and the Claude process with it — instead of leaving it
// running and billing with nobody waiting for the answer.
describe('runReviewCommand: stopped by the person who started it', () => {
  it('hands the signal to the review, and says plainly that it stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-cli-checkout-'))
    const controller = new AbortController()
    const d = deps({
      makeCheckoutDir: vi.fn(async () => dir),
      // What the real engine does on an abort: the spawn's signal kills the process and the run
      // rejects with the abort's reason. The session hands the engine a signal of its own, which the
      // CLI's aborts.
      runEngine: vi.fn(async (input) => {
        controller.abort(new Error('the review was interrupted'))
        expect(input.signal?.aborted).toBe(true)
        throw input.signal?.reason
      }),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true }, d, { signal: controller.signal })).toBe(1)
    expect(d.err.join('\n')).toContain('the review was stopped before it finished')
    expect(d.out).toEqual([])
    expect(d.runCheckPass).not.toHaveBeenCalled()
    // The downloaded code goes with it.
    expect(existsSync(dir)).toBe(false)
  })

  it('says the usual thing about a failure nobody asked for', async () => {
    const d = deps({ runEngine: vi.fn(async () => { throw new Error('spawn claude ENOENT') }) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d, { signal: new AbortController().signal })).toBe(1)
    expect(d.err.join('\n')).toContain('the review did not complete: spawn claude ENOENT')
  })
})

describe('without --post, the CLI buys no re-review pass', () => {
  it('never asks the re-review pass anything, because it reads no marker', async () => {
    // Criss, 2026-09-16: a re-review costs about $0.10 more at per-token API prices, and only a review
    // that reads the summary comment can even form the question. Without --post nothing is read, so no
    // previous findings are passed and `runReview`'s `previousFindings.length > 0` gate never opens.
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', json: true }, d)).toBe(0)
    expect(d.runRecheckPass).not.toHaveBeenCalled()
    const record = JSON.parse(d.out.join('')) as ReviewRecord
    expect(record.recheckUsage).toBeNull()
    expect(record.recheckJudgements).toBeNull()
    // The engine and the check pass, and nothing else: the CLI's bill is exactly what it was.
    expect(record.costUsd).toBeCloseTo(RESULT.usage.costUsd + CHECK_USAGE.costUsd, 6)
  })
})

describe('runReviewCommand: the downloaded code', () => {
  it('is deleted once the review is printed — the CLI keeps no copy of the code it reviewed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-cli-checkout-'))
    const d = deps({ makeCheckoutDir: vi.fn(async () => dir) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })

  it('is kept with --keep-checkout, and the command says where (spec 0.2.0 §5.2)', async () => {
    const dir = mkdtempSync(join(ROOT, 'kept-'))
    const d = deps({ makeCheckoutDir: vi.fn(async () => dir) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', keepCheckout: true }, d)).toBe(0)
    expect(existsSync(dir)).toBe(true)
    expect(d.err.join('\n')).toContain(`the downloaded code was kept at ${dir}`)
  })
})

// ── Posting (spec 0.2.0 §5.4) ──────────────────────────────────────────────────────────────────────

type Call = { route: string; params: Record<string, unknown> }
type IssueComment = { id: number; body: string; user: { login: string } | null }

const USER = 'GET /user'
const STATUS = 'POST /repos/{owner}/{repo}/statuses/{sha}'
const LIST_RUNS = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs'
const CREATE_RUN = 'POST /repos/{owner}/{repo}/check-runs'
const COMPLETE_RUN = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
const SUMMARY_LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_CREATE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_EDIT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
const REVIEW_CREATE = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews'
const REVIEW_COMMENTS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments'

/** A small GitHub that remembers what is written to it: who the token is, statuses, check runs, the
 *  summary comment and a review with its inline comments. A route nobody expected throws. */
const fakeGitHub = (seed: {
  user?: { login: string } | { status: number }; issueComments?: IssueComment[]; fail?: Partial<Record<string, number>>
} = {}) => {
  const calls: Call[] = []
  const issueComments = [...(seed.issueComments ?? [])]
  const request = async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params })
    const failWith = seed.fail?.[route]
    if (failWith !== undefined) throw Object.assign(new Error(`HTTP ${failWith}`), { status: failWith })
    const ok = (data: unknown, headers: Record<string, string> = {}) => ({ status: 200, headers, data })
    switch (route) {
      case USER: {
        const u = seed.user ?? { login: 'alice' }
        if ('status' in u) throw Object.assign(new Error(`HTTP ${u.status}`), { status: u.status })
        return ok(u, { 'x-oauth-scopes': 'repo' })
      }
      case STATUS: return ok({ id: 1 })
      case LIST_RUNS: return ok({ total_count: 0, check_runs: [] })
      case CREATE_RUN: return ok({ id: 4242, html_url: 'https://github.com/acme/widgets/runs/4242' })
      case COMPLETE_RUN: return ok({ id: 4242 })
      case SUMMARY_LIST: return ok(Number(params.page ?? 1) === 1 ? issueComments : [])
      case SUMMARY_CREATE: return ok({ id: 8100, html_url: 'https://github.com/acme/widgets/pull/16#issuecomment-8100' })
      case SUMMARY_EDIT: return ok({ id: params.comment_id, html_url: `https://github.com/acme/widgets/pull/16#issuecomment-${String(params.comment_id)}` })
      case REVIEW_CREATE: return ok({ id: 900 })
      case REVIEW_COMMENTS: return ok([])
      default: throw new Error(`the fake was asked for a route the CLI should not call: ${route}`)
    }
  }
  return { octokit: { request } as unknown as Octokit, calls }
}
const only = (calls: Call[], route: string): Call[] => calls.filter((c) => c.route === route)
const writes = (calls: Call[]): string[] => calls.map((c) => c.route).filter((r) => !r.startsWith('GET '))

/** The harness, posting: a checkout that really exists (anchoring reads the line each finding points
 *  at) and the fake GitHub above. */
const posting = (gh: ReturnType<typeof fakeGitHub>, over: Partial<ReviewCommandDeps> = {}): Harness => deps({
  makeOctokit: vi.fn(() => gh.octokit),
  makeCheckoutDir: vi.fn(async () => mkdtempSync(join(ROOT, 'checkout-'))),
  downloadArchive: vi.fn(async (a: { destDir: string }) => {
    mkdirSync(join(a.destDir, '.github/workflows'), { recursive: true })
    writeFileSync(join(a.destDir, FINDING.file), Array.from({ length: 130 }, (_, i) => `    - run: step-${i + 1}`).join('\n') + '\n')
    return { dir: a.destDir, ...NOTHING_MISSING }
  }),
  ...over,
})

const SENTENCE = 'This will post as @alice on acme/widgets#16: a review with inline comments, a summary comment ' +
  'and a commit status "review-agent".'

describe('runReviewCommand --post: asking first', () => {
  it('asks once on a terminal, before anything is spent, saying what will be posted and as whom', async () => {
    const gh = fakeGitHub()
    const d = posting(gh, { interactive: true, confirm: vi.fn(async () => true) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    expect(d.confirm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.confirm).mock.calls[0][0]).toBe(`${SENTENCE} Continue? [y/N]`)
    // Asked before the model ran: the first engine call comes after the only question.
    expect(vi.mocked(d.confirm).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.runEngine).mock.invocationCallOrder[0])
  })

  it('posts nothing and spends nothing on a no', async () => {
    const gh = fakeGitHub()
    const d = posting(gh, { interactive: true, confirm: vi.fn(async () => false) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_ENGINE_FAILURE)
    expect(d.runEngine).not.toHaveBeenCalled()
    expect(writes(gh.calls)).toEqual([])
    expect(d.err.join('\n')).toContain('nothing was reviewed and nothing was posted')
  })

  it('does not ask with --yes', async () => {
    const gh = fakeGitHub()
    const d = posting(gh, { interactive: true, confirm: vi.fn(async () => false) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, yes: true }, d)).toBe(EXIT_OK)
    expect(d.confirm).not.toHaveBeenCalled()
    expect(only(gh.calls, SUMMARY_CREATE)).toHaveLength(1)
  })

  it('does not ask without a terminal, and says what it is doing so a CI log shows it', async () => {
    const gh = fakeGitHub()
    const d = posting(gh, { interactive: false, confirm: vi.fn(async () => false) })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    expect(d.confirm).not.toHaveBeenCalled()
    expect(d.err).toContain(SENTENCE)
  })
})

describe('describePosting', () => {
  const base = {
    identity: { kind: 'user', login: 'alice' } as const, owner: 'acme', repo: 'widgets', number: 16,
    mode: 'inline+summary' as const, reporter: 'commit-status' as const, fallsBack: false, name: 'review-agent',
  }
  it('says what each mode writes, and what reports it', () => {
    expect(describePosting(base)).toEqual({ writes: true, sentence: SENTENCE })
    expect(describePosting({ ...base, mode: 'summary-only', reporter: 'none' }).sentence)
      .toBe('This will post as @alice on acme/widgets#16: a summary comment.')
    expect(describePosting({ ...base, identity: { kind: 'installation' }, reporter: 'check-run', fallsBack: true }).sentence)
      .toBe("This will post as this token's GitHub App installation on acme/widgets#16: a review with inline comments, " +
        'a summary comment and a check run "review-agent" (a commit status, if the token cannot create one).')
  })
  it('follows the session: check-only without a check run says its findings in the summary (decision §14.3)', () => {
    expect(describePosting({ ...base, mode: 'check-only' }).sentence)
      .toBe('This will post as @alice on acme/widgets#16: a summary comment and a commit status "review-agent".')
  })
  it('writes nothing for a silent repository, and so asks nothing', () => {
    expect(describePosting({ ...base, mode: 'silent' }).writes).toBe(false)
  })
})

describe('runReviewCommand --post: posting as the token’s identity', () => {
  it('posts the review, the summary and a commit status as the person, and says it ran from the command line', async () => {
    const gh = fakeGitHub()
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    // One GET /user decides it (spec 0.2.0 §2.2), and a person's token reports with a status.
    expect(only(gh.calls, USER)).toHaveLength(1)
    expect(only(gh.calls, STATUS).map((c) => c.params.state)).toEqual(['pending', 'success'])
    expect(only(gh.calls, STATUS)[0].params.context).toBe('review-agent')
    expect(only(gh.calls, CREATE_RUN)).toEqual([])
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('run by @alice from the command line')
    expect(String(only(gh.calls, REVIEW_CREATE)[0].params.body)).toContain('run by @alice from the command line')
    const text = d.out.join('')
    expect(text).toContain('posted 1 inline comment and a summary comment: https://github.com/acme/widgets/pull/16#issuecomment-8100')
    expect(text).toContain('reported with a commit status: success')
  })

  it('says "from GitHub Actions" in a workflow — the words only, the report still decided by the token', async () => {
    const gh = fakeGitHub()
    const d = posting(gh, { env: { GITHUB_TOKEN, GITHUB_ACTIONS: 'true' } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain('run by @alice from GitHub Actions')
    // A person's token in a workflow is still a person's token: a status, not a check run.
    expect(only(gh.calls, CREATE_RUN)).toEqual([])
    expect(only(gh.calls, STATUS)).toHaveLength(2)
  })

  it('reports with a check run when the token is an installation’s, as Actions’ GITHUB_TOKEN is', async () => {
    const gh = fakeGitHub({ user: { status: 403 } })
    const d = posting(gh, { env: { GITHUB_TOKEN, GITHUB_ACTIONS: 'true' } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    expect(only(gh.calls, CREATE_RUN)).toHaveLength(1)
    expect(only(gh.calls, STATUS)).toEqual([])
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain('run from GitHub Actions')
  })

  it('reports nothing on the commit with --report none', async () => {
    const gh = fakeGitHub()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, report: 'none' }, posting(gh))).toBe(EXIT_OK)
    expect(only(gh.calls, STATUS)).toEqual([])
    expect(only(gh.calls, SUMMARY_CREATE)).toHaveLength(1)
  })

  it('refuses --report check-run with a person’s token before the pull request is read or anything is spent', async () => {
    const gh = fakeGitHub()
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, report: 'check-run' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('--report check-run needs a token that can create check runs')
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
    expect(writes(gh.calls)).toEqual([])
  })

  it('exits 2 when GitHub refuses the token outright, naming where it came from', async () => {
    const gh = fakeGitHub({ user: { status: 401 } })
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('GitHub refused the token from GITHUB_TOKEN (401)')
    expect(d.runEngine).not.toHaveBeenCalled()
  })
})

describe('runReviewCommand --post: the re-review', () => {
  const previous: MarkerState = { version: 1, runs: [{ headSha: '1'.repeat(40), at: '2026-10-14T10:00:00.000Z', findings: [
    { id: findingId(FINDING), file: FINDING.file, line: 100, severity: 6, title: FINDING.title, commentId: null, outcome: 'open' },
  ] }] }
  const earlier = (): IssueComment[] => [{ id: 9003, body: `### Review of \`1111111\`\n\n${encodeMarker(previous)}\n`, user: { login: 'alice' } }]

  it('reads the earlier summary and runs the re-review pass by default, editing that summary', async () => {
    const gh = fakeGitHub({ issueComments: earlier() })
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_OK)
    expect(vi.mocked(d.runRecheckPass).mock.calls[0][0].previous.map((q) => q.title)).toEqual([FINDING.title])
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9003)
  })

  it('edits the summary this login posted, not the one the App posted on the same pull request (decision §14.7)', async () => {
    const theApps: IssueComment = { id: 9002, body: `### Review of \`1111111\`\n\n${encodeMarker(previous)}\n`, user: { login: 'review-agent[bot]' } }
    const gh = fakeGitHub({ issueComments: [theApps, ...earlier()] })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, posting(gh))).toBe(EXIT_OK)
    expect(only(gh.calls, SUMMARY_EDIT).map((c) => c.params.comment_id)).toEqual([9003])
  })

  it('skips the re-review pass with --no-re-review, and still edits the earlier summary', async () => {
    const gh = fakeGitHub({ issueComments: earlier() })
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, reReview: false }, d)).toBe(EXIT_OK)
    expect(d.runRecheckPass).not.toHaveBeenCalled()
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9003)
  })
})

describe('runReviewCommand --post --json: the envelope (decision §14.8)', () => {
  it('prints { record, posted, report }', async () => {
    const gh = fakeGitHub()
    const d = posting(gh)
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, json: true }, d)).toBe(EXIT_OK)
    const printed = JSON.parse(d.out.join('')) as PostedJson
    expect(Object.keys(printed)).toEqual(['record', 'posted', 'report'])
    expect(printed.record.request.headSha).toBe(PR.headSha)
    expect(printed.posted).toEqual({
      reviewId: 900, summaryCommentId: 8100,
      summaryUrl: 'https://github.com/acme/widgets/pull/16#issuecomment-8100', inlineComments: 1,
    })
    expect(printed.report).toEqual({
      kind: 'commit-status', conclusion: 'success', url: 'https://github.com/acme/widgets/pull/16#issuecomment-8100',
    })
  })
})

// Spec 0.2.0 §5.5.
describe('runReviewCommand --post: GitHub would not take the review', () => {
  // The session reads the summary listing first and survives its failure; publishing reads it again,
  // and that failure is GitHub not taking the review.
  const refusing = () => fakeGitHub({ fail: { [SUMMARY_LIST]: 502 } })

  it('exits 4 and prints the review, so a review paid for is not lost', async () => {
    const d = posting(refusing())
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d)).toBe(EXIT_POST_FAILED)
    expect(EXIT_POST_FAILED).toBe(4)
    const text = d.out.join('')
    expect(text).toContain('Adds a tag check to publish.yml.')
    expect(text).toContain('[6/10 security] .github/workflows/publish.yml:100')
    expect(text).toContain('NOT POSTED')
    expect(d.err.join('\n')).toContain('the review ran and could not be posted')
  })

  it('prints the envelope with nothing posted under --json', async () => {
    const d = posting(refusing())
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true, json: true }, d)).toBe(EXIT_POST_FAILED)
    const printed = JSON.parse(d.out.join('')) as PostedJson
    expect(printed.posted).toBeNull()
    expect(printed.record.output?.summary).toBe('Adds a tag check to publish.yml.')
  })
})

// Spec 0.2.0 §5.4: "A run interrupted after setting `pending` (Ctrl-C) sets the status to `error` on
// the way out, so it does not block a merge forever."
describe('runReviewCommand --post: Ctrl-C after the status was set pending', () => {
  it('finishes the status as error, and says so', async () => {
    const gh = fakeGitHub()
    const controller = new AbortController()
    const d = posting(gh, {
      runEngine: vi.fn(async (input) => {
        controller.abort(new Error('the review was interrupted'))
        throw input.signal?.reason
      }),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', post: true }, d, { signal: controller.signal }))
      .toBe(EXIT_ENGINE_FAILURE)
    expect(only(gh.calls, STATUS).map((c) => c.params.state)).toEqual(['pending', 'error'])
    expect(only(gh.calls, SUMMARY_CREATE)).toEqual([])
    expect(d.err.join('\n')).toContain('the commit status says the review was interrupted')
  })
})

describe('runReviewCommand: a multi-reviewer review printed (spec 0.2.0 §8.3)', () => {
  it('says each duplicate once, naming the other focuses that found it, as posting does', async () => {
    const expiry: Finding = { ...FINDING, title: 'tokens signed with a previous key never expire', lens: 'intent' }
    const sameExpiry: Finding = { ...FINDING, title: 'previous-key tokens are accepted after they expire', lens: 'security' }
    const other: Finding = { ...FINDING, line: 101, title: 'the refresh route still uses the bare secret', lens: 'impact' }
    const output: ReviewOutput = { ...OUTPUT, findings: [expiry, other, sameExpiry] }
    const d = deps({
      runEngine: vi.fn(async () => ({ ...RESULT, output })),
      runCheckPass: vi.fn(async () => ({
        verdicts: [
          { index: 0, verdict: 'confirmed', severity: 9, reason: 'r', evidence: [], duplicateOf: null },
          { index: 1, verdict: 'confirmed', severity: 8, reason: 'r', evidence: [], duplicateOf: null },
          { index: 2, verdict: 'confirmed', severity: 9, reason: 'r', evidence: [], duplicateOf: 0 },
        ] as CheckVerdict[],
        usage: CHECK_USAGE,
      })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(0)
    const out = d.out.join('')
    expect(out).toContain('tokens signed with a previous key never expire')
    expect(out).not.toContain('previous-key tokens are accepted after they expire')
    expect(out).toMatch(/\[6\/10 security · intent reviewer\] .*never expire \[check: confirmed · also found by security\]/)
    expect(out).toContain('1 duplicate merged')
    expect(out).toContain('the refresh route still uses the bare secret')
  })
})

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  REVIEW_INSTRUCTIONS_VERSION,
  type CheckVerdict, type EngineResult, type Finding, type RecheckPassResult, type ReviewOutput,
  type ReviewRecord, type Usage,
} from '@review-agent/core'
import type { PullRequestContext } from '@review-agent/github'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_BAD_USAGE } from './exit-codes'
import { runReviewCommand, type ReviewCommandDeps } from './review-command'

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16,
  headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f', baseSha: '0'.repeat(40),
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and nothing checks them.',
  changedFiles: [{ path: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -88,6 +88,37 @@\n context\n' }],
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

type Harness = ReviewCommandDeps & { out: string[]; err: string[] }

/** A checkout with nothing taken out and nothing missing: the ordinary download. */
const NOTHING_MISSING = { removed: [] as string[], notWritten: [] as { path: string; code: string }[], caseCollisions: [] as string[][] }

/** The re-review pass's answer when nothing is asked of it. The CLI reads no marker, so this is
 *  the only answer it could ever get — and it never even asks. */
const NO_RECHECK: RecheckPassResult = {
  judgements: [], ran: false, skipped: 'nothing-to-ask',
  usage: {
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turns: 0, durationMs: 0,
  },
}

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
    env: { GITHUB_TOKEN: 'ghp_test' },
    makeOctokit: vi.fn(() => ({}) as Octokit),
    makeCheckoutDir: vi.fn(async () => '/tmp/ra-fake-checkout'),
    skillCacheDir: vi.fn(() => '/tmp/ra-fake-skill-cache'),
    fetchPullRequest: vi.fn(async () => PR),
    fetchRepoConfig: vi.fn(async () => null),
    downloadArchive: vi.fn(async (a: { destDir: string }) => ({ dir: a.destDir, ...NOTHING_MISSING })),
    materialiseSkills: vi.fn(async () => []),
    runEngine: vi.fn(async () => RESULT),
    runCheckPass: vi.fn(async () => ({ verdicts: [] as CheckVerdict[], usage: CHECK_USAGE })),
    // Wired because `ReviewCommandDeps` requires it, and never expected to be called: see the case
    // at the end of this file. Present rather than left to the cast below, so "never called" is a
    // fact about the command and not about a missing mock.
    runRecheckPass: vi.fn(async () => NO_RECHECK),
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

  it('exits 2 when there is no GitHub token', async () => {
    const d = deps({ env: {} })
    expect(await runReviewCommand({ repo: 'a/b', pr: '1' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('GITHUB_TOKEN')
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

  it('prints a human summary when --json is absent', async () => {
    const d = deps()
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(0)
    const text = d.out.join('')
    expect(text).toContain('acme/widgets#16 at 4f8e2a1')
    expect(text).toContain('Adds a tag check to publish.yml.')
    expect(text).toContain('[6/10 security] .github/workflows/publish.yml:100')
    // Criss, 2026-09-14 (decision 2): `basic` runs the disprove-it check pass by default, so a review
    // with no --check pays for it and prints it: 0.9412 review + 0.1131 check, to the cent.
    expect(text).toContain('$1.05')
    expect(text).toContain('check $0.11')
    expect(text).not.toContain('"usage"')
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

  it('--json emits the review record, with the settings and skills that produced it', async () => {
    const d = deps({
      materialiseSkills: vi.fn(async () => [
        { id: 'crissmoldovan/review-skills@v0.3.0#test-coverage', path: '/cache/x/test-coverage' },
      ]),
      runCheckPass: vi.fn(async () => ({ verdicts: [VERDICT], usage: CHECK_USAGE })),
    })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16', check: true, json: true }, d)).toBe(0)

    const record = JSON.parse(d.out.join('')) as ReviewRecord
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
    const d = deps({ env: { GITHUB_TOKEN: 'ghp_test', ANTHROPIC_BASE_URL: 'https://gateway.example/v1' } })
    expect(await runReviewCommand({ repo: 'acme/widgets', pr: '16' }, d)).toBe(EXIT_BAD_USAGE)
    expect(d.err.join('\n')).toContain('ANTHROPIC_BASE_URL is set')
    expect(d.err.join('\n')).not.toContain('gateway.example')
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
    expect(d.runEngine).not.toHaveBeenCalled()
  })
})

// Decision §14.4 and spec 0.2.0 §3.2: exactly one credential, or this machine's `claude login` — and
// whichever it is, the Claude process gets that one and no other.
describe('runReviewCommand: the model credential', () => {
  const KEY = 'sk-ant-api03-FAKE-not-a-real-key'
  const TOKEN = 'sk-ant-oat01-FAKE-not-a-real-token'

  it('exits 2 when both credentials are set, naming both and neither value, before any GitHub call', async () => {
    const d = deps({ env: { GITHUB_TOKEN: 'ghp_test', ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })
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
    const d = deps({ env: { GITHUB_TOKEN: 'ghp_test', CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })
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

// Spec 0.2.0 §9.3 P14: Ctrl-C stops the review — and the Claude process with it — instead of leaving it
// running and billing with nobody waiting for the answer.
describe('runReviewCommand: stopped by the person who started it', () => {
  it('hands the signal to the review, and says plainly that it stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-cli-checkout-'))
    const controller = new AbortController()
    const d = deps({
      makeCheckoutDir: vi.fn(async () => dir),
      // What the real engine does on an abort: the spawn's signal kills the process and the run
      // rejects with the abort's reason.
      runEngine: vi.fn(async (input) => {
        expect(input.signal).toBe(controller.signal)
        controller.abort(new Error('the review was interrupted'))
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

describe('the CLI buys no re-review pass', () => {
  it('never asks the re-review pass anything, because it reads no marker', async () => {
    // Criss, 2026-09-16: a re-review costs about $0.10 more at per-token API prices, and only a
    // deployment that reads the bot's summary comment can even form the question. `runReviewCommand`
    // reads no marker and posts nothing, so it passes no previous findings and `runReview`'s
    // `previousFindings.length > 0` gate never opens. The CLI's bill is exactly what it was.
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
})

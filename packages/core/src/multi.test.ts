import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runEngine, type EngineInput, type EngineResult, type Usage } from './engine'
import { parseReviewOutput, type Finding, type ReviewOutput } from './findings'
import { combineFocusRuns, focusRecords, runFocusedReviews, type FocusRun } from './multi'
import { REVIEW_LENSES } from './prompt'
import { fixturePath } from '../test/fixture'
import { inputFixture as baseInputFixture, settingsFixture } from '../test/helpers/engine-input'

const fakeCli = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url))
const FAKE_VARS = [
  'REVIEW_AGENT_CLAUDE_BIN', 'FAKE_CLAUDE_FIXTURE', 'FAKE_CLAUDE_FIXTURE_BY_PROMPT', 'FAKE_CLAUDE_RECORD_DIR',
  'FAKE_CLAUDE_SLEEP_MS', 'FAKE_CLAUDE_EXIT',
]

let checkout: string
let records: string

/** One fixture per focus, picked by the line of the system prompt that names it — every spawn of a
 *  multi-reviewer review reads the same environment in the same tick. `null` is a process that
 *  crashed: no output, exit 1. */
const byFocus = (map: Partial<Record<'intent' | 'impact' | 'security', string | null>>): void => {
  process.env.FAKE_CLAUDE_FIXTURE_BY_PROMPT = JSON.stringify(Object.fromEntries(
    Object.entries(map).map(([lens, f]) => [`Your focus: ${lens}`, f === null ? null : fixturePath(`cli/${f}`)]),
  ))
}
const THREE = { intent: 'multi-intent.json', impact: 'multi-impact.json', security: 'multi-security-budget-partial.json' }

type Spawned = { argv: string[]; stdin: string; cwd: string; startedAt: number; systemPrompt: string }
const recorded = (): string[] => readdirSync(records).filter((f) => f.endsWith('.json')).sort()
const spawned = (): Spawned[] => recorded().map((f) => JSON.parse(readFileSync(join(records, f), 'utf8')) as Spawned)
const focusOf = (s: Spawned): string | undefined => REVIEW_LENSES.find((l) => s.systemPrompt.includes(`Your focus: ${l}`))
const argOf = (s: Spawned, flag: string): string | undefined => s.argv[s.argv.indexOf(flag) + 1]

const inputFixture = (over: Partial<EngineInput> = {}): EngineInput =>
  baseInputFixture({ checkoutDir: checkout, ...over })

beforeEach(() => {
  checkout = mkdtempSync(join(tmpdir(), 'checkout-'))
  records = mkdtempSync(join(tmpdir(), 'ra-spawns-'))
  process.env.REVIEW_AGENT_CLAUDE_BIN = fakeCli
  process.env.FAKE_CLAUDE_RECORD_DIR = records
})
afterEach(() => { for (const k of FAKE_VARS) delete process.env[k] })

const run = (over: Partial<Parameters<typeof runFocusedReviews>[0]> = {}) =>
  runFocusedReviews({ input: inputFixture(), run: runEngine, concurrency: 3, ...over })

describe('runFocusedReviews — one reviewer per focus (spec 0.2.0 §8.3)', () => {
  it('starts one Claude process per focus, each told its own focus, on the same checkout, prompt and flags', async () => {
    byFocus(THREE)
    const runs = await run()

    expect(runs.map((r) => r.lens)).toEqual(['intent', 'impact', 'security'])
    const all = spawned()
    expect(all.map(focusOf).sort()).toEqual(['impact', 'intent', 'security'])
    // The same read-only rules: what differs between them is the focus line of the system prompt, and
    // nothing else on the command line. The prompt's VALUE is left out of the comparison and its flag
    // kept, whichever way it was sent: inline, or — on Windows, and past 16,000 characters — as a
    // file, where each focus writes its own private temp file and so its own path (engine.ts).
    const PROMPT_FLAGS = ['--append-system-prompt', '--append-system-prompt-file']
    const withoutPrompt = (s: Spawned): string[] => s.argv.filter((_, i) => !PROMPT_FLAGS.includes(s.argv[i - 1]))
    for (const s of all) {
      expect(realpathSync(s.cwd)).toBe(realpathSync(checkout))
      expect(s.stdin).toBe('Review this pull request.')
      expect(s.argv).toContain('--restricted')
      expect(withoutPrompt(s)).toEqual(withoutPrompt(all[0]))
      expect(s.systemPrompt).toContain('You are the pull request reviewer.')
    }
  })

  // §8.3 point 1: each focus has its own soft budget and its own ceiling, the tier's — not a third of
  // it. Together they may spend the number of focuses times the tier's ceiling.
  it('gives every focus the tier’s own soft budget and ceiling', async () => {
    byFocus(THREE)
    const settings = settingsFixture({ tier: 'normal', budget: { targetUsd: 3, wrapUpAtUsd: 2.1, ceilingUsd: 7.5 } })
    await run({ input: inputFixture({ settings }) })
    const all = spawned()
    expect(all).toHaveLength(3)
    for (const s of all) {
      expect(argOf(s, '--max-budget-usd')).toBe('7.50')
      expect(s.systemPrompt).toContain('the budget for this review is about $3.00')
    }
  })

  it('keeps what a focus had written when its ceiling stopped it', async () => {
    byFocus(THREE)
    const security = (await run()).find((r) => r.lens === 'security')?.result
    expect(security?.failure).toEqual({ kind: 'budget', spentUsd: 5.0123004 })
    expect(security?.cutShort).toBe(true)
    expect(security?.output?.findings.map((f) => f.title)).toEqual([
      "The retry log line prints the request's Authorization header",
    ])
  })

  // §8.3 point 2: a reviewer that fails does not fail the review.
  it('goes on without a focus whose process crashed, and records how it ended', async () => {
    byFocus({ ...THREE, security: null })
    const runs = await run()
    const security = runs.find((r) => r.lens === 'security')?.result
    expect(security?.output).toBeNull()
    expect(security?.failure).toMatchObject({ kind: 'crashed', code: 1 })
    const combined = combineFocusRuns(runs)
    expect(combined.failure).toBeNull()
    expect(combined.output?.findings).toHaveLength(4)
  })

  it('goes on without a focus that could not start, names it, and throws only when none could', async () => {
    const failed: string[] = []
    const ok: EngineResult = { output: output([finding()]), usage: usage(1), cutShort: false, wrapUpFired: false, failure: null }
    const runs = await runFocusedReviews({
      input: inputFixture(), concurrency: 3,
      run: async (i) => {
        if (i.systemPrompt.includes('Your focus: impact')) throw new Error('spawn claude ENOENT')
        return ok
      },
      onFailure: (lens) => { failed.push(lens) },
    })
    expect(failed).toEqual(['impact'])
    expect(runs.find((r) => r.lens === 'impact')?.result).toMatchObject({
      output: null, failure: { kind: 'crashed', code: null, stderr: 'spawn claude ENOENT' },
    })
    expect(runs.filter((r) => r.result.output !== null)).toHaveLength(2)

    // Every focus failing to start is nothing having run at all: the first reason, as one reviewer gives it.
    await expect(runFocusedReviews({
      input: inputFixture(), concurrency: 3, run: async () => { throw new Error('ANTHROPIC_BASE_URL is set') },
    })).rejects.toThrow('ANTHROPIC_BASE_URL is set')
  })

  it('runs no more focuses at once than it is allowed, and every one of them', async () => {
    for (const concurrency of [1, 2, 3]) {
      let active = 0
      let most = 0
      const started: string[] = []
      const runs = await runFocusedReviews({
        input: inputFixture(), concurrency,
        run: async (i) => {
          active += 1
          most = Math.max(most, active)
          started.push(i.systemPrompt)
          await new Promise((r) => setTimeout(r, 10))
          active -= 1
          return { output: output([]), usage: usage(0.1), cutShort: false, wrapUpFired: false, failure: null }
        },
      })
      expect(most).toBe(concurrency)
      expect(started).toHaveLength(3)
      expect(runs).toHaveLength(3)
    }
  })

  it('refuses a concurrency that is not a whole number of at least one', async () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      await expect(run({ concurrency })).rejects.toThrow(TypeError)
    }
  })
})

describe('runFocusedReviews — stopping a review', () => {
  // Each child is killed by the signal it was started with: a review whose children outlived the stop
  // would keep paying for three answers nobody is waiting for.
  it('kills every focus that is running when the review is stopped', async () => {
    byFocus(THREE)
    process.env.FAKE_CLAUDE_SLEEP_MS = '8000'
    const ac = new AbortController()
    const began = Date.now()
    const p = run({ input: inputFixture({ signal: ac.signal }) })
    const waitForSpawns = async (n: number): Promise<void> => {
      while (recorded().length < n) await new Promise((r) => setTimeout(r, 20))
    }
    await waitForSpawns(3)
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
    // Long before any of the three would have finished on its own.
    expect(Date.now() - began).toBeLessThan(6000)
    expect(spawned()).toHaveLength(3)
  }, 15_000)

  it('starts no focus that was still waiting its turn', async () => {
    byFocus(THREE)
    process.env.FAKE_CLAUDE_SLEEP_MS = '8000'
    const ac = new AbortController()
    const p = run({ input: inputFixture({ signal: ac.signal }), concurrency: 1 })
    while (recorded().length < 1) await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
    // Give a wrongly started second focus the time to write its record.
    await new Promise((r) => setTimeout(r, 300))
    expect(spawned()).toHaveLength(1)
  }, 15_000)

  it('starts no further focus once the review is stopped, even when the running one finishes anyway', async () => {
    // A focus can come back with an answer in the instant the stop lands; the next must still not start.
    const ac = new AbortController()
    const run = vi.fn(async (): Promise<EngineResult> => {
      ac.abort(new Error('the review passed its deadline'))
      return { output: output([]), usage: usage(0.5), cutShort: false, wrapUpFired: false, failure: null }
    })
    await expect(runFocusedReviews({ input: inputFixture({ signal: ac.signal }), run, concurrency: 1 }))
      .rejects.toThrow('the review passed its deadline')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('hands back a review whose every focus had answered when the stop landed', async () => {
    // The same rule one reviewer gets: a finished review is published, stop or no stop.
    const ac = new AbortController()
    let calls = 0
    const runs = await runFocusedReviews({
      input: inputFixture({ signal: ac.signal }), concurrency: 3,
      run: async () => {
        calls += 1
        if (calls === 3) ac.abort()
        return { output: output([]), usage: usage(0.5), cutShort: false, wrapUpFired: false, failure: null }
      },
    })
    expect(runs).toHaveLength(3)
  })

  it('throws the stop, not a crash, when a focus ended because it was stopped', async () => {
    const ac = new AbortController()
    const run = vi.fn(async (i: EngineInput): Promise<EngineResult> => {
      ac.abort(new Error('the review was cancelled'))
      throw i.signal?.reason
    })
    await expect(runFocusedReviews({ input: inputFixture({ signal: ac.signal }), run, concurrency: 1 }))
      .rejects.toThrow('the review was cancelled')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

const usage = (costUsd: number): Usage => ({
  costUsd, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, turns: 4, durationMs: 60_000,
})
const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'src/retry.ts', line: 24, endLine: null, severity: 6, category: 'correctness',
  title: 'The computed delay is never used', explanation: 'e', evidence: ['src/retry.ts:24'], suggestion: null,
  ...over,
})
const output = (findings: Finding[], over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  summary: 'A summary.', intent: { verdict: 'matches', note: 'n' }, findings, inconclusive: [], ...over,
})
const answered = (lens: FocusRun['lens'], out: ReviewOutput, cost = 1, over: Partial<EngineResult> = {}): FocusRun => ({
  lens, result: { output: out, usage: usage(cost), cutShort: false, wrapUpFired: false, failure: null, ...over },
})
const silent = (lens: FocusRun['lens'], failure: EngineResult['failure'], cost = 0): FocusRun => ({
  lens, result: { output: null, usage: usage(cost), cutShort: failure?.kind === 'budget', wrapUpFired: false, failure },
})

describe('combineFocusRuns — the focuses as one review', () => {
  it('reports every focus’s findings, each tagged with the focus that found it, in focus order', () => {
    const r = combineFocusRuns([
      answered('intent', output([finding({ title: 'I1' }), finding({ title: 'I2' })])),
      answered('impact', output([finding({ title: 'M1', category: 'impact' })])),
      answered('security', output([finding({ title: 'S1', category: 'security' })])),
    ])
    expect(r.output?.findings.map((f) => [f.lens, f.title])).toEqual([
      ['intent', 'I1'], ['intent', 'I2'], ['impact', 'M1'], ['security', 'S1'],
    ])
  })

  it('takes the summary and the intent verdict from the intent focus, or from the first that answered', () => {
    const intent = output([], { summary: 'from intent', intent: { verdict: 'partial', note: 'half' } })
    const impact = output([], { summary: 'from impact', intent: { verdict: 'matches', note: 'all' } })
    expect(combineFocusRuns([answered('intent', intent), answered('impact', impact)]).output)
      .toMatchObject({ summary: 'from intent', intent: { verdict: 'partial' } })
    expect(combineFocusRuns([silent('intent', { kind: 'refusal' }), answered('impact', impact)]).output)
      .toMatchObject({ summary: 'from impact', intent: { verdict: 'matches' } })
  })

  it('says each question it could not settle once', () => {
    const q = { question: 'Does the service send Retry-After?', whatWouldSettleIt: 'its docs' }
    const r = combineFocusRuns([
      answered('intent', output([], { inconclusive: [q] })),
      answered('impact', output([], { inconclusive: [q, { question: 'Other?', whatWouldSettleIt: 'x' }] })),
    ])
    expect(r.output?.inconclusive.map((i) => i.question)).toEqual(['Does the service send Retry-After?', 'Other?'])
  })

  // §8.3 point 2, the rule the whole mode turns on.
  it('fails only when no focus produced anything, and then with the first focus’s failure', () => {
    const someAnswered = combineFocusRuns([
      silent('intent', { kind: 'crashed', code: 1, stderr: '' }),
      answered('impact', output([finding()])),
      silent('security', { kind: 'budget', spentUsd: 5.1 }, 5.1),
    ])
    expect(someAnswered.failure).toBeNull()
    expect(someAnswered.output?.findings).toHaveLength(1)
    expect(someAnswered.cutShort).toBe(true)

    const noneAnswered = combineFocusRuns([
      silent('intent', { kind: 'schema' }),
      silent('impact', { kind: 'refusal' }),
      silent('security', { kind: 'budget', spentUsd: 5.1 }, 5.1),
    ])
    expect(noneAnswered.output).toBeNull()
    expect(noneAnswered.failure).toEqual({ kind: 'schema' })
  })

  it('counts a focus cut short with partial findings as having answered', () => {
    const r = combineFocusRuns([
      silent('intent', { kind: 'crashed', code: 1, stderr: '' }),
      answered('security', output([finding({ category: 'security' })]), 5.01,
        { failure: { kind: 'budget', spentUsd: 5.01 }, cutShort: true }),
    ])
    expect(r.failure).toBeNull()
    expect(r.cutShort).toBe(true)
    expect(r.output?.findings[0]?.lens).toBe('security')
  })

  it('bills every focus, the ones that answered nothing included', () => {
    const r = combineFocusRuns([
      answered('intent', output([]), 0.71),
      answered('impact', output([]), 0.9),
      silent('security', { kind: 'budget', spentUsd: 5.01 }, 5.01),
    ])
    expect(r.usage.costUsd).toBeCloseTo(6.62, 6)
    expect(r.usage.turns).toBe(12)
    expect(r.usage.durationMs).toBe(180_000)
  })

  it('never takes a focus from the model’s own words', () => {
    // A model that writes `lens` into a finding is claiming a focus it was not given; the parser drops
    // the key, and only `combineFocusRuns` sets it.
    const parsed = parseReviewOutput({
      summary: 's', intent: { verdict: 'matches', note: 'n' }, inconclusive: [],
      findings: [{ file: 'a.ts', line: 1, severity: 9, category: 'security', title: 't', explanation: 'e', evidence: [], lens: 'security' }],
    })
    expect(parsed.findings[0]).not.toHaveProperty('lens')
  })
})

describe('focusRecords — what the record keeps of each focus (spec 0.2.0 §8.3 point 6)', () => {
  it('records each focus’s bill, whether it answered, whether a limit stopped it, its failure and its findings', () => {
    expect(focusRecords([
      answered('intent', output([finding(), finding()]), 0.71),
      answered('impact', output([]), 0.9),
      answered('security', output([finding()]), 5.01, { failure: { kind: 'budget', spentUsd: 5.01 }, cutShort: true }),
    ])).toEqual([
      { lens: 'intent', usage: usage(0.71), finished: true, cutShort: false, failure: null, findings: 2 },
      { lens: 'impact', usage: usage(0.9), finished: true, cutShort: false, failure: null, findings: 0 },
      { lens: 'security', usage: usage(5.01), finished: true, cutShort: true, failure: { kind: 'budget', spentUsd: 5.01 }, findings: 1 },
    ])
    expect(focusRecords([silent('impact', { kind: 'refusal' })])[0]).toMatchObject({ finished: false, findings: 0 })
  })
})

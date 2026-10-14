import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCheckPass } from './check-pass'
import type { EngineInput } from './engine'
import type { Finding } from './findings'
import { CHECK_DUPLICATES_TEXT } from './prompt'
import { fixturePath } from '../test/fixture'
import { inputFixture as baseInputFixture, settingsFixture } from '../test/helpers/engine-input'

/** The system prompt as the fake Claude received it: on the command line, or — on Windows, or past the
 *  length threshold — in the file `--append-system-prompt-file` named (spec 0.2.0 §9.3 P3). */
const systemPromptOf = (seen: { argv: string[]; systemPromptFile?: { text: string } | null }): string =>
  seen.argv.includes('--append-system-prompt')
    ? seen.argv[seen.argv.indexOf('--append-system-prompt') + 1]
    : seen.systemPromptFile?.text ?? ''

const fakeCli = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url))
let record: string
let checkout: string

// Same reason as engine-run.test.ts: Task 5's helper defaults `checkoutDir` to '/tmp/checkout',
// which does not exist, and `spawn` rejects with ENOENT on a missing `cwd` before the binary is
// ever reached. Every case here gets a real empty directory instead.
const inputFixture = (over: Partial<EngineInput> = {}): EngineInput =>
  baseInputFixture({ checkoutDir: checkout, ...over })

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'src/cache/lru.ts', line: 61, endLine: null,
  severity: 5, category: 'correctness', title: 'Overwriting a key does not refresh its recency',
  explanation: 'e', evidence: ['src/cache/lru.ts:61'], suggestion: null,
  ...over,
})

beforeEach(() => {
  record = join(mkdtempSync(join(tmpdir(), 'review-agent-')), 'record.json')
  checkout = mkdtempSync(join(tmpdir(), 'checkout-'))
  process.env.REVIEW_AGENT_CLAUDE_BIN = fakeCli
  process.env.FAKE_CLAUDE_RECORD = record
  process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/check-verdicts.json')
})
afterEach(() => {
  for (const k of ['REVIEW_AGENT_CLAUDE_BIN', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_FIXTURE']) {
    delete process.env[k]
  }
})

describe('runCheckPass', () => {
  it('returns the verdicts the verifier produced', async () => {
    const findings = Array.from({ length: 7 }, () => finding())
    const r = await runCheckPass({ findings, input: inputFixture() })
    expect(r.verdicts).toHaveLength(7)
    expect(r.verdicts.map((v) => v.verdict)).toEqual(
      ['uncertain', 'confirmed', 'confirmed', 'refuted', 'confirmed', 'confirmed', 'refuted'],
    )
    expect(r.verdicts[0].index).toBe(0)
    expect(r.verdicts[0].evidence.length).toBeGreaterThan(0)
    expect(r.usage.costUsd).toBeCloseTo(0.6282085, 6)
    expect(r.usage.turns).toBe(8)
  })

  it('sends the findings to the verifier, numbered from zero', async () => {
    await runCheckPass({ findings: [finding({ title: 'FIRST' }), finding({ title: 'SECOND' })], input: inputFixture() })
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    expect(seen.stdin).toContain('FIRST')
    expect(seen.stdin).toContain('SECOND')
    expect(seen.stdin).toContain('index = position in this list, from 0')
    const sys = systemPromptOf(seen)
    expect(sys).toContain('try to disprove each finding')
    // Same lock-down as the review itself: this pass also reads PR-authored code.
    expect(seen.argv).toContain('--restricted')
    expect(seen.argv).not.toContain('--safe-mode')
  })

  // Measured $0.07–0.63 against reviews of $0.88–1.67 (design §4.6, §8). The check is a fraction
  // of the review, and it must not be able to spend the review's whole budget a second time.
  it('runs on a fraction of the review budget', async () => {
    await runCheckPass({
      findings: [finding()],
      input: inputFixture({ settings: settingsFixture({ budget: { targetUsd: 2, wrapUpAtUsd: 1.4, ceilingUsd: 5 } }) }),
    })
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    expect(seen.argv[seen.argv.indexOf('--max-budget-usd') + 1]).toBe('1.25')
  })

  // Nothing to disprove: do not spawn, do not bill.
  it('spends nothing when there are no findings', async () => {
    const r = await runCheckPass({ findings: [], input: inputFixture() })
    expect(r.verdicts).toEqual([])
    expect(r.usage.costUsd).toBe(0)
    expect(existsSync(record)).toBe(false)
  })

  it('drops verdicts that point at a finding that does not exist', async () => {
    // A hand-made envelope: index 5 against 2 findings, and index 0 twice.
    const dir = mkdtempSync(join(tmpdir(), 'fx-'))
    const path = join(dir, 'bad-indexes.json')
    writeFileSync(path, JSON.stringify({
      type: 'result', subtype: 'success', terminal_reason: 'completed',
      total_cost_usd: 0.1, num_turns: 3, duration_ms: 1000,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      structured_output: { verdicts: [
        { index: 5, verdict: 'confirmed', severity: 8, reason: 'r', evidence: ['a:1'] },
        { index: 0, verdict: 'refuted', severity: 2, reason: 'first', evidence: ['a:1'] },
        { index: 0, verdict: 'confirmed', severity: 9, reason: 'second', evidence: ['a:1'] },
      ] },
    }))
    process.env.FAKE_CLAUDE_FIXTURE = path
    const r = await runCheckPass({ findings: [finding(), finding()], input: inputFixture() })
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0]).toMatchObject({ index: 0, reason: 'first' })
  })
})

/** The five findings `multi-check-duplicates.json` answers about: the union of three focuses, in
 *  focus order. The fourth is the first again, in the impact focus's words. */
const UNION: Finding[] = [
  finding({ file: 'src/retry.ts', line: 24, title: 'The computed delay is never passed to setTimeout', lens: 'intent' }),
  finding({ file: 'src/retry.ts', line: 13, category: 'intent', title: 'The description promises jitter that the code does not add', lens: 'intent' }),
  finding({ file: 'src/client.ts', line: 88, category: 'impact', title: 'Callers that catch HttpError no longer see the status code', lens: 'impact' }),
  finding({ file: 'src/retry.ts', line: 24, title: 'Retries fire back to back because setTimeout gets no delay', lens: 'impact' }),
  finding({ file: 'src/client.ts', line: 40, category: 'security', title: "The retry log line prints the request's Authorization header", lens: 'security' }),
]
const schemaOf = (seen: { argv: string[] }): string => seen.argv[seen.argv.indexOf('--json-schema') + 1]

// Spec 0.2.0 §8.3, decision §14.17: one check pass over the union of the focuses' findings, which also
// marks duplicates so the same problem found by two focuses is said once.
describe('runCheckPass — a multi-reviewer review', () => {
  beforeEach(() => { process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/multi-check-duplicates.json') })

  it('asks which findings repeat an earlier one, and reads the answer', async () => {
    const r = await runCheckPass({ findings: UNION, input: inputFixture(), focuses: 3 })
    expect(r.verdicts.map((v) => v.duplicateOf)).toEqual([null, null, null, 0, null])
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    expect(systemPromptOf(seen)).toContain(CHECK_DUPLICATES_TEXT)
    expect(JSON.parse(schemaOf(seen)).properties.verdicts.items.properties.duplicate_of).toEqual({ type: ['integer', 'null'] })
    // Each finding goes to the pass with the focus that found it.
    expect(seen.stdin).toContain('"lens": "impact"')
  })

  it('never asks a single reviewer’s check pass, and ignores a duplicate_of it volunteers', async () => {
    // The same envelope, every verdict carrying `duplicate_of`, answering a review by one reviewer.
    const r = await runCheckPass({ findings: UNION, input: inputFixture() })
    expect(r.verdicts).toHaveLength(5)
    for (const v of r.verdicts) expect(v).not.toHaveProperty('duplicateOf')
    const seen = JSON.parse(readFileSync(record, 'utf8'))
    expect(systemPromptOf(seen)).not.toContain('duplicate_of')
    expect(schemaOf(seen)).not.toContain('duplicate_of')
  })

  it('drops a duplicate_of that does not name an earlier finding, so two findings can never drop each other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-'))
    const path = join(dir, 'bad-duplicates.json')
    const v = (index: number, duplicate_of: unknown) => ({ index, verdict: 'confirmed', severity: 5, reason: 'r', evidence: [], duplicate_of })
    writeFileSync(path, JSON.stringify({
      type: 'result', subtype: 'success', terminal_reason: 'completed', total_cost_usd: 0.1, num_turns: 3, duration_ms: 1000,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      structured_output: { verdicts: [v(0, 1), v(1, 1), v(2, 9), v(3, 'zero'), v(4, 2), v(5, -1)] },
    }))
    process.env.FAKE_CLAUDE_FIXTURE = path
    const r = await runCheckPass({ findings: [...UNION, finding()], input: inputFixture(), focuses: 3 })
    // A later one, itself, out of range, not a number, negative: none of them is an earlier finding.
    expect(r.verdicts.map((x) => x.duplicateOf)).toEqual([null, null, null, null, 2, null])
  })

  // Spec 0.2.0 §8.3: the usual quarter of the tier's target, times the focuses that reported anything.
  it('runs on the usual check budget times the number of focuses that reported findings', async () => {
    const settings = settingsFixture({ budget: { targetUsd: 2, wrapUpAtUsd: 1.4, ceilingUsd: 5 } })
    const ceilingFor = async (focuses: number): Promise<string> => {
      await runCheckPass({ findings: UNION, input: inputFixture({ settings }), focuses })
      const seen = JSON.parse(readFileSync(record, 'utf8'))
      return seen.argv[seen.argv.indexOf('--max-budget-usd') + 1]
    }
    // $0.50 a focus as its target, and 2.5x that as the ceiling Claude Code is given.
    expect(await ceilingFor(3)).toBe('3.75')
    expect(await ceilingFor(2)).toBe('2.50')
    expect(await ceilingFor(1)).toBe('1.25')
    // Findings with no focus counted against them still get one focus's worth, never nothing.
    expect(await ceilingFor(0)).toBe('1.25')
  })
})

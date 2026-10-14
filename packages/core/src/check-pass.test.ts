import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCheckPass } from './check-pass'
import type { EngineInput } from './engine'
import type { Finding } from './findings'
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

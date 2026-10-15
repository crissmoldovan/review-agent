import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RETRY_FILE } from './fake-github'

/** Core's stand-in for the Claude Code CLI: it prints a fixture and records what it was started with
 *  — argv, stdin, working directory and its whole environment. Run as `claude.bin`, so every test
 *  here also proves the option reaches the engine. Never a model, never a credential that works. */
export const FAKE_CLAUDE = fileURLToPath(new URL('../../core/test/fake-claude.mjs', import.meta.url))

/** A recorded budget stop with no output at all (core's fixture, per-token API prices as measured). */
export const BUDGET_FAILURE = fileURLToPath(new URL('../../core/test/fixtures/cli/failure-budget.json', import.meta.url))

/** The check pass's system prompt opens with this (core's `checkPassSystemPrompt`). */
const CHECK_PROMPT = 'You are the verification pass'

/** Every variable this suite sets or must not inherit. A developer's own credential in the shell
 *  running the tests would otherwise be read as the default credential — never spent, the fake
 *  answers, but a test about "exactly one" would fail on a machine that has two. */
const CONTROLLED = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'REVIEW_AGENT_CLAUDE_BIN',
  'FAKE_CLAUDE_FIXTURE', 'FAKE_CLAUDE_FIXTURE_BY_PROMPT', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_RECORD_DIR',
  'FAKE_CLAUDE_SLEEP_MS', 'FAKE_CLAUDE_EXIT', 'FAKE_CLAUDE_STDERR',
] as const

/** Takes the controlled variables out of this process's environment, and returns what puts them back. */
export const isolateEnv = (): (() => void) => {
  const saved = new Map(CONTROLLED.map((k) => [k, process.env[k]]))
  for (const k of CONTROLLED) delete process.env[k]
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

type WireFinding = {
  file: string; line: number; severity: number; category: string; title: string; explanation: string
  evidence: string[]; suggestion: string | null
}

/** Four findings, each meant for a different fate once the check pass and the path check have read
 *  them: one said inline at the check's severity, one refuted, one said only in the summary (outside
 *  the diff, and lowered into the low band), and one about a file that is not in the checkout. */
export const FINDINGS: WireFinding[] = [
  { file: RETRY_FILE, line: 24, severity: 7, category: 'correctness', title: 'setTimeout ignores delayMs',
    explanation: 'The delay is computed and never passed.', evidence: [`${RETRY_FILE}:24`], suggestion: null },
  { file: RETRY_FILE, line: 5, severity: 5, category: 'correctness', title: 'retries is never validated',
    explanation: 'A negative count loops for ever.', evidence: [`${RETRY_FILE}:5`], suggestion: null },
  { file: RETRY_FILE, line: 10, severity: 4, category: 'intent', title: 'no jitter between attempts',
    explanation: 'The description promised jitter.', evidence: [`${RETRY_FILE}:10`], suggestion: null },
  { file: 'src/ghost.ts', line: 1, severity: 6, category: 'impact', title: 'a file the change never had',
    explanation: 'Points at a path that is not in the checkout.', evidence: [], suggestion: null },
]

const VERDICTS = [
  { index: 0, verdict: 'confirmed', severity: 6, reason: 'Line 24 passes no delay.', evidence: [`${RETRY_FILE}:24`] },
  { index: 1, verdict: 'refuted', severity: 2, reason: 'retries is validated by the caller.', evidence: [] },
  { index: 2, verdict: 'uncertain', severity: 3, reason: 'Whether jitter was meant here is unclear.', evidence: [] },
  { index: 3, verdict: 'confirmed', severity: 6, reason: 'As written.', evidence: [] },
]

/** A result document in the shape the CLI emits, minimal, written by hand: the figures are invented,
 *  labelled as per-token API prices because that is what the engine reads `total_cost_usd` as. */
const envelope = (structured: unknown, costUsd: number): string => JSON.stringify({
  type: 'result', subtype: 'success', terminal_reason: 'completed', is_error: false,
  num_turns: 9, duration_ms: 51_900, total_cost_usd: costUsd,
  usage: { input_tokens: 18, output_tokens: 3333, cache_read_input_tokens: 121_660, cache_creation_input_tokens: 19_864 },
  structured_output: structured,
})

export const REVIEW_COST_USD = 0.345
export const CHECK_COST_USD = 0.1131

export type Spawn = {
  argv: string[]; stdin: string; cwd: string; env: Record<string, string | undefined>
  startedAt: number; systemPrompt: string
}

/** Fixtures in a directory of their own, and the process environment the fake reads them through.
 *  `review`: the reviewer's answer — the four findings by default, or a file to print instead.
 *  `sleepMs`: how long every spawn holds before answering, for the abort and deadline cases. */
export const fakeClaude = (o: { findings?: WireFinding[]; summary?: string; review?: string; sleepMs?: number } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ra-sdk-claude-'))
  const records = join(dir, 'records')
  mkdirSync(records)
  const review = o.review ?? join(dir, 'review.json')
  if (o.review === undefined) {
    writeFileSync(review, envelope({
      summary: o.summary ?? 'Adds a retry with a delay.',
      intent: { verdict: 'matches', note: 'It does what the description says.' },
      findings: o.findings ?? FINDINGS, inconclusive: [],
    }, REVIEW_COST_USD))
  }
  const check = join(dir, 'check.json')
  writeFileSync(check, envelope({ verdicts: VERDICTS }, CHECK_COST_USD))

  process.env.FAKE_CLAUDE_FIXTURE = review
  process.env.FAKE_CLAUDE_FIXTURE_BY_PROMPT = JSON.stringify({ [CHECK_PROMPT]: check })
  process.env.FAKE_CLAUDE_RECORD_DIR = records
  if (o.sleepMs !== undefined) process.env.FAKE_CLAUDE_SLEEP_MS = String(o.sleepMs)

  return {
    dir,
    /** Every process the fake was started as, in the order they started. */
    spawns: (): Spawn[] => readdirSync(records)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(records, f), 'utf8')) as Spawn)
      .sort((a, b) => a.startedAt - b.startedAt),
    remove: (): void => { rmSync(dir, { recursive: true, force: true }) },
  }
}

export type FakeClaude = ReturnType<typeof fakeClaude>

/** Resolves once `n` processes have started, for a test that stops a review while its model runs. */
export const untilSpawned = async (claude: FakeClaude, n = 1): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (claude.spawns().length >= n) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`the fake Claude was never started ${n} time(s)`)
}

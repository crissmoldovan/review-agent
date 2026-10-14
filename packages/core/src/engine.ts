import { relative, resolve } from 'node:path'
import { spawnClaude } from './cli-process'
import type { ResolvedSettings } from './config'
import { parseReviewOutput } from './findings'
import type { ReviewOutput } from './findings'

export type EngineInput = {
  checkoutDir: string
  prompt: string
  systemPrompt: string
  settings: ResolvedSettings
  schema: object
  /** Resolved, real paths. Task 5b's `materialiseSkills` produces them; nothing here fetches. */
  skillDirs: string[]
  signal?: AbortSignal
}

export type Usage = {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turns: number
  durationMs: number
}

export type EngineFailure =
  | { kind: 'budget'; spentUsd: number }
  | { kind: 'schema' }
  | { kind: 'refusal' }
  | { kind: 'crashed'; code: number | null; stderr: string }
  /** The CLI ran and reported an error before the model produced anything: no login, an API error.
   *  Distinct from `refusal`, which means the model answered and declined. `message` is the CLI's own
   *  text (e.g. "Not logged in · Please run /login"), shown to the user because they can act on it. */
  | { kind: 'cli-error'; terminalReason: string; message: string }

export type EngineResult = {
  output: ReviewOutput | null
  usage: Usage
  cutShort: boolean
  wrapUpFired: boolean
  failure: EngineFailure | null
}

/** The only tools the reviewer ever gets (design §4.3). */
const TOOLS = 'Read,Grep,Glob'

const assertOutsideCheckout = (checkoutDir: string, dir: string): void => {
  const rel = relative(resolve(checkoutDir), resolve(dir))
  const inside = rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
  if (inside) {
    throw new Error(
      `skill dir must not be inside the checkout (design §4.7: skills come from the deployment, never from the reviewed code): ${dir}`,
    )
  }
}

const budgetNote = (i: EngineInput): string =>
  `\n\nBudget: the budget for this review is about $${i.settings.budget.targetUsd.toFixed(2)}. ` +
  `Read what you need and no more. If you have been exploring for a long time, stop opening new ` +
  `files and write up the findings you can already support with evidence you have read.`

export const buildArgv = (i: EngineInput): string[] => {
  for (const dir of i.skillDirs) assertOutsideCheckout(i.checkoutDir, dir)
  return [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools', TOOLS,
    '--allowedTools', TOOLS,
    '--model', i.settings.model,
    '--effort', i.settings.effort,
    '--max-budget-usd', i.settings.budget.ceilingUsd.toFixed(2),
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(i.schema),
    '--append-system-prompt', i.systemPrompt + budgetNote(i),
    ...i.skillDirs.flatMap((dir) => ['--plugin-dir', dir]),
  ]
}

const readResult = (envelope: unknown): {
  structured: unknown; terminalReason: string; subtype: string; isError: boolean; resultText: string
} => {
  const e = (envelope ?? {}) as Record<string, unknown>
  return {
    structured: e.structured_output,
    terminalReason: typeof e.terminal_reason === 'string' ? e.terminal_reason : '',
    subtype: typeof e.subtype === 'string' ? e.subtype : '',
    // The field to trust. A login failure arrives as subtype "success" with is_error true
    // (fixtures/cli/failure-not-logged-in.json, recorded 2026-09-13).
    isError: e.is_error === true,
    resultText: typeof e.result === 'string' ? e.result : '',
  }
}

const classify = (
  r: ReturnType<typeof readResult>, envelope: unknown, run: { exitCode: number | null; stderr: string }, usage: Usage,
): EngineFailure | null => {
  if (envelope === null) return { kind: 'crashed', code: run.exitCode, stderr: run.stderr }
  if (r.subtype === 'error_max_budget_usd') return { kind: 'budget', spentUsd: usage.costUsd }
  if (r.subtype === 'error_max_structured_output_retries') return { kind: 'schema' }
  // After the two specific subtypes, which carry is_error too. Anything else the CLI flags as an error
  // happened before or around the model, and must not fall through to "no output, so a refusal".
  if (r.isError) return { kind: 'cli-error', terminalReason: r.terminalReason, message: r.resultText }
  return null
}

export const runEngine = async (i: EngineInput): Promise<EngineResult> => {
  const run = await spawnClaude({
    argv: buildArgv(i), prompt: i.prompt, cwd: i.checkoutDir, signal: i.signal,
  })
  const read = readResult(run.envelope)
  const { structured, terminalReason } = read
  let failure = classify(read, run.envelope, run, run.usage)

  let output: ReviewOutput | null = null
  if (structured !== undefined && structured !== null) {
    try {
      output = parseReviewOutput(structured)
    } catch {
      // The CLI said the document validated; our own parse disagreed. Same class of problem as
      // error_max_structured_output_retries, so the same failure kind — the caller does not care
      // which side noticed.
      failure = failure ?? { kind: 'schema' }
    }
  } else if (failure === null) {
    // No structured output, no error subtype: the run finished by answering in prose instead of
    // in the schema. That is a refusal.
    failure = { kind: 'refusal' }
  }

  return {
    output,
    usage: run.usage,
    // A run that never started was not cut short: `cutShort` means the ceiling or a limit stopped a
    // review in progress, and a login failure reporting it would send someone looking at budgets.
    cutShort: terminalReason !== 'completed' && failure?.kind !== 'cli-error',
    // Always false, and it is not an oversight: nothing can fire. The spike of 2026-09-13
    // (docs/spikes/wrap-up.md) proved the delivery half works — a PostToolUse hook passed through
    // --settings survives --restricted and demonstrably puts text in front of the model — and then
    // found there is no spend to trigger it on. The hook event carries no cost, no usage and no
    // token count; --no-session-persistence means the transcript it points at is never written; and
    // in stream-json, total_cost_usd arrives only on the final result event, after the run is over.
    // So the soft target is advisory (see budgetNote above) and the hard ceiling keeps whatever was
    // produced (the budget branch of `classify`). Revisit when the CLI documents task budgets.
    wrapUpFired: false,
    failure,
  }
}

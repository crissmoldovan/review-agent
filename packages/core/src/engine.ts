import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInsideDir, spawnClaude, type CliRun } from './cli-process'
import type { ResolvedSettings } from './config'
import { parseReviewOutput } from './findings'
import type { ReviewOutput } from './findings'
import type { ClaudeRuntime } from './runtime'

export type EngineInput = {
  checkoutDir: string
  prompt: string
  systemPrompt: string
  settings: ResolvedSettings
  schema: object
  /** Resolved, real paths. Task 5b's `materialiseSkills` produces them; nothing here fetches. */
  skillDirs: string[]
  signal?: AbortSignal
  /** The credential, binary and passed-through variables for this review's Claude processes (spec
   *  0.2.0 §3.2). Carried to every pass — the check and re-check passes spread this input — so all
   *  three are billed to the same account and run the same binary. Absent: today's environment rules. */
  runtime?: ClaudeRuntime
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

const realpathOrSelf = (p: string): string => {
  try { return realpathSync(p) } catch { return p }
}

/** Compared as written AND resolved, and inside if either says so (spec 0.2.0 §9.3 P12).
 *  `materialiseSkills` hands back real paths, but a checkout made under macOS's `/var/folders` is
 *  `/private/var/folders` once resolved, so a skill symlinked into it compared lexically as outside
 *  it. Resolving alone is not enough either: a path that does not exist resolves to itself, and one
 *  side resolved against one side not is the same mismatch the other way round. */
const assertOutsideCheckout = (checkoutDir: string, dir: string): void => {
  if (isInsideDir(checkoutDir, dir) || isInsideDir(realpathOrSelf(checkoutDir), realpathOrSelf(dir))) {
    throw new Error(
      `skill dir must not be inside the checkout (design §4.7: skills come from the deployment, never from the reviewed code): ${dir}`,
    )
  }
}

const budgetNote = (i: EngineInput): string =>
  `\n\nBudget: the budget for this review is about $${i.settings.budget.targetUsd.toFixed(2)}. ` +
  `Read what you need and no more. If you have been exploring for a long time, stop opening new ` +
  `files and write up the findings you can already support with evidence you have read.`

/** Everything appended to Claude Code's own system prompt for one pass: the instructions, then this
 *  pass's budget sentence. One function, so the text on the command line and the text in the file
 *  (`systemPromptFile` below) cannot differ. */
const systemPromptText = (i: EngineInput): string => i.systemPrompt + budgetNote(i)

/** `systemPromptFile`: pass the system prompt as `--append-system-prompt-file <path>` instead of as
 *  text (spec 0.2.0 §9.3 P3). The caller writes the file; `runClaude` below is the one that does. */
export const buildArgv = (i: EngineInput, opts: { systemPromptFile?: string } = {}): string[] => {
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
    ...(opts.systemPromptFile === undefined
      ? ['--append-system-prompt', systemPromptText(i)]
      : ['--append-system-prompt-file', opts.systemPromptFile]),
    ...i.skillDirs.flatMap((dir) => ['--plugin-dir', dir]),
  ]
}

/** Longer than this, the system prompt goes through a file on every OS (spec 0.2.0 §9.3 P3, and the
 *  figure is the plan's). Windows caps a whole command line at 32,767 characters, and the system prompt
 *  is the one argument that grows with what a deployment and a repository add — up to 10,000
 *  characters each (`prompt.ts`), on top of the fixed rules. 16,000 is under half that cap, which
 *  leaves the rest of the line — the findings schema above all — its room. On Windows the file is used
 *  whatever the length; elsewhere the same threshold means a long set of instructions takes the same
 *  road on every OS, so the road Windows depends on is exercised everywhere. */
export const SYSTEM_PROMPT_FILE_THRESHOLD = 16_000

/** Where a pass's system prompt goes. Injected only by tests, which need the Windows answer on any OS. */
export type SystemPromptPlacement = { platform?: NodeJS.Platform; threshold?: number }

/** Starts one pass of Claude Code on `i` — the review, the check or the re-check — and is the only
 *  thing in this package that does: all three call it, so all three get the same flags (`buildArgv`),
 *  the same runtime and the same system-prompt placement.
 *
 *  The system prompt goes through a file on Windows, or when it is longer than
 *  `SYSTEM_PROMPT_FILE_THRESHOLD` (spec 0.2.0 §9.3 P3; S8 settled that Claude Code 2.1.258 accepts
 *  `--append-system-prompt-file`). The file is the deployment's and the repository's instructions, so
 *  it is private and short-lived: a fresh directory under the OS temp directory — `mkdtemp`, which
 *  creates it `0700` — never inside the checkout, where the model could be pointed at it, the file
 *  `0600`, and the directory removed when the pass ends, however it ends. */
export const runClaude = async (i: EngineInput, placement: SystemPromptPlacement = {}): Promise<CliRun> => {
  const spawnWith = (argv: string[]): Promise<CliRun> => spawnClaude({
    argv, prompt: i.prompt, cwd: i.checkoutDir, signal: i.signal,
    ...(i.runtime !== undefined && { runtime: i.runtime }),
  })
  const text = systemPromptText(i)
  const viaFile = (placement.platform ?? process.platform) === 'win32' ||
    text.length > (placement.threshold ?? SYSTEM_PROMPT_FILE_THRESHOLD)
  if (!viaFile) return spawnWith(buildArgv(i))

  const dir = await mkdtemp(join(tmpdir(), 'review-agent-prompt-'))
  try {
    // A deployment whose temp directory is inside the checkout would hand the model the file.
    if (isInsideDir(i.checkoutDir, dir) || isInsideDir(realpathOrSelf(i.checkoutDir), realpathOrSelf(dir))) {
      throw new Error(`the system prompt file would be inside the checkout of the code under review (${dir}); refusing to write it there`)
    }
    const file = join(dir, 'system-prompt.txt')
    // `wx`: the directory is brand new and this name must not already be there.
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return await spawnWith(buildArgv(i, { systemPromptFile: file }))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* best effort */ })
  }
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
  const run = await runClaude(i)
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
    // (a spike during development) proved the delivery half works — a PostToolUse hook passed through
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

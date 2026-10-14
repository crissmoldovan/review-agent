import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { Usage } from './engine'

export type CliRun = { envelope: unknown; usage: Usage; exitCode: number | null; stderr: string }

/** Where the Claude Code binary is, as an ABSOLUTE path that is not inside `avoidDir` — the checkout of
 *  the code under review.
 *
 *  Never a bare name. `spawn('claude')` hands the lookup to the OS, and on Windows the lookup searches
 *  the child's working directory BEFORE `PATH` (libuv, `deps/uv/src/win/process.c`: "look in cwd
 *  first, then scan path"). The working directory is the checkout, so a pull request that added
 *  `claude.exe` at its root would be run in place of Claude, with the model credential in its
 *  environment. POSIX does the same for an empty or `.` entry in `PATH`. So the lookup is done here,
 *  in the parent: only absolute `PATH` directories, never one inside the checkout, and an explicit
 *  `REVIEW_AGENT_CLAUDE_BIN` must be absolute and outside the checkout too.
 *
 *  On Windows only `claude.exe` is accepted — what Anthropic's native installer and WinGet put on
 *  `PATH`. An npm install there leaves `.cmd`/`.ps1` shims, which `spawn` cannot run without a shell
 *  (Node refuses `.cmd` since the April 2024 security release), and a shell is never used here: it
 *  would not escape the arguments, which carry a repository's own review instructions. */
export const resolveClaudeBinary = (a: {
  env: Record<string, string | undefined>
  avoidDir: string
  platform?: NodeJS.Platform
  isExecutableFile?: (path: string) => boolean
  realpath?: (path: string) => string
}): string => {
  const platform = a.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const isExecutableFile = a.isExecutableFile ?? executableFileTest(platform)
  const real = a.realpath ?? realpathOrSelf
  const avoid = real(path.resolve(a.avoidDir))
  const inside = (candidate: string): boolean => {
    const rel = path.relative(avoid, real(candidate))
    return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
  }

  const named = a.env.REVIEW_AGENT_CLAUDE_BIN
  if (named !== undefined && named !== '') {
    if (!path.isAbsolute(named)) {
      throw new Error('REVIEW_AGENT_CLAUDE_BIN must be an absolute path to the Claude Code binary; a relative one could resolve inside the code under review')
    }
    if (inside(named)) {
      throw new Error('REVIEW_AGENT_CLAUDE_BIN points inside the checkout of the code under review; refusing to run it')
    }
    return named
  }

  const names = platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const dir of pathEntries(a.env, platform)) {
    // '' and '.' — and any relative entry — would mean the working directory, which is the checkout.
    if (dir === '' || !path.isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (!isExecutableFile(candidate) || inside(candidate)) continue
      return candidate
    }
  }
  throw new Error(platform === 'win32'
    ? 'Claude Code was not found: no claude.exe in an absolute PATH directory. Install it with Anthropic\'s installer (irm https://claude.ai/install.ps1 | iex) or WinGet, or set REVIEW_AGENT_CLAUDE_BIN to the absolute path of claude.exe'
    : 'Claude Code was not found: no executable `claude` in an absolute PATH directory. Install Claude Code, or set REVIEW_AGENT_CLAUDE_BIN to its absolute path')
}

/** `PATH` as the platform spells it. On Windows the key may be `Path`, and a plain object copy of the
 *  environment loses `process.env`'s case-insensitivity there. */
const pathEntries = (env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] => {
  const key = platform === 'win32'
    ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
    : 'PATH'
  const value = key === undefined ? undefined : env[key]
  return (value ?? '').split(platform === 'win32' ? ';' : ':')
}

const executableFileTest = (platform: NodeJS.Platform) => (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false
    if (platform !== 'win32') accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const realpathOrSelf = (p: string): string => {
  try { return realpathSync(p) } catch { return p }
}

// Design §4.3: "the process environment holds only the model credential". A model that can Read
// files could otherwise read its own environment — which, in the App deployment, is where the
// GitHub installation token lives. Allow-list, never deny-list. `extra` is passed explicitly by
// the caller (Task 7's wrap-up variables), never harvested from process.env: nothing ambient can
// smuggle a value into the child by naming it right.
/** Every variable the reviewer's child process may see. It reads a pull request's code, so this list is
 *  a security boundary: design §4.3, "the model's process gets the model credential and nothing else".
 *  Exported so a test pins it — anything not here never reaches the child. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'LANG',
  // Criss, 2026-09-13. On macOS the Claude CLI finds a `claude` login in the keychain through USER;
  // without it the end-to-end run answered "Not logged in" for $0 and never reached the model. It is
  // the account name, not a secret, and the model has no shell and no file access outside the
  // checkout, so the keychain itself stays out of its reach.
  'USER',
  // The model credential, in whichever of the TWO kinds the deployment chose (Criss, 2026-09-14,
  // decision 10): an Anthropic API key, or a subscription token from `claude setup-token`.
  // ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL were here and are deliberately gone: a gateway
  // bearer token plus a base URL sends the reviewed pull request's code to a third party that
  // nothing in this product names, which is not one of the two kinds. spawnClaude refuses to start
  // at all when ANTHROPIC_BASE_URL is set (gatewayBaseUrlRefusal, below), so this is the quiet half
  // of a loud rule.
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]

/** Criss, 2026-09-14 (decision 10): the reviewer refuses to run when ANTHROPIC_BASE_URL is set.
 *  Not forwarding it (the allow-list above) is silent — an operator who pointed the CLI at a gateway
 *  would get a review from Anthropic and believe it came from somewhere else. One sentence, one
 *  place: spawnClaude uses it, `review-agent review` uses it before any GitHub call, and the
 *  trigger.dev task (plan 2, Task 13) imports it. Names the variable, never its value. */
export const gatewayBaseUrlRefusal = (env: Record<string, string | undefined>): string | null =>
  (env.ANTHROPIC_BASE_URL ?? '') === ''
    ? null
    : 'ANTHROPIC_BASE_URL is set: this reviewer sends the reviewed code only to Anthropic, with an ' +
      'Anthropic API key or a subscription token, and refuses to run pointed anywhere else. Unset it.'

export const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const k of CHILD_ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k]
  // Test-only seam: the fake CLI needs its own instructions. Never present in production because
  // nothing sets it there.
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_CLAUDE_')) env[k] = process.env[k]
  return { ...env, ...extra }
}

// Loose on purpose: the real document carries ~24 top-level keys (session_id, modelUsage,
// subagent_stats, ttft_ms …) and the CLI adds more between versions. A strict schema would turn
// a CLI upgrade into an outage. We validate only what we read.
const envelopeSchema = z.looseObject({
  total_cost_usd: z.number().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z.looseObject({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).optional(),
})

export const parseUsage = (envelope: unknown): Usage => {
  const e = envelopeSchema.safeParse(envelope)
  // One optional value, read with `?.` throughout. Do NOT reintroduce `const d = e.success ? e.data
  // : {}` with `'usage' in d ? …` narrowing: a z.looseObject's output carries an index signature,
  // so on the `{}` branch the `in` check widens to `unknown`, the union collapses to `unknown`, and
  // every field read below is an error under `strict`.
  const d = e.success ? e.data : undefined
  const u = d?.usage ?? {}
  return {
    costUsd: d?.total_cost_usd ?? 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    turns: d?.num_turns ?? 0,
    durationMs: d?.duration_ms ?? 0,
  }
}

export const spawnClaude = (a: {
  argv: string[]; prompt: string; cwd: string; signal?: AbortSignal
  extraEnv?: Record<string, string>
}): Promise<CliRun> =>
  new Promise((resolve, reject) => {
    // Before anything is spawned, so nothing is spent and nothing reaches a gateway.
    const refusal = gatewayBaseUrlRefusal(process.env)
    if (refusal !== null) { reject(new Error(refusal)); return }
    let bin: string
    try {
      bin = resolveClaudeBinary({ env: process.env, avoidDir: a.cwd })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    // A JavaScript entry point (`.js`, `.mjs`, `.cjs`) is run with this Node: Windows cannot start a
    // script by its shebang, and Claude Code's own npm package falls back to `node cli-wrapper.cjs`.
    // The path was resolved and checked above either way.
    const viaNode = /\.(c|m)?js$/i.test(bin)
    const child = spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...a.argv] : a.argv, {
      cwd: a.cwd,
      env: childEnv(a.extraEnv),
      signal: a.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      // No console window flashing up when the reviewer runs from a GUI app or a service on Windows.
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { out += c })
    child.stderr.on('data', (c: string) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => {
      // An abort kills the child, and Node then races an 'error' (AbortError) against this 'close'.
      // Deciding it here rather than relying on the order makes the abort result deterministic.
      if (a.signal?.aborted === true) {
        reject(a.signal.reason instanceof Error ? a.signal.reason : new Error('The operation was aborted'))
        return
      }
      let envelope: unknown = null
      try { envelope = JSON.parse(out) } catch { envelope = null }
      resolve({ envelope, usage: parseUsage(envelope), exitCode: code, stderr: err })
    })
    child.stdin.on('error', () => { /* the CLI may exit before reading it all */ })
    child.stdin.end(a.prompt)
  })

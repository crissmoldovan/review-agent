import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import type { Usage } from './engine'
import {
  credentialVariable, gatewayBaseUrlRefusal, MODEL_CREDENTIAL_VARS, type ClaudeRuntime,
} from './runtime'

export type CliRun = { envelope: unknown; usage: Usage; exitCode: number | null; stderr: string }

/** Is `candidate` the directory `dir`, or anywhere under it? By path alone; a caller that cares about
 *  symlinks resolves both first.
 *
 *  One test for every "outside the checkout" rule in this package (spec 0.2.0 §9.3 P12), because the
 *  hand-written ones got it wrong in both directions: `rel.startsWith('..')` calls a directory named
 *  `..skills` INSIDE the checkout outside it, and `!rel.startsWith('/')` calls a skill on another
 *  Windows drive — where `relative` returns the absolute `D:\skills` — inside. The path API is a
 *  parameter so the Windows answer can be tested on any OS. */
export const isInsideDir = (
  dir: string, candidate: string, path: typeof posix = nodePath,
): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(candidate))
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
}

/** The most the npm-stub check reads of any candidate. The stub is 500 bytes (verified 2026-10-14
 *  against `@anthropic-ai/claude-code` 2.1.300, whose `bin/claude.exe` is a shell script until the
 *  package's install script replaces it); the real binary is ~200 MB and is never read at all. */
const STUB_MAX_BYTES = 4096
/** The stub's own words: `Error: claude native binary not installed.` */
const STUB_TEXT = /native binary not installed/i

const stubMessage = (candidate: string, platform: NodeJS.Platform): string =>
  "Claude Code's native binary is not installed — npm skipped its install script. " +
  `${candidate} is the placeholder npm leaves in its place. Reinstall @anthropic-ai/claude-code with its ` +
  'install script allowed (npm 12 blocks dependency install scripts by default), or install Claude Code with ' +
  (platform === 'win32'
    ? "Anthropic's installer (irm https://claude.ai/install.ps1 | iex) or WinGet"
    : "Anthropic's installer (curl -fsSL https://claude.ai/install.sh | bash)") +
  ', or set REVIEW_AGENT_CLAUDE_BIN to the absolute path of the real binary'

/** Where the Claude Code binary is, as an ABSOLUTE path that is not inside `avoidDir` — the checkout of
 *  the code under review.
 *
 *  Never a bare name. `spawn('claude')` hands the lookup to the OS, and on Windows the lookup searches
 *  the child's working directory BEFORE `PATH` (libuv, `deps/uv/src/win/process.c`: "look in cwd
 *  first, then scan path"). The working directory is the checkout, so a pull request that added
 *  `claude.exe` at its root would be run in place of Claude, with the model credential in its
 *  environment. POSIX does the same for an empty or `.` entry in `PATH`. So the lookup is done here,
 *  in the parent: only absolute `PATH` directories, never one inside the checkout, and an explicit
 *  binary — `runtime.bin`, else `REVIEW_AGENT_CLAUDE_BIN` — must be absolute and outside the checkout
 *  too.
 *
 *  On Windows the binary is `claude.exe`, never a shim: an npm install puts only `.cmd`/`.ps1` shims on
 *  `PATH`, which `spawn` cannot run without a shell (Node refuses `.cmd` since the April 2024 security
 *  release), and a shell is never used here — it would not escape the arguments, which carry a
 *  repository's own review instructions (spec 0.2.0 §9.3 P2). So a directory holding `claude.cmd` is
 *  looked in for the native binary npm installed beside the shim: `node_modules\@anthropic-ai\
 *  claude-code\bin\claude.exe` under a global prefix, or under the `node_modules` a `.bin` sits in.
 *
 *  On every OS a candidate that is npm's placeholder for the binary — the package before its install
 *  script ran, which npm 12 no longer runs by default — is passed over, and reported by name when
 *  nothing else is found: running it fails with a message about npm, from inside a review. */
export const resolveClaudeBinary = (a: {
  env: Record<string, string | undefined>
  avoidDir: string
  /** `runtime.bin` (spec 0.2.0 §3.2): wins over REVIEW_AGENT_CLAUDE_BIN, by the same rules. */
  bin?: string
  platform?: NodeJS.Platform
  isExecutableFile?: (path: string) => boolean
  realpath?: (path: string) => string
  /** A file's text, when the file is no larger than `maxBytes`; otherwise, or when it cannot be read,
   *  null. The stub check reads through this and nothing else. */
  readSmallFile?: (path: string, maxBytes: number) => string | null
}): string => {
  const platform = a.platform ?? process.platform
  const path = platform === 'win32' ? win32 : posix
  const isExecutableFile = a.isExecutableFile ?? executableFileTest(platform)
  const real = a.realpath ?? realpathOrSelf
  const readSmallFile = a.readSmallFile ?? readSmallFileFromDisk
  const avoid = path.resolve(a.avoidDir)
  const avoidReal = real(avoid)
  // As written AND resolved, inside if either says so: a path that does not exist yet resolves to
  // itself, and on macOS the checkout under `/var/folders` resolves to `/private/var/folders`, so a
  // resolved-only comparison called a not-yet-existing file in the checkout "outside" it.
  const inside = (candidate: string): boolean =>
    isInsideDir(avoid, candidate, path) || isInsideDir(avoidReal, real(candidate), path)
  const isStub = (candidate: string): boolean =>
    STUB_TEXT.test(readSmallFile(candidate, STUB_MAX_BYTES) ?? '')

  const [named, label] = a.bin !== undefined && a.bin !== ''
    ? [a.bin, 'runtime.bin']
    : [a.env.REVIEW_AGENT_CLAUDE_BIN, 'REVIEW_AGENT_CLAUDE_BIN']
  if (named !== undefined && named !== '') {
    if (!path.isAbsolute(named)) {
      throw new Error(`${label} must be an absolute path to the Claude Code binary; a relative one could resolve inside the code under review`)
    }
    if (inside(named)) {
      throw new Error(`${label} points inside the checkout of the code under review; refusing to run it`)
    }
    if (isStub(named)) throw new Error(stubMessage(named, platform))
    return named
  }

  const candidatesIn = (dir: string): string[] => {
    if (platform !== 'win32') return [path.join(dir, 'claude')]
    const native = [path.join(dir, 'claude.exe')]
    if (!isExecutableFile(path.join(dir, 'claude.cmd'))) return native
    const inPackage = (modules: string): string =>
      path.join(modules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    native.push(inPackage(path.join(dir, 'node_modules')))
    const parent = path.dirname(dir)
    if (path.basename(dir).toLowerCase() === '.bin' && path.basename(parent).toLowerCase() === 'node_modules') {
      native.push(inPackage(parent))
    }
    return native
  }

  let stub: string | null = null
  for (const dir of pathEntries(a.env, platform)) {
    // '' and '.' — and any relative entry — would mean the working directory, which is the checkout.
    if (dir === '' || !path.isAbsolute(dir)) continue
    for (const candidate of candidatesIn(dir)) {
      if (!isExecutableFile(candidate) || inside(candidate)) continue
      // Passed over rather than refused: a real binary later on PATH is the one to run. Remembered,
      // so that when there is none the error names the actual problem instead of "not found".
      if (isStub(candidate)) { stub ??= candidate; continue }
      return candidate
    }
  }
  if (stub !== null) throw new Error(stubMessage(stub, platform))
  throw new Error(platform === 'win32'
    ? 'Claude Code was not found: no claude.exe in an absolute PATH directory, nor in the npm package beside a claude.cmd. Install it with Anthropic\'s installer (irm https://claude.ai/install.ps1 | iex) or WinGet, or set REVIEW_AGENT_CLAUDE_BIN to the absolute path of claude.exe'
    : 'Claude Code was not found: no executable `claude` in an absolute PATH directory. Install Claude Code, or set REVIEW_AGENT_CLAUDE_BIN to its absolute path')
}

/** At most `maxBytes` of a file, and only when the whole file fits: a size check first, so a 200 MB
 *  binary is never opened for reading. */
const readSmallFileFromDisk = (p: string, maxBytes: number): string | null => {
  try {
    if (statSync(p).size > maxBytes) return null
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const n = readSync(fd, buf, 0, maxBytes, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
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
  // at all when ANTHROPIC_BASE_URL is set (gatewayBaseUrlRefusal, in runtime.ts), so this is the
  // quiet half of a loud rule.
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  // Spec 0.2.0 §9.3 P7: paths and switches, not secrets. CLAUDE_CONFIG_DIR is where a relocated
  // Claude Code keeps its login and settings — without it a container or a second account answers
  // "Not logged in" — and USE_BUILTIN_RIPGREP=0 is how Claude Code on Alpine (musl) is told to use
  // the system's ripgrep, which its Grep tool needs. Neither moves the code anywhere or pays anybody.
  'CLAUDE_CONFIG_DIR', 'USE_BUILTIN_RIPGREP',
]

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/

/** Why a name `runtime.passEnv` asks for may never reach the child, or null when it may (spec 0.2.0
 *  §9.3 P8, decision §14.13: a deployment-named list, empty by default). The list is the deployment's
 *  to write, so these are the names no deployment gets to write into it — every one of them is a
 *  credential this product holds, or decides where the reviewed code goes. */
const passEnvRefusal = (name: string): string | null => {
  if (!VARIABLE_NAME.test(name)) return 'not a variable name'
  // The credential travels as `runtime.credential`, whose whole point is that nothing ambient rides
  // along with it; a base URL or gateway token is refused everywhere (decision 10, §14.5).
  if (name.startsWith('ANTHROPIC_') || name === 'CLAUDE_CODE_OAUTH_TOKEN') return 'a model credential or endpoint'
  // Spec 0.2.0 §2.3, "the reviewed code goes to Anthropic and nowhere else": these switch Claude Code
  // to another provider's endpoint, which is the base-URL refusal by another name.
  if (name.startsWith('CLAUDE_CODE_USE_')) return 'switches the model provider'
  // This product's own settings and secrets: the App's key and client id, the record callback's
  // secret, the skills download token. None is for the model, and the App key is the one secret the
  // whole design keeps out of everything (design §4.3).
  if (name.startsWith('REVIEW_AGENT_')) return "this product's own setting or secret"
  // Spec 0.2.0 §10: a GitHub token "is never ... given to the Claude process"; the runner's trigger.dev
  // key starts runs that spend money.
  if (name === 'GITHUB_TOKEN' || name === 'GH_TOKEN' || name === 'TRIGGER_SECRET_KEY') return 'a secret this product holds'
  return null
}

/** Throws, naming every refused entry, when `passEnv` asks for anything the child may never see.
 *  An entry that is not a variable name is COUNTED, not shown: the likeliest such entry is a value
 *  pasted where its name belonged, and an error message is a place a value must never go. */
const assertPassEnv = (names: readonly string[]): void => {
  const refused = names.flatMap((n) => {
    const why = passEnvRefusal(n)
    return why === null ? [] : [{ n, why }]
  })
  if (refused.length === 0) return
  const malformed = refused.filter((r) => r.why === 'not a variable name').length
  const named = refused.filter((r) => r.why !== 'not a variable name').map((r) => `${r.n} (${r.why})`)
  throw new Error(
    'runtime.passEnv names variables the Claude process may never see: ' +
    [...named, ...(malformed > 0 ? [`${malformed} ${malformed === 1 ? 'entry that is' : 'entries that are'} not a variable name (not shown, in case it is a value)`] : [])].join('; ') +
    '. Variables are passed by name, capitals, digits and underscores only.',
  )
}

/** The child's whole environment. Allow-listed, plus `runtime.passEnv` by name, plus `extra`.
 *
 *  When `runtime.credential` is given it is the ONLY credential the child sees (spec 0.2.0 §3.2): both
 *  credential variables are taken out of whatever the allow-list copied from this process, and the
 *  given one is put back — none at all for a `claude login`, which Claude Code finds for itself.
 *  Without it, the child gets whichever credential this process's environment holds, as before. */
export const childEnv = (extra: Record<string, string> = {}, runtime: ClaudeRuntime = {}): NodeJS.ProcessEnv => {
  const passEnv = runtime.passEnv ?? []
  assertPassEnv(passEnv)
  const env: NodeJS.ProcessEnv = {}
  for (const k of [...CHILD_ENV_ALLOWLIST, ...passEnv]) if (process.env[k] !== undefined) env[k] = process.env[k]
  // Test-only seam: the fake CLI needs its own instructions. Never present in production because
  // nothing sets it there.
  for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_CLAUDE_')) env[k] = process.env[k]
  const out: NodeJS.ProcessEnv = { ...env, ...extra }
  if (runtime.credential !== undefined) {
    // Read before anything is removed: an invalid credential throws with the environment untouched.
    const given = credentialVariable(runtime.credential)
    for (const k of MODEL_CREDENTIAL_VARS) delete out[k]
    if (given !== null) out[given.name] = given.value
  }
  return out
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
  runtime?: ClaudeRuntime
}): Promise<CliRun> =>
  new Promise((resolve, reject) => {
    // Before anything is spawned, so nothing is spent and nothing reaches a gateway. Asked of this
    // process's own environment even when the credential is passed explicitly and the child would
    // never see the variable (decision §14.5: refuse — the conservative reading of an operator who
    // set it believing the code goes there).
    const refusal = gatewayBaseUrlRefusal(process.env)
    if (refusal !== null) { reject(new Error(refusal)); return }
    let bin: string
    let env: NodeJS.ProcessEnv
    try {
      bin = resolveClaudeBinary({
        env: process.env, avoidDir: a.cwd,
        ...(a.runtime?.bin !== undefined && { bin: a.runtime.bin }),
      })
      // Built here, before the spawn, so a refused `passEnv` name or a malformed credential rejects
      // with nothing started.
      env = childEnv(a.extraEnv, a.runtime)
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
      env,
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

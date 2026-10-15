import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { UsageError } from './flags'

/** Where the GitHub token came from. Said out loud by `doctor` and by `review` — the source, never the
 *  token (spec 0.2.0 §5.3, §10). */
export type GitHubTokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh'
export type FoundToken = { token: string; source: GitHubTokenSource }

/** What `gh auth token --hostname <host>` answered. Everything that is not a token is a reason to move
 *  on to the next step, and is kept only so the message can say which. */
export type GhAnswer =
  | { kind: 'token'; token: string }
  | { kind: 'not-logged-in' }
  | { kind: 'not-installed' }
  /** It ran and failed some other way — timed out, crashed. The reason is this module's own words:
   *  gh's output is never quoted, because what it prints on stdout is the token. */
  | { kind: 'failed'; reason: string }

/** The GitHub CLI, as far as this command uses it. A parameter, so no test ever runs the real one. */
export type GhCli = {
  authToken: (host: string) => Promise<GhAnswer>
  /** `gh auth login --web --hostname <host>`, run interactively with this terminal. Its exit code, or
   *  null when it could not be started. */
  authLogin: (host: string) => Promise<number | null>
}

export type TokenLookup =
  | ({ kind: 'found' } & FoundToken)
  | { kind: 'none'; gh: Exclude<GhAnswer, { kind: 'token' }> }

/** The token, in the spec's order (spec 0.2.0 §5.3): `GITHUB_TOKEN`, then `GH_TOKEN`, each only when
 *  set and not empty, then the GitHub CLI's own login for this host. Asks nobody anything. */
export const findGitHubToken = async (a: {
  env: Record<string, string | undefined>; host: string; gh: GhCli
}): Promise<TokenLookup> => {
  // Empty counts as unset, as it does for every variable this product reads: `GITHUB_TOKEN=` in a CI
  // file is somebody clearing it, and an empty token would only fail later, at GitHub, as a 401.
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = a.env[name] ?? ''
    if (value !== '') return { kind: 'found', token: value, source: name }
  }
  const answer = await a.gh.authToken(a.host)
  return answer.kind === 'token'
    ? { kind: 'found', token: answer.token, source: 'gh' }
    : { kind: 'none', gh: answer }
}

/** What a token needs, said the way each kind of token is set up. */
export type TokenNeed = 'read' | 'post'

export const tokenNeeds = (need: TokenNeed, repo: string | null): string => {
  const on = repo === null ? 'on the repository' : `on ${repo}`
  return need === 'read'
    ? `Contents: Read and Pull requests: Read ${on} (a classic token: the repo scope, or none for a public repository)`
    : `Contents: Read, Pull requests: Read and Write, and Commit statuses: Write ${on} ` +
      '(a classic token: the repo scope, or public_repo for a public repository)'
}

/** Exactly what to set, for a person or a CI log with no terminal to ask on (spec 0.2.0 §5.3). Shared
 *  with `doctor`, which says the same thing as its fix. */
export const noTokenAdvice = (a: {
  host: string; gh: Exclude<GhAnswer, { kind: 'token' }>; need: TokenNeed; repo: string | null
}): string => {
  const ghSaid = a.gh.kind === 'not-installed'
    ? 'the GitHub CLI (gh) is not installed'
    : a.gh.kind === 'not-logged-in'
      ? `the GitHub CLI is not logged in to ${a.host}`
      : `\`gh auth token\` failed: ${a.gh.reason}`
  return `no GitHub token: GITHUB_TOKEN and GH_TOKEN are not set, and ${ghSaid}. ` +
    `Set GITHUB_TOKEN (or GH_TOKEN) to a token with ${tokenNeeds(a.need, a.repo)}, ` +
    `or log in with \`gh auth login --web --hostname ${a.host}\`.`
}

/** The token a review uses, or a UsageError saying exactly what to set (spec 0.2.0 §5.3).
 *
 *  Steps 1–3 are `findGitHubToken`. Step 4 happens only with a terminal a person is at: offer to run
 *  `gh auth login --web` for them — it opens a browser and they approve there, so no token is ever
 *  typed into this process — and ask `gh` again once it finishes. Without a terminal there is nobody
 *  to approve anything, so it stops at once, exit 2, with the advice above.
 *
 *  The token is returned, and that is all that happens to it here: never printed, never logged, never
 *  written anywhere. What the caller may do with it is build a GitHub client; the Claude process never
 *  sees it, because its environment is an allow-list that names no GitHub variable (core,
 *  `CHILD_ENV_ALLOWLIST`). */
export const resolveGitHubToken = async (a: {
  env: Record<string, string | undefined>
  host: string
  gh: GhCli
  need: TokenNeed
  repo: string
  /** A person is at a terminal to answer: stdin is a TTY. */
  interactive: boolean
  confirm: (question: string, signal?: AbortSignal) => Promise<boolean>
  stderr: (s: string) => void
  signal?: AbortSignal
}): Promise<FoundToken> => {
  const first = await findGitHubToken(a)
  if (first.kind === 'found') return { token: first.token, source: first.source }
  const advice = noTokenAdvice({ host: a.host, gh: first.gh, need: a.need, repo: a.repo })
  // Nothing to offer: no terminal, or no `gh` to run. A gh that failed oddly is not offered a login
  // either — logging in again does not mend a gh that times out.
  if (!a.interactive || first.gh.kind !== 'not-logged-in') throw new UsageError(advice)

  const login = `gh auth login --web --hostname ${a.host}`
  const yes = await a.confirm(
    `No GitHub token: GITHUB_TOKEN and GH_TOKEN are not set, and the GitHub CLI is not logged in to ${a.host}. ` +
    `Run \`${login}\` now? It opens your browser, and you approve there. [y/N]`,
    a.signal,
  )
  if (!yes) throw new UsageError(advice)
  const code = await a.gh.authLogin(a.host)
  if (code !== 0) {
    throw new UsageError(`\`${login}\` did not finish (${code === null ? 'it could not be started' : `exit ${code}`}); ${advice}`)
  }
  const second = await a.gh.authToken(a.host)
  if (second.kind !== 'token') throw new UsageError(noTokenAdvice({ host: a.host, gh: second, need: a.need, repo: a.repo }))
  a.stderr(`logged in: using the GitHub CLI's login for ${a.host}`)
  return { token: second.token, source: 'gh' }
}

/** How long `gh auth token` gets. It reads a file or the system keychain and answers at once; a gh
 *  that takes longer is stuck, and a review should say so rather than hang. */
export const GH_TIMEOUT_MS = 15_000

/** An executable called `name` (`name.exe` on Windows) in an ABSOLUTE `PATH` directory, or null.
 *
 *  Never the bare name, for the reason the Claude binary is never started by one (core, cli-process.ts,
 *  `resolveClaudeBinary`): on Windows a bare name is looked up in the working directory BEFORE `PATH`,
 *  and POSIX does the same for an empty or `.` entry. Somebody running this inside a clone of a
 *  repository they do not trust would otherwise run that repository's `gh.exe` — and hand it nothing
 *  less than a request for their GitHub token. */
export const findOnPath = (
  name: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (p: string) => boolean = executableTest(platform),
): string | null => {
  const path = platform === 'win32' ? win32 : posix
  // `Path` on Windows: a plain copy of the environment loses process.env's case-insensitivity there.
  const key = platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH'
  const dirs = (key === undefined ? '' : env[key] ?? '').split(platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, platform === 'win32' ? `${name}.exe` : name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

const executableTest = (platform: NodeJS.Platform) => (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false
    if (platform !== 'win32') accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The real GitHub CLI: started by absolute path, with no shell — the host is an argument, never
 *  command text — and the caller's own environment, which is where gh finds its configuration. */
export const liveGhCli = (env: Record<string, string | undefined>): GhCli => {
  // An empty GITHUB_TOKEN or GH_TOKEN is "unset" to this product (above); gh is not left to read it
  // differently.
  const ghEnv: NodeJS.ProcessEnv = { ...env }
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) if (ghEnv[k] === '') delete ghEnv[k]
  return {
    authToken: (host) => new Promise((resolve) => {
      const gh = findOnPath('gh', env)
      if (gh === null) { resolve({ kind: 'not-installed' }); return }
      execFile(gh, ['auth', 'token', '--hostname', host], {
        encoding: 'utf8', timeout: GH_TIMEOUT_MS, windowsHide: true, env: ghEnv,
      }, (error, stdout) => {
        if (error === null) {
          const token = stdout.trim()
          resolve(token === '' ? { kind: 'not-logged-in' } : { kind: 'token', token })
          return
        }
        const e = error as { killed?: boolean; code?: unknown }
        if (e.code === 'ENOENT') resolve({ kind: 'not-installed' })
        else if (e.killed === true) resolve({ kind: 'failed', reason: `it did not answer within ${GH_TIMEOUT_MS / 1000} seconds` })
        // gh exits 1 when it holds no token for the host ("no oauth token found"). Its message is not
        // quoted, on principle: this is the one command whose output is a credential.
        else if (e.code === 1) resolve({ kind: 'not-logged-in' })
        else resolve({ kind: 'failed', reason: `it exited with ${String(e.code)}` })
      })
    }),
    authLogin: (host) => new Promise((resolve) => {
      const gh = findOnPath('gh', env)
      if (gh === null) { resolve(null); return }
      // The terminal is handed over whole: gh prints a one-time code and opens the browser, and the
      // person approves there. Nothing of what it prints passes through this process.
      const child = spawn(gh, ['auth', 'login', '--web', '--hostname', host], { stdio: 'inherit', env: ghEnv })
      child.on('error', () => { resolve(null) })
      child.on('close', (code) => { resolve(code) })
    }),
  }
}

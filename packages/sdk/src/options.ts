import { isAbsolute } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, gatewayBaseUrlRefusal, modelCredentialFromEnv, SecretValue,
  type DeploymentConfig, type Effort, type ModelCredential, type ReportMode, type SeverityBands,
  type SkillSource, type Tier, type TierSettings,
} from '@review-agent/core'
import { DEFAULT_SESSION_DEADLINE_MS, octokitFor, type ReportWant, type ReviewAsk } from '@review-agent/github'
import type { ProgressEvent } from './progress'

/** How to reach GitHub (spec 0.2.0 §4.2): a token, from which a client is built with the API version
 *  every way in was proven against (`octokitFor`), or a client the host already has. `baseUrl` is a
 *  GitHub Enterprise Server's API root, `https://<host>/api/v3`; left out, github.com. */
export type GitHubAccess =
  | { token: string; baseUrl?: string }
  | { octokit: Octokit }

/** The model credential (spec 0.2.0 §2.3): an Anthropic API key — the normal path, and the only one
 *  for a service that reviews for other people — a subscription token from `claude setup-token`, for
 *  your own use, or this machine's `claude login`. A value may be passed already wrapped in a
 *  `SecretValue`; a bare string is wrapped on the way in, so nothing this package hands on prints it. */
export type CredentialOption =
  | { apiKey: string | SecretValue }
  | { oauthToken: string | SecretValue }
  | 'claude-login'

/** The deployment settings (docs/configuration.md in the repository), any of them left out — at any
 *  depth. `settings: { report: { checkRunName: 'review' } }` changes the one name and keeps
 *  every other report setting; see `mergeSettings` for why the merge goes exactly this deep.
 *
 *  Every `Partial<DeploymentConfig>` is one of these (spec 0.2.0 §4.2 names that type), so a host can
 *  pass a whole deployment object it already keeps. `command` and `autoReview` are read only by the
 *  App's receiver, and are accepted here and ignored. */
export type ReviewSettings = {
  command?: string
  model?: string
  effort?: Effort
  tiers?: { [T in Tier]?: Partial<TierSettings> }
  severity?: { bands?: Partial<SeverityBands>; postInlineAtOrAbove?: number }
  report?: Partial<DeploymentConfig['report']>
  skills?: SkillSource[]
  instructions?: string
  autoReview?: DeploymentConfig['autoReview']
  allowMulti?: boolean
}

/** What `authorize` is asked about, before anything is spent (spec 0.2.0 §4.2). It carries what
 *  `pushAccessOf` reads — `octokit`, `owner`, `repo`, `username` — so `authorize: pushAccessOf` is the
 *  App's own gate, as it is. */
export type AuthorizeRequest = {
  /** The client this review reads GitHub with. */
  octokit: Octokit
  owner: string
  repo: string
  pr: number
  /** `requestedBy`: the login whose request this is. */
  username: string
  /** The commit this review would read, as GitHub answered just now. */
  headSha: string
}

/** Several focused reviewers instead of one (spec 0.2.0 §8.3), and how many of them run at once: all
 *  three when `true`. Each is a Claude process of its own, and one review peaks around 400 MiB, so a
 *  host short of memory says `{ concurrency: 1 }`. */
export type MultiOption = boolean | { concurrency: number }

export type ReviewOptions = {
  /** The repository, `'owner/name'`. */
  repo: string
  /** The pull request's number. */
  pr: number
  github: GitHubAccess
  /** Left out: from this process's environment, exactly one of `ANTHROPIC_API_KEY` and
   *  `CLAUDE_CODE_OAUTH_TOKEN` (`modelCredentialFromEnv`, as the App's runner reads it). */
  credential?: CredentialOption
  /** Post the review, its inline comments and its summary, and report on the commit. Default `false`:
   *  review, return the result, and write nothing to GitHub at all. */
  post?: boolean
  /** How to report the outcome on the commit when posting (spec 0.2.0 §2.2). `'auto'`, the default:
   *  a check run when the token can create one, a commit status when it cannot. `'check-run'` with a
   *  token that cannot create one is a `failed` result before any money is spent. Read only when
   *  posting. */
  report?: ReportWant
  /** This request, as the CLI's flags say it; the settings' own when left out. */
  tier?: Tier
  effort?: Effort
  /** The model's name, e.g. `claude-opus-5`. */
  model?: string
  /** Run the disprove-it pass, whatever the tier says (`true`), or skip it (`false`). */
  check?: boolean
  /** Extra context for the reviewer. It is data, never instruction. */
  brief?: string
  /** Lower this review's budget, in US dollars at per-token API prices. It can never be raised past
   *  the tier's. */
  budgetUsd?: number
  multi?: MultiOption
  settings?: ReviewSettings
  /** Whose request this is: the login `authorize` is asked about, and `record.request.requestedBy`. */
  requestedBy?: string
  /** A gate asked after the pull request is read and before anything is downloaded or spent. `false`
   *  is a `refused` result. It must answer `true` or `false`; it needs `requestedBy`. */
  authorize?: (who: AuthorizeRequest) => boolean | Promise<boolean>
  /** Which Claude Code to run: an absolute path. Left out, `REVIEW_AGENT_CLAUDE_BIN`, else `claude`
   *  on `PATH`. */
  claude?: { bin?: string }
  /** Where checkouts go, each in a new directory of its own that is removed when the review ends.
   *  Absolute. Left out, the OS temp directory. */
  workDir?: string
  /** Where skills are cached. Absolute. Left out, this OS's cache directory. */
  skillCacheDir?: string
  /** The review stops itself this long after it starts — after the pull request has been read.
   *  Default 30 minutes. */
  deadlineMs?: number
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
}

/** Everything `reviewPullRequest` runs on, checked and settled. */
export type Normalised = {
  owner: string
  repo: string
  pr: number
  octokit: Octokit
  credential: ModelCredential
  post: boolean
  report: ReportWant
  ask: ReviewAsk
  deployment: DeploymentConfig
  requestedBy: string | null
  authorize: ((who: AuthorizeRequest) => boolean | Promise<boolean>) | null
  bin: string | null
  workDir: string | null
  skillCacheDir: string | null
  focusConcurrency: number | null
  deadlineMs: number
  signal: AbortSignal | null
  onProgress: ((event: ProgressEvent) => void) | null
}

// ── The closed vocabularies ──────────────────────────────────────────────────────────────────────
// Each a `Record` over the type, so adding a value to the type in core fails to compile here until
// it is added here too: a list that silently fell behind would refuse a valid option.

const TIER_SET: Record<Tier, true> = { basic: true, normal: true, thorough: true }
const EFFORT_SET: Record<Effort, true> = { low: true, medium: true, high: true, xhigh: true, max: true }
const MODE_SET: Record<ReportMode, true> = {
  'inline+summary': true, 'summary-only': true, 'check-only': true, silent: true,
}
const AUTO_REVIEW_SET: Record<DeploymentConfig['autoReview'], true> = { 'open+ready': true, off: true }
const REPORT_SET: Record<ReportWant, true> = { auto: true, 'check-run': true, 'commit-status': true, none: true }

const TIERS = Object.keys(TIER_SET) as Tier[]
const EFFORTS = Object.keys(EFFORT_SET) as Effort[]
const MODES = Object.keys(MODE_SET) as ReportMode[]
const AUTO_REVIEWS = Object.keys(AUTO_REVIEW_SET)
const REPORTS = Object.keys(REPORT_SET) as ReportWant[]

/** Every option `reviewPullRequest` takes. A key outside it is refused rather than ignored: a
 *  misspelt `credentials` would otherwise fall back to the environment's credential and bill an
 *  account nobody chose (spec 0.2.0 §2.3) — and a misspelt `post` would silently not post. */
const OPTION_KEYS: ReadonlySet<string> = new Set<keyof ReviewOptions>([
  'repo', 'pr', 'github', 'credential', 'post', 'report', 'tier', 'effort', 'model', 'check', 'brief',
  'budgetUsd', 'multi', 'settings', 'requestedBy', 'authorize', 'claude', 'workDir', 'skillCacheDir',
  'deadlineMs', 'signal', 'onProgress',
])

/** setTimeout's longest delay. Node sets any longer one to 1 ms, so a "very long" deadline would stop
 *  every review the moment it started. */
const MAX_DEADLINE_MS = 2_147_483_647

/** GitHub's own shapes: an owner is letters, digits and hyphens; a repository adds `.` and `_`. */
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A plain object — `{}` or `Object.create(null)` — the only kind the settings merge descends into. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!isRecord(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}

const oneOf = <T extends string>(name: string, v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new TypeError(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v) ?? String(v)}`)
  }
  return v as T
}

const nonEmptyString = (name: string, v: unknown): string => {
  if (typeof v !== 'string' || v === '') throw new TypeError(`${name} must be a non-empty string`)
  return v
}

const absolutePath = (name: string, v: unknown): string => {
  const s = nonEmptyString(name, v)
  // Refused rather than resolved against whatever directory the process started in: a relative
  // checkout directory, or Claude binary, could resolve somewhere nobody chose — for the binary,
  // inside the code under review (spec 0.2.0 §9.3 P1).
  if (!isAbsolute(s)) throw new TypeError(`${name} must be an absolute path, got ${JSON.stringify(s)}`)
  return s
}

const onlyKeys = (name: string, v: Record<string, unknown>, allowed: readonly string[]): void => {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new TypeError(`${name}.${k} is not an option; ${name} takes ${allowed.join(', ')}`)
  }
}

// ── Credentials ──────────────────────────────────────────────────────────────────────────────────

/** A credential value, wrapped. Never echoed in an error: the commonest wrong value here is a real
 *  key in the wrong place, and an error message is a place a key must never go. */
const secretOf = (name: string, v: unknown): SecretValue => {
  // By shape rather than `instanceof`: two copies of core in one install are two SecretValue classes,
  // and core's own check reads it the same way (`credentialVariable`).
  if (isRecord(v) && typeof (v as { reveal?: unknown }).reveal === 'function') {
    const s = v as unknown as SecretValue
    if (typeof s.reveal() !== 'string' || s.reveal() === '') throw new TypeError(`${name} is empty`)
    return s
  }
  if (typeof v !== 'string' || v === '') {
    throw new TypeError(`${name} must be a non-empty string or a SecretValue (its value is not shown)`)
  }
  return new SecretValue(v)
}

/** The model credential this review runs with, explicit whichever way it came: it travels to the
 *  Claude process as `runtime.credential` (spec 0.2.0 §3.2), so that process sees it and no other —
 *  never through `process.env`, where two reviews in one process would race on it.
 *
 *  A subscription token is wrapped and handed on unchanged, and nothing keeps it once the review
 *  returns: no module state, no cache (spec 0.2.0 §2.3 — Anthropic's terms forbid a product storing
 *  or intermediating one).
 *
 *  `ANTHROPIC_BASE_URL` set in this process refuses the review even when the credential is passed
 *  explicitly and the Claude process would never see the variable (decision §14.5: the conservative
 *  reading of an operator who set it believing the code goes there). */
export const credentialOf = (c: unknown, env: Record<string, string | undefined>): ModelCredential => {
  let credential: ModelCredential
  if (c === undefined) {
    // Exactly one, and no `claude login` (spec 0.2.0 §3.2): an SDK host is a service until it says
    // otherwise, and a login on a server is somebody's personal account paying for everybody's
    // reviews. Throws, naming variables and never a value — this also refuses the gateway.
    return modelCredentialFromEnv(env, { allowLogin: false })
  } else if (c === 'claude-login') {
    credential = { kind: 'claude-login' }
  } else if (isRecord(c)) {
    const keys = Object.keys(c)
    if (keys.length !== 1 || (keys[0] !== 'apiKey' && keys[0] !== 'oauthToken')) {
      throw new TypeError("credential must be exactly one of { apiKey }, { oauthToken } or 'claude-login'")
    }
    credential = keys[0] === 'apiKey'
      ? { kind: 'api-key', value: secretOf('credential.apiKey', c.apiKey) }
      : { kind: 'oauth-token', value: secretOf('credential.oauthToken', c.oauthToken) }
  } else {
    throw new TypeError("credential must be { apiKey }, { oauthToken } or 'claude-login'")
  }
  const gateway = gatewayBaseUrlRefusal(env)
  if (gateway !== null) throw new Error(gateway)
  return credential
}

// ── GitHub ───────────────────────────────────────────────────────────────────────────────────────

const octokitOf = (g: unknown): Octokit => {
  if (!isRecord(g)) throw new TypeError('github must be { token, baseUrl? } or { octokit }')
  if (Object.hasOwn(g, 'octokit')) {
    // Both would mean two answers to "who is this review": refuse rather than pick one.
    onlyKeys('github', g, ['octokit'])
    if (!isRecord(g.octokit) || typeof (g.octokit as { request?: unknown }).request !== 'function') {
      throw new TypeError('github.octokit must be an Octokit client')
    }
    return g.octokit as unknown as Octokit
  }
  onlyKeys('github', g, ['token', 'baseUrl'])
  // Never echoed, like a model credential: it is one.
  if (typeof g.token !== 'string' || g.token === '') {
    throw new TypeError('github.token must be a non-empty string (its value is not shown)')
  }
  if (g.baseUrl === undefined) return octokitFor({ token: g.token })
  const baseUrl = nonEmptyString('github.baseUrl', g.baseUrl)
  let protocol: string
  try { protocol = new URL(baseUrl).protocol } catch { throw new TypeError(`github.baseUrl must be a URL, got ${JSON.stringify(baseUrl)}`) }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new TypeError(`github.baseUrl must be an http(s) URL, got ${JSON.stringify(baseUrl)}`)
  }
  return octokitFor({ token: g.token, baseUrl })
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** Keys that are settings although the built-in defaults leave them out, and what they hold. */
const ABSENT_BY_DEFAULT: Readonly<Record<string, 'string'>> = { instructions: 'string' }

/** Settings whose value is one of a closed list. */
const ENUM_AT: Readonly<Record<string, readonly string[]>> = {
  effort: EFFORTS, 'report.mode': MODES, autoReview: AUTO_REVIEWS,
  'tiers.basic.effort': EFFORTS, 'tiers.normal.effort': EFFORTS, 'tiers.thorough.effort': EFFORTS,
}

/** Settings that may be null: the gate, off (`config.ts`). */
const NULLABLE_NUMBER_AT: ReadonlySet<string> = new Set(['report.failAtOrAbove'])

const leafOf = (base: unknown, over: unknown, path: string[]): unknown => {
  const at = path.join('.')
  const name = `settings.${at}`
  const allowed = ENUM_AT[at]
  if (allowed !== undefined) return oneOf(name, over, allowed)
  if (ABSENT_BY_DEFAULT[at] === 'string') {
    if (typeof over !== 'string') throw new TypeError(`${name} must be a string`)
    return over
  }
  if (NULLABLE_NUMBER_AT.has(at)) {
    if (over !== null && (typeof over !== 'number' || !Number.isFinite(over))) throw new TypeError(`${name} must be a number or null`)
    return over
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(over)) throw new TypeError(`${name} must be an array`)
    // A copy, so a host that changes its array later does not change a review already running.
    return [...over] as unknown
  }
  if (typeof base === 'number') {
    if (typeof over !== 'number' || !Number.isFinite(over)) throw new TypeError(`${name} must be a finite number`)
    return over
  }
  if (typeof over !== typeof base) throw new TypeError(`${name} must be a ${typeof base}`)
  return over
}

const mergeAt = (base: unknown, over: unknown, path: string[]): unknown => {
  if (over === undefined) return base
  if (isPlainObject(base)) {
    const name = path.length === 0 ? 'settings' : `settings.${path.join('.')}`
    if (!isPlainObject(over)) throw new TypeError(`${name} must be an object`)
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(over)) {
      const at = [...path, key]
      // Own keys only: a JSON `__proto__` key is not a setting, and is refused like any other typo.
      if (!Object.hasOwn(base, key) && !Object.hasOwn(ABSENT_BY_DEFAULT, at.join('.'))) {
        throw new TypeError(`settings.${at.join('.')} is not a setting`)
      }
      out[key] = mergeAt(base[key], value, at)
    }
    return out
  }
  return leafOf(base, over, path)
}

/** The deployment settings this review runs with: the built-in defaults (`defaultDeploymentConfig`),
 *  with the host's `settings` merged over them key by key, at every depth the defaults have —
 *  `report.checkRunName`, `tiers.normal.budgetUsd`, `severity.bands.high`. Arrays (`skills`) and
 *  plain values replace; `undefined` leaves the default; `null` is a value (`failAtOrAbove: null`
 *  is the gate off).
 *
 *  Why this deep and no deeper. A shallow spread would make `{ report: { checkRunName } }` drop every
 *  other report setting, so a host changing one name would have to restate the rest — and a restated
 *  default is frozen at the version it was copied from, missing every later change to it. Going
 *  deeper than the defaults' own objects, into `skills`, would make an entry impossible to remove:
 *  a list of allowed skill sources is replaced as a whole or not at all.
 *
 *  A key that is not a setting, or a value of the wrong type, throws (spec 0.2.0 §4.3: an option of
 *  the wrong type is a programmer's error). A JavaScript host with a misspelt `reprot` would otherwise
 *  get the defaults and never know. */
export const mergeSettings = (over: unknown): DeploymentConfig => {
  const base = defaultDeploymentConfig()
  if (over === undefined) return base
  return mergeAt(base, over, []) as DeploymentConfig
}

// ── Everything ───────────────────────────────────────────────────────────────────────────────────

/** Every option checked before anything is fetched or spent (spec 0.2.0 §4.3). A missing or
 *  wrong-typed option throws a `TypeError`; a process no review can run in — no model credential, two
 *  of them, or `ANTHROPIC_BASE_URL` set — throws an `Error`, as the CLI exits 2 for the same. Both
 *  are the programmer's or the operator's to fix, and the same on every call, so they are thrown
 *  rather than returned: a host's per-review outcome handling would otherwise log them as one bad
 *  pull request after another. */
export const normalise = (options: unknown, env: Record<string, string | undefined>): Normalised => {
  if (!isRecord(options)) throw new TypeError('reviewPullRequest takes one options object')
  for (const k of Object.keys(options)) {
    if (!OPTION_KEYS.has(k)) throw new TypeError(`${k} is not an option of reviewPullRequest`)
  }
  const o = options as Partial<Record<keyof ReviewOptions, unknown>>

  if (typeof o.repo !== 'string') throw new TypeError("repo must be 'owner/name'")
  const where = REPO.exec(o.repo)
  if (where === null || where[2] === '.' || where[2] === '..') {
    throw new TypeError(`repo must be 'owner/name', got ${JSON.stringify(o.repo)}`)
  }
  const [, owner, repo] = where as unknown as [string, string, string]
  if (typeof o.pr !== 'number' || !Number.isInteger(o.pr) || o.pr <= 0) {
    throw new TypeError(`pr must be a pull request number, got ${JSON.stringify(o.pr) ?? String(o.pr)}`)
  }
  if (o.github === undefined) throw new TypeError('github is required: { token, baseUrl? } or { octokit }')
  const octokit = octokitOf(o.github)

  if (o.post !== undefined && typeof o.post !== 'boolean') throw new TypeError('post must be true or false')
  const report = o.report === undefined ? 'auto' : oneOf('report', o.report, REPORTS)

  let focusConcurrency: number | null = null
  let multi = false
  if (o.multi !== undefined && o.multi !== false) {
    if (o.multi === true) {
      multi = true
    } else if (isRecord(o.multi)) {
      onlyKeys('multi', o.multi, ['concurrency'])
      const c = o.multi.concurrency
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) {
        throw new TypeError(`multi.concurrency must be a whole number of at least 1, got ${JSON.stringify(c) ?? String(c)}`)
      }
      multi = true
      focusConcurrency = c
    } else {
      throw new TypeError('multi must be true, false or { concurrency }')
    }
  }

  if (o.check !== undefined && typeof o.check !== 'boolean') throw new TypeError('check must be true or false')
  if (o.brief !== undefined && typeof o.brief !== 'string') throw new TypeError('brief must be a string')
  if (o.budgetUsd !== undefined && (typeof o.budgetUsd !== 'number' || !Number.isFinite(o.budgetUsd) || o.budgetUsd <= 0)) {
    throw new TypeError(`budgetUsd must be a positive number of US dollars, got ${JSON.stringify(o.budgetUsd) ?? String(o.budgetUsd)}`)
  }
  const requestedBy = o.requestedBy === undefined ? null : nonEmptyString('requestedBy', o.requestedBy)
  const ask: ReviewAsk = {
    ...(o.tier !== undefined && { tier: oneOf('tier', o.tier, TIERS) }),
    ...(o.effort !== undefined && { effort: oneOf('effort', o.effort, EFFORTS) }),
    ...(o.model !== undefined && { model: nonEmptyString('model', o.model) }),
    ...(o.check !== undefined && { check: o.check }),
    ...(o.brief !== undefined && { brief: o.brief }),
    ...(o.budgetUsd !== undefined && { budgetUsd: o.budgetUsd }),
    // Only `true` is carried, as `refuseUnbuilt` carries it: false and absent mean the same.
    ...(multi && { multi: true }),
    ...(requestedBy !== null && { requestedBy }),
  }
  const deployment = mergeSettings(o.settings)

  if (o.authorize !== undefined && typeof o.authorize !== 'function') throw new TypeError('authorize must be a function')
  // The gate is a question about a person. Asked about nobody, `pushAccessOf` would be asked about an
  // empty login — and a gate that cannot say who it let through is not one.
  if (o.authorize !== undefined && requestedBy === null) {
    throw new TypeError('authorize needs requestedBy: the login whose request it decides')
  }

  let bin: string | null = null
  if (o.claude !== undefined) {
    if (!isRecord(o.claude)) throw new TypeError('claude must be { bin? }')
    onlyKeys('claude', o.claude, ['bin'])
    if (o.claude.bin !== undefined) bin = absolutePath('claude.bin', o.claude.bin)
  }
  const workDir = o.workDir === undefined ? null : absolutePath('workDir', o.workDir)
  const skillCacheDir = o.skillCacheDir === undefined ? null : absolutePath('skillCacheDir', o.skillCacheDir)

  const deadlineMs = o.deadlineMs ?? DEFAULT_SESSION_DEADLINE_MS
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS) {
    throw new TypeError(`deadlineMs must be a positive number of milliseconds, at most ${MAX_DEADLINE_MS}, got ${JSON.stringify(o.deadlineMs) ?? String(o.deadlineMs)}`)
  }
  if (o.signal !== undefined) {
    const s = o.signal as { aborted?: unknown; addEventListener?: unknown }
    if (!isRecord(s) || typeof s.aborted !== 'boolean' || typeof s.addEventListener !== 'function') {
      throw new TypeError('signal must be an AbortSignal')
    }
  }
  if (o.onProgress !== undefined && typeof o.onProgress !== 'function') throw new TypeError('onProgress must be a function')

  // Last: everything above is the caller's to fix in code; this is the environment's.
  const credential = credentialOf(o.credential, env)

  return {
    owner, repo, pr: o.pr, octokit, credential, post: o.post ?? false, report, ask, deployment,
    requestedBy, authorize: (o.authorize as Normalised['authorize'] | undefined) ?? null,
    bin, workDir, skillCacheDir, focusConcurrency, deadlineMs: deadlineMs as number,
    signal: (o.signal as AbortSignal | undefined) ?? null,
    onProgress: (o.onProgress as Normalised['onProgress'] | undefined) ?? null,
  }
}

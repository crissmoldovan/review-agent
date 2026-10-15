import type { Octokit } from '@octokit/core'
import type { ReportMode, SeverityBands } from '@review-agent/core'
import { z } from 'zod'
import {
  completeCheckRun, conclusionFor, createCheckRun,
  type CheckConclusion, type CheckGate, type CheckOutcome,
} from './check-run'

/** How a review reports its outcome on the reviewed commit (spec 0.2.0 §2.2, §3.1). A check run when
 *  the token can create one — an App's installation token, or Actions' `GITHUB_TOKEN` with
 *  `checks: write` — and a commit status when it cannot: GitHub lets only Apps create check runs, so
 *  a person's token, classic or fine-grained, never can. Or nothing, when asked for nothing. */
export type ReportKind = 'check-run' | 'commit-status'

/** What every report needs, given once when it starts so that finishing it needs only the outcome. */
export type ReportStart = {
  octokit: Octokit
  owner: string
  repo: string
  headSha: string
  /** `report.checkRunName`: the check run's name, or the commit status's context. One setting for
   *  both, so a branch rule keyed on it means the same thing whichever kind reported. */
  name: string
  /** Carried on a check run — the App's Re-run button reads its settings back out of it. A commit
   *  status has nowhere to keep it, and does not. */
  externalId?: string
  /** What `conclusionFor` and the check run's output read (Criss, decisions 5, 6 and 7). */
  gate: CheckGate
  mode: ReportMode
  maxInline: number
  bands: SeverityBands
  /** Where a report that could not be written says so. A report never throws once started; this
   *  is how its failures stay visible. */
  log?: (message: string, fields: Record<string, unknown>) => void
}

export type ReportFinish = {
  outcome: CheckOutcome
  /** The summary comment's page, when there is one: a commit status links to it (spec 0.2.0 §14.2). */
  summaryUrl?: string | null
  /** The review was stopped by whoever ran it — Ctrl-C, an SDK host's signal — rather than failing
   *  on its own. A commit status says `error` for it (spec 0.2.0 §5.4); a check run has always said
   *  `neutral` for a cancelled run, and still does. */
  interrupted?: boolean
}

export interface ReportHandle {
  /** What actually reported: `reporterFor('auto')` can start as a check run and fall back to a status. */
  readonly kind: ReportKind
  /** The check run's id; null for a commit status, which a later status of the same context replaces
   *  and nothing needs to address again. */
  readonly id: number | null
  /** The check run's page; for a commit status, the summary comment it links to once finished. */
  readonly url: string | null
  /** At most once, and it never throws: a GitHub failure while closing the report must not turn a
   *  finished, paid-for review into a failed one. The conclusion a check run concludes with — for a
   *  commit status too, whose own state says it differently (`statusFor`) — or null when nothing
   *  was written. */
  finish(a: ReportFinish): Promise<CheckConclusion | null>
}

export interface Reporter {
  readonly kind: ReportKind | 'none'
  /** Opens the report — `in_progress`, or `pending` — before any model money is spent. It THROWS when
   *  GitHub refuses: a review whose report cannot exist is stopped while it has cost nothing, which is
   *  also how `'check-run'` with a token that cannot create one becomes an error before any money is
   *  spent (spec 0.2.0 §4.2). Null when there is nothing to report on. */
  start(a: ReportStart): Promise<ReportHandle | null>
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Octokit throws a RequestError carrying the HTTP status. Read narrowly, as post.ts does. */
const statusOf = (e: unknown): number | null =>
  typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number'
    ? (e as { status: number }).status
    : null

/** A logger that throws must not undo a report, let alone a review. */
const say = (s: ReportStart, message: string, fields: Record<string, unknown>): void => {
  try { s.log?.(message, fields) } catch { /* the log is the only thing lost */ }
}

/** The two GitHub calls a check-run report makes, as seams. The real ones when left out; the App's
 *  runner hands in the ones its own tests watch, so moving it onto this reporter (0.2.0 Stage 6)
 *  kept every assertion it already made about what a check run is created and completed with. */
export type CheckRunCalls = {
  createCheckRun?: typeof createCheckRun
  completeCheckRun?: typeof completeCheckRun
}

const checkRunHandle = (
  s: ReportStart, created: { id: number; url: string | null }, complete: typeof completeCheckRun,
): ReportHandle => {
  let finished = false
  return {
    kind: 'check-run',
    id: created.id,
    url: created.url,
    finish: async (f) => {
      if (finished) return null
      finished = true
      try {
        return await complete({
          octokit: s.octokit, owner: s.owner, repo: s.repo, checkRunId: created.id, outcome: f.outcome,
          // Both halves of the gate, together, and what checkRunOutput reads: annotations only in
          // check-only, capped at maxInline, and the bands the hidden verdict counts with.
          gate: s.gate, mode: s.mode, maxInline: s.maxInline, bands: s.bands,
        })
      } catch (e) {
        say(s, 'the check run could not be completed', { checkRunId: created.id, error: messageOf(e) })
        return null
      }
    },
  }
}

/** A check run, as the App has always reported (design §5). `onStarted` hears its id the moment it
 *  exists, before any model money is spent: the App's runner records it so a retried attempt can
 *  close the one this attempt opened (Criss, 2026-09-24). A failure in `onStarted` is logged and the
 *  review goes on — it is the caller's bookkeeping, not the review.
 *
 *  `statusIfRefused` is `reporterFor('auto')`'s: when GitHub answers the create with 403 — an Actions
 *  token without `checks: write`, or a token `tokenIdentityOf` misjudged — the report falls back to
 *  a commit status rather than stopping the review. Asked for explicitly (`'check-run'`), a refusal
 *  is an error instead (spec 0.2.0 §4.2). */
export const checkRunReporter = (o: {
  onStarted?: (checkRunId: number) => Promise<void>
  statusIfRefused?: boolean
  calls?: CheckRunCalls
} = {}): Reporter => ({
  kind: 'check-run',
  start: async (s) => {
    const create = o.calls?.createCheckRun ?? createCheckRun
    let created: { id: number; url: string | null }
    try {
      created = await create({
        octokit: s.octokit, owner: s.owner, repo: s.repo, headSha: s.headSha, name: s.name,
        ...(s.externalId !== undefined && { externalId: s.externalId }),
      })
    } catch (e) {
      if (o.statusIfRefused !== true || statusOf(e) !== 403) throw e
      say(s, 'this token cannot create a check run; reporting with a commit status instead', {
        repo: `${s.owner}/${s.repo}`, headSha: s.headSha.slice(0, 12),
      })
      return commitStatusReporter().start(s)
    }
    if (o.onStarted !== undefined) {
      try {
        await o.onStarted(created.id)
      } catch (e) {
        say(s, 'could not record the check run that was opened', { checkRunId: created.id, error: messageOf(e) })
      }
    }
    return checkRunHandle(s, created, o.calls?.completeCheckRun ?? completeCheckRun)
  },
})

/** The longest description a commit status is given: 140 characters, as the 0.2.0 plan fixes it
 *  (Stage 2, item 3), after GitHub's limit. NOT VERIFIED by a live call here that GitHub refuses a
 *  longer one rather than clipping it; clipped either way, because a refused final POST would leave
 *  the status `pending`, and a pending status blocks a merge that requires it. */
export const MAX_STATUS_DESCRIPTION_CHARS = 140

/** One line, at most 140 characters — counted in characters, not UTF-16 units, so an ellipsis never
 *  lands in the middle of one. A reason can carry a newline; a status description is one line. */
const clipDescription = (s: string): string => {
  const chars = Array.from(s.replace(/\s+/g, ' ').trim())
  return chars.length <= MAX_STATUS_DESCRIPTION_CHARS
    ? chars.join('')
    : `${chars.slice(0, MAX_STATUS_DESCRIPTION_CHARS - 1).join('')}…`
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

export type StatusState = 'pending' | 'success' | 'failure' | 'error'

/** What a commit status says for an outcome. Statuses have no `neutral` (spec 0.2.0 §14.2): a review
 *  that did not run — failed, refused, abandoned — reports `success`, as its check run concludes
 *  `neutral`, so an outage never blocks a merge; and the description says in so many words that it
 *  is not a verdict, so nobody reads a green tick as a clean review. A review stopped by whoever ran
 *  it reports `error` (§5.4), which a later run of the same context replaces. The gate decides
 *  `failure` exactly as it does for a check run, through the same `conclusionFor`. */
export const statusFor = (a: { outcome: CheckOutcome; gate: CheckGate; interrupted?: boolean }): {
  state: Exclude<StatusState, 'pending'>; description: string; conclusion: CheckConclusion
} => {
  const { outcome, gate } = a
  const conclusion = conclusionFor({ outcome, gate })
  // Only a review that did not finish was interrupted: one the stop landed on after it had finished
  // is published, and reports what it found.
  if (a.interrupted === true && outcome.kind !== 'reviewed') {
    return { state: 'error', conclusion, description: 'The review was interrupted before it finished. Run it again for a result.' }
  }
  switch (outcome.kind) {
    case 'reviewed': {
      const worst = outcome.findings.reduce((m, f) => Math.max(m, f.severity), 0)
      const said = outcome.findings.length === 0
        ? 'No findings'
        : `${plural(outcome.findings.length, 'finding')}, worst ${worst}/10`
      const gated = conclusion === 'failure' && gate.failAtOrAbove !== null
        ? `, at or above the gate of ${gate.failAtOrAbove}/10`
        : ''
      const cut = outcome.cutShort ? '; cut short by its budget ceiling' : ''
      return { state: conclusion === 'failure' ? 'failure' : 'success', conclusion, description: clipDescription(`${said}${gated}${cut}`) }
    }
    case 'failed':
      return { state: 'success', conclusion, description: clipDescription(`Not a verdict: the review did not finish — ${outcome.reason}`) }
    case 'refused':
      return { state: 'success', conclusion, description: clipDescription(`Not a verdict: no review was run — ${outcome.reason}`) }
    case 'abandoned':
      return { state: 'success', conclusion, description: 'Not a verdict: the review was stopped before it could report.' }
  }
}

const STARTED_DESCRIPTION = 'The review is running.'

/** Only an http(s) URL becomes a link on the commit. */
const linkable = (url: string | null | undefined): string | null =>
  typeof url === 'string' && /^https?:\/\//.test(url) ? url : null

/** A commit status: what a person's token, or a bot account's, can report (spec 0.2.0 §2.2). It needs
 *  push access, or `statuses: write`.
 *
 *  A SOFT gate, and every document that mentions it says so (§5.4): a branch rule cannot pin a status
 *  to this reviewer, so anyone with push access can set one with the same context. For a gate that
 *  holds, report with a check run, from the App or from Actions. */
export const commitStatusReporter = (): Reporter => ({
  kind: 'commit-status',
  start: async (s) => {
    const post = (state: StatusState, description: string, targetUrl: string | null) =>
      s.octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
        owner: s.owner, repo: s.repo, sha: s.headSha, state, context: s.name, description,
        ...(targetUrl !== null && { target_url: targetUrl }),
      })
    await post('pending', STARTED_DESCRIPTION, null)
    let finished = false
    let url: string | null = null
    return {
      kind: 'commit-status',
      id: null,
      get url() { return url },
      finish: async (f) => {
        if (finished) return null
        finished = true
        const { state, description, conclusion } = statusFor({
          outcome: f.outcome, gate: s.gate, ...(f.interrupted === true && { interrupted: true }),
        })
        const target = linkable(f.summaryUrl ?? (f.outcome.kind === 'reviewed' ? f.outcome.summaryUrl : null))
        try {
          await post(state, description, target)
          url = target
          return conclusion
        } catch (e) {
          say(s, 'the commit status could not be completed', {
            repo: `${s.owner}/${s.repo}`, headSha: s.headSha.slice(0, 12), error: messageOf(e),
          })
          return null
        }
      },
    }
  },
})

/** Reports nothing: `--report none`, or a review that only prints. */
export const noReporter: Reporter = { kind: 'none', start: async () => null }

/** Whose token this is, as far as reporting needs to know: a USER — a person, or a machine account —
 *  whose login is known, or an INSTALLATION — an App's token, or Actions' `GITHUB_TOKEN`, which is
 *  one (spec 0.2.0 §2.2). */
export type TokenIdentity =
  /** `scopes`: a classic token's scope NAMES, from the same answer's `x-oauth-scopes` header — what
   *  `review-agent doctor` says the token can reach (spec 0.2.0 §10). Names, never the token. Absent
   *  when GitHub sent no such header; NOT VERIFIED by a live call here that a fine-grained token is
   *  answered without one, so nothing decides anything on its absence. */
  | { kind: 'user'; login: string; scopes?: string[] }
  | { kind: 'installation' }

const UserSchema = z.object({ login: z.string().min(1) })

/** `"repo, read:org"` as `['repo', 'read:org']`; an empty header — a classic token with no scope —
 *  as `[]`; no header as null. */
const scopesOf = (headers: unknown): string[] | null => {
  const value = typeof headers === 'object' && headers !== null
    ? (headers as Record<string, unknown>)['x-oauth-scopes']
    : undefined
  if (typeof value !== 'string') return null
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

/** One read, and no write, decides it: `GET /user`. A user token is answered with the user, whose
 *  login the CLI needs anyway — to say who it will post as, and to find its own summary comment. An
 *  installation token is answered 403 ("Resource not accessible by integration"), because an
 *  installation is not a user.
 *
 *  Why this and not the alternatives, each considered: the token's prefix is the token, and this
 *  product never reads a token's text to decide anything; the environment (`GITHUB_ACTIONS`) is a
 *  guess the spec rules out (§2.2, §5.4), since a workflow can hold a person's token; trying to
 *  create a check run is a write, and `--post` asks before it writes; and `GET /installation/
 *  repositories` would say "installation" but give no login. NOT VERIFIED by a live call while this
 *  was written (2026-10-15): that GitHub answers an installation token here with 403 rather than
 *  another 4xx. A wrong answer costs a report, not a review — a token misjudged as an installation
 *  falls back to a commit status when its check run is refused (`statusIfRefused`).
 *
 *  401 (a bad or expired token), a 5xx, or a network failure is thrown: none of them is an answer
 *  about what the token is. */
export async function tokenIdentityOf(octokit: Octokit): Promise<TokenIdentity> {
  let res: { data: unknown; headers: unknown }
  try {
    res = await octokit.request('GET /user')
  } catch (e) {
    if (statusOf(e) === 403) return { kind: 'installation' }
    throw e
  }
  const scopes = scopesOf(res.headers)
  return { kind: 'user', login: UserSchema.parse(res.data).login, ...(scopes !== null && { scopes }) }
}

/** How to report, as a CLI flag or an SDK option says it (spec 0.2.0 §4.2, §5.2). */
export type ReportWant = 'auto' | 'check-run' | 'commit-status' | 'none'

const WANTS: readonly ReportWant[] = ['auto', 'check-run', 'commit-status', 'none']

/** The reporter a review should use. `'auto'` is a check run when the token can create one and a
 *  commit status when it cannot, decided from the token with ONE call to GitHub (`tokenIdentityOf`)
 *  — never from a guess about the environment (spec 0.2.0 §2.2). Pass `identity` when the caller has
 *  already asked, and no call is made at all. The other three are what they say, and make no call. */
export async function reporterFor(a: {
  octokit: Octokit
  want: ReportWant
  identity?: TokenIdentity
  onStarted?: (checkRunId: number) => Promise<void>
}): Promise<Reporter> {
  if (!WANTS.includes(a.want)) throw new TypeError(`report must be one of ${WANTS.join(', ')}, got ${JSON.stringify(a.want)}`)
  const started = a.onStarted === undefined ? {} : { onStarted: a.onStarted }
  switch (a.want) {
    case 'none': return noReporter
    case 'commit-status': return commitStatusReporter()
    case 'check-run': return checkRunReporter(started)
    case 'auto': {
      const identity = a.identity ?? await tokenIdentityOf(a.octokit)
      return identity.kind === 'user'
        ? commitStatusReporter()
        : checkRunReporter({ ...started, statusIfRefused: true })
    }
  }
}

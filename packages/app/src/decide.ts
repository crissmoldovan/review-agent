import { z } from 'zod'
import type { DeploymentConfig, Effort, ReviewRequest, Tier } from '@review-agent/core'
// RERUN_IDENTIFIER is imported, never redefined and never re-exported: Task 6 owns the string because
// Task 6 writes the button, and decide.test.ts imports it from the same place.
import {
  decodeRequestRefinement, encodeRequestRefinement, MARKER_OPEN, RERUN_IDENTIFIER, refuseUnbuilt,
} from '@review-agent/github'

// Re-exported from their new home, so the receiver's API is unchanged (0.2.0).
export { decodeRequestRefinement, encodeRequestRefinement }

/** Decision 4's refusals and the function every other doorway applies them with live in
 *  `@review-agent/github` since 0.2.0 (spec 0.2.0 §3.1), so the CLI and the SDK refuse exactly what
 *  this receiver refuses. Re-exported, so `@review-agent/app/receiver` still offers them. */
export { MULTI_REFUSED, MULTI_REFUSED_AUTOMATIC, THOROUGH_REFUSED, refuseUnbuilt } from '@review-agent/github'

export type WebhookDelivery = { event: string; payload: unknown }

export type Decision =
  | { kind: 'review'; request: ReviewRequest; installationId: number; refused?: string[] }
  | { kind: 'ignore'; why: string }

const ignore = (why: string): Decision => ({ kind: 'ignore', why })

/** An `issue_comment` payload has no head sha — the `issue` object carries URLs and nothing about
 *  the commit. The runner resolves it with `fetchPullRequest` before the review starts; until then
 *  the request says so in a word rather than carrying an empty string that looks like a sha. */
export const HEAD_SHA_UNRESOLVED = 'unresolved'

const Installation = z.object({ id: z.number().int().positive() })
const Repository = z.object({ full_name: z.string().min(1) })

const PullRequestEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  pull_request: z.object({
    number: z.number().int().positive(),
    draft: z.boolean().optional(), // absent on some payloads; absent means "not a draft"
    head: z.object({ sha: z.string().min(1) }),
  }),
})

const TIERS: readonly Tier[] = ['basic', 'normal', 'thorough']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The comment doorway takes the same flags as `review-agent review` (design §3: "It behaves like
 *  a command line because that is how it is invoked"), minus `--brief`: in a comment the free text
 *  IS the brief, and offering two ways to write it only invites a contradiction.
 *  A value that is not allowed is not used, and the review a person asked for still happens at
 *  the deployment's defaults — but it is NAMED in `refused`, never dropped in silence (Criss,
 *  2026-09-14, decision 4). That is the trap: a value this parser drops never reaches
 *  `resolveSettings`, so it can never land in `droppedRequestKeys`, and this list is the only way
 *  the summary (Task 3) can say so. `--multi` asks for the multi-reviewer mode (spec 0.2.0 §8.3,
 *  decision §14.16): the parser honours it, and a deployment that switched the mode off has it
 *  refused by `decideDelivery` and again by the runner, which also checks push access before anything
 *  is spent (§14.19). It was refused outright until 0.2.0 built the mode. `--tier thorough` was
 *  refused with it until 0.2.0, which made it one reviewer at `high` effort everywhere (§14.1), and is
 *  honoured like the other two tiers. */
export type CommandFlags = { request: Partial<ReviewRequest>; refused: string[] }

export function parseCommandFlags(rest: string): CommandFlags {
  const out: Partial<ReviewRequest> = {}
  const refused: string[] = []
  const notUsed = (flag: string, v: string): void => {
    refused.push(`\`${flag} ${v}\` — not a value this flag takes, so the deployment’s default was used.`)
  }
  const tokens = rest.split(/\s+/).filter((t) => t !== '')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? null : token.slice(eq + 1)
    const value = () => inline ?? (tokens[i + 1]?.startsWith('--') === false ? tokens[++i] : '')
    switch (name) {
      case '--tier': {
        const v = value()
        if ((TIERS as readonly string[]).includes(v)) out.tier = v as Tier
        else notUsed('--tier', v)
        break
      }
      case '--effort': { const v = value(); if ((EFFORTS as readonly string[]).includes(v)) out.effort = v as Effort; else notUsed('--effort', v); break }
      case '--model': { const v = value(); if (v !== '') out.model = v; break }
      case '--budget': { const v = value(); const n = Number(v); if (Number.isFinite(n) && n > 0) out.budgetUsd = n; else notUsed('--budget', v); break }
      case '--multi': out.multi = true; break
      case '--check': out.check = true; break
      case '--skip-check': out.check = false; break
      default: break // an unknown flag is free text as far as this parser is concerned
    }
  }
  return { request: out, refused }
}

/** The four flags `parseCommandFlags` reads a value for. Each consumes the token after it, unless
 *  that token is itself a flag or the value was given inline with `=`. */
const FLAGS_WITH_VALUE = new Set(['--tier', '--effort', '--model', '--budget'])

/** Every flag `parseCommandFlags` has a case for. Only these are consumed. A word that merely
 *  starts with `--` stays in the brief, exactly as the parser's default branch leaves it: a person
 *  who wrote `--verbose` gets their word back in the brief rather than having it vanish. */
const KNOWN_FLAGS = new Set(['--tier', '--effort', '--model', '--budget', '--check', '--skip-check', '--multi'])

/** The words the flags did not consume, plus every line after the first, are the brief. */
const splitCommand = (rest: string): { flags: Partial<ReviewRequest>; refused: string[]; brief: string } => {
  const [first = '', ...tail] = rest.split('\n')
  const { request: flags, refused } = parseCommandFlags(first)
  const consumed = new Set<string>()
  const tokens = first.split(/\s+/).filter((t) => t !== '')
  for (let i = 0; i < tokens.length; i++) {
    if (!KNOWN_FLAGS.has(tokens[i].split('=')[0])) continue
    consumed.add(String(i))
    if (!tokens[i].includes('=') && tokens[i + 1]?.startsWith('--') === false && FLAGS_WITH_VALUE.has(tokens[i])) {
      consumed.add(String(i + 1))
      i++
    }
  }
  const words = tokens.filter((_, i) => !consumed.has(String(i)))
  return { flags, refused, brief: [words.join(' '), ...tail].join('\n').trim() }
}

const CheckRunEvent = z.object({
  action: z.string(),
  requested_action: z.object({ identifier: z.string() }).optional(),
  installation: Installation,
  repository: Repository,
  sender: z.object({ login: z.string() }).optional(),
  check_run: z.object({
    id: z.number().int().positive(),
    head_sha: z.string().min(1).optional(),
    external_id: z.string().nullable().optional(),
    pull_requests: z.array(z.object({ number: z.number().int().positive() })).optional(),
  }),
})

const IssueCommentEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  issue: z.object({
    number: z.number().int().positive(),
    // The documented test for "is this a pull request": a plain issue has no such key.
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    user: z.object({ login: z.string(), type: z.string().optional() }).optional(),
  }),
})

const commandMatch = (body: string, command: string): string | null => {
  const text = body.trimStart()
  if (text.slice(0, command.length).toLowerCase() !== command.toLowerCase()) return null
  const rest = text.slice(command.length)
  // A whole word: `/reviewer please` is not `/review`.
  if (rest !== '' && !/^\s/.test(rest)) return null
  return rest
}

/** Design §5: "Release-only PRs — those touching just version, changelog or lock files — get no
 *  automatic review, and can still be reviewed on request." Exactly these count, matched on the
 *  path's last segment unless the pattern says otherwise:
 *    lock files      — the manifests below, by name
 *    changelogs      — CHANGELOG / CHANGES / HISTORY / RELEASES / RELEASE-NOTES, any of .md .markdown .txt .rst, or bare
 *    version files   — package.json, VERSION, version.txt, and a .changeset/*.md entry
 *  `package.json` is in the list with its eyes open: a version bump lives there, and without it the
 *  rule would do nothing for the ecosystem this product is written in. The price is that a
 *  dependency bump touching only `package.json` and a lock file gets no AUTOMATIC review. It still
 *  gets one for the asking, and one other changed file disarms the whole rule. */
const LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'Pipfile.lock',
])
const VERSION_FILES = new Set(['package.json', 'VERSION', 'version.txt'])
const CHANGELOG = /^(changelog|changes|history|releases|release-notes)(\.(md|markdown|txt|rst))?$/i
const CHANGESET = /^\.changeset\/[^/]+\.md$/

const isReleasePath = (path: string): boolean => {
  const name = path.split('/').pop() ?? path
  return LOCK_FILES.has(name) || VERSION_FILES.has(name) || CHANGELOG.test(name) || CHANGESET.test(path)
}

export const isReleaseOnly = (paths: string[]): boolean => paths.length > 0 && paths.every(isReleasePath)

/** Automatic means nobody asked: `requestId` is set by the comment doorway and the re-run button
 *  and by nothing else (design §3). */
export const isAutomatic = (r: ReviewRequest): boolean => r.requestId === undefined

/** The `pull_request` webhook carries counts and no file list, so this cannot be decided inside
 *  `decideDelivery`. The runner calls it after `fetchPullRequest` (Task 13). The rule lives here
 *  because here is where every other "should this be a review" question is answered and tested. */
export const skipAsReleaseOnly = (a: { request: ReviewRequest; changedPaths: string[] }): boolean =>
  isAutomatic(a.request) && isReleaseOnly(a.changedPaths)

export function decideDelivery(a: { delivery: WebhookDelivery; deployment: DeploymentConfig }): Decision {
  const { delivery, deployment } = a
  if (delivery.event === 'pull_request') {
    const parsed = PullRequestEvent.safeParse(delivery.payload)
    if (!parsed.success) return ignore('a pull_request delivery without the fields a review needs')
    const e = parsed.data
    if (deployment.autoReview === 'off') return ignore(`autoReview is off; ${e.action} starts no review`)
    if (e.action === 'opened' && e.pull_request.draft === true) {
      return ignore('opened as a draft; the review waits for ready_for_review (design §5)')
    }
    // Design §5: on open, or on first leaving draft. Never on a push — `synchronize` is the push,
    // and reviewing every push is the behaviour the design explicitly refuses.
    if (e.action !== 'opened' && e.action !== 'ready_for_review') {
      return ignore(`pull_request.${e.action} is not a trigger (design §5)`)
    }
    // Never `multi`, and no flag can put it here: an automatic review is paid for on nobody's say-so,
    // so it runs one reviewer (spec 0.2.0 §8.3 point 5, decision §14.19). The runner refuses one
    // anyway, should a payload built by hand arrive with it.
    return {
      kind: 'review',
      installationId: e.installation.id,
      request: {
        repo: e.repository.full_name,
        pr: e.pull_request.number,
        headSha: e.pull_request.head.sha,
      },
    }
  }
  if (delivery.event === 'issue_comment') {
    const parsed = IssueCommentEvent.safeParse(delivery.payload)
    if (!parsed.success) return ignore('an issue_comment delivery without the fields a review needs')
    const e = parsed.data
    if (e.action !== 'created') return ignore(`issue_comment.${e.action} starts no review`)
    if (e.issue.pull_request === undefined || e.issue.pull_request === null) {
      return ignore('a comment on a plain issue, not a pull request')
    }
    // Two independent guards against the loop. (a) is the one the design relies on: the marker is
    // a string this product controls, where the `<slug>[bot]` login convention is NOT verified.
    // (b) is belt and braces on a field the research pack does not verify either, so it is
    // optional in the schema and can only ever make the decision more conservative.
    if (e.comment.body.includes(MARKER_OPEN)) return ignore('a comment carrying this App own review marker')
    if (e.comment.user?.type === 'Bot') return ignore('a comment written by a Bot account')
    const rest = commandMatch(e.comment.body, deployment.command)
    if (rest === null) return ignore('a pull request comment that does not start with the command')
    const split = splitCommand(rest)
    // Decision 4 for the one flag a deployment can switch off: `--multi` with `allowMulti: false`
    // (spec 0.2.0 §14.19) is taken off here and named, so the payload never asks for what this
    // deployment does not run.
    const allowed = refuseUnbuilt(split.flags, { allowMulti: deployment.allowMulti })
    const flags = allowed.request
    const refused = [...split.refused, ...allowed.refused]
    const { brief } = split
    return {
      kind: 'review',
      installationId: e.installation.id,
      // On the decision, never inside `request`: an automatic review, and a comment with nothing
      // refused, carry no extra key (Criss, 2026-09-14, decision 4).
      ...(refused.length > 0 && { refused }),
      request: {
        ...flags,
        repo: e.repository.full_name,
        pr: e.issue.number,
        headSha: HEAD_SHA_UNRESOLVED,
        ...(e.comment.user !== undefined && { requestedBy: e.comment.user.login }),
        // Design §3: the comment id, "so asking twice always runs".
        requestId: String(e.comment.id),
        ...(brief !== '' && { brief }),
      },
    }
  }
  if (delivery.event === 'check_run') {
    const parsed = CheckRunEvent.safeParse(delivery.payload)
    if (!parsed.success) return ignore('a check_run delivery without the fields a review needs')
    const e = parsed.data
    if (e.action !== 'requested_action') return ignore(`check_run.${e.action} starts no review`)
    if (e.requested_action?.identifier !== RERUN_IDENTIFIER) {
      return ignore(`check_run action ${JSON.stringify(e.requested_action?.identifier ?? null)} is not the re-run button`)
    }
    const pr = e.check_run.pull_requests?.[0]?.number
    if (pr === undefined) return ignore('the re-run button was pressed on a check run with no pull request')
    // Decision 4: a Re-run repeats the settings it carried — `multi` among them, since a button press
    // is a request like a comment (spec 0.2.0 §14.19) — except what this deployment does not allow.
    const carried = refuseUnbuilt(decodeRequestRefinement(e.check_run.external_id) ?? {}, {
      allowMulti: deployment.allowMulti,
    })
    return {
      kind: 'review',
      installationId: e.installation.id,
      ...(carried.refused.length > 0 && { refused: carried.refused }),
      request: {
        ...carried.request,
        repo: e.repository.full_name,
        pr,
        headSha: e.check_run.head_sha ?? HEAD_SHA_UNRESOLVED,
        ...(e.sender !== undefined && { requestedBy: e.sender.login }),
        // A button press is an explicit request, so it carries a requestId and is never collapsed
        // into an earlier automatic review of the same sha (Task 11's idempotency key).
        requestId: `rerun:${e.check_run.id}`,
      },
    }
  }
  return ignore(`${delivery.event} is not an event this App acts on`)
}

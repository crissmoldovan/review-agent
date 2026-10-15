import type { Octokit } from '@octokit/core'
import { z } from 'zod'
import type { DeploymentConfig, Finding, ReportMode, Tier } from '@review-agent/core'
import { findingId } from './marker'

/** design §5: "The check-run 'Re-run' button repeats the last request". GitHub sends the click
 *  back as a `check_run.requested_action` webhook carrying `requested_action.identifier`, so this
 *  string is the entire contract between the button and the delivery decision (Task 10). */
export const RERUN_IDENTIFIER = 'rerun'

/** GitHub's documented caps on `actions[]`. Over any of them the call is a 422; under the count
 *  cap but over a length, the button silently never appears. Exported so the test can assert
 *  against the numbers rather than against a copy of them. */
export const CHECK_ACTION_LIMITS = {
  actions: 3, label: 20, description: 40, identifier: 20,
} as const

export type CheckAction = { label: string; description: string; identifier: string }

export const RERUN_ACTION: CheckAction = {
  label: 'Re-run',                           // 6 of 20
  description: 'Review this commit again',   // 24 of 40
  identifier: RERUN_IDENTIFIER,              // 5 of 20
}

/** Criss, 2026-09-14 (decision 5; design §5's conclusion table, recorded in §12): a finished review concludes `success`
 *  or `failure`, and an error, a refusal or an abandoned run concludes `neutral`.
 *  `timed_out` is deliberately NOT here: it was this plan's first answer for an abandoned run and
 *  the decision replaced it with `neutral`, because an abandoned run is an infrastructure failure
 *  and an infrastructure failure must not block a merge. */
export type CheckConclusion = 'success' | 'neutral' | 'failure'

export type CheckOutcome =
  | { kind: 'reviewed'; headSha: string; tier: Tier; model: string; costUsd: number
      /** Already check-adjusted by Task 7b: the check pass's severities, and never a refuted
       *  finding. This module does not re-apply verdicts; it would be a second reading of
       *  `CheckVerdict.index` and a second chance to disagree about whose verdict it was. */
      findings: Finding[]
      /** The subset the check pass CONFIRMED, or `null` when no check pass ran. Only read when a
       *  deployment set `gateRequiresConfirmed` (Criss, decision 6). */
      confirmed: Finding[] | null
      /** The hard ceiling fired and what is here is what the review got to (design §4.5). */
      cutShort: boolean
      posted: number; summaryUrl: string | null }
  | { kind: 'failed'; headSha: string; reason: string }
  /** Criss, 2026-09-14 (decision 3): a requested review refused before anything was spent — the
   *  requester cannot push to the repository. Visible on the pull request, never silent. */
  | { kind: 'refused'; headSha: string; reason: string }
  | { kind: 'abandoned'; headSha: string }

/** The two settings that make a gate, passed together because they are one decision. */
export type CheckGate = { failAtOrAbove: number | null; requiresConfirmed: boolean }

/** The one mapping from the two gate settings to a `CheckGate`: the setting is
 *  `gateRequiresConfirmed` and the gate's field is `requiresConfirmed` (Criss, decisions 5 and 6).
 *  Here, beside the gate, since 0.2.0's Stage 6: the review session and the App's runner — whose
 *  push-access refusal is a check run the session never opens — both report through it, so the
 *  renaming is written once and the two cannot drift apart. */
export const gateOf = (report: DeploymentConfig['report']): CheckGate => ({
  failAtOrAbove: report.failAtOrAbove,
  requiresConfirmed: report.gateRequiresConfirmed,
})

/** report.ts (Task 10b) says in so many words that this decision is not its own: `silent` and
 *  `check-only` both post no comment, and whether a check run exists is the whole difference
 *  between the two modes (design §3.1). */
export const checkRunWanted = (mode: ReportMode): boolean => mode !== 'silent'

/** Criss, 2026-09-14 (decision 5): a FINISHED review with nothing at the gate concludes
 *  `success` — not `neutral`, which silently passes branch protection and would make an armed
 *  gate impossible to tell from a decorative one (`04-REVIEWER.md` §4.2). A review that could not
 *  run, a refusal, and a run that was abandoned all conclude `neutral`: the failure is the
 *  product's, and blocking a merge over it would punish the wrong person. `failure` needs two
 *  things to be true at once — a deployment named a threshold, and the CHECK-ADJUSTED findings
 *  reached it (decision 6). */
export const conclusionFor = (a: {
  outcome: CheckOutcome; gate: CheckGate
}): CheckConclusion => {
  const { outcome, gate } = a
  // An outage must not block a merge (04-REVIEWER §4.2, "binding"). Both non-reviewed kinds are
  // the product failing, not the pull request.
  if (outcome.kind !== 'reviewed') return 'neutral'
  const threshold = gate.failAtOrAbove
  if (threshold === null) return 'success'
  // Decision 6: the gate reads the check-adjusted set, and a deployment may narrow it again to
  // what the pass CONFIRMED. `confirmed: null` means no pass ran, so nothing is confirmed and
  // nothing can fail — a disarmed gate, which checkRunOutput says out loud.
  const gated = gate.requiresConfirmed ? outcome.confirmed ?? [] : outcome.findings
  return gated.some((f) => f.severity >= threshold) ? 'failure' : 'success'
}

/** A crashed CLI's stderr or a terminal reason is the only unbounded string that reaches a check
 *  run's text. 200 characters is about two rendered lines — enough to name the failure, and not
 *  enough to turn an error into a wall. */
export const MAX_REASON_CHARS = 200

/** GitHub's documented cap: at most 50 annotations per request (verified facts, "Check runs").
 *  `report.maxInline` is normally far below it — 15 by default — but a deployment may raise that,
 *  and a 422 on a check run is a review that reported nothing. */
export const MAX_ANNOTATIONS = 50

/** The opening of the machine-readable line in `output.text`. Exported so the test, and anything
 *  that later reads a check run back, match on one string rather than on a copy of it. */
export const VERDICT_OPEN = '<!-- review-agent-verdict: '

/** GitHub's documented caps on one annotation: 255 CHARACTERS of title, 64 KB of message. Over
 *  either, the PATCH that completes the check run is a 422 — so the run this review opened stays
 *  `in_progress` for ever, which is the exact failure a check run exists to prevent. Both inputs are
 *  model-authored and the findings schema bounds neither (`title` and `explanation` are plain
 *  `z.string()`), so both are clipped here rather than trusted. */
export const MAX_ANNOTATION_TITLE_CHARS = 255
export const MAX_ANNOTATION_MESSAGE_BYTES = 64 * 1024

/** Clips to a BYTE cap without cutting a multi-byte character in half. A model may answer in any
 *  language, and half a character is a 400 from the JSON encoder or a replacement glyph on screen. */
const clipBytes = (s: string, maxBytes: number): string => {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  // 0b10xxxxxx is a UTF-8 continuation byte: walk back off any, to land on a character boundary.
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

export type Annotation = {
  path: string
  start_line: number
  end_line: number
  annotation_level: 'notice' | 'warning' | 'failure'
  message: string
  title: string
}

const short = (sha: string): string => sha.slice(0, 7)
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

type Bands = { critical: number; high: number; medium: number }

const levelFor = (severity: number, bands: Bands): Annotation['annotation_level'] =>
  severity >= bands.high ? 'failure' : severity >= bands.medium ? 'warning' : 'notice'

/** Criss, 2026-09-14 (decision 7): annotations in `check-only` and nowhere else. In every other
 *  mode the same findings are already an inline comment and a line in the summary comment, and a
 *  third copy is noise. In `check-only` nothing is posted at all, so this is the whole report.
 *  The list it is given is already check-adjusted — refuted findings are gone and the severities
 *  are the pass's — so neither has to be re-derived here. */
export const annotationsFor = (a: {
  outcome: CheckOutcome; mode: ReportMode; maxInline: number; bands: Bands
}): Annotation[] => {
  if (a.mode !== 'check-only' || a.outcome.kind !== 'reviewed') return []
  const cap = Math.min(a.maxInline, MAX_ANNOTATIONS)
  return a.outcome.findings.slice(0, cap).map((f): Annotation => {
    // findings.ts parses `line` as an integer >= 0, and 0 means file-level. GitHub has no line 0,
    // so a file-level finding is annotated at the top of the file rather than dropped.
    const line = f.line === 0 ? 1 : f.line
    const end = f.endLine === null || f.endLine < line ? line : f.endLine
    return {
      path: f.file,
      start_line: line,
      end_line: end,
      annotation_level: levelFor(f.severity, a.bands),
      title: f.title.slice(0, MAX_ANNOTATION_TITLE_CHARS),
      message: clipBytes(
        `Severity ${f.severity}/10 (${f.category}) — ${f.explanation}`,
        MAX_ANNOTATION_MESSAGE_BYTES,
      ),
    }
  })
}

/** One HTML comment holding the numbers, in every mode (decision 7). It is the same trick the
 *  summary comment's marker plays: the state a later reader needs lives in the pull request, not
 *  in a database this product does not have. A reader of the check run sees nothing. */
export const verdictJson = (a: { outcome: CheckOutcome; bands: Bands }): string => {
  const { outcome, bands } = a
  const common = { sha: outcome.headSha }
  // The bands are a deployment setting (design §3.1), so the counts are counted with the
  // deployment's own bands rather than with four numbers written twice.
  const inBand = (f: Finding, lo: number, hi: number): boolean => f.severity >= lo && f.severity < hi
  const body = outcome.kind !== 'reviewed'
    ? { ...common, outcome: outcome.kind }
    : {
        ...common,
        tier: outcome.tier,
        model: outcome.model,
        cost_usd: outcome.costUsd,
        cut_short: outcome.cutShort,
        critical: outcome.findings.filter((f) => f.severity >= bands.critical).length,
        high: outcome.findings.filter((f) => inBand(f, bands.high, bands.critical)).length,
        medium: outcome.findings.filter((f) => inBand(f, bands.medium, bands.high)).length,
        low: outcome.findings.filter((f) => f.severity < bands.medium).length,
        posted: outcome.posted,
        confirmed: outcome.confirmed === null ? null : outcome.confirmed.length,
        findings: outcome.findings.map((f) => ({ id: findingId(f), severity: f.severity })),
      }
  return `${VERDICT_OPEN}${JSON.stringify(body)} -->`
}

export const checkRunOutput = (a: {
  outcome: CheckOutcome; mode: ReportMode; maxInline: number; bands: Bands; gate: CheckGate
}): { title: string; summary: string; text: string; annotations?: Annotation[] } => {
  const { outcome } = a
  const text = verdictJson({ outcome, bands: a.bands })
  if (outcome.kind === 'abandoned') {
    return {
      title: 'Review timed out',
      summary: `The review of \`${short(outcome.headSha)}\` was killed before it could report. `
        + 'Nothing was posted. Use **Re-run** to review this commit again.',
      text,
    }
  }
  if (outcome.kind === 'failed') {
    return {
      title: 'Review did not finish',
      summary: `The review of \`${short(outcome.headSha)}\` stopped: `
        + `${outcome.reason.slice(0, MAX_REASON_CHARS)}. Use **Re-run** to try again.`,
      text,
    }
  }
  if (outcome.kind === 'refused') {
    // Decision 3. Visible, and plain about the money: the refusal happened before the archive, the
    // engine and the check pass, so this commit cost nothing. A maintainer who presses Re-run gets a
    // review under their own name.
    return {
      title: 'Review refused',
      summary: `No review of \`${short(outcome.headSha)}\` was run: `
        + `${outcome.reason.slice(0, MAX_REASON_CHARS)}. Nothing was reviewed and nothing was spent.`,
      text,
    }
  }
  const worst = outcome.findings.reduce((m, f) => Math.max(m, f.severity), 0)
  const title = outcome.findings.length === 0
    ? 'No findings'
    : `${plural(outcome.findings.length, 'finding')}, worst ${worst}/10`
  const lines = [
    `Reviewed \`${short(outcome.headSha)}\` — tier **${outcome.tier}**, model `
      + `\`${outcome.model}\`, $${outcome.costUsd.toFixed(2)}.`,
    outcome.findings.length === 0
      ? 'Nothing to report.'
      : `${plural(outcome.findings.length, 'finding')}, ${outcome.posted} posted as `
        + `${outcome.posted === 1 ? 'a comment' : 'comments'}.`,
  ]
  // design §4.5: the ceiling fired and what is above is what the review got to. Said in words,
  // because a reader deciding whether to trust "no findings" needs to know the review stopped.
  if (outcome.cutShort) {
    lines.push('This review was **cut short** by the budget ceiling; what it found is above.')
  }
  // A gate that cannot fire, said out loud rather than repaired. `confirmed === null` means no
  // check pass ran, and `requiresConfirmed` means only a confirmed finding may fail a build.
  if (a.gate.failAtOrAbove !== null && a.gate.requiresConfirmed && outcome.confirmed === null) {
    lines.push('The gate is set to require a confirmed finding, but **no check pass ran** for '
      + 'this tier, so nothing can reach it.')
  }
  // The findings themselves are in the comments and the summary comment. Repeating them here
  // would double what a reader has to read and is the only thing on this page that could grow
  // with the size of the review. In `check-only` there are no comments, and the annotations below
  // are where they go instead.
  if (outcome.summaryUrl !== null) lines.push(`[The full summary](${outcome.summaryUrl})`)
  const annotations = annotationsFor({
    outcome, mode: a.mode, maxInline: a.maxInline, bands: a.bands,
  })
  return {
    title,
    summary: lines.join('\n'),
    text,
    ...(annotations.length > 0 && { annotations }),
  }
}

/** An installation token expires in one hour, so no review can still be running after that: a
 *  check run of ours still `in_progress` an hour after it started was abandoned, almost always by
 *  a `maxDuration` kill, which runs no cleanup hook and so could not complete it from inside. */
export const STALE_AFTER_MS = 60 * 60 * 1000

const CreatedSchema = z.object({ id: z.number().int(), html_url: z.string().nullish() })
const ListSchema = z.object({
  check_runs: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    status: z.string(),
    started_at: z.string().nullish(),
  })),
})

/** What the sweep hands `completeCheckRun` for a run it did not start and knows nothing about. An
 *  abandoned outcome has no findings, so no annotation, no band count and no gate reads any of these;
 *  they are here because the signature is one signature. */
const SWEEP_CONTEXT = {
  gate: { failAtOrAbove: null, requiresConfirmed: false },
  mode: 'inline+summary',
  maxInline: 0,
  bands: { critical: 9, high: 7, medium: 4 },
} as const satisfies { gate: CheckGate; mode: ReportMode; maxInline: number; bands: Bands }

/** Completes check runs of ours that an earlier, killed review left open on this commit.
 *  `check_name` and `status` narrow the request, and the same conditions are re-applied here,
 *  because the two query parameters were proven by hand rather than read in the research pack:
 *  if either is ever ignored, this still closes only our own abandoned runs. */
export async function closeStaleCheckRuns(a: {
  octokit: Octokit; owner: string; repo: string; headSha: string; name: string; now?: Date
  /** How old an `in_progress` run of ours must be to count as abandoned. STALE_AFTER_MS unless the
   *  caller KNOWS the run before it was killed and passes 0. No caller in plan 2 does. Since
   *  2026-09-18 trigger.dev repeats a run up to three attempts (Criss, 2026-09-18, reversing answer 13), so a retried
   *  attempt is such a caller — but it does NOT pass 0, because 0 would also close a concurrent
   *  sibling run's check of the same name and sha. It closes the one run it replaces by id instead,
   *  through `closeCheckRunIfInProgress` (Criss, 2026-09-24); this rule remains the fallback when
   *  that id could not be recalled. The scheduled sweep (Task
   *  13b) cannot know a run is dead, so it keeps the hour. */
  staleAfterMs?: number
}): Promise<number> {
  const { octokit, owner, repo, headSha, name } = a
  const now = a.now ?? new Date()
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner, repo, ref: headSha, check_name: name, status: 'in_progress', per_page: 100,
  })
  const parsed = ListSchema.safeParse(res.data)
  if (!parsed.success) return 0
  const cutoff = now.getTime() - (a.staleAfterMs ?? STALE_AFTER_MS)
  let closed = 0
  for (const run of parsed.data.check_runs) {
    if (run.name !== name || run.status !== 'in_progress') continue
    const started = run.started_at === null || run.started_at === undefined
      ? Number.NaN : Date.parse(run.started_at)
    // A run with no readable start time is left alone: it might be a review that started a
    // second ago, and closing someone else's live check run is worse than leaving a stale one.
    if (Number.isNaN(started) || started > cutoff) continue
    await completeCheckRun({
      octokit, owner, repo, checkRunId: run.id,
      outcome: { kind: 'abandoned', headSha }, ...SWEEP_CONTEXT, now,
    })
    closed += 1
  }
  return closed
}

/** Opens the check run at the start of a review, so the pull request shows that something is
 *  happening during the two to five minutes a review takes (design §8). */
const OneRunSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  head_sha: z.string(),
})

/** Closes ONE check run of ours, by id, as abandoned — but only while it is still `in_progress`.
 *
 *  Added 2026-09-24 (Criss: "Fix it inside #6 first"). Since `MAX_ATTEMPTS` became 3, trigger.dev
 *  retries a crashed or killed attempt itself, and the retry creates a fresh check run while the
 *  killed attempt's stays `in_progress` — closeStaleCheckRuns would leave it for an hour, because it
 *  is seconds old. A retried attempt KNOWS which run it replaces (the task recalls its id), so it
 *  closes that one run by id and nothing else. Matching by name and sha instead — `staleAfterMs: 0`
 *  — would also close a concurrent sibling review's check on the same commit.
 *
 *  Three guards, each re-read from what GitHub returns rather than trusted from what was remembered:
 *  the run must still be `in_progress` (a killed attempt may have completed its check before it
 *  died, and completing it again would overwrite a verdict somebody can already see), and its name
 *  and head sha must be the ones this review uses. Returns whether it closed anything. */
export async function closeCheckRunIfInProgress(a: {
  octokit: Octokit; owner: string; repo: string; checkRunId: number; name: string; headSha: string
  now?: Date
}): Promise<boolean> {
  const { octokit, owner, repo, checkRunId, name, headSha } = a
  const res = await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner, repo, check_run_id: checkRunId,
  })
  const parsed = OneRunSchema.safeParse(res.data)
  if (!parsed.success) return false
  const run = parsed.data
  if (run.status !== 'in_progress' || run.name !== name || run.head_sha !== headSha) return false
  await completeCheckRun({
    octokit, owner, repo, checkRunId: run.id,
    outcome: { kind: 'abandoned', headSha }, ...SWEEP_CONTEXT, now: a.now ?? new Date(),
  })
  return true
}

export async function createCheckRun(a: {
  octokit: Octokit; owner: string; repo: string; headSha: string; name: string
  detailsUrl?: string; externalId?: string; now?: Date; staleAfterMs?: number
}): Promise<{ id: number; url: string | null }> {
  const { octokit, owner, repo, headSha, name } = a
  const now = a.now ?? new Date()
  try {
    await closeStaleCheckRuns({
      octokit, owner, repo, headSha, name, now,
      ...(a.staleAfterMs !== undefined && { staleAfterMs: a.staleAfterMs }),
    })
  } catch {
    // Swallowed deliberately: the sweep is housekeeping. A stale check run is a blemish; a
    // review that did not run because the sweep 403'd is a broken product.
  }
  const res = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner, repo, name, head_sha: headSha,
    status: 'in_progress',                    // no default is documented; say which one we mean
    started_at: now.toISOString(),
    ...(a.detailsUrl !== undefined && { details_url: a.detailsUrl }),
    ...(a.externalId !== undefined && { external_id: a.externalId }),
  })
  const created = CreatedSchema.parse(res.data)
  // The check run's page, as GitHub gave it, for a caller that reports where the result is (spec
  // 0.2.0 §4.3). Null when the answer carried none rather than a URL assembled from a format string.
  const url = typeof created.html_url === 'string' && /^https?:\/\//.test(created.html_url) ? created.html_url : null
  return { id: created.id, url }
}

/** Ends the check run. The PATCH carries no `status`: the documented behaviour is that providing
 *  `conclusion` sets the status to completed, and sending both would be two sources of truth.
 *  Unlike the sweep, a failure here is thrown: the caller has to know that the check run this
 *  review opened is still open. */
export async function completeCheckRun(a: {
  octokit: Octokit; owner: string; repo: string; checkRunId: number
  outcome: CheckOutcome; gate: CheckGate; mode: ReportMode; maxInline: number; bands: Bands
  now?: Date
}): Promise<CheckConclusion> {
  const conclusion = conclusionFor({ outcome: a.outcome, gate: a.gate })
  await a.octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner: a.owner, repo: a.repo, check_run_id: a.checkRunId,
    conclusion,
    completed_at: (a.now ?? new Date()).toISOString(),
    // The summary, the hidden verdict in `text`, and in check-only only the annotations. One
    // request: `maxInline` and MAX_ANNOTATIONS keep the list inside GitHub's 50, so no chunking.
    output: checkRunOutput({
      outcome: a.outcome, mode: a.mode, maxInline: a.maxInline, bands: a.bands, gate: a.gate,
    }),
    // design §5. Offered only on a finished check run: a Re-run button on a review that is still
    // running buys a second paid review of the same commit for nothing.
    actions: [RERUN_ACTION],
  })
  return conclusion
}

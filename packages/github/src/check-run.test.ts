import type { Octokit } from '@octokit/core'
import { describe, expect, it } from 'vitest'
import type { Finding, ReportMode } from '@review-agent/core'
import { conclusionFor, checkRunWanted, type CheckGate, type CheckOutcome } from './check-run'

const finding = (severity: number): Finding => ({
  file: 'src/token.ts', line: 42, endLine: null, severity, category: 'security',
  title: 'the installation token is logged at info', explanation: 'e', evidence: [], suggestion: null,
})

const reviewed = (findings: Finding[], over: Partial<Extract<CheckOutcome, { kind: 'reviewed' }>> = {}): CheckOutcome => ({
  kind: 'reviewed', headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
  tier: 'basic', model: 'claude-opus-5', costUsd: 0.94, findings,
  confirmed: null, cutShort: false, posted: findings.length,
  summaryUrl: 'https://github.com/crissmoldovan/review-agent-proving-ground/pull/1#issuecomment-1',
  ...over,
})

const OPEN_GATE = { failAtOrAbove: null, requiresConfirmed: false } as const

describe('conclusionFor', () => {
  it('is success with the gate off, even for a finding rated 10 out of 10', () => {
    // Criss, 2026-09-14 (decision 5), adopting a deployment's reviewer spec. `neutral`
    // silently PASSES branch protection, so concluding it for a finished review would mean the
    // gate could never be armed and no test would say so.
    expect(conclusionFor({ outcome: reviewed([finding(10)]), gate: OPEN_GATE })).toBe('success')
  })

  it('is success for a review with nothing to say, and for one whose files were all filtered out', () => {
    // Both arrive here as a finished review with no findings, which is the same fact twice.
    expect(conclusionFor({ outcome: reviewed([]), gate: OPEN_GATE })).toBe('success')
  })

  it('fails only when the deployment asked for a gate and the review reached it', () => {
    const gate = { failAtOrAbove: 9, requiresConfirmed: false }
    expect(conclusionFor({ outcome: reviewed([finding(9)]), gate })).toBe('failure')
    expect(conclusionFor({ outcome: reviewed([finding(8)]), gate })).toBe('success')
    expect(conclusionFor({ outcome: reviewed([]), gate: { failAtOrAbove: 1, requiresConfirmed: false } }))
      .toBe('success')
  })

  it('gates on the confirmed subset when the deployment demanded confirmation', () => {
    // Criss, 2026-09-14 (decision 6). `findings` is already check-adjusted — the check's
    // severities, no refuted finding — and this narrows it once more.
    const gate = { failAtOrAbove: 9, requiresConfirmed: true }
    const uncertainOnly = reviewed([finding(9)], { confirmed: [] })
    const confirmedOne = reviewed([finding(9)], { confirmed: [finding(9)] })
    expect(conclusionFor({ outcome: uncertainOnly, gate })).toBe('success')
    expect(conclusionFor({ outcome: confirmedOne, gate })).toBe('failure')
    // And with the switch off, the same uncertain finding still gates: that is the default.
    expect(conclusionFor({ outcome: uncertainOnly, gate: { failAtOrAbove: 9, requiresConfirmed: false } }))
      .toBe('failure')
  })

  it('cannot fail a build when confirmation is demanded and no check pass ran', () => {
    // `confirmed: null` is "no pass ran". The gate is disarmed, deliberately and visibly: the
    // output says so (checkRunOutput), so nobody discovers it from a merge that should not have
    // happened.
    const gate = { failAtOrAbove: 1, requiresConfirmed: true }
    expect(conclusionFor({ outcome: reviewed([finding(10)]), gate })).toBe('success')
  })

  it('is neutral when the review itself broke, gate or no gate', () => {
    // A reviewer that cannot review must not block a merge: the failure is the product's, not
    // the pull request's. This is the row 04-REVIEWER §4.2 calls binding.
    const failed: CheckOutcome = { kind: 'failed', headSha: '4f8e2a1', reason: 'budget ceiling' }
    expect(conclusionFor({ outcome: failed, gate: { failAtOrAbove: 1, requiresConfirmed: false } }))
      .toBe('neutral')
    // Criss, decision 3: a request from somebody without push access is refused before anything is
    // spent. Nothing was reviewed, so nothing can pass or fail.
    const refused: CheckOutcome = { kind: 'refused', headSha: '4f8e2a1', reason: '@someone has no push access' }
    expect(conclusionFor({ outcome: refused, gate: { failAtOrAbove: 1, requiresConfirmed: false } }))
      .toBe('neutral')
  })

  it('is neutral for a run that was killed before it could report', () => {
    // Criss, 2026-09-14 (decision 5): `timed_out` is gone. An abandoned run is an infrastructure
    // failure and infrastructure failures conclude neutral.
    const abandoned: CheckOutcome = { kind: 'abandoned', headSha: '4f8e2a1' }
    expect(conclusionFor({ outcome: abandoned, gate: OPEN_GATE })).toBe('neutral')
  })

  it('judges a cut-short run on the findings it did return', () => {
    // design §4.5 and 04-REVIEWER §4.2: whatever was produced is still posted, marked cut short.
    // The MARK is checkRunOutput's job; the conclusion is judged normally.
    const gate = { failAtOrAbove: 9, requiresConfirmed: false }
    expect(conclusionFor({ outcome: reviewed([finding(9)], { cutShort: true }), gate })).toBe('failure')
    expect(conclusionFor({ outcome: reviewed([finding(4)], { cutShort: true }), gate })).toBe('success')
  })
})

describe('checkRunWanted', () => {
  it('creates a check run for every mode except silent', () => {
    // report.ts deliberately left this decision here: `silent` and `check-only` post no comment,
    // and the check run is the entire difference between them (design §3.1).
    expect(checkRunWanted('inline+summary')).toBe(true)
    expect(checkRunWanted('summary-only')).toBe(true)
    expect(checkRunWanted('check-only')).toBe(true)
    expect(checkRunWanted('silent')).toBe(false)
  })
})

import {
  MAX_ANNOTATIONS, MAX_ANNOTATION_MESSAGE_BYTES, MAX_ANNOTATION_TITLE_CHARS, MAX_REASON_CHARS,
  VERDICT_OPEN, checkRunOutput,
} from './check-run'
import { findingId } from './marker'

const BANDS = { critical: 9, high: 7, medium: 4 }
const output = (
  outcome: CheckOutcome,
  over: { mode?: ReportMode; maxInline?: number; gate?: CheckGate } = {},
) => checkRunOutput({
  outcome,
  mode: over.mode ?? 'inline+summary',
  maxInline: over.maxInline ?? 15,
  bands: BANDS,
  gate: over.gate ?? OPEN_GATE,
})

describe('checkRunOutput', () => {
  it('names the commit, the tier, the model and the cost', () => {
    const out = output(reviewed([finding(8), finding(3)]))
    expect(out.title).toBe('2 findings, worst 8/10')
    expect(out.summary).toContain('`4f8e2a1`')            // the short sha, as the summary comment uses
    expect(out.summary).toContain('**basic**')
    expect(out.summary).toContain('claude-opus-5')
    expect(out.summary).toContain('$0.94')
    expect(out.summary).toContain('2 posted as comments')
    expect(out.summary).toContain('https://github.com/crissmoldovan/review-agent-proving-ground/pull/1#issuecomment-1')
  })

  it('says so plainly when there was nothing to report', () => {
    const out = output(reviewed([]))
    expect(out.title).toBe('No findings')
    expect(out.summary).toContain('Nothing to report')
  })

  it('is the same handful of lines whether the review found two things or two hundred', () => {
    // No character limit on output.summary is documented, so this codes to none. It is bounded
    // by what it contains instead: counts, never the text of a finding, which the comments
    // already carry and which is the only input here that can grow without bound.
    const many = Array.from({ length: 200 }, (_, i) => finding((i % 10) + 1))
    const big = output(reviewed(many))
    const small = output(reviewed([finding(8), finding(3)]))
    expect(big.summary.split('\n')).toHaveLength(small.summary.split('\n').length)
    expect(big.summary).not.toContain('the installation token is logged at info')
    expect(big.summary.length).toBeLessThan(400)
  })

  it('clips the one free-text input a failure can carry', () => {
    const out = output({ kind: 'failed', headSha: '4f8e2a1', reason: 'x'.repeat(5_000) })
    expect(out.title).toBe('Review did not finish')
    expect(out.summary.length).toBeLessThan(MAX_REASON_CHARS + 200)
  })

  it('tells a reader what to do about a review that was killed', () => {
    const out = output({ kind: 'abandoned', headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f' })
    expect(out.title).toBe('Review timed out')
    expect(out.summary).toContain('Re-run')
    expect(out.summary).toContain('Nothing was posted')
  })

  it('says a refused request was refused, by whom, and that nothing was spent', () => {
    // Criss, decision 3. No "Re-run to try again": the same person pressing it is refused again.
    const out = output({
      kind: 'refused', headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
      reason: '@someone asked for a review and does not have push access to crissmoldovan/review-agent-proving-ground',
    })
    expect(out.title).toBe('Review refused')
    expect(out.summary).toContain('@someone')
    expect(out.summary).toContain('Nothing was reviewed and nothing was spent')
    expect(out.summary).not.toContain('try again')
    expect(out.annotations).toBeUndefined()
  })

  it('clips a refusal reason too, and not only a failure one', () => {
    // Added 2026-09-14, not in the plan: the plan clips both branches and tests only `failed`, so
    // deleting the refusal branch's slice left all 32 cases green. `CheckOutcome['reason']` is a
    // bare string on both kinds, and a refusal reason is built from a login and a repository name
    // that this module does not bound, so the same clip needs the same lock.
    const out = output({ kind: 'refused', headSha: '4f8e2a1', reason: 'x'.repeat(5_000) })
    expect(out.summary.length).toBeLessThan(MAX_REASON_CHARS + 200)
  })

  it('says the review was cut short, in every mode, when the ceiling fired', () => {
    // design §4.5: whatever was produced is still posted, marked cut short. A check run that said
    // "1 finding" without saying the review stopped early would be lying by omission.
    for (const mode of ['inline+summary', 'summary-only', 'check-only'] as ReportMode[]) {
      const out = output(reviewed([finding(6)], { cutShort: true }), { mode })
      expect(out.summary, mode).toContain('cut short')
    }
    expect(output(reviewed([finding(6)])).summary).not.toContain('cut short')
  })

  it('carries a hidden machine-readable verdict in every mode', () => {
    for (const mode of ['inline+summary', 'summary-only', 'check-only'] as ReportMode[]) {
      const out = output(reviewed([finding(8), finding(3)], { cutShort: true }), { mode })
      expect(out.text, mode).toContain(VERDICT_OPEN)
      const json = JSON.parse(out.text.slice(out.text.indexOf('{'), out.text.lastIndexOf('}') + 1)) as Record<string, unknown>
      expect(json).toMatchObject({
        sha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
        tier: 'basic', model: 'claude-opus-5', cost_usd: 0.94, cut_short: true,
        critical: 0, high: 1, medium: 0, low: 1, posted: 2,
      })
      expect(json.findings).toEqual([
        { id: findingId(finding(8)), severity: 8 },
        { id: findingId(finding(3)), severity: 3 },
      ])
    }
    // It is a comment, so a reader of the check run never sees it.
    expect(output(reviewed([])).text.trim().startsWith('<!--')).toBe(true)
    expect(output(reviewed([])).text.trim().endsWith('-->')).toBe(true)
  })

  it('lists the findings as annotations in check-only, and in no other mode', () => {
    // Criss, decision 7. In check-only nothing is posted at all and the check run IS the report.
    // Everywhere else the findings are already an inline comment and a summary comment.
    const out = output(reviewed([finding(8), finding(3)]), { mode: 'check-only' })
    expect(out.annotations).toHaveLength(2)
    expect(out.annotations?.[0]).toEqual({
      path: 'src/token.ts', start_line: 42, end_line: 42,
      annotation_level: 'failure',                       // 8 is at or above bands.high
      title: 'the installation token is logged at info',
      message: 'Severity 8/10 (security) — e',
    })
    for (const mode of ['inline+summary', 'summary-only', 'silent'] as ReportMode[]) {
      expect(output(reviewed([finding(8)]), { mode }).annotations, mode).toBeUndefined()
    }
  })

  it('clips an annotation title and message to the sizes GitHub documents', () => {
    // Both are model-authored and the findings schema bounds neither. Over GitHub's cap the PATCH
    // that completes the check run is a 422, so the run stays `in_progress` for ever and the pull
    // request shows a review that never finished — the failure this whole module exists to prevent.
    // Batch 2's verifiers deleted the title clip and all 34 cases stayed green: nothing was long.
    const long = output(
      reviewed([{ ...finding(8), title: 'T'.repeat(300), explanation: 'E'.repeat(70_000) }]),
      { mode: 'check-only' },
    ).annotations?.[0]
    expect(MAX_ANNOTATION_TITLE_CHARS).toBe(255)
    expect(MAX_ANNOTATION_MESSAGE_BYTES).toBe(64 * 1024)
    expect(long?.title).toHaveLength(MAX_ANNOTATION_TITLE_CHARS)
    expect(Buffer.byteLength(long?.message ?? '', 'utf8')).toBe(MAX_ANNOTATION_MESSAGE_BYTES)
  })

  it('clips a message on a character boundary, because a model may answer in any language', () => {
    // The message cap is 64 KB of BYTES. Cutting the buffer at 65,536 would leave half a
    // three-byte character at the end, which is a replacement glyph on screen at best.
    const message = output(
      reviewed([{ ...finding(8), explanation: '⚠'.repeat(30_000) }]),   // three bytes each
      { mode: 'check-only' },
    ).annotations?.[0].message ?? ''
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE_BYTES)
    expect(message).not.toContain('�')
  })

  it('maps severity onto GitHub three annotation levels through the deployment bands', () => {
    const levels = (f: Finding) =>
      output(reviewed([f]), { mode: 'check-only' }).annotations?.[0].annotation_level
    expect(levels(finding(9))).toBe('failure')     // >= bands.high (7): failure
    expect(levels(finding(7))).toBe('failure')
    expect(levels(finding(5))).toBe('warning')     // >= bands.medium (4): warning
    expect(levels(finding(3))).toBe('notice')
  })

  it('puts a file-level finding on line 1, because GitHub has no line 0', () => {
    const fileLevel = { ...finding(6), line: 0 }
    const a = output(reviewed([fileLevel]), { mode: 'check-only' }).annotations?.[0]
    expect(a?.start_line).toBe(1)
    expect(a?.end_line).toBe(1)
  })

  it('never sends more annotations than the deployment or GitHub allows', () => {
    // report.maxInline first (decision 7), then GitHub's documented 50 per request, so a
    // deployment that raises maxInline past 50 gets a shorter list rather than a 422.
    const many = Array.from({ length: 200 }, (_, i) => finding((i % 10) + 1))
    expect(output(reviewed(many), { mode: 'check-only' }).annotations).toHaveLength(15)
    expect(output(reviewed(many), { mode: 'check-only', maxInline: 500 }).annotations)
      .toHaveLength(MAX_ANNOTATIONS)
  })

  it('says the gate is disarmed when a deployment demands confirmation and no pass ran', () => {
    // A configuration nobody would notice otherwise: gateRequiresConfirmed on, check pass off,
    // so nothing can ever be confirmed and nothing can ever fail.
    const out = output(reviewed([finding(10)]), {
      gate: { failAtOrAbove: 9, requiresConfirmed: true },
    })
    expect(out.summary).toContain('no check pass ran')
    // And it does not say it when the pass did run.
    const ran = output(reviewed([finding(10)], { confirmed: [] }), {
      gate: { failAtOrAbove: 9, requiresConfirmed: true },
    })
    expect(ran.summary).not.toContain('no check pass ran')
  })
})

import { STALE_AFTER_MS, closeCheckRunIfInProgress, closeStaleCheckRuns, createCheckRun } from './check-run'

type Call = { route: string; params: Record<string, unknown> }

/** A real object, not a mock library: it records what was asked and answers with canned data, so
 *  a test can assert on the exact request body GitHub would have received. */
function fakeOctokit(answer: (route: string, params: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params })
      return { status: 200, headers: {}, data: answer(route, params) }
    },
  } as unknown as Octokit
  return { octokit, calls }
}

const NOW = new Date('2026-09-14T12:00:00.000Z')
const HEAD = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const noStale = { total_count: 0, check_runs: [] }

describe('createCheckRun', () => {
  it('sends the two required fields and an explicit status', async () => {
    const { octokit, calls } = fakeOctokit((route) =>
      route.startsWith('GET') ? noStale : { id: 7331 })
    const created = await createCheckRun({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD,
      name: 'review-agent', now: NOW,
    })
    expect(created.id).toBe(7331)
    const post = calls.find((c) => c.route.startsWith('POST'))
    expect(post?.route).toBe('POST /repos/{owner}/{repo}/check-runs')
    expect(post?.params.name).toBe('review-agent')       // report.checkRunName, from settings
    expect(post?.params.head_sha).toBe(HEAD)
    // No default is documented for `status`, so the product says which one it means.
    expect(post?.params.status).toBe('in_progress')
    expect(post?.params.started_at).toBe('2026-09-14T12:00:00.000Z')
    expect(post?.params.conclusion).toBeUndefined()
  })

  it('closes the check run an earlier review abandoned before it opens its own', async () => {
    // A maxDuration kill runs no lifecycle hook, so nothing inside the killed process completed
    // this one. The next review of the same commit is the first thing that can.
    const started = new Date(NOW.getTime() - STALE_AFTER_MS - 60_000).toISOString()
    const { octokit, calls } = fakeOctokit((route) =>
      route.startsWith('GET')
        ? { total_count: 1, check_runs: [{ id: 900, name: 'review-agent', status: 'in_progress', started_at: started }] }
        : { id: 7331 })
    await createCheckRun({ octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW })
    const patch = calls.find((c) => c.route.startsWith('PATCH'))
    expect(patch?.params.check_run_id).toBe(900)
    // Criss, 2026-09-14 (decision 5): an abandoned run is an infrastructure failure, and those
    // conclude neutral. `timed_out` is no longer a conclusion this product sends.
    expect(patch?.params.conclusion).toBe('neutral')
    expect(calls.filter((c) => c.route.startsWith('POST'))).toHaveLength(1)
  })

  it('leaves a check run that could still be running alone', async () => {
    const started = new Date(NOW.getTime() - 90_000).toISOString()   // ninety seconds ago
    const { octokit, calls } = fakeOctokit((route) =>
      route.startsWith('GET')
        ? { total_count: 1, check_runs: [{ id: 901, name: 'review-agent', status: 'in_progress', started_at: started }] }
        : { id: 7332 })
    const closed = await closeStaleCheckRuns({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW,
    })
    expect(closed).toBe(0)
    expect(calls.filter((c) => c.route.startsWith('PATCH'))).toHaveLength(0)
  })

  it('leaves a run whose start time it cannot read alone', async () => {
    // `started_at` is `nullish` on the wire, and an unreadable one is not evidence of anything: the
    // run might have started a second ago. Date.parse(null as never) is NaN, and NaN > cutoff is
    // false, so without the explicit NaN guard this falls through to "stale" and PATCHes a live
    // check run — someone else's review, concluded `neutral` while it is still working. Batch 2's
    // verifiers deleted `Number.isNaN(started) ||` and all 34 cases stayed green.
    const { octokit, calls } = fakeOctokit(() => ({
      total_count: 1,
      check_runs: [{ id: 903, name: 'review-agent', status: 'in_progress', started_at: null }],
    }))
    const closed = await closeStaleCheckRuns({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW,
    })
    expect(closed).toBe(0)
    expect(calls.filter((c) => c.route.startsWith('PATCH'))).toHaveLength(0)
  })

  it('closes a check run of any age when the caller says the attempt before it was killed', async () => {
    // The parameter is tested because it exists, not because a caller in this plan uses it yet.
    // Since 2026-09-18 the project allows three attempts (Criss, 2026-09-18, reversing answer 13), so a retried attempt
    // DOES come after a killed one. It still does not pass 0 — 0 would also close a concurrent
    // sibling run's check of the same name and sha — and closes the one run it replaces by id,
    // through closeCheckRunIfInProgress (Criss, 2026-09-24; its own cases are below). A caller that
    // KNOWS the run before it was killed may pass 0.
    const started = new Date(NOW.getTime() - 90_000).toISOString()   // ninety seconds ago
    const { octokit, calls } = fakeOctokit((route) =>
      route.startsWith('GET')
        ? { total_count: 1, check_runs: [{ id: 902, name: 'review-agent', status: 'in_progress', started_at: started }] }
        : { id: 7334 })
    const closed = await closeStaleCheckRuns({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW, staleAfterMs: 0,
    })
    expect(closed).toBe(1)
    expect(calls.find((c) => c.route.startsWith('PATCH'))?.params.check_run_id).toBe(902)
  })

  it('closes only its own abandoned run when the API ignores the filters it was sent', async () => {
    // Added 2026-09-14, not in the plan. Step 16 proved `check_name` and `status` are honoured
    // today, and Step 18 re-applies both client-side precisely so that the day they are not, this
    // still closes nothing but our own abandoned runs — but no case made that re-check bite:
    // deleting the line left all 32 green, because every fixture answered with matching runs only.
    // This is what an ignored filter looks like on the wire.
    const old = new Date(NOW.getTime() - STALE_AFTER_MS - 60_000).toISOString()
    const { octokit, calls } = fakeOctokit(() => ({
      total_count: 3,
      check_runs: [
        // Another app's check run on the same commit, equally old. Completing it would be this
        // product vandalising a stranger's build.
        { id: 800, name: 'codeql', status: 'in_progress', started_at: old },
        // One of ours that already finished: nothing to adopt, and a second PATCH would overwrite
        // the conclusion the review it belongs to just wrote.
        { id: 801, name: 'review-agent', status: 'completed', started_at: old },
        { id: 802, name: 'review-agent', status: 'in_progress', started_at: old },
      ],
    }))
    const closed = await closeStaleCheckRuns({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW,
    })
    expect(closed).toBe(1)
    const patches = calls.filter((c) => c.route.startsWith('PATCH'))
    expect(patches).toHaveLength(1)
    expect(patches[0].params.check_run_id).toBe(802)
  })

  it('creates the check run anyway when the sweep cannot be done', async () => {
    // Housekeeping must never cost a review. A stale check run left behind is a blemish; a
    // review that did not happen because a list call 403'd is a product that does not work.
    const calls: Call[] = []
    const octokit = {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params })
        if (route.startsWith('GET')) throw Object.assign(new Error('Resource not accessible'), { status: 403 })
        return { status: 200, headers: {}, data: { id: 7333 } }
      },
    } as unknown as Octokit
    const created = await createCheckRun({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW,
    })
    expect(created.id).toBe(7333)
    expect(calls.filter((c) => c.route.startsWith('POST'))).toHaveLength(1)
  })
})

import { CHECK_ACTION_LIMITS, RERUN_ACTION, RERUN_IDENTIFIER, completeCheckRun } from './check-run'

/** Everything completeCheckRun needs besides the address and the outcome: the gate, and the three
 *  settings checkRunOutput reads. Design §3.1's defaults, gate off. */
const CONTEXT = { gate: OPEN_GATE, mode: 'inline+summary' as const, maxInline: 15, bands: BANDS }

describe('completeCheckRun', () => {
  it('sets a conclusion and lets GitHub set the status', async () => {
    const { octokit, calls } = fakeOctokit(() => ({ id: 7331 }))
    const conclusion = await completeCheckRun({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 7331,
      outcome: reviewed([finding(8)]), ...CONTEXT, now: NOW,
    })
    // A finished review with the gate off concludes success (Criss, decision 5).
    expect(conclusion).toBe('success')
    expect(calls).toHaveLength(1)
    expect(calls[0].route).toBe('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}')
    expect(calls[0].params.conclusion).toBe('success')
    // "Providing conclusion will automatically set the status parameter to completed" — sending
    // our own `status` as well would be a second source of truth for the same thing.
    expect(calls[0].params.status).toBeUndefined()
    expect(calls[0].params.completed_at).toBe('2026-09-14T12:00:00.000Z')
    expect(calls[0].params.output).toEqual(checkRunOutput({ outcome: reviewed([finding(8)]), ...CONTEXT }))
  })

  it('offers the Re-run button, within GitHub’s limits on actions', async () => {
    const { octokit, calls } = fakeOctokit(() => ({ id: 7331 }))
    await completeCheckRun({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 7331,
      outcome: reviewed([]), ...CONTEXT, now: NOW,
    })
    const actions = calls[0].params.actions as { label: string; description: string; identifier: string }[]
    expect(actions).toEqual([RERUN_ACTION])
    // Over any of these GitHub answers 422, or accepts the call and shows no button at all —
    // which is worse, because nothing says the feature is gone.
    expect(actions.length).toBeLessThanOrEqual(CHECK_ACTION_LIMITS.actions)
    for (const action of actions) {
      expect(action.label.length).toBeLessThanOrEqual(CHECK_ACTION_LIMITS.label)
      expect(action.description.length).toBeLessThanOrEqual(CHECK_ACTION_LIMITS.description)
      expect(action.identifier.length).toBeLessThanOrEqual(CHECK_ACTION_LIMITS.identifier)
    }
    // design §5: the button repeats the last request. This identifier is what comes back on the
    // `check_run.requested_action` webhook, and Task 10 matches the delivery on it.
    expect(RERUN_ACTION.identifier).toBe(RERUN_IDENTIFIER)
  })

  it('does not offer a Re-run button while the review is still running', async () => {
    // A second click would buy a second review of the same commit. The button belongs on a check
    // run that has finished, where re-running is the only thing left to do.
    const { octokit, calls } = fakeOctokit((route) => route.startsWith('GET') ? noStale : { id: 7331 })
    await createCheckRun({
      octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', now: NOW,
    })
    const post = calls.find((c) => c.route.startsWith('POST'))
    expect(post?.params.actions).toBeUndefined()
  })

  it('passes a gated deployment’s failure straight through', async () => {
    const { octokit, calls } = fakeOctokit(() => ({ id: 7331 }))
    const conclusion = await completeCheckRun({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 7331,
      outcome: reviewed([finding(9)]), ...CONTEXT,
      gate: { failAtOrAbove: 9, requiresConfirmed: false }, now: NOW,
    })
    expect(conclusion).toBe('failure')
    expect(calls[0].params.conclusion).toBe('failure')
  })

  it('sends annotations in check-only, and the hidden verdict in every mode', async () => {
    // Criss, decision 7. The PATCH is what GitHub stores, so this is where "annotations only in
    // check-only" is true on the wire or not true at all.
    const checkOnly = fakeOctokit(() => ({ id: 7331 }))
    await completeCheckRun({
      octokit: checkOnly.octokit, owner: 'acme', repo: 'widgets', checkRunId: 7331,
      outcome: reviewed([finding(8)]), ...CONTEXT, mode: 'check-only', now: NOW,
    })
    const sentCheckOnly = checkOnly.calls[0].params.output as { text: string; annotations?: unknown[] }
    expect(sentCheckOnly.annotations).toHaveLength(1)
    expect(sentCheckOnly.text).toContain(VERDICT_OPEN)

    const inline = fakeOctokit(() => ({ id: 7331 }))
    await completeCheckRun({
      octokit: inline.octokit, owner: 'acme', repo: 'widgets', checkRunId: 7331,
      outcome: reviewed([finding(8)]), ...CONTEXT, now: NOW,
    })
    const sentInline = inline.calls[0].params.output as { text: string; annotations?: unknown[] }
    expect(sentInline.annotations).toBeUndefined()
    expect(sentInline.text).toContain(VERDICT_OPEN)
  })
})

// Added 2026-09-24 (Criss: "Fix it inside #6 first"). Since MAX_ATTEMPTS became 3, a retried attempt
// comes after a killed one. It must close the killed attempt's check run — and ONLY that one, never a
// concurrent sibling review's check of the same name and sha, which is why this takes an id rather
// than matching by name the way closeStaleCheckRuns does.
describe('closeCheckRunIfInProgress', () => {
  const run = (over: Record<string, unknown> = {}) =>
    ({ id: 902, name: 'review-agent', status: 'in_progress', head_sha: HEAD, ...over })

  it('closes the one check run it was given, by id, as abandoned', async () => {
    const { octokit, calls } = fakeOctokit((route) => (route.startsWith('GET') ? run() : { id: 902 }))
    const closed = await closeCheckRunIfInProgress({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 902, name: 'review-agent', headSha: HEAD, now: NOW,
    })
    expect(closed).toBe(true)
    const patch = calls.find((c) => c.route.startsWith('PATCH'))
    expect(patch?.params.check_run_id).toBe(902)
    expect(patch?.params.conclusion).toBe('neutral')
    // By id: it never lists the commit's check runs, so it cannot reach a sibling's.
    expect(calls.some((c) => c.route.includes('/commits/'))).toBe(false)
  })

  it('leaves a check run that is already completed exactly as it is', async () => {
    // The trap: the killed attempt may have FINISHED its check — posted a real conclusion — and
    // crashed afterwards. Completing it again would overwrite a verdict somebody can already see.
    const { octokit, calls } = fakeOctokit(() => run({ status: 'completed' }))
    const closed = await closeCheckRunIfInProgress({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 902, name: 'review-agent', headSha: HEAD, now: NOW,
    })
    expect(closed).toBe(false)
    expect(calls.some((c) => c.route.startsWith('PATCH'))).toBe(false)
  })

  it('leaves a check run with another name, or on another commit, alone', async () => {
    // A recalled id that somehow points elsewhere must close nothing. Both conditions are checked
    // on what GitHub returns, not trusted from what was remembered.
    for (const other of [run({ name: 'someone-elses-check' }), run({ head_sha: 'f'.repeat(40) })]) {
      const { octokit, calls } = fakeOctokit(() => other)
      const closed = await closeCheckRunIfInProgress({
        octokit, owner: 'acme', repo: 'widgets', checkRunId: 902, name: 'review-agent', headSha: HEAD, now: NOW,
      })
      expect(closed).toBe(false)
      expect(calls.some((c) => c.route.startsWith('PATCH'))).toBe(false)
    }
  })

  it('closes nothing when GitHub answers with something it cannot read', async () => {
    const { octokit, calls } = fakeOctokit(() => ({ unexpected: true }))
    const closed = await closeCheckRunIfInProgress({
      octokit, owner: 'acme', repo: 'widgets', checkRunId: 902, name: 'review-agent', headSha: HEAD, now: NOW,
    })
    expect(closed).toBe(false)
    expect(calls.some((c) => c.route.startsWith('PATCH'))).toBe(false)
  })
})


import type { Octokit } from '@octokit/core'
import type { Finding } from '@review-agent/core'
import { describe, expect, it, vi } from 'vitest'
import type { CheckOutcome } from './check-run'
import {
  MAX_STATUS_DESCRIPTION_CHARS, checkRunReporter, commitStatusReporter, noReporter, reporterFor,
  statusFor, tokenIdentityOf, type ReportStart,
} from './reporter'

type Call = { route: string; params: Record<string, unknown> }

/** A GitHub that records every request and answers each route with what the case says: a value, or
 *  an HTTP status to throw. A route nobody answered throws, so a request the product should not make
 *  fails the case rather than quietly succeeding. */
const fakeGitHub = (answers: Record<string, unknown | { status: number }>) => {
  const calls: Call[] = []
  const octokit = {
    request: async (route: string, params: Record<string, unknown> = {}) => {
      calls.push({ route, params })
      if (!(route in answers)) throw new Error(`the fake was asked for a route this case did not expect: ${route}`)
      const a = answers[route]
      if (typeof a === 'object' && a !== null && 'status' in a && typeof (a as { status: unknown }).status === 'number') {
        throw Object.assign(new Error(`HTTP ${(a as { status: number }).status}`), { status: (a as { status: number }).status })
      }
      return { status: 200, headers: {}, data: a }
    },
  } as unknown as Octokit
  return { octokit, calls }
}
const writes = (calls: Call[]): Call[] => calls.filter((c) => !c.route.startsWith('GET '))

const LIST_RUNS = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs'
const CREATE_RUN = 'POST /repos/{owner}/{repo}/check-runs'
const COMPLETE_RUN = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
const STATUS = 'POST /repos/{owner}/{repo}/statuses/{sha}'
const USER = 'GET /user'

const HEAD = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const SUMMARY = 'https://github.com/acme/widgets/pull/16#issuecomment-8100'
const startFor = (octokit: Octokit, over: Partial<ReportStart> = {}, logs: string[] = []): ReportStart => ({
  octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent',
  gate: { failAtOrAbove: null, requiresConfirmed: false }, mode: 'inline+summary', maxInline: 15,
  bands: { critical: 9, high: 7, medium: 4 }, log: (m) => { logs.push(m) }, ...over,
})

const finding = (severity: number): Finding => ({
  file: 'src/a.ts', line: 3, endLine: null, severity, category: 'correctness',
  title: `a finding at ${severity}`, explanation: 'e', evidence: [], suggestion: null,
})
const reviewed = (findings: Finding[], over: Partial<Extract<CheckOutcome, { kind: 'reviewed' }>> = {}): CheckOutcome => ({
  kind: 'reviewed', headSha: HEAD, tier: 'basic', model: 'claude-opus-5', costUsd: 0.21,
  findings, confirmed: null, cutShort: false, posted: findings.length, summaryUrl: SUMMARY, ...over,
})
const failed = (reason: string): CheckOutcome => ({ kind: 'failed', headSha: HEAD, reason })

describe('checkRunReporter', () => {
  const answers = {
    [LIST_RUNS]: { total_count: 0, check_runs: [] },
    [CREATE_RUN]: { id: 7331, html_url: 'https://github.com/acme/widgets/runs/7331' },
    [COMPLETE_RUN]: { id: 7331 },
  }

  it('opens a check run, hears its id at once, and completes it with the gate and the mode', async () => {
    const gh = fakeGitHub(answers)
    const heard: number[] = []
    const handle = await checkRunReporter({ onStarted: async (id) => { heard.push(id) } })
      .start(startFor(gh.octokit, { externalId: 'e30', mode: 'check-only' }))
    expect(handle).toMatchObject({ kind: 'check-run', id: 7331, url: 'https://github.com/acme/widgets/runs/7331' })
    expect(heard).toEqual([7331])
    expect(gh.calls.find((c) => c.route === CREATE_RUN)?.params).toMatchObject({ name: 'review-agent', head_sha: HEAD, external_id: 'e30' })

    const conclusion = await handle?.finish({ outcome: reviewed([finding(8)]) })
    expect(conclusion).toBe('success')
    const patch = gh.calls.find((c) => c.route === COMPLETE_RUN)?.params
    expect(patch?.conclusion).toBe('success')
    // check-only: the findings are the check run's annotations (decision 7).
    expect((patch?.output as { annotations?: unknown[] }).annotations).toHaveLength(1)
  })

  it('finishes at most once, so a review cannot overwrite its own verdict', async () => {
    const gh = fakeGitHub(answers)
    const handle = await checkRunReporter().start(startFor(gh.octokit))
    await handle?.finish({ outcome: reviewed([]) })
    expect(await handle?.finish({ outcome: failed('again') })).toBeNull()
    expect(gh.calls.filter((c) => c.route === COMPLETE_RUN)).toHaveLength(1)
  })

  it('never throws when GitHub will not complete it, and says so in the log', async () => {
    const logs: string[] = []
    const gh = fakeGitHub({ ...answers, [COMPLETE_RUN]: { status: 502 } })
    const handle = await checkRunReporter().start(startFor(gh.octokit, {}, logs))
    await expect(handle?.finish({ outcome: reviewed([]) })).resolves.toBeNull()
    expect(logs).toContain('the check run could not be completed')
  })

  it('goes on with the review when the caller could not record the id, and logs it', async () => {
    const logs: string[] = []
    const gh = fakeGitHub(answers)
    const handle = await checkRunReporter({ onStarted: async () => { throw new Error('metadata down') } })
      .start(startFor(gh.octokit, {}, logs))
    expect(handle?.id).toBe(7331)
    expect(logs).toContain('could not record the check run that was opened')
  })

  it('is an error, before anything is spent, when asked for by name and the token cannot create one (spec 0.2.0 §4.2)', async () => {
    const gh = fakeGitHub({ ...answers, [CREATE_RUN]: { status: 403 } })
    await expect(checkRunReporter().start(startFor(gh.octokit))).rejects.toMatchObject({ status: 403 })
    expect(gh.calls.some((c) => c.route === STATUS)).toBe(false)
  })

  it('falls back to a commit status on a 403 when it was chosen automatically', async () => {
    // An Actions token without `checks: write`, or a token tokenIdentityOf misjudged: the report
    // changes kind, the review goes on.
    const logs: string[] = []
    const gh = fakeGitHub({ ...answers, [CREATE_RUN]: { status: 403 }, [STATUS]: { id: 1 } })
    const handle = await checkRunReporter({ statusIfRefused: true }).start(startFor(gh.octokit, {}, logs))
    expect(handle?.kind).toBe('commit-status')
    expect(gh.calls.find((c) => c.route === STATUS)?.params).toMatchObject({ state: 'pending', context: 'review-agent', sha: HEAD })
    expect(logs).toContain('this token cannot create a check run; reporting with a commit status instead')
  })

  it('does not fall back on anything but a 403: a 500 is not an answer about the token', async () => {
    const gh = fakeGitHub({ ...answers, [CREATE_RUN]: { status: 500 } })
    await expect(checkRunReporter({ statusIfRefused: true }).start(startFor(gh.octokit))).rejects.toMatchObject({ status: 500 })
    expect(gh.calls.some((c) => c.route === STATUS)).toBe(false)
  })

  it('creates and completes through the calls it is handed, with exactly what it would send GitHub', async () => {
    // The App's runner hands in the two functions its own tests watch (0.2.0 Stage 6); the shapes
    // they are called with are the contract those tests were written against.
    const gh = fakeGitHub({})
    const createCheckRun = vi.fn(async () => ({ id: 4242, url: null }))
    const completeCheckRun = vi.fn(async () => 'neutral' as const)
    const handle = await checkRunReporter({ calls: { createCheckRun, completeCheckRun } })
      .start(startFor(gh.octokit, { externalId: 'eyJ0aWVyIjoibm9ybWFsIn0' }))
    expect(await handle?.finish({ outcome: failed('stopped') })).toBe('neutral')
    expect(createCheckRun.mock.calls).toEqual([[{
      octokit: gh.octokit, owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent', externalId: 'eyJ0aWVyIjoibm9ybWFsIn0',
    }]])
    expect(completeCheckRun.mock.calls).toEqual([[{
      octokit: gh.octokit, owner: 'acme', repo: 'widgets', checkRunId: 4242, outcome: failed('stopped'),
      gate: { failAtOrAbove: null, requiresConfirmed: false }, mode: 'inline+summary', maxInline: 15,
      bands: { critical: 9, high: 7, medium: 4 },
    }]])
    expect(gh.calls).toEqual([])
  })
})

describe('commitStatusReporter', () => {
  it('sets pending at the start and the final state at the end, under the check-run name, linking the summary', async () => {
    const gh = fakeGitHub({ [STATUS]: { id: 1 } })
    const handle = await commitStatusReporter().start(startFor(gh.octokit))
    expect(handle).toMatchObject({ kind: 'commit-status', id: null, url: null })
    const conclusion = await handle?.finish({ outcome: reviewed([finding(6)]), summaryUrl: SUMMARY })
    expect(conclusion).toBe('success')
    expect(handle?.url).toBe(SUMMARY)
    const [pending, done] = gh.calls.map((c) => c.params)
    expect(pending).toMatchObject({ owner: 'acme', repo: 'widgets', sha: HEAD, state: 'pending', context: 'review-agent' })
    expect(pending?.target_url).toBeUndefined()
    expect(done).toMatchObject({ sha: HEAD, state: 'success', context: 'review-agent', description: '1 finding, worst 6/10', target_url: SUMMARY })
  })

  it('reports a review that did not run as success, saying it is not a verdict (decision §14.2)', async () => {
    // Statuses have no neutral. An outage must never block a merge, and a green tick must never be
    // read as a clean review: the description is the difference.
    const gh = fakeGitHub({ [STATUS]: { id: 1 } })
    const handle = await commitStatusReporter().start(startFor(gh.octokit))
    const conclusion = await handle?.finish({ outcome: failed('the reviewer process crashed (exit 1)') })
    expect(conclusion).toBe('neutral')
    expect(gh.calls[1]?.params).toMatchObject({
      state: 'success',
      description: 'Not a verdict: the review did not finish — the reviewer process crashed (exit 1)',
    })
  })

  it('reports a review its runner stopped as error, which the next run replaces (spec 0.2.0 §5.4)', async () => {
    const gh = fakeGitHub({ [STATUS]: { id: 1 } })
    const handle = await commitStatusReporter().start(startFor(gh.octokit))
    await handle?.finish({ outcome: failed('the review was cancelled'), interrupted: true })
    expect(gh.calls[1]?.params.state).toBe('error')
  })

  it('fails the commit only through the gate, exactly as a check run would', async () => {
    const gh = fakeGitHub({ [STATUS]: { id: 1 } })
    const handle = await commitStatusReporter().start(startFor(gh.octokit, { gate: { failAtOrAbove: 7, requiresConfirmed: false } }))
    expect(await handle?.finish({ outcome: reviewed([finding(8), finding(3)]) })).toBe('failure')
    expect(gh.calls[1]?.params).toMatchObject({ state: 'failure', description: '2 findings, worst 8/10, at or above the gate of 7/10' })
  })

  it('is an error at the start, before anything is spent, when the token cannot set a status', async () => {
    const gh = fakeGitHub({ [STATUS]: { status: 403 } })
    await expect(commitStatusReporter().start(startFor(gh.octokit))).rejects.toMatchObject({ status: 403 })
  })

  it('never throws at the end, finishes once, and links nothing that is not http(s)', async () => {
    const logs: string[] = []
    let n = 0
    const octokit = {
      request: async (_route: string, params: Record<string, unknown>) => {
        n += 1
        if (n === 2) throw Object.assign(new Error('HTTP 502'), { status: 502 })
        return { status: 201, headers: {}, data: { id: n, params } }
      },
    } as unknown as Octokit
    const handle = await commitStatusReporter().start(startFor(octokit, {}, logs))
    await expect(handle?.finish({ outcome: reviewed([]), summaryUrl: 'javascript:alert(1)' })).resolves.toBeNull()
    expect(logs).toContain('the commit status could not be completed')
    expect(await handle?.finish({ outcome: reviewed([]) })).toBeNull()
    expect(n).toBe(2)
  })
})

describe('statusFor', () => {
  const gate = { failAtOrAbove: null, requiresConfirmed: false }

  it('says what the review found, and that it was cut short when it was', () => {
    expect(statusFor({ outcome: reviewed([]), gate })).toEqual({ state: 'success', conclusion: 'success', description: 'No findings' })
    expect(statusFor({ outcome: reviewed([finding(4), finding(9)], { cutShort: true }), gate }).description)
      .toBe('2 findings, worst 9/10; cut short by its budget ceiling')
  })

  it('reports what a finished review found even when the stop landed after it finished', () => {
    // The session publishes such a review (Criss, 2026-09-16); its status must not say it was cut off.
    expect(statusFor({ outcome: reviewed([]), gate, interrupted: true }).state).toBe('success')
    expect(statusFor({ outcome: failed('the review was cancelled'), gate, interrupted: true }).state).toBe('error')
  })

  it('reports every kind of review that did not run as success, never as a verdict', () => {
    for (const outcome of [
      failed('a reason'),
      { kind: 'refused', headSha: HEAD, reason: '@mallory cannot push here' } as const,
      { kind: 'abandoned', headSha: HEAD } as const,
    ]) {
      const s = statusFor({ outcome, gate: { failAtOrAbove: 1, requiresConfirmed: false } })
      expect(s.state).toBe('success')
      expect(s.conclusion).toBe('neutral')
      expect(s.description.startsWith('Not a verdict: ')).toBe(true)
    }
  })

  it(`clips a description to ${MAX_STATUS_DESCRIPTION_CHARS} characters, on one line`, () => {
    const s = statusFor({ outcome: failed(`line one\n\nline two ${'é'.repeat(300)}`), gate })
    expect(Array.from(s.description)).toHaveLength(MAX_STATUS_DESCRIPTION_CHARS)
    expect(s.description.endsWith('…')).toBe(true)
    expect(s.description).not.toContain('\n')
    expect(s.description).toContain('line one line two')
  })
})

describe('noReporter', () => {
  it('reports nothing and asks GitHub nothing', async () => {
    const gh = fakeGitHub({})
    expect(await noReporter.start(startFor(gh.octokit))).toBeNull()
    expect(gh.calls).toEqual([])
  })
})

describe('tokenIdentityOf: one read decides what the token can report with', () => {
  it('knows a user token by its user, and keeps the login', async () => {
    const gh = fakeGitHub({ [USER]: { login: 'alice', id: 1 } })
    expect(await tokenIdentityOf(gh.octokit)).toEqual({ kind: 'user', login: 'alice' })
    expect(gh.calls).toEqual([{ route: USER, params: {} }])
  })

  it('keeps a classic token’s scope names from the same answer, and no header as no scopes', async () => {
    const withScopes = {
      request: async () => ({ status: 200, headers: { 'x-oauth-scopes': 'repo, read:org' }, data: { login: 'alice' } }),
    } as unknown as Octokit
    expect(await tokenIdentityOf(withScopes)).toEqual({ kind: 'user', login: 'alice', scopes: ['repo', 'read:org'] })
    // A classic token with no scope at all sends the header empty: that is "none", not "unknown".
    const noScope = {
      request: async () => ({ status: 200, headers: { 'x-oauth-scopes': '' }, data: { login: 'alice' } }),
    } as unknown as Octokit
    expect(await tokenIdentityOf(noScope)).toEqual({ kind: 'user', login: 'alice', scopes: [] })
  })

  it('knows an installation token by GitHub refusing it a user', async () => {
    const gh = fakeGitHub({ [USER]: { status: 403 } })
    expect(await tokenIdentityOf(gh.octokit)).toEqual({ kind: 'installation' })
  })

  it('lets a bad token, an outage or a malformed answer out rather than guessing', async () => {
    await expect(tokenIdentityOf(fakeGitHub({ [USER]: { status: 401 } }).octokit)).rejects.toMatchObject({ status: 401 })
    await expect(tokenIdentityOf(fakeGitHub({ [USER]: { status: 503 } }).octokit)).rejects.toMatchObject({ status: 503 })
    await expect(tokenIdentityOf(fakeGitHub({ [USER]: { id: 1 } }).octokit)).rejects.toThrow()
  })
})

describe('reporterFor (spec 0.2.0 §2.2)', () => {
  it('reports with a commit status for a person’s token, decided with one call and no write', async () => {
    const gh = fakeGitHub({ [USER]: { login: 'alice' } })
    const r = await reporterFor({ octokit: gh.octokit, want: 'auto' })
    expect(r.kind).toBe('commit-status')
    expect(gh.calls.map((c) => c.route)).toEqual([USER])
    expect(writes(gh.calls)).toEqual([])
  })

  it('reports with a check run for an installation token, falling back to a status if refused', async () => {
    const gh = fakeGitHub({
      [USER]: { status: 403 }, [LIST_RUNS]: { total_count: 0, check_runs: [] },
      [CREATE_RUN]: { status: 403 }, [STATUS]: { id: 1 },
    })
    const r = await reporterFor({ octokit: gh.octokit, want: 'auto' })
    expect(r.kind).toBe('check-run')
    expect((await r.start(startFor(gh.octokit)))?.kind).toBe('commit-status')
  })

  it('asks GitHub nothing when the caller already knows the token, or named the kind', async () => {
    const gh = fakeGitHub({})
    expect((await reporterFor({ octokit: gh.octokit, want: 'auto', identity: { kind: 'user', login: 'alice' } })).kind).toBe('commit-status')
    expect((await reporterFor({ octokit: gh.octokit, want: 'auto', identity: { kind: 'installation' } })).kind).toBe('check-run')
    expect((await reporterFor({ octokit: gh.octokit, want: 'check-run' })).kind).toBe('check-run')
    expect((await reporterFor({ octokit: gh.octokit, want: 'commit-status' })).kind).toBe('commit-status')
    expect(await reporterFor({ octokit: gh.octokit, want: 'none' })).toBe(noReporter)
    expect(gh.calls).toEqual([])
  })

  it('does not fall back when the check run was asked for by name', async () => {
    const gh = fakeGitHub({ [LIST_RUNS]: { total_count: 0, check_runs: [] }, [CREATE_RUN]: { status: 403 } })
    const r = await reporterFor({ octokit: gh.octokit, want: 'check-run' })
    await expect(r.start(startFor(gh.octokit))).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a kind it does not know, as a programmer’s error', async () => {
    await expect(reporterFor({ octokit: fakeGitHub({}).octokit, want: 'status' as never })).rejects.toThrow(TypeError)
  })
})

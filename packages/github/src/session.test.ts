import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, SecretLeak, SecretValue,
  type CheckVerdict, type ClaudeRuntime, type DeploymentConfig, type EngineInput, type EngineResult,
  type Finding, type RecheckPassResult, type RepoConfig, type ReportMode, type ReviewOutput, type Usage,
} from '@review-agent/core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { VERDICT_OPEN } from './check-run'
import { decodeMarker, encodeMarker, findingId, type MarkerState } from './marker'
import type { PullRequestContext } from './pr'
import { MULTI_REFUSED } from './refusals'
import { checkRunReporter, commitStatusReporter, type Reporter } from './reporter'
import type { FocusRunsOutcome, ReviewAsk, RunReviewDeps } from './run-review'
import {
  failureSentence, mayRetry, postedCommentsOf, prepareReview, runReviewSession, saidSafely,
  type PreparedReview, type SessionDeps, type SessionResult,
} from './session'

const HEAD_SHA = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const BASE_SHA = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'
const OLD_SHA = '1'.repeat(40)
/** A GitHub token's shape with a nonsense body, which core's scanner matches. */
const LEAKED_TOKEN = 'ghp_' + 'A'.repeat(36)

// One hunk whose new side is lines 98 to 103, so line 100 can carry an inline comment.
const PATCH = '@@ -98,2 +98,6 @@\n context\n+a\n+b\n+c\n+d\n context\n'
const FILE = '.github/workflows/publish.yml'
const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16, headSha: HEAD_SHA, baseSha: BASE_SHA,
  title: 'ci(publish): refuse a tag that does not match package.json', body: '',
  changedFiles: [{ path: FILE, status: 'modified', patch: PATCH }], diff: '',
}
const FINDING: Finding = {
  file: FILE, line: 100, endLine: null, severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes',
  explanation: 'A tag pushed from any branch publishes that branch.', evidence: [], suggestion: null,
}
const OUTPUT: ReviewOutput = {
  summary: 'Adds a tag check to publish.yml.',
  intent: { verdict: 'matches', note: 'It does what the description says.' },
  findings: [FINDING], inconclusive: [],
}
// A measured basic-tier run (design §8), at per-token API prices.
const USAGE: Usage = {
  costUsd: 0.345, inputTokens: 18, outputTokens: 3333, cacheReadTokens: 121_660,
  cacheWriteTokens: 19_864, turns: 10, durationMs: 51_900,
}
const CHECK_USAGE: Usage = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104, cacheReadTokens: 61_230,
  cacheWriteTokens: 18_944, turns: 8, durationMs: 41_022,
}
const NOTHING: Usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 }
const RESULT: EngineResult = { output: OUTPUT, usage: USAGE, cutShort: false, wrapUpFired: false, failure: null }
const NO_RECHECK: RecheckPassResult = { judgements: [], ran: false, skipped: 'nothing-to-ask', usage: NOTHING }

// Every checkout this file makes lives under one directory, so nothing is left behind.
const ROOT = mkdtempSync(join(tmpdir(), 'ra-session-'))
afterAll(async () => { await rm(ROOT, { recursive: true, force: true }) })

/** The real `runReview`'s collaborators, minus GitHub and the model: a checkout that really exists —
 *  anchoring reads the line each finding points at — and an engine that answers what the case says. */
const runReviewDeps = (over: Partial<RunReviewDeps> = {}): RunReviewDeps => ({
  fetchPullRequest: vi.fn(async () => { throw new Error('the session must not fetch the pull request again') }),
  fetchRepoConfig: vi.fn(async () => { throw new Error('the session must not fetch the repo config again') }),
  downloadArchive: vi.fn(async (a: { destDir: string }) => {
    mkdirSync(join(a.destDir, '.github/workflows'), { recursive: true })
    writeFileSync(join(a.destDir, FILE), Array.from({ length: 130 }, (_, i) => `    - run: step-${i + 1}`).join('\n') + '\n')
    return { dir: a.destDir, removed: [], notWritten: [], caseCollisions: [] }
  }),
  materialiseSkills: vi.fn(async () => []),
  runEngine: vi.fn(async () => RESULT),
  runCheckPass: vi.fn(async () => ({ verdicts: [] as CheckVerdict[], usage: CHECK_USAGE })),
  runRecheckPass: vi.fn(async () => NO_RECHECK),
  makeCheckoutDir: vi.fn(async () => mkdtempSync(join(ROOT, 'checkout-'))),
  skillCacheDir: () => join(ROOT, 'skills'),
  now: () => new Date('2026-10-15T10:00:00.000Z'),
  note: () => undefined,
  ...over,
})

type Call = { route: string; params: Record<string, unknown> }
type IssueComment = { id: number; body: string; user: { login: string } | null }
type ReviewComment = {
  id: number; path: string; line: number | null; body: string
  pull_request_review_id: number | null; in_reply_to_id: number | null; user: { login: string } | null
}

const LIST_RUNS = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs'
const CREATE_RUN = 'POST /repos/{owner}/{repo}/check-runs'
const COMPLETE_RUN = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
const STATUS = 'POST /repos/{owner}/{repo}/statuses/{sha}'
const SUMMARY_LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_CREATE = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
const SUMMARY_EDIT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
const REVIEW_CREATE = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews'
const REVIEW_COMMENTS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments'

/** A small GitHub that remembers what is written to it, enough for a whole session: check runs,
 *  statuses, the summary comment and a review with its inline comments. */
const fakeGitHub = (seed: {
  issueComments?: IssueComment[]; reviewComments?: ReviewComment[]
  fail?: Partial<Record<string, number>>
} = {}) => {
  const calls: Call[] = []
  const issueComments = [...(seed.issueComments ?? [])]
  const reviewComments = [...(seed.reviewComments ?? [])]
  let nextComment = 5001
  const request = async (route: string, params: Record<string, unknown> = {}) => {
    calls.push({ route, params })
    const status = seed.fail?.[route]
    if (status !== undefined) throw Object.assign(new Error(`HTTP ${status}`), { status })
    const ok = (data: unknown) => ({ status: 200, headers: {}, data })
    switch (route) {
      case LIST_RUNS: return ok({ total_count: 0, check_runs: [] })
      case CREATE_RUN: return ok({ id: 4242, html_url: 'https://github.com/acme/widgets/runs/4242' })
      case COMPLETE_RUN: return ok({ id: 4242 })
      case STATUS: return ok({ id: 1 })
      case SUMMARY_LIST: return ok(issueComments.slice((Number(params.page ?? 1) - 1) * 100, Number(params.page ?? 1) * 100))
      case SUMMARY_CREATE: {
        issueComments.push({ id: 8100, body: String(params.body), user: { login: 'review-agent[bot]' } })
        return ok({ id: 8100, html_url: 'https://github.com/acme/widgets/pull/16#issuecomment-8100' })
      }
      case SUMMARY_EDIT: return ok({ id: params.comment_id, html_url: `https://github.com/acme/widgets/pull/16#issuecomment-${String(params.comment_id)}` })
      case REVIEW_CREATE: {
        for (const c of params.comments as { path: string; line: number; body: string }[]) {
          reviewComments.push({ id: nextComment++, path: c.path, line: c.line, body: c.body, pull_request_review_id: 900, in_reply_to_id: null, user: { login: 'review-agent[bot]' } })
        }
        return ok({ id: 900 })
      }
      case REVIEW_COMMENTS: return ok(reviewComments)
      default: throw new Error(`the fake was asked for a route the session should not call: ${route}`)
    }
  }
  return { octokit: { request } as unknown as Octokit, calls }
}
const only = (calls: Call[], route: string): Call[] => calls.filter((c) => c.route === route)
const writes = (calls: Call[]): string[] => calls.map((c) => c.route).filter((r) => !r.startsWith('GET '))

const deploymentIn = (mode: ReportMode = 'inline+summary', allowMulti = true): DeploymentConfig => {
  const d = defaultDeploymentConfig()
  d.report.mode = mode
  d.allowMulti = allowMulti
  return d
}

/** What a caller gets from prepareReview, with GitHub's two reads answered in place. */
const prepare = async (a: {
  octokit: Octokit; mode?: ReportMode; ask?: ReviewAsk; repoConfig?: RepoConfig | null; allowMulti?: boolean
}): Promise<PreparedReview> => {
  const p = await prepareReview({
    octokit: a.octokit, owner: 'acme', repo: 'widgets', number: 16,
    deployment: deploymentIn(a.mode, a.allowMulti), ask: a.ask ?? {},
    deps: { fetchPullRequest: async () => PR, fetchRepoConfig: async () => a.repoConfig ?? null },
  })
  if (p.kind !== 'prepared') throw new Error(`expected a prepared review, got ${p.kind}`)
  return p
}

const session = async (a: {
  gh: ReturnType<typeof fakeGitHub>; post?: boolean; reporter?: Reporter; mode?: ReportMode
  deps?: Partial<RunReviewDeps>; ask?: ReviewAsk; repoConfig?: RepoConfig | null
  findSummaryComment?: SessionDeps['findSummaryComment']
  extra?: Partial<Parameters<typeof runReviewSession>[0]>
  allowMulti?: boolean
}): Promise<{ result: SessionResult; deps: RunReviewDeps; logs: string[] }> => {
  const deps = runReviewDeps(a.deps)
  const logs: string[] = []
  const prepared = await prepare({
    octokit: a.gh.octokit, mode: a.mode, ask: a.ask, repoConfig: a.repoConfig, allowMulti: a.allowMulti,
  })
  const result = await runReviewSession({
    prepared, post: a.post ?? true, via: { kind: 'cli', login: 'alice' },
    ...(a.reporter !== undefined && { reporter: a.reporter }),
    deps: {
      runReviewDeps: deps, log: (m) => { logs.push(m) },
      ...(a.findSummaryComment !== undefined && { findSummaryComment: a.findSummaryComment }),
    },
    ...a.extra,
  })
  return { result, deps, logs }
}

const expectKind = <K extends SessionResult['kind']>(r: SessionResult, kind: K): Extract<SessionResult, { kind: K }> => {
  if (r.kind !== kind) throw new Error(`expected ${kind}, got ${r.kind}: ${'reason' in r ? r.reason : ''}`)
  return r as Extract<SessionResult, { kind: K }>
}

/** The failed reason a check run was completed with, as everyone who can see the pull request reads it. */
const checkRunSummary = (calls: Call[]): string =>
  String((only(calls, COMPLETE_RUN)[0]?.params.output as { summary: string } | undefined)?.summary ?? '')

describe('prepareReview (spec 0.2.0 §3)', () => {
  it('reads the pull request, then the repository file from the BASE commit, and resolves at the head', async () => {
    const fetchRepoConfig = vi.fn(async () => ({ postInlineAtOrAbove: 7 }))
    const p = await prepareReview({
      octokit: {} as Octokit, owner: 'acme', repo: 'widgets', number: 16, deployment: deploymentIn(),
      ask: { tier: 'normal' }, deps: { fetchPullRequest: async () => PR, fetchRepoConfig },
    })
    if (p.kind !== 'prepared') throw new Error('expected prepared')
    expect(fetchRepoConfig.mock.calls[0]).toEqual([expect.objectContaining({ baseRef: BASE_SHA })])
    expect(p.settings.tier).toBe('normal')
    expect(p.settings.severity.postInlineAtOrAbove).toBe(7)
    expect(p.pr.headSha).toBe(HEAD_SHA)
  })

  it('honours --multi with any tier, for every way in, now that the mode is built (spec 0.2.0 §8.3)', async () => {
    const p = await prepare({ octokit: {} as Octokit, ask: { multi: true, tier: 'thorough' } })
    expect(p.ask).toEqual({ tier: 'thorough', multi: true })
    expect(p.refused).toEqual([])
    expect(p.settings.tier).toBe('thorough')
    expect(p.settings.multi).toBe(true)
  })

  it('refuses --multi a deployment switched off, for every way in, and names it (spec 0.2.0 §14.19)', async () => {
    const p = await prepare({ octokit: {} as Octokit, ask: { multi: true, tier: 'thorough' }, allowMulti: false })
    expect(p.ask).toEqual({ tier: 'thorough' })
    expect(p.refused).toEqual([MULTI_REFUSED])
    expect(p.settings.tier).toBe('thorough')
    expect(p.settings.multi).toBe(false)
  })

  it('returns GitHub’s refusal as a failure that spent nothing, with any token in it withheld', async () => {
    const p = await prepareReview({
      octokit: {} as Octokit, owner: 'acme', repo: 'widgets', number: 16, deployment: deploymentIn(), ask: {},
      deps: { fetchPullRequest: async () => { throw new Error(`Bad credentials for ${LEAKED_TOKEN}`) } },
    })
    expect(p).toMatchObject({ kind: 'failed', stage: 'before-model', retryable: true, spentUsd: 0, engineStarted: false })
    expect(JSON.stringify({ ...p, cause: undefined })).not.toContain(LEAKED_TOKEN)
  })

  it('throws only for a programmer’s error', async () => {
    await expect(prepareReview({
      octokit: {} as Octokit, owner: 'acme', repo: 'widgets', number: 0, deployment: deploymentIn(), ask: {},
    })).rejects.toThrow(TypeError)
  })
})

describe('runReviewSession: posting (spec 0.2.0 §3)', () => {
  it('reports with a check run, reviews, posts, and finishes the report linking the summary', async () => {
    const gh = fakeGitHub()
    const { result } = await session({ gh, reporter: checkRunReporter() })
    const r = expectKind(result, 'reviewed')

    // The report opens before the review is paid for, and closes after it is posted.
    expect(writes(gh.calls)).toEqual([CREATE_RUN, REVIEW_CREATE, SUMMARY_CREATE, COMPLETE_RUN])
    expect(r.report).toEqual({ kind: 'check-run', id: 4242, url: 'https://github.com/acme/widgets/runs/4242', conclusion: 'success' })
    expect(r.verdict).toContain(VERDICT_OPEN)
    expect(r.comments).toEqual([{ findingId: findingId(FINDING), file: FILE, line: 100, commentId: 5001 }])
    // GitHub's own link to the summary, now that publishing hands one back.
    expect(checkRunSummary(gh.calls)).toContain('[The full summary](https://github.com/acme/widgets/pull/16#issuecomment-8100)')
    // Every body says it is automated and who ran it (§5.6).
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body).split('\n')[0]).toContain('run by @alice from the command line')
    expect(r.record.costUsd).toBeCloseTo(0.345 + 0.1131, 6)
  })

  it('removes the downloaded code when it is done, unless asked to keep it (spec 0.2.0 §3.3)', async () => {
    const gone = await session({ gh: fakeGitHub(), reporter: checkRunReporter() })
    const dir = expectKind(gone.result, 'reviewed').review.checkoutDir
    expect(existsSync(dir)).toBe(false)
    expect(expectKind(gone.result, 'reviewed').checkoutDir).toBeNull()

    const kept = await session({ gh: fakeGitHub(), reporter: checkRunReporter(), extra: { keepCheckout: true } })
    const keptDir = expectKind(kept.result, 'reviewed').checkoutDir
    expect(keptDir).not.toBeNull()
    expect(existsSync(String(keptDir))).toBe(true)
  })

  it('carries the credential it is given into every pass (spec 0.2.0 §3.2)', async () => {
    const runtime: ClaudeRuntime = { credential: { kind: 'api-key', value: new SecretValue('sk-ant-api-FAKE') } }
    const { deps } = await session({ gh: fakeGitHub(), reporter: checkRunReporter(), extra: { runtime } })
    expect(vi.mocked(deps.runEngine).mock.calls[0][0].runtime).toBe(runtime)
  })

  it('reports nothing in silent mode, and still hands back what the review would have said', async () => {
    const gh = fakeGitHub()
    const r = expectKind((await session({ gh, mode: 'silent', reporter: checkRunReporter() })).result, 'reviewed')
    expect(writes(gh.calls)).toEqual([])
    expect(r.report).toBeNull()
    expect(r.published?.findings.map((f) => f.title)).toEqual([FINDING.title])
    expect(r.verdict).toContain(VERDICT_OPEN)
  })

  it('names in the summary, once, what the caller and the preparation refused', async () => {
    const gh = fakeGitHub()
    await session({
      gh, reporter: checkRunReporter(), ask: { multi: true }, allowMulti: false, extra: { refused: [MULTI_REFUSED] },
    })
    const body = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(body.split(MULTI_REFUSED)).toHaveLength(2)
  })

  it('passes the external id to a check run, so the App’s Re-run button can repeat the settings', async () => {
    const gh = fakeGitHub()
    await session({ gh, reporter: checkRunReporter(), extra: { externalId: 'eyJ0aWVyIjoibm9ybWFsIn0' } })
    expect(only(gh.calls, CREATE_RUN)[0].params.external_id).toBe('eyJ0aWVyIjoibm9ybWFsIn0')
  })
})

describe('runReviewSession: reporting with a commit status (spec 0.2.0 §2.2, §14.2, §14.3)', () => {
  it('sets pending before the review and success after, linking the summary comment', async () => {
    const gh = fakeGitHub()
    const r = expectKind((await session({ gh, reporter: commitStatusReporter() })).result, 'reviewed')
    expect(writes(gh.calls)).toEqual([STATUS, REVIEW_CREATE, SUMMARY_CREATE, STATUS])
    const [pending, done] = only(gh.calls, STATUS).map((c) => c.params)
    expect(pending).toMatchObject({ state: 'pending', context: 'review-agent', sha: HEAD_SHA })
    expect(done).toMatchObject({ state: 'success', target_url: 'https://github.com/acme/widgets/pull/16#issuecomment-8100' })
    expect(r.report).toMatchObject({ kind: 'commit-status', conclusion: 'success', url: 'https://github.com/acme/widgets/pull/16#issuecomment-8100' })
  })

  it('puts a check-only review’s findings in the summary when no check run can carry them (decision §14.3)', async () => {
    const gh = fakeGitHub()
    const r = expectKind((await session({ gh, mode: 'check-only', reporter: commitStatusReporter() })).result, 'reviewed')
    // No inline comments: still not a review on the lines. But the findings are said somewhere.
    expect(only(gh.calls, REVIEW_CREATE)).toEqual([])
    const body = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(body).toContain('#### Not placed inline')
    expect(body).toContain(FINDING.title)
    // The review ran as summary-only from the start, so the record says what it did.
    expect(r.record.settings.report.mode).toBe('summary-only')
    expect(r.published?.mode).toBe('summary-only')
  })

  it('still does so when it is the repository that lowered the mode to check-only', async () => {
    const gh = fakeGitHub()
    const r = expectKind((await session({ gh, repoConfig: { mode: 'check-only', postInlineAtOrAbove: 7 }, reporter: commitStatusReporter() })).result, 'reviewed')
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain(FINDING.title)
    // The repository's other settings still apply.
    expect(r.record.settings.severity.postInlineAtOrAbove).toBe(7)
  })

  it('keeps check-only to the check run when there is one to carry the findings', async () => {
    const gh = fakeGitHub()
    await session({ gh, mode: 'check-only', reporter: checkRunReporter() })
    expect(writes(gh.calls)).toEqual([CREATE_RUN, COMPLETE_RUN])
    expect((only(gh.calls, COMPLETE_RUN)[0].params.output as { annotations?: unknown[] }).annotations).toHaveLength(1)
  })

  it('says error, not success, when whoever ran it stopped it (spec 0.2.0 §5.4)', async () => {
    const stop = new AbortController()
    const gh = fakeGitHub()
    const { result } = await session({
      gh, reporter: commitStatusReporter(),
      deps: {
        runEngine: vi.fn(async (input: EngineInput) => {
          stop.abort()
          return await new Promise<EngineResult>((resolve) => {
            if (input.signal?.aborted === true) resolve({ output: null, usage: USAGE, cutShort: false, wrapUpFired: false, failure: { kind: 'crashed', code: null, stderr: '' } })
          })
        }),
      },
      extra: { signal: stop.signal },
    })
    expect(expectKind(result, 'unfinished')).toMatchObject({ stopped: 'cancelled', retryable: false })
    expect(only(gh.calls, STATUS).map((c) => c.params.state)).toEqual(['pending', 'error'])
  })
})

describe('runReviewSession: reading only (post: false — the CLI today)', () => {
  it('asks GitHub nothing, writes nothing, reports nothing and buys no re-review pass', async () => {
    const summary: MarkerState = { version: 1, runs: [{ headSha: OLD_SHA, at: '2026-10-14T10:00:00.000Z', findings: [
      { id: findingId(FINDING), file: FILE, line: 100, severity: 6, title: FINDING.title, commentId: 101, outcome: 'open' },
    ] }] }
    const gh = fakeGitHub({ issueComments: [{ id: 9002, body: `x\n\n${encodeMarker(summary)}\n`, user: { login: 'review-agent[bot]' } }] })
    const start = vi.fn(async () => null)
    const { result, deps } = await session({ gh, post: false, reporter: { kind: 'check-run', start } })
    const r = expectKind(result, 'reviewed')
    expect(gh.calls).toEqual([])
    expect(start).not.toHaveBeenCalled()
    expect(deps.runRecheckPass).not.toHaveBeenCalled()
    expect(r).toMatchObject({ published: null, report: null, verdict: null, comments: [] })
    expect(r.record.output?.findings).toEqual([FINDING])
  })
})

describe('runReviewSession: a re-review (spec 0.2.0 §3.3)', () => {
  const lastState: MarkerState = { version: 1, runs: [{ headSha: OLD_SHA, at: '2026-10-14T10:00:00.000Z', findings: [
    { id: findingId(FINDING), file: FILE, line: 100, severity: 6, title: FINDING.title, commentId: 101, outcome: 'open' },
  ] }] }
  const summaryBy = (id: number, login: string): IssueComment =>
    ({ id, body: `### Review of \`1111111\`\n\n${encodeMarker(lastState)}\n`, user: { login } })
  const theirComment = (login: string): ReviewComment[] => [
    { id: 101, path: FILE, line: 100, body: '**Severity 6/10** · security', pull_request_review_id: 700, in_reply_to_id: null, user: { login } },
    { id: 102, path: FILE, line: 100, body: '/dispute only maintainers can push tags', pull_request_review_id: 701, in_reply_to_id: 101, user: { login } },
  ]

  it('reads the previous marker before the review and asks the re-review pass about it', async () => {
    const gh = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]')], reviewComments: theirComment('review-agent[bot]') })
    const { deps } = await session({ gh, reporter: checkRunReporter() })
    expect(vi.mocked(deps.runRecheckPass).mock.calls[0][0].previous.map((q) => q.title)).toEqual([FINDING.title])
    // One listing for the whole session: the comment the state came from is the one edited.
    expect(only(gh.calls, SUMMARY_LIST)).toHaveLength(1)
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9002)
  })

  it('buys no re-review pass when told not to, and still edits the summary it found rather than posting a second (spec 0.2.0 §5.2)', async () => {
    const gh = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]')] })
    const { result, deps } = await session({ gh, reporter: checkRunReporter(), extra: { reReview: false } })
    expect(deps.runRecheckPass).not.toHaveBeenCalled()
    expect(expectKind(result, 'reviewed').record.recheckUsage).toBeNull()
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9002)
    expect(only(gh.calls, SUMMARY_CREATE)).toEqual([])
    // Nothing was asked, so nothing the earlier review said is judged resolved: its row stays open.
    expect(decodeMarker(String(only(gh.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('open')
  })

  it('edits the summary its own login posted, not another way in’s (decision §14.7)', async () => {
    const gh = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]'), summaryBy(9003, 'alice')] })
    await session({ gh, reporter: commitStatusReporter(), extra: { selfLogin: 'alice' } })
    expect(only(gh.calls, SUMMARY_EDIT)[0].params.comment_id).toBe(9003)
  })

  it('posts its own summary when GitHub refuses it the edit of somebody else’s (decision §14.7)', async () => {
    const gh = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]')], fail: { [SUMMARY_EDIT]: 403 } })
    const r = expectKind((await session({ gh, reporter: commitStatusReporter(), extra: { selfLogin: 'alice' } })).result, 'reviewed')
    expect(only(gh.calls, SUMMARY_CREATE)).toHaveLength(1)
    expect(r.published?.summaryCommentId).toBe(8100)
  })

  it('hears the person who posted the review dispute its finding, and ignores only the bot it is told of (decision §14.6)', async () => {
    const hers = fakeGitHub({ issueComments: [summaryBy(9003, 'alice')], reviewComments: theirComment('alice') })
    await session({ gh: hers, reporter: commitStatusReporter(), extra: { selfLogin: 'alice' } })
    expect(decodeMarker(String(only(hers.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('disputed')

    const bots = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]')], reviewComments: theirComment('review-agent[bot]') })
    await session({ gh: bots, reporter: checkRunReporter(), extra: { ignoreRepliesFrom: 'review-agent[bot]' } })
    expect(decodeMarker(String(only(bots.calls, SUMMARY_EDIT)[0].params.body))?.runs[0].findings[0].outcome).toBe('open')
  })

  it('reviews anyway when the marker cannot be read, buying no re-review pass', async () => {
    // The session's own read fails; publishing reads for itself afterwards, and that read works.
    const gh = fakeGitHub({ issueComments: [summaryBy(9002, 'review-agent[bot]')] })
    const { result, deps, logs } = await session({
      gh, reporter: checkRunReporter(), findSummaryComment: async () => { throw new Error(`HTTP 502 ${LEAKED_TOKEN}`) },
    })
    expect(deps.runRecheckPass).not.toHaveBeenCalled()
    expect(logs).toContain('the previous review’s marker could not be read; no re-review pass will run')
    expect(expectKind(result, 'reviewed').published?.summaryCommentId).toBe(9002)
  })
})

describe('runReviewSession: what may be paid for twice (spec 0.2.0 §4.3)', () => {
  it('stops before anything is spent when the report cannot be opened, and says a retry is safe', async () => {
    const gh = fakeGitHub({ fail: { [CREATE_RUN]: 403 } })
    const { result, deps } = await session({ gh, reporter: checkRunReporter() })
    expect(expectKind(result, 'failed')).toMatchObject({ stage: 'before-model', retryable: true, spentUsd: 0, engineStarted: false })
    expect(deps.downloadArchive).not.toHaveBeenCalled()
    expect(deps.runEngine).not.toHaveBeenCalled()
  })

  it('fails before the model when the archive will not download, and scans the reason it reports', async () => {
    const gh = fakeGitHub()
    const { result, deps } = await session({
      gh, reporter: checkRunReporter(),
      deps: { downloadArchive: vi.fn(async () => { throw new Error(`502 from codeload with ${LEAKED_TOKEN}`) }) },
    })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'before-model', retryable: true, spentUsd: 0 })
    expect(deps.runEngine).not.toHaveBeenCalled()
    expect(f.reason).not.toContain(LEAKED_TOKEN)
    expect(checkRunSummary(gh.calls)).not.toContain(LEAKED_TOKEN)
    expect(f.report?.conclusion).toBe('neutral')
  })

  it('never offers a retry once the engine has spent, and says what was spent', async () => {
    const gh = fakeGitHub()
    const { result } = await session({
      gh, reporter: checkRunReporter(),
      deps: { runCheckPass: vi.fn(async () => { throw new Error('the check pass crashed') }) },
    })
    expect(expectKind(result, 'failed')).toMatchObject({ stage: 'model', retryable: false, engineStarted: true, spentUsd: 0.345 })
  })

  it('withholds a review whose output matched a secret pattern, and never retries it', async () => {
    const gh = fakeGitHub()
    const leaky: EngineResult = { ...RESULT, output: { ...OUTPUT, summary: `the token is ${LEAKED_TOKEN}` } }
    const { result } = await session({ gh, reporter: checkRunReporter(), deps: { runEngine: vi.fn(async () => leaky) } })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'withheld', retryable: false })
    expect(f.reason.startsWith('the review was withheld: ')).toBe(true)
    expect(f.cause).toBeInstanceOf(SecretLeak)
    expect(writes(gh.calls)).toEqual([CREATE_RUN, COMPLETE_RUN])
  })

  it('says the review did not complete, and that a free crash may be tried again', async () => {
    const gh = fakeGitHub()
    const crashed: EngineResult = { output: null, usage: NOTHING, cutShort: false, wrapUpFired: false, failure: { kind: 'crashed', code: 1, stderr: '' } }
    const { result } = await session({ gh, reporter: checkRunReporter(), deps: { runEngine: vi.fn(async () => crashed) } })
    const u = expectKind(result, 'unfinished')
    expect(u).toMatchObject({ retryable: true, spentUsd: 0, stopped: null, reason: 'the reviewer process crashed (exit 1)' })
    // The pull request is told, in the product's own words.
    expect(String(only(gh.calls, SUMMARY_CREATE)[0].params.body)).toContain('This review did not complete')
    expect(u.report?.conclusion).toBe('neutral')
  })

  it('never retries a review that produced nothing after it had spent', async () => {
    const gh = fakeGitHub()
    const paid: EngineResult = { output: null, usage: USAGE, cutShort: false, wrapUpFired: false, failure: { kind: 'schema' } }
    const { result } = await session({ gh, reporter: checkRunReporter(), deps: { runEngine: vi.fn(async () => paid) } })
    expect(expectKind(result, 'unfinished')).toMatchObject({ retryable: false, spentUsd: 0.345 })
  })

  it('hands back a paid-for review GitHub would not take, so it is not lost, and never retries it', async () => {
    const gh = fakeGitHub({ fail: { [SUMMARY_CREATE]: 500 } })
    const { result } = await session({ gh, reporter: checkRunReporter() })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'publish', retryable: false, engineStarted: true })
    expect(f.spentUsd).toBeCloseTo(0.4581, 4)
    expect(f.review?.record.output?.findings).toEqual([FINDING])
    expect(checkRunSummary(gh.calls)).toContain('the review ran and could not be posted')
  })
})

describe('runReviewSession: the deadline and the signal', () => {
  it('stops a review at its deadline, kills the model, and reports why', async () => {
    const gh = fakeGitHub()
    const { result } = await session({
      gh, reporter: checkRunReporter(),
      deps: {
        runEngine: vi.fn((input: EngineInput) => new Promise<EngineResult>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve({ output: null, usage: USAGE, cutShort: false, wrapUpFired: false, failure: { kind: 'crashed', code: null, stderr: '' } }))
        })),
      },
      extra: { deadlineMs: 20 },
    })
    const u = expectKind(result, 'unfinished')
    expect(u).toMatchObject({ stopped: 'deadline', retryable: false, published: null })
    expect(u.reason).toBe('the review passed its 0s deadline and was stopped')
    expect(checkRunSummary(gh.calls)).toContain('deadline')
    // Stopped is not "did not complete": no summary claims to be this review.
    expect(only(gh.calls, SUMMARY_CREATE)).toEqual([])
  })

  it('publishes a review that had already finished when the stop landed', async () => {
    const stop = new AbortController()
    const gh = fakeGitHub()
    const { result, logs } = await session({
      gh, reporter: checkRunReporter(),
      deps: { runCheckPass: vi.fn(async () => { stop.abort(); return { verdicts: [] as CheckVerdict[], usage: CHECK_USAGE } }) },
      extra: { signal: stop.signal },
    })
    expect(expectKind(result, 'reviewed').stoppedAfterFinishing).toBe(true)
    expect(only(gh.calls, REVIEW_CREATE)).toHaveLength(1)
    expect(logs).toContain('the review was stopped after it had already finished; publishing it anyway')
  })

  it('spends nothing and opens nothing when it was cancelled before it started', async () => {
    const stop = new AbortController()
    stop.abort()
    const gh = fakeGitHub()
    const { result, deps } = await session({ gh, reporter: checkRunReporter(), extra: { signal: stop.signal } })
    expect(expectKind(result, 'failed')).toMatchObject({ stage: 'before-model', retryable: false, stopped: 'cancelled' })
    expect(gh.calls).toEqual([])
    expect(deps.runEngine).not.toHaveBeenCalled()
  })
})

describe('runReviewSession: what nobody wrote a branch for', () => {
  it('returns a failure for an error after the report was finished, and keeps the conclusion it reported', async () => {
    // Everything after `publishReview` is bookkeeping that cannot throw today. A collaborator that
    // does — here the injected publisher, after the report — must not turn into a thrown error, nor
    // wipe the conclusion GitHub was already given.
    const gh = fakeGitHub()
    const { publishReview } = await import('./publish')
    const deps = runReviewDeps()
    const prepared = await prepare({ octokit: gh.octokit })
    let calls = 0
    const reporter: Reporter = {
      kind: 'check-run',
      start: async () => ({
        kind: 'check-run', id: 1, url: null,
        finish: async () => { calls += 1; return calls === 1 ? 'success' : null },
      }),
    }
    const result = await runReviewSession({
      prepared, post: true, via: { kind: 'sdk' }, reporter,
      deps: {
        runReviewDeps: deps,
        publishReview: async (x) => {
          const out = await publishReview(x)
          // `marker` is read only after the report is finished (the comments this run posted).
          return { ...out, get marker(): never { throw new Error(`bookkeeping broke ${LEAKED_TOKEN}`) } }
        },
      },
    })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'model', retryable: false, engineStarted: true })
    expect(f.reason).toBe('its text is withheld because it matched a secret pattern')
    expect(f.report?.conclusion).toBe('success')
    expect(calls).toBe(1)
  })
})

describe('runReviewSession: what it throws', () => {
  it('throws only for a programmer’s error', async () => {
    const prepared = await prepare({ octokit: fakeGitHub().octokit })
    const deps = { runReviewDeps: runReviewDeps() }
    await expect(runReviewSession({ prepared, post: 'yes' as never, via: { kind: 'sdk' }, deps })).rejects.toThrow(TypeError)
    await expect(runReviewSession({ prepared: {} as never, post: true, via: { kind: 'sdk' }, deps })).rejects.toThrow(TypeError)
    await expect(runReviewSession({ prepared, post: true, via: { kind: 'sdk' }, deadlineMs: 0, deps })).rejects.toThrow(TypeError)
  })
})

/** An engine that answers as the focus it was started for: the lens is in the system prompt, the one
 *  thing `runFocusedReviews` changes per focus. A focus with no entry here gets `fallback`. */
const byFocus = (answers: Partial<Record<'intent' | 'impact' | 'security', EngineResult>>, fallback: EngineResult = RESULT) =>
  vi.fn(async (input: EngineInput): Promise<EngineResult> => {
    const lens = (['intent', 'impact', 'security'] as const).find((l) => input.systemPrompt.includes(`Your focus: ${l}`))
    return (lens === undefined ? undefined : answers[lens]) ?? fallback
  })
const NO_ANSWER = (failure: EngineResult['failure'], costUsd = 0): EngineResult => ({
  output: null, usage: { ...NOTHING, costUsd }, cutShort: failure?.kind === 'budget', wrapUpFired: false, failure,
})

describe('runReviewSession: the multi-reviewer mode (spec 0.2.0 §8.3)', () => {
  it('publishes one review from three focused reviewers, names how each ended, and marks each line with its focus', async () => {
    const gh = fakeGitHub()
    const quiet: EngineResult = { ...RESULT, output: { ...OUTPUT, findings: [] } }
    const runEngine = byFocus({ impact: quiet, security: NO_ANSWER({ kind: 'budget', spentUsd: 5.01 }, 5.01) })
    const { result } = await session({ gh, reporter: checkRunReporter(), ask: { multi: true }, deps: { runEngine } })

    const r = expectKind(result, 'reviewed')
    expect(runEngine).toHaveBeenCalledTimes(3)
    expect(r.record.settings.multi).toBe(true)
    expect(r.record.focuses.map((f) => [f.lens, f.finished, f.cutShort])).toEqual([
      ['intent', true, false], ['impact', true, false], ['security', false, true],
    ])
    // Every focus is paid for, the one that answered nothing included.
    expect(r.record.costUsd).toBeCloseTo(USAGE.costUsd * 2 + 5.01 + CHECK_USAGE.costUsd, 6)
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('Three focused reviewers: intent ✓ · impact ✓ · security ✗ (did not finish)')
    const comments = only(gh.calls, REVIEW_CREATE)[0].params.comments as { body: string }[]
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain('**Severity 6/10** · security · intent focus')
  })

  // §8.3 point 2: the review fails only when every focus produced nothing — and then says so about
  // each of them, not about the first one's ceiling.
  it('is unfinished only when no focus answered, and names how each one ended', async () => {
    const gh = fakeGitHub()
    const runEngine = byFocus({
      intent: NO_ANSWER({ kind: 'budget', spentUsd: 5.02 }, 5.02),
      impact: NO_ANSWER({ kind: 'refusal' }, 0.4),
      security: NO_ANSWER({ kind: 'crashed', code: 1, stderr: '' }),
    })
    const { result } = await session({ gh, reporter: checkRunReporter(), ask: { multi: true }, deps: { runEngine } })
    const u = expectKind(result, 'unfinished')
    expect(u.reason).toBe(
      'none of the 3 focused reviewers produced a review — intent: the review stopped at its $5.00 ceiling after $5.02; ' +
      'impact: the model answered in prose instead of the review schema; security: the reviewer process crashed (exit 1)',
    )
    expect(u.retryable).toBe(false)
    const summary = String(only(gh.calls, SUMMARY_CREATE)[0].params.body)
    expect(summary).toContain('**This review did not complete:** none of its 3 focused reviewers returned an answer.')
    expect(summary).toContain('Three focused reviewers: intent ✗ (did not finish) · impact ✗ (did not finish) · security ✗ (did not finish)')
  })

  it('stops every focus when the review is stopped, and starts none it had not started', async () => {
    const stop = new AbortController()
    const gh = fakeGitHub()
    const seen: EngineInput[] = []
    const runEngine = vi.fn((input: EngineInput) => new Promise<EngineResult>((_resolve, reject) => {
      seen.push(input)
      input.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      // Once both are running: what a person pressing Ctrl-C mid-review looks like.
      if (seen.length === 2) setTimeout(() => { stop.abort() }, 0)
    }))
    const { result } = await session({
      gh, reporter: checkRunReporter(), ask: { multi: true }, deps: { runEngine, concurrency: 2 },
      extra: { signal: stop.signal },
    })
    expect(expectKind(result, 'failed')).toMatchObject({ stage: 'model', stopped: 'cancelled', retryable: false })
    // Two ran side by side and both got the stop; the third was never started.
    expect(seen).toHaveLength(2)
    expect(seen.every((i) => i.signal?.aborted === true)).toBe(true)
  })
})

describe('runReviewSession: focuses run elsewhere (spec 0.2.0 §8.3 point 4)', () => {
  const ran = (lens: 'intent' | 'impact' | 'security', result: EngineResult = RESULT) => ({ lens, result })
  const runFocuses = (over: { throws?: Error } = {}) =>
    vi.fn(async (): Promise<FocusRunsOutcome> => {
      if (over.throws !== undefined) throw over.throws
      return { runs: [ran('intent'), ran('impact'), ran('security')], withheld: [] }
    })

  it('publishes one review from focuses another runner ran, and counts what they cost', async () => {
    const gh = fakeGitHub()
    const { result, deps } = await session({ gh, reporter: checkRunReporter(), ask: { multi: true }, deps: { runFocuses: runFocuses() } })
    const r = expectKind(result, 'reviewed')
    expect(deps.runEngine).not.toHaveBeenCalled()
    expect(r.record.costUsd).toBeCloseTo(USAGE.costUsd * 3 + CHECK_USAGE.costUsd, 6)
    expect(only(gh.calls, REVIEW_CREATE)).toHaveLength(1)
  })

  it('never calls a failure after those focuses free: it knows what they spent, and does not offer a retry', async () => {
    // The check pass dies after three focuses elsewhere were paid for. Without the watch on the
    // runner, nothing here would have seen the engine start, and the failure would read as a $0 one
    // that a second run could fix — the whole review bought again.
    const gh = fakeGitHub()
    const { result } = await session({
      gh, reporter: checkRunReporter(), ask: { multi: true },
      deps: { runFocuses: runFocuses(), runCheckPass: vi.fn(async () => { throw new Error('spawn EAGAIN') }) },
    })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'model', engineStarted: true, retryable: false })
    expect(f.spentUsd).toBeCloseTo(USAGE.costUsd * 3, 6)
  })

  it('does not offer a retry when none of the focuses could run, because what they spent is not known', async () => {
    const gh = fakeGitHub()
    const { result } = await session({
      gh, reporter: checkRunReporter(), ask: { multi: true },
      deps: { runFocuses: runFocuses({ throws: new Error('none of the three tasks ran') }) },
    })
    expect(expectKind(result, 'failed')).toMatchObject({ stage: 'model', engineStarted: true, retryable: false })
  })
})

describe('runReviewSession: the caller hears the review before it is published (onReviewed)', () => {
  it('hands over the review once it has run, before anything about it is written', async () => {
    const gh = fakeGitHub()
    let writtenBefore = -1
    const onReviewed = vi.fn(() => { writtenBefore = gh.calls.filter((c) => c.route !== LIST_RUNS && c.route !== CREATE_RUN && c.route !== SUMMARY_LIST).length })
    const { result } = await session({ gh, reporter: checkRunReporter(), extra: { onReviewed } })
    const r = expectKind(result, 'reviewed')
    expect(onReviewed).toHaveBeenCalledTimes(1)
    expect(onReviewed.mock.calls[0]).toEqual([r.review])
    // Opened the report and read the marker, and posted nothing yet.
    expect(writtenBefore).toBe(0)
  })

  it('hears a review that produced nothing too, so its cost is recorded', async () => {
    const onReviewed = vi.fn()
    const { result } = await session({
      gh: fakeGitHub(), reporter: checkRunReporter(),
      deps: { runEngine: vi.fn(async () => ({ ...RESULT, output: null, failure: { kind: 'refusal' as const } })) },
      extra: { onReviewed },
    })
    expectKind(result, 'unfinished')
    expect(onReviewed).toHaveBeenCalledTimes(1)
  })

  it('treats a throw from it as a failure after the money was spent: the report says so, nothing is posted, no retry', async () => {
    const gh = fakeGitHub()
    const { result, deps } = await session({
      gh, reporter: checkRunReporter(),
      extra: { onReviewed: () => { throw new Error(`the metric sink refused the batch for ${LEAKED_TOKEN}`) } },
    })
    const f = expectKind(result, 'failed')
    expect(f).toMatchObject({ stage: 'model', engineStarted: true, retryable: false })
    expect(f.spentUsd).toBeCloseTo(USAGE.costUsd + CHECK_USAGE.costUsd, 6)
    expect(f.reason).toBe('its text is withheld because it matched a secret pattern')
    expect(only(gh.calls, REVIEW_CREATE)).toEqual([])
    expect(checkRunSummary(gh.calls)).toContain('withheld')
    // The checkout is still removed.
    const dir = await vi.mocked(deps.makeCheckoutDir).mock.results[0].value as string
    expect(existsSync(dir)).toBe(false)
  })
})

describe('the rules the App’s runner and the session share', () => {
  const record = (over: { costUsd?: number; failure?: unknown }) => ({
    costUsd: over.costUsd ?? 0, failure: over.failure ?? null,
    settings: { budget: { ceilingUsd: 5 } },
  }) as never

  it('lets only a failure that spent nothing, for a reason a second run can change, be run again', () => {
    expect(mayRetry(record({ failure: { kind: 'crashed', code: 1 } }))).toBe(true)
    expect(mayRetry(record({ failure: { kind: 'cli-error', message: 'overloaded' } }))).toBe(true)
    expect(mayRetry(record({ failure: { kind: 'crashed', code: 1 }, costUsd: 0.01 }))).toBe(false)
    for (const kind of ['budget', 'schema', 'refusal']) expect(mayRetry(record({ failure: { kind } }))).toBe(false)
    expect(mayRetry(record({}))).toBe(false)
  })

  it('never says a secret, whatever it is asked to say', () => {
    expect(saidSafely(`denied for ${LEAKED_TOKEN}`)).toBe('its text is withheld because it matched a secret pattern')
    expect(saidSafely('a plain sentence')).toBe('a plain sentence')
    expect(failureSentence(record({ failure: { kind: 'cli-error', message: LEAKED_TOKEN } }))).not.toContain(LEAKED_TOKEN)
  })

  it('lists only this run’s comments, by the head it reviewed', () => {
    const marker: MarkerState = { version: 1, runs: [
      { headSha: OLD_SHA, at: 'a', findings: [{ id: 'aaaaaaaaaaaa', file: 'x', line: 1, severity: 5, title: 'old', commentId: 1, outcome: 'open' }] },
      { headSha: HEAD_SHA, at: 'b', findings: [
        { id: 'bbbbbbbbbbbb', file: 'y', line: 2, severity: 5, title: 'new', commentId: 2, outcome: 'open' },
        { id: 'cccccccccccc', file: 'z', line: 3, severity: 5, title: 'summary only', commentId: null, outcome: 'open' },
      ] },
    ] }
    expect(postedCommentsOf({ headSha: HEAD_SHA, marker })).toEqual([{ findingId: 'bbbbbbbbbbbb', file: 'y', line: 2, commentId: 2 }])
  })
})

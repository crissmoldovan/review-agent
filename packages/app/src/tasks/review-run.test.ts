import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Octokit } from '@octokit/core'
import {
  buildReviewRecord, defaultDeploymentConfig, resolveSettings, SecretLeak,
  type CheckVerdict, type DeploymentConfig, type EngineFailure, type EngineResult, type Finding,
  type RecheckPassResult, type RepoConfig, type ResolvedSettings, type ReviewOutput,
  type ReviewRecord, type ReviewRequest, type Usage,
} from '@review-agent/core'
import {
  conclusionFor, runReview, STALE_AFTER_MS, VERDICT_OPEN, verdictJson,
  type CheckConclusion, type CheckGate, type CheckOutcome, type FoundSummary, type MarkerRun,
  type MarkerState, type PublishedReview, type PullRequestContext, type RunReviewDeps,
  type RunReviewResult,
} from '@review-agent/github'
import { describe, expect, it, vi } from 'vitest'
import type { AppIdentity } from '../credentials'
import { HEAD_SHA_UNRESOLVED, MULTI_REFUSED, decodeRequestRefinement } from '../decide'
import {
  REVIEW_TASK_ID, idempotencyKeyFor, tagsFor, type ReviewTaskPayload, type TriggerPort,
} from '../dispatch'
import type { RecordCallback, RecordCallbackOutcome, sendRecordCallback } from './record-callback'
import {
  DoNotRetry, MAX_DELIBERATE_RETRIES, RECORD_WARN_BYTES, RetryThis, assertModelCredential, mayRetry,
  reviewTaskRun,
  type ReviewTaskDeps, type ReviewTaskResult,
} from './review-run'

// A real subscription-token shape with an obviously nonsense value: one test greps every log line
// and every metric for it, so it has to be findable and must never be a real credential.
const CREDENTIAL = 'sk-ant-oat01-FAKE-DO-NOT-LOG-7Q4Z'
const IDENTITY: AppIdentity = {
  clientId: 'Iv23liR3v13wAg3nt',
  privateKeyPem: 'FAKE-PEM-DO-NOT-LOG-5R8W',
}
const TOKEN = {
  token: 'ghs_installation_FAKE_DO_NOT_LOG',
  expiresAt: '2026-09-14T11:00:00Z',
  repositories: ['acme/widgets'],
}
/** A GitHub token's shape with a nonsense body — 36 characters after the prefix, which is what
 *  core's scanner actually matches. Three cases in *what may be paid for twice* throw it from each
 *  of the three places an error somebody else threw becomes a check run summary, and ask the same
 *  question of all three: does the public half of the pull request get to read it. */
const LEAKED_TOKEN = 'ghp_' + 'A'.repeat(36)

// The two shas of run-review.test.ts, so base and head are told apart by eye in a failure.
const HEAD = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const BASE = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'

const REQUEST: ReviewRequest = {
  repo: 'acme/widgets', pr: 16, headSha: HEAD,
  requestedBy: 'crissmoldovan', requestId: 'gh-delivery-8f2c',
}
const PAYLOAD: ReviewTaskPayload = { request: REQUEST, installationId: 12_345_678 }

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16, headSha: HEAD, baseSha: BASE,
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and nothing checks them.',
  changedFiles: [{
    path: '.github/workflows/publish.yml', status: 'modified',
    patch: '@@ -88,6 +88,37 @@\n context\n',
  }],
  diff: 'diff --git a/.github/workflows/publish.yml b/.github/workflows/publish.yml\n',
}

const FINDING: Finding = {
  file: '.github/workflows/publish.yml', line: 100, endLine: null,
  severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes',
  explanation: 'A tag pushed from any branch publishes that branch.',
  evidence: ['.github/workflows/publish.yml:100'], suggestion: null,
}
const OUTPUT: ReviewOutput = {
  summary: 'Adds a tag check to publish.yml.',
  intent: { verdict: 'matches', note: 'It does what the brief says.' },
  findings: [FINDING],
  inconclusive: [],
}
// The figures of a measured basic-tier run: $0.345 at per-token API prices, 10 turns, 51.9s of
// model time inside 55s of wall clock.
const USAGE: Usage = {
  costUsd: 0.345, inputTokens: 18, outputTokens: 3333,
  cacheReadTokens: 121_660, cacheWriteTokens: 19_864, turns: 10, durationMs: 51_900,
}
const CHECK_USAGE: Usage = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104,
  cacheReadTokens: 61_230, cacheWriteTokens: 18_944, turns: 8, durationMs: 41_022,
}
const RECHECK_USAGE: Usage = {
  costUsd: 0.0968, inputTokens: 4, outputTokens: 1264,
  cacheReadTokens: 8_493, cacheWriteTokens: 9_206, turns: 4, durationMs: 41_200,
}
/** What the re-review pass answers when there is nothing to ask about — a first review. It is the
 *  default here because most of this file's cases are first reviews. */
const NO_RECHECK: RecheckPassResult = {
  judgements: [], ran: false, skipped: 'nothing-to-ask',
  usage: {
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turns: 0, durationMs: 0,
  },
}
const RESULT: EngineResult = {
  output: OUTPUT, usage: USAGE, cutShort: false, wrapUpFired: false, failure: null,
}
const DEPLOYMENT: DeploymentConfig = defaultDeploymentConfig()
const SETTINGS: ResolvedSettings = resolveSettings({
  deployment: DEPLOYMENT, repo: null, request: REQUEST,
})

/** A RunReviewResult built the way runReview builds one — the record comes from the real
 *  buildReviewRecord, so a field this task reads is a field the product actually writes. */
const reviewOf = (over: { result?: EngineResult; settings?: ResolvedSettings } = {}): RunReviewResult => {
  const result = over.result ?? RESULT
  const settings = over.settings ?? SETTINGS
  const request: ReviewRequest = { ...REQUEST, headSha: PR.headSha }
  return {
    pr: PR, request, settings, result, check: null, recheck: null, skills: [],
    checkoutDir: '/tmp/ra-fake-checkout', removedFromCheckout: ['.npmrc'],
    record: buildReviewRecord({
      request, settings, result, skills: [], check: null, recheck: null, removedFromCheckout: ['.npmrc'],
      startedAt: new Date('2026-09-14T10:00:00.000Z'),
      finishedAt: new Date('2026-09-14T10:00:55.000Z'),
    }),
  }
}
const REVIEWED = reviewOf()

/** What publishReview (Task 7b) hands back when everything was said inline. This task reads
 *  `findings`, `counts`, `reviewId`, `summaryCommentId`, `headSha` and `mode` and nothing else. */
const publishedFor = (r: RunReviewResult, over: Partial<PublishedReview> = {}): PublishedReview => {
  const findings = r.result.output?.findings ?? []
  return {
    mode: r.settings.report.mode,
    headSha: r.pr.headSha,
    completed: r.result.failure === null && r.result.output !== null,
    reviewId: 77,
    summaryCommentId: 903,
    summaryUrl: null,
    said: {
      inline: findings.map((f) => ({ finding: f, line: f.line, side: 'RIGHT' as const })),
      summaryOnly: [],
    },
    findings,
    // No check pass ran in these fixtures, so nothing is confirmed and nobody checked (Task 7b).
    confirmed: null,
    counts: {
      inline: findings.length, summaryOnly: 0, droppedInline: 0, suppressed: 0, notInCheckout: 0,
      retracted: 0, reinstated: 0, retractionsWithheld: 0,
    },
    marker: { version: 1, runs: [] },
    bodies: { review: 'review body', inline: [], summary: 'summary body' },
    ...over,
  }
}

const runReviewDepsWith = (over: Partial<RunReviewDeps> = {}): RunReviewDeps => ({
  // The task hands runReview the pull request and the config it already fetched. If either of
  // these is ever called, something fetched twice — and the second answer could be a different
  // commit from the one the check run was opened on.
  fetchPullRequest: vi.fn(async () => PR),
  fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => null),
  downloadArchive: vi.fn(async (a: { destDir: string }) => ({
    dir: a.destDir, removed: ['.npmrc'], notWritten: [] as { path: string; code: string }[], caseCollisions: [] as string[][],
  })),
  materialiseSkills: vi.fn(async () => []),
  runEngine: vi.fn(async () => RESULT),
  runCheckPass: vi.fn(async () => ({ verdicts: [] as CheckVerdict[], usage: CHECK_USAGE })),
  runRecheckPass: vi.fn(async () => NO_RECHECK),
  makeCheckoutDir: vi.fn(async () => '/tmp/ra-fake-checkout'),
  skillCacheDir: vi.fn(() => '/tmp/ra-fake-skill-cache'),
  now: vi.fn(() => new Date('2026-09-14T10:00:00.000Z')),
  note: vi.fn(),
  ...over,
})

type Harness = ReviewTaskDeps & {
  logs: { message: string; fields: Record<string, unknown> }[]
  metrics: { name: string; value: number; attributes: Record<string, string> }[]
}

const deps = (over: Partial<ReviewTaskDeps> = {}): Harness => {
  const logs: Harness['logs'] = []
  const metrics: Harness['metrics'] = []
  return {
    logs,
    metrics,
    env: { CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL },
    identity: vi.fn(() => IDENTITY),
    now: () => new Date('2026-09-14T10:00:55.000Z'),
    deadlineMs: 30 * 60 * 1000,
    deployment: vi.fn(() => DEPLOYMENT),
    installationToken: vi.fn(async () => TOKEN),
    makeOctokit: vi.fn(() => ({}) as Octokit),
    fetchPullRequest: vi.fn(async () => PR),
    fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => null),
    // No previous review by default: most cases here are a pull request's first.
    findSummaryComment: vi.fn(async () => null),
    hasPushAccess: vi.fn(async () => true),
    runReview: vi.fn(async () => REVIEWED),
    runReviewDeps: runReviewDepsWith(),
    publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review)),
    createCheckRun: vi.fn(async () => ({ id: 4242, url: null })),
    closeCheckRunIfInProgress: vi.fn(async (_a: Parameters<ReviewTaskDeps['closeCheckRunIfInProgress']>[0]) => true),
    checkRunMemory: null,
    // The real conclusionFor, so a test that asks what the check run concluded gets Task 6's
    // answer and not a second opinion invented here.
    completeCheckRun: vi.fn(async (a: { outcome: CheckOutcome; gate: CheckGate }) =>
      conclusionFor({ outcome: a.outcome, gate: a.gate })),
    startAnotherRun: vi.fn(async (_a: Parameters<TriggerPort>[0]) => ({ id: 'run_again_1' })),
    // No callback and a sender that says so, so every case written before Task 13c keeps meaning
    // what it meant: nothing leaves this harness unless the case asks for it.
    recordCallback: null,
    sendRecord: vi.fn(async (_a: Parameters<typeof sendRecordCallback>[0]): Promise<RecordCallbackOutcome> => ({ sent: false, why: 'not-configured' })),
    log: (message: string, fields: Record<string, unknown>) => { logs.push({ message, fields }) },
    metric: (name: string, value: number, attributes: Record<string, string>) => {
      metrics.push({ name, value, attributes })
    },
    ...over,
  }
}

const reviewedOf = (r: ReviewTaskResult): Extract<ReviewTaskResult, { kind: 'reviewed' }> => {
  if (r.kind !== 'reviewed') throw new Error(`expected a review, got ${r.kind}`)
  return r
}

/** The sentence Task 6 renders verbatim into the check run summary, where everyone who can see the
 *  pull request reads it. Narrowed rather than cast: `reason` exists only on the failed variant, and
 *  a check run of another kind here is a different defect that should say so. */
const failedReasonOn = (d: Harness): string => {
  const outcome = vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome
  if (outcome.kind !== 'failed') throw new Error(`expected a failed check run, got ${outcome.kind}`)
  return outcome.reason
}

describe('the review task', () => {
  it('mints a token for one repository, opens a check run, reviews, publishes and completes it', async () => {
    const d = deps()
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))

    // Scoped to the one repository under review, by NAME, never to the installation
    // (Global Constraints; verified facts: `repositories` takes names, max 500).
    expect(d.installationToken).toHaveBeenCalledWith({
      identity: IDENTITY, installationId: 12_345_678, repositories: ['widgets'],
    })
    expect(d.makeOctokit).toHaveBeenCalledWith(TOKEN.token)
    expect(vi.mocked(d.createCheckRun).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', headSha: HEAD, name: 'review-agent',
    })
    expect(vi.mocked(d.runReview).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', number: 16, deployment: DEPLOYMENT,
    })
    // The whole posting path is one call, and it is handed the review unchanged: what is said,
    // where, and at what severity is Task 7b's decision, not this task's.
    expect(vi.mocked(d.publishReview).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', number: 16, review: REVIEWED,
    })
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0]).toMatchObject({
      checkRunId: 4242,
      gate: { failAtOrAbove: null, requiresConfirmed: false },
      mode: 'inline+summary', maxInline: 15, bands: { critical: 9, high: 7, medium: 4 },
      outcome: {
        kind: 'reviewed', headSha: HEAD, tier: 'basic', model: 'claude-opus-5', costUsd: 0.345,
        findings: [FINDING], confirmed: null, cutShort: false, posted: 1, summaryUrl: null,
      },
    })
    expect(out).toEqual({
      kind: 'reviewed', headSha: HEAD, record: REVIEWED.record,
      reviewId: 77, summaryCommentId: 903,
      counts: { inline: 1, summaryOnly: 0, droppedInline: 0, suppressed: 0, notInCheckout: 0, retracted: 0, reinstated: 0, retractionsWithheld: 0 },
      verdict: expect.stringContaining(VERDICT_OPEN),
      // A finished review with the gate off concludes success (Task 6, Criss decision 5).
      checkRun: { id: 4242, conclusion: 'success' },
      // The fixture's marker holds no runs, so nothing was posted inline to reply under.
      comments: [],
    })
  })

  it('refuses to start when the deployment set no model credential, before any GitHub call', async () => {
    const d = deps({ env: {} })
    await expect(reviewTaskRun(PAYLOAD, {}, d))
      .rejects.toThrow(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/)
    expect(d.installationToken).not.toHaveBeenCalled()
    expect(d.fetchPullRequest).not.toHaveBeenCalled()
    expect(d.createCheckRun).not.toHaveBeenCalled()
  })

  it('refuses to start when two model credentials are set, because nobody could say which one is being billed', async () => {
    const d = deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-api-FAKE', CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL } })
    await expect(reviewTaskRun(PAYLOAD, {}, d)).rejects.toThrow(/exactly one/)
    expect(d.installationToken).not.toHaveBeenCalled()
  })

  it('accepts either credential kind, because the deployment chooses (Criss, 2026-09-14)', async () => {
    for (const env of [
      { ANTHROPIC_API_KEY: 'sk-ant-api-FAKE' },
      { CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL },
    ]) {
      await expect(reviewTaskRun(PAYLOAD, {}, deps({ env })))
        .resolves.toMatchObject({ kind: 'reviewed' })
    }
  })

  it('refuses to start when ANTHROPIC_BASE_URL is set, before any GitHub call (Criss, decision 10)', async () => {
    // Two kinds, and the gateway is neither: a base URL sends the reviewed code to a third party.
    const d = deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-api-FAKE', ANTHROPIC_BASE_URL: 'https://gateway.example/v1' } })
    await expect(reviewTaskRun(PAYLOAD, {}, d)).rejects.toThrow(/ANTHROPIC_BASE_URL/)
    expect(d.installationToken).not.toHaveBeenCalled()
    // A gateway bearer token on its own is not a credential this product knows.
    await expect(reviewTaskRun(PAYLOAD, {}, deps({ env: { ANTHROPIC_AUTH_TOKEN: 'gateway-FAKE' } })))
      .rejects.toThrow(/no model credential/)
  })

  it('refuses to start when the App identity is missing, before any GitHub call', async () => {
    const d = deps({
      identity: vi.fn(() => {
        throw new Error('the App identity is not set: REVIEW_AGENT_APP_CLIENT_ID')
      }),
    })
    await expect(reviewTaskRun(PAYLOAD, {}, d)).rejects.toThrow(/REVIEW_AGENT_APP_CLIENT_ID/)
    expect(d.installationToken).not.toHaveBeenCalled()
  })
})

describe('the commit that is reviewed', () => {
  it('opens the check run on the head GitHub reports, because a pull request comment names none', async () => {
    // Task 10 sends HEAD_SHA_UNRESOLVED for an issue_comment: the payload has no head sha to give.
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, headSha: HEAD_SHA_UNRESOLVED } }, {}, d)
    expect(vi.mocked(d.createCheckRun).mock.calls[0][0].headSha).toBe(HEAD)
  })

  it('opens it on the current head when the webhook’s sha has gone stale', async () => {
    const stale = 'a'.repeat(40)
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, headSha: stale } }, {}, d)
    expect(vi.mocked(d.createCheckRun).mock.calls[0][0].headSha).toBe(HEAD)
    expect(JSON.stringify(vi.mocked(d.createCheckRun).mock.calls)).not.toContain(stale)
  })

  it('asks runReview for the pull request by number, and hands it no sha to overwrite', async () => {
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, headSha: HEAD_SHA_UNRESOLVED } }, {}, d)
    const call = vi.mocked(d.runReview).mock.calls[0][0]
    expect(call).toMatchObject({ owner: 'acme', repo: 'widgets', number: 16 })
    expect(call.ask).toEqual({ requestedBy: 'crissmoldovan', requestId: 'gh-delivery-8f2c' })
  })

  it('reviews the pull request it already fetched, so the sha reviewed is the sha the check run is on', async () => {
    // The real runReview over fake collaborators: this is the test that says the two halves agree.
    const d = deps({ runReview })
    const out = reviewedOf(
      await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, headSha: HEAD_SHA_UNRESOLVED } }, {}, d),
    )
    expect(d.fetchPullRequest).toHaveBeenCalledTimes(1)
    expect(d.runReviewDeps.fetchPullRequest).not.toHaveBeenCalled()
    expect(out.record.request.headSha).toBe(HEAD)
    expect(vi.mocked(d.runReviewDeps.downloadArchive).mock.calls[0][0].ref).toBe(HEAD)
  })
})

describe('what the report mode decides', () => {
  it('opens no check run when the repository lowered the mode to silent, and still records the review', async () => {
    const d = deps({ fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => ({ mode: 'silent' })) })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(d.createCheckRun).not.toHaveBeenCalled()
    expect(d.completeCheckRun).not.toHaveBeenCalled()
    // publishReview is still called: it gates its own writes on the resolved mode (Task 7b), so in
    // `silent` it writes nothing and reports what it would have said. One owner of that rule.
    expect(d.publishReview).toHaveBeenCalledTimes(1)
    expect(out.checkRun).toBeNull()
  })

  it('in check-only, completes the check run on what the review would have said, having posted nothing', async () => {
    const deployment: DeploymentConfig = {
      ...DEPLOYMENT, report: { ...DEPLOYMENT.report, mode: 'check-only' },
    }
    const d = deps({
      deployment: () => deployment,
      publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review, {
        mode: 'check-only', reviewId: null, summaryCommentId: null,
        counts: { inline: 0, summaryOnly: 0, droppedInline: 0, suppressed: 0, notInCheckout: 0, retracted: 0, reinstated: 0, retractionsWithheld: 0 },
      })),
    })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(d.createCheckRun).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome)
      .toMatchObject({ kind: 'reviewed', findings: [FINDING], posted: 0 })
  })

  it('reads the base branch’s own file once, and runReview resolves the same settings from it', async () => {
    const d = deps({
      runReview,
      fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => ({ mode: 'summary-only' })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    // The BASE sha: a pull request must not write the settings that judge it (design §4.3).
    expect(vi.mocked(d.fetchRepoConfig).mock.calls[0][0].baseRef).toBe(BASE)
    expect(d.runReviewDeps.fetchRepoConfig).not.toHaveBeenCalled()
    expect(out.record.settings.report.mode).toBe('summary-only')
  })

  it('names the check run from the resolved settings, and hands Task 6 their gate', async () => {
    const deployment: DeploymentConfig = {
      ...DEPLOYMENT,
      report: { ...DEPLOYMENT.report, checkRunName: 'acme-review', failAtOrAbove: 9, gateRequiresConfirmed: true },
    }
    const d = deps({ deployment: () => deployment })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(vi.mocked(d.createCheckRun).mock.calls[0][0].name).toBe('acme-review')
    // Without this the gate Task 6 built can never fire, whatever a deployment sets. Both halves
    // travel together (Criss, decision 6): a threshold without its confirmation rule is half a gate.
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].gate)
      .toEqual({ failAtOrAbove: 9, requiresConfirmed: true })
  })
})

describe('a release that nobody asked to have reviewed', () => {
  // Task 10's rule: lock files, changelogs and version files, and one other changed file disarms it.
  const RELEASE: PullRequestContext = {
    ...PR,
    changedFiles: [
      { path: 'package.json', status: 'modified' },
      { path: 'pnpm-lock.yaml', status: 'modified' },
      { path: 'CHANGELOG.md', status: 'modified' },
    ],
  }
  const AUTOMATIC: ReviewTaskPayload = {
    request: { repo: 'acme/widgets', pr: 16, headSha: HEAD },
    installationId: 12_345_678,
  }

  it('is skipped before a check run exists and before the model is paid for', async () => {
    const d = deps({ fetchPullRequest: vi.fn(async () => RELEASE) })
    expect(await reviewTaskRun(AUTOMATIC, {}, d))
      .toEqual({ kind: 'skipped', reason: 'release-only', headSha: HEAD })
    expect(d.runReview).not.toHaveBeenCalled()
    expect(d.createCheckRun).not.toHaveBeenCalled()
    expect(d.publishReview).not.toHaveBeenCalled()
  })

  it('is reviewed when somebody asked for it, because a request disarms the skip (design §5)', async () => {
    const d = deps({ fetchPullRequest: vi.fn(async () => RELEASE) })
    expect((await reviewTaskRun(PAYLOAD, {}, d)).kind).toBe('reviewed')
    expect(d.runReview).toHaveBeenCalledTimes(1)
  })
})

describe('who may spend the money on a review (Criss, decision 3)', () => {
  const AUTOMATIC: ReviewTaskPayload = {
    request: { repo: 'acme/widgets', pr: 16, headSha: HEAD },
    installationId: 12_345_678,
  }

  it('never asks about the author of an automatic review, because any pull request that opens is reviewed', async () => {
    const d = deps({ hasPushAccess: vi.fn(async () => false) })
    expect((await reviewTaskRun(AUTOMATIC, {}, d)).kind).toBe('reviewed')
    expect(d.hasPushAccess).not.toHaveBeenCalled()
  })

  it('reviews a request from somebody with push access, having asked once, on the minted token', async () => {
    const d = deps({ hasPushAccess: vi.fn(async () => true) })
    expect((await reviewTaskRun(PAYLOAD, {}, d)).kind).toBe('reviewed')
    expect(d.hasPushAccess).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.hasPushAccess).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', username: 'crissmoldovan',
    })
  })

  it('refuses a request from somebody without push access before the archive or the engine, and says so on the pull request', async () => {
    const d = deps({ hasPushAccess: vi.fn(async () => false), runReview })
    const out = await reviewTaskRun(PAYLOAD, {}, d)
    expect(out).toEqual({
      kind: 'refused', reason: 'no-push-access', headSha: HEAD, requestedBy: 'crissmoldovan',
      checkRun: { id: 4242, conclusion: 'neutral' },
    })
    // $0: nothing downloaded, no model, no check pass, nothing posted.
    expect(d.runReviewDeps.downloadArchive).not.toHaveBeenCalled()
    expect(d.runReviewDeps.runEngine).not.toHaveBeenCalled()
    expect(d.runReviewDeps.runCheckPass).not.toHaveBeenCalled()
    expect(d.publishReview).not.toHaveBeenCalled()
    // Visible, not silent: a check run on the head, concluded neutral (Task 6), naming who asked.
    const outcome = vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome
    expect(outcome).toMatchObject({ kind: 'refused', headSha: HEAD })
    expect(JSON.stringify(outcome)).toContain('@crissmoldovan')
    expect(JSON.stringify(outcome)).toContain('push access')
  })

  it('refuses a request that names nobody, because there is nobody to check', async () => {
    const { requestedBy: _nobody, ...anonymous } = REQUEST
    const d = deps({ hasPushAccess: vi.fn(async () => true) })
    expect((await reviewTaskRun({ ...PAYLOAD, request: anonymous }, {}, d)).kind).toBe('refused')
    expect(d.hasPushAccess).not.toHaveBeenCalled()
    expect(d.runReview).not.toHaveBeenCalled()
  })

  it('still answers the person in silent mode, because silent governs what a review says, not whether a request is answered', async () => {
    const d = deps({
      hasPushAccess: vi.fn(async () => false),
      fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => ({ mode: 'silent' })),
    })
    expect((await reviewTaskRun(PAYLOAD, {}, d)).kind).toBe('refused')
    expect(d.createCheckRun).toHaveBeenCalledTimes(1)
  })
})

describe('what the summary is told (Criss, decision 4)', () => {
  it('hands publishReview the refusals the comment doorway carried, so the summary names them', async () => {
    const refused = [MULTI_REFUSED]
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, refused }, {}, d)
    expect(vi.mocked(d.publishReview).mock.calls[0][0]).toMatchObject({ refused })
  })

  it('refuses the fan-out a payload carries itself, reviews with one reviewer, and names it', async () => {
    // A Re-run is refused in decideDelivery (Task 10), but a payload can be triggered by hand, as
    // Task 15 Step 16 does. `--multi` stays refused until the multi-reviewer mode is built.
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, tier: 'thorough', multi: true } }, {}, d)
    const ask = vi.mocked(d.runReview).mock.calls[0][0].ask
    expect(ask.multi).toBeUndefined()
    expect(vi.mocked(d.publishReview).mock.calls[0][0].refused).toEqual([MULTI_REFUSED])
  })

  it('honours a thorough tier a payload carries, because it is one reviewer at high effort (spec 0.2.0 §14.1)', async () => {
    // It used to be stripped with `multi`, when `thorough` was going to mean the fan-out. Now it buys
    // what it says, so it reaches runReview and nothing in the summary calls it refused.
    const d = deps()
    await reviewTaskRun({ ...PAYLOAD, request: { ...REQUEST, tier: 'thorough' } }, {}, d)
    expect(vi.mocked(d.runReview).mock.calls[0][0].ask.tier).toBe('thorough')
    expect(vi.mocked(d.publishReview).mock.calls[0][0].refused).toBeUndefined()
    expect(decodeRequestRefinement(vi.mocked(d.createCheckRun).mock.calls[0][0].externalId)).toEqual({ tier: 'thorough' })
  })

  it('says on every summary and review that the App ran it (spec 0.2.0 §5.6, decision §14.9)', async () => {
    const d = deps()
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(vi.mocked(d.publishReview).mock.calls[0][0].via).toEqual({ kind: 'app' })
  })
})

describe('what the check run carries', () => {
  it('carries the settings of the request, so the Re-run button repeats them (design §5)', async () => {
    const asked: ReviewTaskPayload = {
      ...PAYLOAD,
      request: { ...REQUEST, tier: 'normal', check: true, brief: 'Only the release job.' },
    }
    const d = deps()
    await reviewTaskRun(asked, {}, d)
    const externalId = vi.mocked(d.createCheckRun).mock.calls[0][0].externalId
    expect(decodeRequestRefinement(externalId)).toEqual({ tier: 'normal', check: true })
    // `brief` is deliberately NOT carried (decide.ts, encodeRequestRefinement): it is free text a
    // person typed after `/review`, and external_id is readable by anyone who can read the check
    // run and rides every Re-run for as long as it exists. Base64url is an encoding, not a wrapper
    // that makes text private — so the assertion is on the raw string, not on what decoding gives
    // back, which would still pass if the brief were encoded and merely dropped on the way out.
    expect(Buffer.from(String(externalId), 'base64url').toString('utf8'))
      .not.toContain('Only the release job.')
  })

  it('gates on what was said, so a finding the check pass refuted cannot fail a build', async () => {
    const severe: Finding = { ...FINDING, severity: 9 }
    const deployment: DeploymentConfig = {
      ...DEPLOYMENT, report: { ...DEPLOYMENT.report, failAtOrAbove: 9 },
    }
    const d = deps({
      deployment: () => deployment,
      runReview: vi.fn(async () => reviewOf({
        result: { ...RESULT, output: { ...OUTPUT, findings: [severe] } },
      })),
      // The check pass refuted it: publishReview said it nowhere, and says so in `findings`.
      publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review, {
        findings: [],
        counts: { inline: 0, summaryOnly: 0, droppedInline: 0, suppressed: 1, notInCheckout: 0, retracted: 0, reinstated: 0, retractionsWithheld: 0 },
      })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome)
      .toMatchObject({ findings: [], posted: 0 })
    // Nothing reached the gate, so a finished review concludes success (Task 6, decision 5).
    expect(out.checkRun?.conclusion).toBe('success')
  })
})

describe('what may be paid for twice', () => {
  const recordWith = (over: Partial<ReviewRecord>): ReviewRecord => ({ ...REVIEWED.record, ...over })
  const failedReview = (failure: EngineFailure, costUsd: number): RunReviewResult =>
    reviewOf({ result: { output: null, usage: { ...USAGE, costUsd }, cutShort: false, wrapUpFired: false, failure } })

  // A failure `mayRetry` calls free starts a NEW run of the whole review, model included (Step 45e).
  // Since 2026-09-18 trigger.dev ALSO repeats a run itself, up to three attempts (Task 12, MAX_ATTEMPTS;
  // (Criss, 2026-09-18, reversing answer 13)) — so this answer is no longer the only thing between a failure and a second bill:
  // a crash with nothing thrown is repeated by the platform whatever this returns. A measured review is
  // $0.345 to $1.06 (per-token API prices, design §8), so a
  // wrong answer here buys it again, up to twice more, silently, on every crash.
  it('never retries a failure that already paid for the model', () => {
    for (const failure of [
      { kind: 'budget' as const, spentUsd: 5 }, { kind: 'schema' as const }, { kind: 'refusal' as const },
    ]) {
      expect(mayRetry(recordWith({ failure, costUsd: 1.02 }))).toBe(false)
    }
  })

  it('never retries a refusal, a schema failure or a budget stop even when nothing was spent, because a second attempt asks the same model the same question about the same commit', () => {
    for (const failure of [
      { kind: 'budget' as const, spentUsd: 0 }, { kind: 'schema' as const }, { kind: 'refusal' as const },
    ]) {
      expect(mayRetry(recordWith({ failure, costUsd: 0 }))).toBe(false)
    }
  })

  it('retries a crash or a CLI error that spent nothing, which is the one failure a second attempt can fix', () => {
    expect(mayRetry(recordWith({ failure: { kind: 'crashed', code: 137, stderr: 'killed' }, costUsd: 0 }))).toBe(true)
    expect(mayRetry(recordWith({
      failure: { kind: 'cli-error', terminalReason: 'error', message: 'API error 529 overloaded' },
      costUsd: 0,
    }))).toBe(true)
  })

  it('does not retry a crash that happened after the model had spent', () => {
    expect(mayRetry(recordWith({ failure: { kind: 'crashed', code: 1, stderr: 'boom' }, costUsd: 0.61 }))).toBe(false)
  })

  it('completes the check run and starts nothing again when the engine failed after spending', async () => {
    const d = deps({ runReview: vi.fn(async () => failedReview({ kind: 'refusal' }, 1.02)) })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as DoNotRetry).spentUsd).toBe(1.02)
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
    // The pull request is told as well as the check run. publishReview writes the summary that
    // says "This review did not complete", in its own fixed words, and carries the previous
    // marker over untouched (Task 7b, Steps 34 to 37) — this task is that path's only production
    // caller, so a return before this call would leave the last review's summary standing as if
    // it were this one's. The WORDS are Task 7b's test; that it happens at all is this one.
    expect(d.publishReview).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.publishReview).mock.calls[0][0].review.result.output).toBeNull()
  })

  it('completes the check run and lets a free crash run again', async () => {
    const d = deps({
      runReview: vi.fn(async () => failedReview({ kind: 'crashed', code: 137, stderr: 'killed' }, 0)),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  it('lets a free crash run again on the REAL runReview, where the engine wrapper has already marked the run as started', async () => {
    // The case above mocks `runReview`, so `spend.engineStarted` is still false and the error is
    // let out for the wrong reason. In the DEPLOYED runner the wrapper Step 35 puts around
    // `runEngine` sets that flag before `runReview` returns — and it returns a record with no
    // output and $0 spent, which is precisely the case the retry exists for. So the mocked case
    // cannot reach the branch that matters, and without this one the retry path is unreachable in
    // production while the suite stays green. Real pipeline, real record: crash, exit 137, $0.
    const crashed: EngineResult = {
      output: null, usage: { ...USAGE, costUsd: 0 }, cutShort: false, wrapUpFired: false,
      failure: { kind: 'crashed', code: 137, stderr: 'killed' },
    }
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({ runEngine: vi.fn(async () => crashed) }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(d.runReviewDeps.runEngine).toHaveBeenCalledTimes(1)
    expect(thrown).toBeInstanceOf(RetryThis)
    // The assertion that is about money: a DoNotRetry here is a $0 crash nobody ever retries, and
    // a 137 is an out-of-memory kill — the one failure a second attempt can actually fix.
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('may be retried')
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  it('lets a GitHub failure run again when it happened before anything was opened or spent', async () => {
    const d = deps({ installationToken: vi.fn(async () => { throw new Error('GitHub responded 502') }) })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('502')
    expect(d.runReview).not.toHaveBeenCalled()
    expect(d.createCheckRun).not.toHaveBeenCalled()
  })

  it('lets a download that failed inside the pipeline run again, before the engine started', async () => {
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({
        downloadArchive: vi.fn(async () => { throw new Error('GitHub responded 502 on the tarball') }),
      }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('tarball')
    expect(d.runReviewDeps.runEngine).not.toHaveBeenCalled()
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  it('does not retry a failure that came after the engine started, and says what had been spent', async () => {
    // The check pass is a second model call made after the first has been paid for, and it reaches
    // this task as a plain Error: spawnClaude rejects on the child's 'error' event
    // (packages/core/src/cli-process.ts). Classifying by error type would retry it and buy the
    // whole review again; classifying by position does not.
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({
        runCheckPass: vi.fn(async () => { throw new Error('spawn EAGAIN') }),
      }),
    })
    const thrown = await reviewTaskRun(
      { ...PAYLOAD, request: { ...REQUEST, check: true } }, {}, d,
    ).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as DoNotRetry).spentUsd).toBe(0.345)
    expect(d.runReviewDeps.runEngine).toHaveBeenCalledTimes(1)
  })

  it('does not re-run the model because GitHub would not take the comments', async () => {
    const d = deps({ publishReview: vi.fn(async () => { throw new Error('GitHub responded 502') }) })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('could not be posted')
    expect((thrown as DoNotRetry).spentUsd).toBe(0.345)
    // The human still learns what happened, from the check run.
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  // Three places in this task turn an error somebody else threw into a `CheckOutcome.failed.reason`,
  // and Task 6 renders that reason verbatim into the check run summary, which everyone who can see
  // the pull request reads (design §4.3). runReview's own scan covers the review output and the
  // check verdicts (Task 1, Step 16) and NOTHING scans the message of a collaborator's error — an
  // octokit error quotes the request it made and the installation token can be in it. One case per
  // site, each entering by the door that site is on, because a case that only exercises one of them
  // lets a careless edit to either other one ship a token onto a public surface with a green suite.
  it('does not print a thrown error onto the check run when the review could not be posted', async () => {
    const d = deps({
      publishReview: vi.fn(async () => { throw new Error(`POST /reviews failed for token ${LEAKED_TOKEN}`) }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    const reason = failedReasonOn(d)
    expect(reason).toContain('could not be posted')
    expect(reason).toContain('withheld')
    expect(reason).not.toContain(LEAKED_TOKEN)
    expect((thrown as Error).message).not.toContain(LEAKED_TOKEN)
  })

  it('does not print a thrown error onto the check run when a collaborator failed before the engine', async () => {
    // The reachable one, and the reason this is not a hypothetical: `downloadArchive` and
    // `materialiseSkills` are octokit calls made with the installation token, they run inside
    // runReview BEFORE the engine, and an octokit error quotes the request it made. The whole
    // review is still in front of it, so this error is also the one that starts another run — and
    // the log line that says so must not carry the token either.
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({
        downloadArchive: vi.fn(async () => {
          throw new Error(`HttpError: 401 for GET /repos/acme/widgets/tarball (token ${LEAKED_TOKEN})`)
        }),
      }),
    })
    await reviewTaskRun(PAYLOAD, {}, d).catch(() => undefined)
    const reason = failedReasonOn(d)
    expect(reason).toContain('did not complete')
    expect(reason).toContain('withheld')
    expect(reason).not.toContain(LEAKED_TOKEN)
    expect(d.runReviewDeps.runEngine).not.toHaveBeenCalled()
    expect(JSON.stringify(d.logs)).not.toContain(LEAKED_TOKEN)
  })

  it('does not print a thrown error onto the check run when the bookkeeping after the review threw', async () => {
    // The last door: everything after the engine has spent — the metrics, the log line, the publish
    // — is wrapped in one catch, and in the deployed runner those calls are @trigger.dev/sdk's. An
    // error out of one of them lands on the same public check run as the other two.
    const d = deps({
      runReview,
      metric: () => { throw new Error(`the logger rejected the batch for token ${LEAKED_TOKEN}`) },
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    const reason = failedReasonOn(d)
    expect(reason).toContain('withheld')
    expect(reason).not.toContain(LEAKED_TOKEN)
    expect((thrown as Error).message).not.toContain(LEAKED_TOKEN)
  })

  it('does not retry a withheld review, and knows what the withheld review had cost', async () => {
    // 36 characters after the prefix: what the scanner's pattern actually matches. runReview throws
    // SecretLeak AFTER runEngine has been paid, and the error carries no usage — so the money is
    // known only because this task watched the engine.
    const TOKEN_IN_OUTPUT = 'ghp_' + 'A'.repeat(36)
    const leaky: EngineResult = {
      ...RESULT, output: { ...OUTPUT, summary: `the workflow used ${TOKEN_IN_OUTPUT} directly` },
    }
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({ runEngine: vi.fn(async () => leaky) }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as DoNotRetry).spentUsd).toBe(0.345)
    expect((thrown as Error).message).not.toContain(TOKEN_IN_OUTPUT)
    expect(d.publishReview).not.toHaveBeenCalled()
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  it('posts what a budget stop had already found, and does not throw away a review that was posted', async () => {
    const cut: EngineResult = {
      ...RESULT, usage: { ...USAGE, costUsd: 5 }, cutShort: true,
      failure: { kind: 'budget', spentUsd: 5 },
    }
    const d = deps({ runReview: vi.fn(async () => reviewOf({ result: cut })) })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(d.publishReview).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome)
      .toMatchObject({ kind: 'reviewed', costUsd: 5 })
    expect(out.record.failure).toEqual({ kind: 'budget', spentUsd: 5 })
    expect(out.record.cutShort).toBe(true)
  })
})

describe('when a review runs too long or is cancelled', () => {
  const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })

  it('hands the engine an abort signal, and aborts it when trigger.dev cancels the run', async () => {
    const outer = new AbortController()
    let inner: AbortSignal | undefined
    const d = deps({
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        inner = a.signal
        await untilAborted(a.signal)
        throw new Error('The operation was aborted')
      }),
    })
    const running = reviewTaskRun(PAYLOAD, { signal: outer.signal }, d).catch((e: unknown) => e)
    // runReview is reached only after the token, the pull request, the config and the check run
    // have each been awaited, so wait for the condition rather than for one microtask.
    await vi.waitFor(() => { expect(inner).toBeInstanceOf(AbortSignal) })
    expect(inner?.aborted).toBe(false)
    outer.abort()
    const thrown = await running
    expect(inner?.aborted).toBe(true)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('cancelled')
  })

  it('stops a review that passes its own deadline and completes the check run on the way out, because a maxDuration kill would not', async () => {
    const d = deps({
      deadlineMs: 5,
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        await untilAborted(a.signal)
        throw new Error('The operation was aborted')
      }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('deadline')
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome).toMatchObject({
      kind: 'failed', headSha: HEAD, reason: expect.stringContaining('deadline'),
    })
  })

  it('does not retry a review the deadline stopped, even when the killed engine reports it spent nothing', async () => {
    // The child is killed, so the engine comes back with a crash and $0 — which `mayRetry` would
    // otherwise call retryable. The deadline already spent the whole deadline's worth of model.
    const d = deps({
      deadlineMs: 5,
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        await untilAborted(a.signal)
        return reviewOf({
          result: {
            output: null, usage: { ...USAGE, costUsd: 0 }, cutShort: true, wrapUpFired: false,
            failure: { kind: 'crashed', code: null, stderr: 'killed' },
          },
        })
      }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('deadline')
  })

  it('publishes a review the deadline caught while it was finishing', async () => {
    // THE WINDOW THE THIRD PASS OPENED. `runRecheckPass` catches its own abort and returns a value,
    // so a deadline landing inside it produces a COMPLETE review — output, findings, a record, the
    // money already spent — and `runReview` returns it normally. This branch used to throw all of
    // that away without posting anything, on the only deployed path: no summary comment, no inline
    // comments, no marker, and the engine and check money gone. Design point 4 says an outcome
    // refinement must never cost the pull request its review, and the asymmetry was absurd — the
    // branch below publishes a review that produced NOTHING.
    const d = deps({
      deadlineMs: 5,
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        await untilAborted(a.signal)
        return reviewOf()                     // finished: output non-null, failure null
      }),
    })
    const out = await reviewTaskRun(PAYLOAD, {}, d)
    expect(d.publishReview).toHaveBeenCalledTimes(1)
    expect(out.kind).toBe('reviewed')
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('reviewed')
    // Said out loud in the log, because a deadline that changed nothing still means the review ran
    // right up to its limit.
    expect(d.logs.map((l) => l.message))
      .toContain('the review was stopped after it had already finished; publishing it anyway')
  })

  it('still throws away a review the deadline caught before it had anything', async () => {
    // The other half, unchanged: a stopped engine that produced nothing is not a review, and a
    // deadline means the model ran for the whole deadline. Not retried, whatever it says it cost.
    const d = deps({
      deadlineMs: 5,
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        await untilAborted(a.signal)
        return reviewOf({
          result: {
            output: null, usage: { ...USAGE, costUsd: 0.2 }, cutShort: true, wrapUpFired: false,
            failure: { kind: 'crashed', code: null, stderr: 'killed' },
          },
        })
      }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect(d.publishReview).not.toHaveBeenCalled()
  })

  it('leaves no timer behind after a review that finished early', async () => {
    vi.useFakeTimers()
    try {
      await reviewTaskRun(PAYLOAD, {}, deps({ deadlineMs: 60_000 }))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('buys nothing for a run trigger.dev had already cancelled before it started', async () => {
    // `addEventListener('abort', …)` on a signal that has ALREADY aborted never fires, and the
    // listener is attached four network round trips in — token, pull request, config, check run.
    // Without an up-front check, a run the operator cancelled while it sat in the queue reaches
    // the model with a live signal and is paid for in full.
    const cancelled = new AbortController()
    cancelled.abort()
    const d = deps()
    const thrown = await reviewTaskRun(PAYLOAD, { signal: cancelled.signal }, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('cancelled')
    expect(d.installationToken).not.toHaveBeenCalled()
    expect(d.runReview).not.toHaveBeenCalled()
  })

  it('buys nothing for a run cancelled in the four round trips before the listener is attached', async () => {
    // Not in the plan, and added because the second `aborted` check had no test: the guard at the
    // top of reviewTaskRun runs BEFORE the token, the pull request, the repo config and the check
    // run, and `addEventListener('abort', …)` is attached after all four. An abort landing in that
    // window fires no listener and is not seen by the top check either — so without the re-check
    // the run goes on to pay the model in full for an answer trigger.dev has already stopped
    // waiting for. Aborting inside `installationToken` puts the abort exactly in that window.
    const cancelled = new AbortController()
    const d = deps({
      installationToken: vi.fn(async () => { cancelled.abort(); return TOKEN }),
      // What a real `runReview` does with an already-aborted signal: `spawnClaude` rejects and the
      // rejection comes out of the pipeline. The default fixture here answers with a COMPLETE review
      // however the signal stands, which nothing in production can do — and since 2026-09-16 a
      // complete review is published even when a stop landed while it was finishing, so a fixture
      // that lies about this would be asserting the opposite of the rule it is testing.
      runReview: vi.fn(async (a: { signal?: AbortSignal }) => {
        if (a.signal?.aborted ?? false) throw new Error('The operation was aborted')
        return reviewOf()
      }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, { signal: cancelled.signal }, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('cancelled')
    // The money assertion: a cancelled run posts nothing and is never billed for a second review.
    expect(d.publishReview).not.toHaveBeenCalled()
    expect(vi.mocked(d.completeCheckRun).mock.calls[0][0].outcome.kind).toBe('failed')
  })

  it('stops itself before trigger.dev stops it, and before a check run counts as abandoned', async () => {
    // The order is the design: our deadline completes the check run, a maxDuration kill would not,
    // and an installation token is dead after an hour anyway. The middle number is read from the
    // NAMED export of trigger.config.ts rather than from defineConfig's return value: that function
    // lives in @trigger.dev/sdk, whose declared return type nothing in this plan has verified, and a
    // lock must not rest on a type nobody has read. The config passes the same constant to
    // `maxDuration`, so the two cannot drift. Both imports are dynamic and local to this test:
    // `DEFAULT_DEADLINE_MS` does not exist until Step 40, and a static import of a missing export
    // would fail the whole file at collection instead of failing this one case.
    // What the order does NOT cover is a death with nothing thrown: a crash, a SIGTERM, an eviction
    // or a stall. trigger.dev would retry those on its own (shouldRetryError, @trigger.dev/core
    // 4.5.16, Task 12 Step 5), and nothing is thrown that DoNotRetry could stop — and since
    // 2026-09-18 the project allows THREE attempts (MAX_ATTEMPTS; Criss, reversing answer 13), so
    // those deaths ARE repeated, including after the model has spent.
    // The dead run's check run stays `in_progress` until the next review of the commit or the
    // hourly sweep (Task 13b) closes it on STALE_AFTER_MS.
    vi.stubEnv('TRIGGER_PROJECT_REF', 'proj_test_only')
    try {
      const { MAX_DURATION_SECONDS } = await import('../../trigger.config')
      const { DEFAULT_DEADLINE_MS } = await import('./review-run')
      expect(DEFAULT_DEADLINE_MS).toBeLessThan(MAX_DURATION_SECONDS * 1000)
      expect(MAX_DURATION_SECONDS * 1000).toBeLessThan(STALE_AFTER_MS)
    } finally {
      // `unstubEnvs` is not on in vitest.config.ts, so a stub left here would follow every other
      // test in this worker.
      vi.unstubAllEnvs()
    }
  })
})

describe('what a finished review leaves behind', () => {
  it('emits cost, findings and duration as metrics, because metrics are queryable later and run metadata is not', async () => {
    const d = deps()
    await reviewTaskRun(PAYLOAD, { attempt: 2 }, d)
    const byName = Object.fromEntries(d.metrics.map((m) => [m.name, m]))
    expect(byName['review.cost_usd']?.value).toBe(0.345)
    expect(byName['review.findings']?.value).toBe(1)
    expect(byName['review.duration_ms']?.value).toBe(55_000)
    expect(byName['review.cost_usd']?.attributes).toMatchObject({
      repo: 'acme/widgets', pr: '16', tier: 'basic', model: 'claude-opus-5',
      outcome: 'reviewed', attempt: '2',
    })
  })

  it('records the money even when the review failed, because the money was still spent', async () => {
    const d = deps({
      runReview: vi.fn(async () => reviewOf({
        result: { ...RESULT, output: null, failure: { kind: 'refusal' } },
      })),
    })
    await reviewTaskRun(PAYLOAD, {}, d).catch(() => undefined)
    const cost = d.metrics.find((m) => m.name === 'review.cost_usd')
    expect(cost?.value).toBe(0.345)
    expect(cost?.attributes.outcome).toBe('refusal')
  })

  it('records the money a withheld review spent, which is the one failure that has no record at all', async () => {
    const leak = 'ghp_' + 'A'.repeat(36)
    const d = deps({
      runReview,
      runReviewDeps: runReviewDepsWith({
        runEngine: vi.fn(async () => ({
          ...RESULT, output: { ...OUTPUT, summary: `the workflow used ${leak}` },
        })),
      }),
    })
    await reviewTaskRun(PAYLOAD, {}, d).catch(() => undefined)
    const cost = d.metrics.find((m) => m.name === 'review.cost_usd')
    expect(cost?.value).toBe(0.345)
    expect(cost?.attributes.outcome).toBe('withheld')
  })

  it('records a skipped release as a review that cost nothing, so the saving is countable', async () => {
    const d = deps({
      fetchPullRequest: vi.fn(async () => ({
        ...PR, changedFiles: [{ path: 'CHANGELOG.md', status: 'modified' }],
      })),
    })
    await reviewTaskRun({ request: { repo: 'acme/widgets', pr: 16, headSha: HEAD }, installationId: 12_345_678 }, {}, d)
    const cost = d.metrics.find((m) => m.name === 'review.cost_usd')
    expect(cost?.value).toBe(0)
    expect(cost?.attributes.outcome).toBe('skipped')
  })

  it('logs a line small enough to survive, and never the review itself', async () => {
    const d = deps()
    await reviewTaskRun(PAYLOAD, {}, d)
    const line = d.logs.find((l) => l.message === 'review finished')
    expect(line?.fields).toMatchObject({ repo: 'acme/widgets', pr: 16, findings: 1, costUsd: 0.345 })
    const published = d.logs.find((l) => l.message === 'review published')
    expect(published?.fields).toMatchObject({ inline: 1, summaryOnly: 0, droppedInline: 0, suppressed: 0, notInCheckout: 0 })
    // The I/O packet cap is 128 KB and a transcript is clipped: the findings' own text never
    // enters a log line.
    expect(JSON.stringify(d.logs)).not.toContain('A tag pushed from any branch')
  })

  it('warns when a record is close to the 128 KB packet limit, so a clipped run page is explained', async () => {
    const fat = reviewOf({
      result: {
        ...RESULT,
        output: {
          ...OUTPUT,
          findings: Array.from({ length: 50 }, () => ({ ...FINDING, explanation: 'x'.repeat(2_500) })),
        },
      },
    })
    const d = deps({ runReview: vi.fn(async () => fat) })
    await reviewTaskRun(PAYLOAD, {}, d)
    const warning = d.logs.find((l) => l.message.includes('128 KB'))
    expect(Number(warning?.fields.recordBytes)).toBeGreaterThan(RECORD_WARN_BYTES)
  })

  it('never writes the model credential, the installation token or the App key anywhere', async () => {
    const d = deps()
    await reviewTaskRun(PAYLOAD, {}, d)
    const everything = JSON.stringify({ logs: d.logs, metrics: d.metrics })
    expect(everything).not.toContain(CREDENTIAL)
    expect(everything).not.toContain(TOKEN.token)
    expect(everything).not.toContain(IDENTITY.privateKeyPem)
  })

  it('names the variables and not the value when the credential is missing', () => {
    const message = String((() => {
      try { assertModelCredential({}); return '' } catch (e) { return e instanceof Error ? e.message : String(e) }
    })())
    expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(message).not.toContain(CREDENTIAL)
  })

  it('does not let a throw from this bookkeeping buy the review again', async () => {
    // These metric and log calls run after the money is gone, and in the deployed runner they are
    // `logger.info` from @trigger.dev/sdk. A plain Error out of one of them would start a new run
    // (Step 45e) — the whole review, $0.345 to $1.06 at per-token API prices, bought again, up to
    // twice more, because a logger had a bad moment. Step 40's catch is what stands there; this is
    // the case that proves it does.
    const d = deps({ runReview, metric: () => { throw new Error('the logger blew up') } })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    // The REAL runReview, and `basic` has the check pass on since Task 0 with no `check` key in the
    // request, so the pass ran over the one finding and its cost is part of what was spent. Both
    // figures are per-token API prices. Asserting the review's $0.345 alone would say the check
    // pass's money was not counted.
    expect((thrown as DoNotRetry).spentUsd).toBeCloseTo(USAGE.costUsd + CHECK_USAGE.costUsd, 10)
  })
})

describe('the hidden verdict, in every mode (Criss, decision 7)', () => {
  it('returns the verdict line in silent mode, where no check run exists to carry it, cut short and all', async () => {
    const cut: EngineResult = {
      ...RESULT, usage: { ...USAGE, costUsd: 5 }, cutShort: true, failure: { kind: 'budget', spentUsd: 5 },
    }
    const d = deps({
      fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => ({ mode: 'silent' })),
      runReview: vi.fn(async () => reviewOf({ result: cut })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(out.checkRun).toBeNull()
    expect(out.verdict.startsWith(VERDICT_OPEN)).toBe(true)
    expect(out.verdict).toContain('"cut_short":true')
    expect(out.record.cutShort).toBe(true)
  })

  it('returns the very line the check run carries when there is one', async () => {
    const d = deps()
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    const sent = vi.mocked(d.completeCheckRun).mock.calls[0][0]
    expect(out.verdict).toBe(verdictJson({ outcome: sent.outcome, bands: sent.bands }))
  })
})

describe('a failure that spent nothing starts another run, on purpose (Criss, answer 13)', () => {
  const port = () => vi.fn(async (_a: Parameters<TriggerPort>[0]) => ({ id: 'run_again_1' }))
  const gitHubDown = () => vi.fn(async () => { throw new Error('GitHub responded 502') })
  const crashedForFree: EngineResult = {
    output: null, usage: { ...USAGE, costUsd: 0 }, cutShort: false, wrapUpFired: false,
    failure: { kind: 'crashed', code: 137, stderr: 'killed' },
  }

  it('starts one new run of the same request when GitHub failed before anything was spent, and still fails this one', async () => {
    const startAnotherRun = port()
    const d = deps({ startAnotherRun, installationToken: gitHubDown() })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    // The error that explains THIS run, unchanged. Since 2026-09-18 trigger.dev repeats it up to
    // three attempts before failing the run (MAX_ATTEMPTS (Criss, 2026-09-18, reversing answer 13)); the error each attempt throws is this one.
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('502')
    expect(startAnotherRun).toHaveBeenCalledTimes(1)
    expect(startAnotherRun.mock.calls[0][0]).toEqual({
      taskId: REVIEW_TASK_ID,
      payload: { ...PAYLOAD, retry: 1 },
      // A key of its own: this run still holds the original one until it has failed.
      idempotencyKey: `${idempotencyKeyFor(REQUEST)}:retry-1`,
      tags: tagsFor(REQUEST),
    })
  })

  it('starts one for a crash that produced nothing and cost nothing, on the REAL runReview', async () => {
    const startAnotherRun = port()
    const d = deps({
      startAnotherRun, runReview,
      runReviewDeps: runReviewDepsWith({ runEngine: vi.fn(async () => crashedForFree) }),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RetryThis)
    expect(startAnotherRun).toHaveBeenCalledTimes(1)
    expect(startAnotherRun.mock.calls[0][0].payload.retry).toBe(1)
  })

  /** Every run this failure started, by the count it put in the payload. */
  const startedAfter = async (retry: number): Promise<(number | undefined)[]> => {
    const startAnotherRun = port()
    await reviewTaskRun({ ...PAYLOAD, retry }, {}, deps({ startAnotherRun, installationToken: gitHubDown() }))
      .catch(() => undefined)
    return startAnotherRun.mock.calls.map((c) => c[0].payload.retry)
  }

  it('counts the runs it started, starts one for the first failure and the second, and none after that', async () => {
    // Literals, never MAX_DELIBERATE_RETRIES: a case that reads the constant it is meant to pin
    // moves with it, and a ceiling nothing holds is not a ceiling — raise the export to 5 and a
    // request that has already been reviewed three times buys three more reviews in silence.
    // `retry` counts the runs already started FOR this request, so 0 is the run the webhook
    // started, and the whole request gets three: that one and the two below.
    expect(await startedAfter(0)).toEqual([1])
    expect(await startedAfter(1)).toEqual([2])
    expect(await startedAfter(2)).toEqual([])
    // Past the ceiling as well as at it — a hand-built payload can carry any number.
    expect(await startedAfter(3)).toEqual([])
  })

  it('says in the log that the request has used the runs it may start, and names the ceiling it used', async () => {
    const last = port()
    const d = deps({ startAnotherRun: last, installationToken: gitHubDown() })
    await reviewTaskRun({ ...PAYLOAD, retry: 2 }, {}, d).catch(() => undefined)
    expect(last).not.toHaveBeenCalled()
    expect(d.logs.find((l) => l.message.startsWith('not started again'))?.fields)
      .toMatchObject({ retry: 2, max: 2 })
  })

  it('publishes that ceiling as two, which is the number a payload built by hand sets to start none', async () => {
    // The exported value is a contract with everything that builds a payload without going through
    // this file — Task 15's one hosted run sets `retry` to exactly this so it buys exactly one
    // review. Two is the number because it leaves a request the three tries it had under
    // trigger.dev's own default of three attempts: three runs this file chose to start, each one
    // begun only when nothing had been spent. Since 2026-09-18 the platform ALSO retries three
    // times (MAX_ATTEMPTS; Criss, reversing answer 13), and the two multiply rather than overlap —
    // a request can now reach three deliberate runs of up to three paid attempts each.
    expect(MAX_DELIBERATE_RETRIES).toBe(2)
  })

  it('starts none when it cannot read the count, rather than guessing how many runs came before', async () => {
    for (const retry of [-1, 1.5, '1' as unknown as number]) {
      const startAnotherRun = port()
      await reviewTaskRun({ ...PAYLOAD, retry }, {}, deps({ startAnotherRun, installationToken: gitHubDown() }))
        .catch(() => undefined)
      expect(startAnotherRun).not.toHaveBeenCalled()
    }
  })

  it('never starts one after the model was paid, for a misconfigured deployment, or for a cancelled run', async () => {
    const refusedAfterSpend: EngineResult = {
      output: null, usage: { ...USAGE, costUsd: 1.02 }, cutShort: false, wrapUpFired: false,
      failure: { kind: 'refusal' },
    }
    const cases: Partial<ReviewTaskDeps>[] = [
      { runReview, runReviewDeps: runReviewDepsWith({ runEngine: vi.fn(async () => refusedAfterSpend) }) },
      { runReview, runReviewDeps: runReviewDepsWith({ runCheckPass: vi.fn(async () => { throw new Error('spawn EAGAIN') }) }) },
      { env: {} },
    ]
    for (const over of cases) {
      const startAnotherRun = port()
      const thrown = await reviewTaskRun(PAYLOAD, {}, deps({ ...over, startAnotherRun })).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(DoNotRetry)
      expect(startAnotherRun).not.toHaveBeenCalled()
    }
    const cancelled = new AbortController()
    cancelled.abort()
    const startAnotherRun = port()
    await reviewTaskRun(PAYLOAD, { signal: cancelled.signal }, deps({ startAnotherRun })).catch(() => undefined)
    expect(startAnotherRun).not.toHaveBeenCalled()
  })

  it('starts none in process, where there is no runner to start one on', async () => {
    const d = deps({ startAnotherRun: null, installationToken: gitHubDown() })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect((thrown as Error).message).toContain('502')
    expect(d.logs.some((l) => l.message.startsWith('not started again'))).toBe(true)
  })

  it('keeps the error that explains the run when another run cannot be started', async () => {
    const d = deps({
      startAnotherRun: vi.fn(async () => { throw new Error('trigger.dev answered 503') }),
      installationToken: gitHubDown(),
    })
    const thrown = await reviewTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect((thrown as Error).message).toContain('502')
    expect(String(d.logs.find((l) => l.message === 'another run could not be started')?.fields.why))
      .toContain('503')
  })

  it('starts nothing for a review that finished', async () => {
    const startAnotherRun = port()
    expect((await reviewTaskRun(PAYLOAD, {}, deps({ startAnotherRun }))).kind).toBe('reviewed')
    expect(startAnotherRun).not.toHaveBeenCalled()
  })
})

describe('trigger.dev repeats a run three times (Criss, 2026-09-18, reversing answer 13)', () => {
  it('allows three attempts per run, project-wide', async () => {
    // From the NAMED export, as the timeout-ordering case of Step 38 reads MAX_DURATION_SECONDS,
    // because what defineConfig returns is unverified (Task 12 Step 5). This was 1 from 2026-09-14
    // to 2026-09-18; the cost of 3 — a review that died after spending is paid up to three times —
    // is recorded on MAX_ATTEMPTS itself, and was put to Criss before he confirmed it.
    vi.stubEnv('TRIGGER_PROJECT_REF', 'proj_test_only')
    try {
      const { MAX_ATTEMPTS } = await import('../../trigger.config')
      expect(MAX_ATTEMPTS).toBe(3)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('hands that constant to the project default, and names no other attempt count', () => {
    const config = readFileSync(fileURLToPath(new URL('../../trigger.config.ts', import.meta.url)), 'utf8')
    expect(config).toMatch(/default:\s*\{\s*maxAttempts:\s*MAX_ATTEMPTS\b/)
    expect(config.match(/\bmaxAttempts\s*:/g) ?? []).toHaveLength(1)
  })
})

describe('the finished record, sent to the deployment (Criss, answer 16)', () => {
  const CALLBACK: RecordCallback = {
    url: 'https://ops.example.test/api/review-agent/record', secretEnv: 'REVIEW_AGENT_RECORD_SECRET',
  }
  const sender = (outcome: () => Promise<RecordCallbackOutcome>) =>
    vi.fn(async (_a: Parameters<typeof sendRecordCallback>[0]) => outcome())

  it('sends the finished review after it is published and its check run completed, and returns that same result', async () => {
    const sendRecord = sender(async () => ({ sent: true, status: 202 }))
    const d = deps({ recordCallback: CALLBACK, sendRecord })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(sendRecord).toHaveBeenCalledTimes(1)
    expect(sendRecord.mock.calls[0][0]).toEqual({ callback: CALLBACK, env: d.env, body: { version: 1, result: out } })
    const sentAt = sendRecord.mock.invocationCallOrder[0]
    expect(vi.mocked(d.publishReview).mock.invocationCallOrder[0]).toBeLessThan(sentAt)
    expect(vi.mocked(d.completeCheckRun).mock.invocationCallOrder[0]).toBeLessThan(sentAt)
  })

  it('sends it in silent mode too, where nothing is posted and the record is the whole account', async () => {
    const sendRecord = sender(async () => ({ sent: true, status: 202 }))
    const d = deps({
      recordCallback: CALLBACK, sendRecord,
      fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => ({ mode: 'silent' })),
    })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(sendRecord).toHaveBeenCalledTimes(1)
  })

  it('does not fail, retry or re-run a review whose callback threw', async () => {
    const sendRecord = sender(async () => { throw new Error('the callback receiver exploded') })
    const startAnotherRun = vi.fn(async (_a: Parameters<TriggerPort>[0]) => ({ id: 'run_again_1' }))
    const d = deps({ recordCallback: CALLBACK, sendRecord, startAnotherRun })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(out.record).toEqual(REVIEWED.record)
    expect(d.runReview).toHaveBeenCalledTimes(1)
    expect(startAnotherRun).not.toHaveBeenCalled()
    expect(d.logs.find((l) => l.message === 'record callback')?.fields.sent).toBe(false)
  })

  it('says in its log whether the record was sent, and never the address', async () => {
    const d = deps({ recordCallback: CALLBACK, sendRecord: sender(async () => ({ sent: false, why: 'timeout' })) })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(d.logs.find((l) => l.message === 'record callback')?.fields).toEqual({ sent: false, why: 'timeout' })
    expect(JSON.stringify(d.logs)).not.toContain(CALLBACK.url)
  })

  it('sends nothing for a review that did not finish, or that was skipped', async () => {
    const sendRecord = sender(async () => ({ sent: true, status: 202 }))
    const refused: EngineResult = { ...RESULT, output: null, failure: { kind: 'refusal' } }
    await reviewTaskRun(PAYLOAD, {}, deps({
      recordCallback: CALLBACK, sendRecord, runReview: vi.fn(async () => reviewOf({ result: refused })),
    })).catch(() => undefined)
    await reviewTaskRun({ request: { repo: 'acme/widgets', pr: 16, headSha: HEAD }, installationId: 12_345_678 }, {}, deps({
      recordCallback: CALLBACK, sendRecord,
      fetchPullRequest: vi.fn(async () => ({ ...PR, changedFiles: [{ path: 'CHANGELOG.md', status: 'modified' }] })),
    }))
    expect(sendRecord).not.toHaveBeenCalled()
  })
})

// ── The re-review pass, wired (Criss, 2026-09-16) ────────────────────────────────────────────────
// The question comes out of the marker in the bot's own summary comment, and the pass runs INSIDE
// runReview so its cost lands in the record. So the marker has to be read before the review, not
// during publishing — and the same one handed on, or a judgement's index would address rows it was
// not computed about.

describe('the re-review pass gets its question from the marker', () => {
  const previousRun: MarkerRun = {
    headSha: '1'.repeat(40), at: '2026-09-13T10:00:00.000Z',
    findings: [{
      id: 'a7ac9b0581f8', file: 'src/retry.ts', line: 24, severity: 8, category: 'correctness',
      title: 'Computed backoff delay is never used; the wait is always 0ms',
      commentId: 4013307235, outcome: 'open',
    }],
  }
  const MARKER: MarkerState = { version: 1, runs: [previousRun] }
  const SUMMARY: FoundSummary = { commentId: 9002, marker: MARKER }

  it('reads the summary comment once, before the review, and asks about its rows', async () => {
    const d = deps({ findSummaryComment: vi.fn(async () => SUMMARY), runReview })
    await reviewTaskRun(PAYLOAD, {}, d)

    expect(d.findSummaryComment).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.findSummaryComment).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', number: 16,
    })
    const asked = vi.mocked(d.runReviewDeps.runRecheckPass).mock.calls[0][0]
    expect(asked.previous).toEqual([{
      file: 'src/retry.ts', line: 24, severity: 8, category: 'correctness',
      title: 'Computed backoff delay is never used; the wait is always 0ms',
    }])
  })

  it('hands publishReview the very marker the question was built from', async () => {
    // Not a second listing. A re-read could answer with a different comment — somebody posts while
    // the review runs — and every judgement would then address the wrong rows.
    const d = deps({ findSummaryComment: vi.fn(async () => SUMMARY), runReview })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(vi.mocked(d.publishReview).mock.calls[0][0].existing).toBe(SUMMARY)
  })

  it('buys nothing on a first review: no marker, no question, no pass', async () => {
    const d = deps({ findSummaryComment: vi.fn(async () => null), runReview })
    await reviewTaskRun(PAYLOAD, {}, d)
    expect(d.runReviewDeps.runRecheckPass).not.toHaveBeenCalled()
    // `null` and not `undefined`: it looked, and there is none. publishReview must not look again.
    expect(vi.mocked(d.publishReview).mock.calls[0][0].existing).toBeNull()
  })

  it('puts the third pass’s money in the metric and the record, labelled like the other two', async () => {
    // The number the public summary prints. All three are model spend at per-token API prices —
    // not a subscription allowance, not a price charged to anyone — and a pass whose cost did not
    // reach this total would be an unrecorded charge.
    const d = deps({
      findSummaryComment: vi.fn(async () => SUMMARY),
      runReview,
      runReviewDeps: runReviewDepsWith({
        runRecheckPass: vi.fn(async () => ({
          judgements: [{ index: 0, file: 'src/retry.ts', state: 'resolved' as const, reason: 'r', evidence: [] }],
          usage: RECHECK_USAGE, ran: true, skipped: null,
        })),
      }),
    })
    const out = await reviewTaskRun(PAYLOAD, {}, d)
    const all = USAGE.costUsd + CHECK_USAGE.costUsd + RECHECK_USAGE.costUsd
    expect(d.metrics.find((m) => m.name === 'review.cost_usd')?.value).toBeCloseTo(all, 6)
    expect(out.kind === 'reviewed' ? out.record.costUsd : 0).toBeCloseTo(all, 6)
    expect(out.kind === 'reviewed' ? out.record.recheckUsage : null).toEqual(RECHECK_USAGE)
  })

  it('refuses the pass rather than the review when a secret in the OUTPUT stops everything first', async () => {
    // Ordering, asserted: `assertNoSecrets` runs before the check pass and therefore before this
    // one, so a review that cannot be emitted buys neither. $0.345 spent, and no third pass.
    const d = deps({
      findSummaryComment: vi.fn(async () => SUMMARY),
      runReview,
      runReviewDeps: runReviewDepsWith({
        runEngine: vi.fn(async () => ({
          ...RESULT,
          output: { ...OUTPUT, summary: `the workflow used ghp_${'A'.repeat(36)}` },
        })),
      }),
    })
    await reviewTaskRun(PAYLOAD, {}, d).catch(() => undefined)
    expect(d.runReviewDeps.runRecheckPass).not.toHaveBeenCalled()
    expect(d.metrics.find((m) => m.name === 'review.cost_usd')?.value).toBeCloseTo(USAGE.costUsd, 6)
  })

  it('reviews the pull request anyway when the marker cannot be read', async () => {
    // A listing GitHub refused. The review is worth more than the refinement: the pass is simply not
    // bought, and publishing does its own read as it always did.
    const d = deps({
      findSummaryComment: vi.fn(async () => { throw new Error('502 Bad Gateway') }),
      runReview,
    })
    expect((await reviewTaskRun(PAYLOAD, {}, d)).kind).toBe('reviewed')
    expect(d.runReviewDeps.runRecheckPass).not.toHaveBeenCalled()
    expect(vi.mocked(d.publishReview).mock.calls[0][0].existing).toBeUndefined()
  })

  it('carries the answer through to publishing, so an outcome can be settled', async () => {
    const d = deps({
      findSummaryComment: vi.fn(async () => SUMMARY),
      runReview,
      runReviewDeps: runReviewDepsWith({
        runRecheckPass: vi.fn(async () => ({
          judgements: [{ index: 0, file: 'src/retry.ts', state: 'resolved' as const, reason: 'guarded now', evidence: ['src/retry.ts:24'] }],
          usage: RECHECK_USAGE, ran: true, skipped: null,
        })),
      }),
    })
    await reviewTaskRun(PAYLOAD, {}, d)
    const review = vi.mocked(d.publishReview).mock.calls[0][0].review
    expect(review.recheck?.judgements).toEqual([
      { index: 0, file: 'src/retry.ts', state: 'resolved', reason: 'guarded now', evidence: ['src/retry.ts:24'] },
    ])
    expect(review.record.recheckUsage?.costUsd).toBe(RECHECK_USAGE.costUsd)
  })

  it('logs whether the pass ran, so silence is not mistaken for agreement', async () => {
    // "No outcome changed" and "the pass never ran" look identical from outside — and the whole
    // history of this feature is outcomes that were wrong and looked fine. An operator has to be
    // able to tell them apart without opening the record.
    const refused: RecheckPassResult = {
      judgements: [], ran: false, skipped: 'budget',
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 },
    }
    const d = deps({
      findSummaryComment: vi.fn(async () => SUMMARY),
      runReview,
      runReviewDeps: runReviewDepsWith({ runRecheckPass: vi.fn(async () => refused) }),
    })
    await reviewTaskRun(PAYLOAD, {}, d)
    const finished = d.logs.find((l) => l.message === 'review finished')
    expect(finished?.fields).toMatchObject({ recheck: 'budget' })

    const answered = deps({
      findSummaryComment: vi.fn(async () => SUMMARY),
      runReview,
      runReviewDeps: runReviewDepsWith({
        runRecheckPass: vi.fn(async () => ({
          judgements: [{ index: 0, file: 'src/retry.ts', state: 'resolved' as const, reason: 'r', evidence: [] }],
          usage: RECHECK_USAGE, ran: true, skipped: null,
        })),
      }),
    })
    await reviewTaskRun(PAYLOAD, {}, answered)
    expect(answered.logs.find((l) => l.message === 'review finished')?.fields)
      .toMatchObject({ recheck: 'ran', recheckResolved: 1 })

    // A first review asked nothing, and says so rather than reading as a pass that answered nothing.
    const firstReview = deps({ runReview })
    await reviewTaskRun(PAYLOAD, {}, firstReview)
    expect(firstReview.logs.find((l) => l.message === 'review finished')?.fields)
      .toMatchObject({ recheck: 'not-asked' })
  })
})

// Added 2026-09-24 (Criss: "Fix it inside #6 first"). With MAX_ATTEMPTS at 3, trigger.dev retries a
// killed attempt itself. The retry must close the killed attempt's check run — that one, by id —
// before it opens its own, or the pull request shows a stuck "in progress" check for up to an hour.
describe('a retried attempt closes the check run of the attempt it replaces', () => {
  const memory = (recalled: number | undefined) => {
    const remembered: number[] = []
    return {
      remembered,
      port: {
        remember: vi.fn(async (id: number) => { remembered.push(id) }),
        recall: vi.fn(() => recalled),
      },
    }
  }

  it('on the first attempt, remembers the check run it created and closes nothing', async () => {
    const m = memory(undefined)
    const d = deps({ checkRunMemory: m.port })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 1 }, d))
    expect(m.remembered).toEqual([4242])
    expect(d.closeCheckRunIfInProgress).not.toHaveBeenCalled()
  })

  it('on a retry, closes the recalled check run BEFORE opening a new one, then remembers the new one', async () => {
    const order: string[] = []
    const m = memory(901)
    const d = deps({
      checkRunMemory: m.port,
      closeCheckRunIfInProgress: vi.fn(async () => { order.push('close'); return true }),
      createCheckRun: vi.fn(async () => { order.push('create'); return { id: 4242, url: null } }),
    })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 2 }, d))
    expect(order).toEqual(['close', 'create'])
    // By id, and scoped to this review's own name and commit — never a sibling's check.
    expect(vi.mocked(d.closeCheckRunIfInProgress).mock.calls[0][0]).toMatchObject({
      checkRunId: 901, owner: 'acme', repo: 'widgets', name: 'review-agent', headSha: HEAD,
    })
    expect(m.remembered).toEqual([4242])
  })

  it('on a retry with nothing recalled, closes nothing and still reviews', async () => {
    // The fallback: whatever lost the id, the hourly sweep still closes the stale run, as before.
    const d = deps({ checkRunMemory: memory(undefined).port })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 2 }, d))
    expect(d.closeCheckRunIfInProgress).not.toHaveBeenCalled()
  })

  it('with no memory at all — the in-process runner — closes nothing on any attempt', async () => {
    const d = deps({ checkRunMemory: null })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 3 }, d))
    expect(d.closeCheckRunIfInProgress).not.toHaveBeenCalled()
  })

  it('still reviews when closing the old check run fails, and says so', async () => {
    // Housekeeping, like createCheckRun's own sweep: a stuck check is a blemish, a review that did
    // not run because the cleanup 403'd is a broken product.
    const d = deps({
      checkRunMemory: memory(901).port,
      closeCheckRunIfInProgress: vi.fn(async () => { throw new Error('403 Resource not accessible') }),
    })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 2 }, d))
    expect(d.createCheckRun).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(d.logs)).toMatch(/could not close the check run/)
  })

  it('still reviews when remembering the new check run fails, and says so', async () => {
    const m = memory(undefined)
    m.port.remember = vi.fn(async () => { throw new Error('metadata unavailable') })
    const d = deps({ checkRunMemory: m.port })
    reviewedOf(await reviewTaskRun(PAYLOAD, { attempt: 1 }, d))
    expect(JSON.stringify(d.logs)).toMatch(/could not remember the check run/)
  })
})


// Added 2026-09-24 (Criss: a deployment's listener, in the product's words). A deployment that
// records what people reply to a finding has to know which GitHub comment IS that finding — a reply
// arrives carrying only `in_reply_to_id`. The product already reads every posted comment's id back
// into the marker; the finished record now carries this run's list, so a deployment can match a
// reply to a finding without a GitHub read of its own.
describe('the finished result carries the comment each posted finding became', () => {
  const run = (headSha: string, findings: Array<{ id: string; file: string; line: number; commentId: number | null }>) => ({
    headSha, at: '2026-09-24T09:00:00.000Z',
    findings: findings.map((f) => ({ ...f, severity: 7 as const, title: 't', outcome: 'open' as const })),
  })

  it('lists this run\'s posted findings as { findingId, file, line, commentId }', async () => {
    const d = deps({
      publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review, {
        marker: { version: 1, runs: [run(HEAD, [
          { id: 'f-aaa', file: 'src/a.ts', line: 10, commentId: 5001 },
          { id: 'f-bbb', file: 'src/b.ts', line: 22, commentId: 5002 },
        ])] },
      })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(out.comments).toEqual([
      { findingId: 'f-aaa', file: 'src/a.ts', line: 10, commentId: 5001 },
      { findingId: 'f-bbb', file: 'src/b.ts', line: 22, commentId: 5002 },
    ])
  })

  it('leaves out a finding that got no inline comment — summary-only, or refused by GitHub', async () => {
    const d = deps({
      publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review, {
        marker: { version: 1, runs: [run(HEAD, [
          { id: 'f-aaa', file: 'src/a.ts', line: 10, commentId: 5001 },
          { id: 'f-ccc', file: 'src/c.ts', line: 3, commentId: null },
        ])] },
      })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(out.comments.map((c) => c.findingId)).toEqual(['f-aaa'])
  })

  it('takes THIS run, never an earlier review\'s, even when the marker holds several', async () => {
    // The marker keeps up to ten runs. An earlier review's comments are not this review's, and a
    // reply under one of them belongs to that earlier record.
    const d = deps({
      publishReview: vi.fn(async (a: { review: RunReviewResult }) => publishedFor(a.review, {
        marker: { version: 1, runs: [
          run('0'.repeat(40), [{ id: 'f-old', file: 'src/a.ts', line: 1, commentId: 4001 }]),
          run(HEAD, [{ id: 'f-new', file: 'src/a.ts', line: 1, commentId: 5001 }]),
        ] },
      })),
    })
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(out.comments).toEqual([{ findingId: 'f-new', file: 'src/a.ts', line: 1, commentId: 5001 }])
  })

  it('is an empty list — not absent — when nothing was posted inline', async () => {
    const out = reviewedOf(await reviewTaskRun(PAYLOAD, {}, deps()))
    expect(out.comments).toEqual([])
  })
})

describe('the review task: the downloaded code', () => {
  it('is deleted after the review is published', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-runner-checkout-'))
    const d = deps({ runReview: vi.fn(async () => ({ ...reviewOf(), checkoutDir: dir })) })
    reviewedOf(await reviewTaskRun(PAYLOAD, {}, d))
    expect(existsSync(dir)).toBe(false)
  })
})

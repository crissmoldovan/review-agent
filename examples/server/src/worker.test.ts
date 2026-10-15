import type { installationToken } from '@review-agent/app'
import { pushAccessOf, SecretValue, defaultDeploymentConfig, type ReviewOptions, type ReviewResult } from '@review-agent/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewJob } from './job'
import { createLogger } from './log'
import { reviewJob, type WorkerDeps } from './worker'

const HEAD_SHA = 'b'.repeat(40)
// Shaped like the real thing, so the logger's pattern scan is exercised as it would be in production.
const INSTALLATION_TOKEN = `ghs_${'T'.repeat(36)}`
const API_KEY = `sk-ant-api03-${'k'.repeat(40)}`
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n'

const automatic: ReviewJob = {
  key: `auto:acme/widgets#7@${HEAD_SHA}`,
  request: { repo: 'acme/widgets', pr: 7, headSha: HEAD_SHA },
  installationId: 42,
  refused: [],
  deliveryId: 'delivery-1',
}
const requested: ReviewJob = {
  key: 'req:acme/widgets#7:9001',
  request: { repo: 'acme/widgets', pr: 7, headSha: 'unresolved', tier: 'normal', requestedBy: 'alice', requestId: '9001' },
  installationId: 42,
  refused: [],
  deliveryId: 'delivery-2',
}

const REVIEWED = {
  kind: 'reviewed',
  record: { costUsd: 0.21 },
  findings: [],
  posted: null,
  report: { kind: 'check-run', conclusion: 'success', url: 'https://github.com/acme/widgets/runs/1', id: 1 },
} as unknown as ReviewResult

const failed = (a: { retryable: boolean; spentUsd: number; cause?: unknown }): ReviewResult => ({
  kind: 'failed', stage: a.spentUsd === 0 ? 'before-model' : 'model', reason: 'it did not run',
  spentUsd: a.spentUsd, retryable: a.retryable, stopped: null, record: null, findings: null, report: null,
  cause: a.cause,
})

/** The worker with GitHub and the model faked: a token minter, a client whose only route is the pull
 *  request's file list, and a review that returns what the case says. */
const setup = (a: { files?: string[]; result?: ReviewResult; mint?: WorkerDeps['mintToken'] } = {}) => {
  const lines: string[] = []
  const requests: string[] = []
  const octokit = {
    request: vi.fn(async (route: string) => {
      requests.push(route)
      return { data: (a.files ?? ['src/a.ts']).map((filename) => ({ filename })) }
    }),
  }
  const mintToken = a.mint ?? vi.fn<typeof installationToken>(async () => ({
    token: INSTALLATION_TOKEN, expiresAt: '2026-10-15T13:00:00Z', repositories: ['acme/widgets'],
  }))
  const github = vi.fn(() => octokit as unknown as ReturnType<NonNullable<WorkerDeps['github']>>)
  const review = vi.fn(async (_o: ReviewOptions): Promise<ReviewResult> => a.result ?? REVIEWED)
  const deps: WorkerDeps = {
    identity: { clientId: 'Iv23liExampleClientId', privateKeyPem: PEM },
    apiKey: new SecretValue(API_KEY),
    deployment: defaultDeploymentConfig(),
    workDir: '/srv/review-agent/checkouts',
    skillCacheDir: '/srv/review-agent/skills',
    log: createLogger({ secrets: () => [API_KEY, PEM], write: (l) => lines.push(l) }),
    mintToken, github, review,
  }
  return { deps, lines, requests, mintToken, github, review, octokit }
}

const optionsOf = (review: ReturnType<typeof setup>['review']): ReviewOptions => review.mock.calls[0][0]

describe('reviewJob, an automatic review', () => {
  it('reviews as the App: a token for the one repository, posted, reported with a check run', async () => {
    const s = setup()
    const signal = new AbortController().signal
    expect(await reviewJob(automatic, signal, s.deps)).toEqual({ remember: true })

    expect(s.mintToken).toHaveBeenCalledWith({
      identity: s.deps.identity, installationId: 42, repositories: ['widgets'],
    })
    expect(s.github).toHaveBeenCalledWith(INSTALLATION_TOKEN)
    const o = optionsOf(s.review)
    expect(o).toMatchObject({
      repo: 'acme/widgets', pr: 7, github: { octokit: s.octokit }, post: true, report: 'check-run',
      settings: s.deps.deployment, workDir: s.deps.workDir, skillCacheDir: s.deps.skillCacheDir, signal,
    })
    expect((o.credential as { apiKey: SecretValue }).apiKey.reveal()).toBe(API_KEY)
    // Nobody asked, so there is nobody to authorize: any pull request that opens is reviewed.
    expect(o).not.toHaveProperty('authorize')
    expect(o).not.toHaveProperty('requestedBy')
  })

  it('is skipped before anything is spent when every changed file is a release file', async () => {
    const s = setup({ files: ['package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'] })
    expect(await reviewJob(automatic, new AbortController().signal, s.deps)).toEqual({ remember: true })
    expect(s.review).not.toHaveBeenCalled()
    expect(s.lines.some((l) => l.includes('review skipped: every changed file is a release file'))).toBe(true)
  })

  it('is reviewed when code changed beside the release files', async () => {
    const s = setup({ files: ['package.json', 'src/money.ts'] })
    await reviewJob(automatic, new AbortController().signal, s.deps)
    expect(s.review).toHaveBeenCalledOnce()
  })
})

describe('reviewJob, a requested review', () => {
  it("is gated on the requester's push access, and carries what they asked for", async () => {
    const s = setup()
    await reviewJob(requested, new AbortController().signal, s.deps)
    expect(optionsOf(s.review)).toMatchObject({ requestedBy: 'alice', authorize: pushAccessOf, tier: 'normal' })
  })

  it('reviews a release-only pull request: the rule is for automatic reviews only', async () => {
    const s = setup({ files: ['package.json', 'pnpm-lock.yaml'] })
    await reviewJob(requested, new AbortController().signal, s.deps)
    expect(s.requests).toEqual([])
    expect(s.review).toHaveBeenCalledOnce()
  })

  it('is refused before a token is minted when GitHub named nobody, so push access cannot be checked', async () => {
    const s = setup()
    const nobody = { ...requested, request: { ...requested.request, requestedBy: undefined } }
    expect(await reviewJob(nobody, new AbortController().signal, s.deps)).toEqual({ remember: true })
    expect(s.mintToken).not.toHaveBeenCalled()
    expect(s.review).not.toHaveBeenCalled()
  })
})

describe('reviewJob tells the queue', () => {
  it('to forget a review GitHub would not mint a token for, so a redelivery runs it', async () => {
    const s = setup({ mint: vi.fn<typeof installationToken>(async () => { throw new Error('HTTP 502') }) })
    expect(await reviewJob(automatic, new AbortController().signal, s.deps)).toEqual({ remember: false })
    expect(s.review).not.toHaveBeenCalled()
  })

  it('to forget a review that failed before spending anything', async () => {
    const s = setup({ result: failed({ retryable: true, spentUsd: 0 }) })
    expect(await reviewJob(automatic, new AbortController().signal, s.deps)).toEqual({ remember: false })
  })

  it('to remember a review that failed after the model was paid, so a redelivery does not pay twice', async () => {
    const s = setup({ result: failed({ retryable: false, spentUsd: 0.4 }) })
    expect(await reviewJob(automatic, new AbortController().signal, s.deps)).toEqual({ remember: true })
  })

  it('to forget a review cancelled before it started', async () => {
    const s = setup()
    const controller = new AbortController()
    controller.abort()
    expect(await reviewJob(automatic, controller.signal, s.deps)).toEqual({ remember: false })
    expect(s.mintToken).not.toHaveBeenCalled()
  })
})

describe('reviewJob logs', () => {
  it('no installation token, API key or App key, even when a note or an error quotes one', async () => {
    const s = setup({ result: failed({ retryable: false, spentUsd: 0.1, cause: new Error(`Bad credentials: ${INSTALLATION_TOKEN}`) }) })
    s.review.mockImplementationOnce(async (o: ReviewOptions) => {
      o.onProgress?.({ repo: o.repo, pr: o.pr, stage: 'preparing', note: `token ${INSTALLATION_TOKEN}`, details: { authorization: `token ${INSTALLATION_TOKEN}`, key: API_KEY } })
      return failed({ retryable: false, spentUsd: 0.1, cause: new Error(`Bad credentials: ${INSTALLATION_TOKEN} ${PEM}`) })
    })
    await reviewJob(automatic, new AbortController().signal, s.deps)
    const all = s.lines.join('\n')
    expect(s.lines.length).toBeGreaterThan(2)
    expect(all).not.toContain(INSTALLATION_TOKEN)
    expect(all).not.toContain(API_KEY)
    expect(all).not.toContain('not-a-real-key')
  })
})

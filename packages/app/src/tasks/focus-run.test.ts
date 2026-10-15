import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, resolveSettings,
  type DeploymentConfig, type EngineInput, type EngineResult, type Finding, type RepoConfig, type ReviewOutput,
  type ReviewRequest, type Usage,
} from '@review-agent/core'
import type { PullRequestContext } from '@review-agent/github'
import { describe, expect, it, vi } from 'vitest'
import type { AppIdentity } from '../credentials'
import {
  FOCUS_TASK_ID, focusesAsChildTasks, focusIdempotencyKey, focusTaskRun,
  type FocusBatchItem, type FocusBatchRun, type FocusTaskDeps, type FocusTaskOutput, type FocusTaskPayload,
} from './focus-run'
import { DoNotRetry } from './review-run'

// Never a real credential: a nonsense value in the shape of one, findable in any output it leaks into.
const CREDENTIAL = 'sk-ant-oat01-FAKE-DO-NOT-LOG-9K2P'
const IDENTITY: AppIdentity = { clientId: 'Iv23liR3v13wAg3nt', privateKeyPem: 'FAKE-PEM-DO-NOT-LOG' }
const HEAD = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
const BASE = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'
const MOVED = 'a'.repeat(40)
const LEAKED_TOKEN = 'ghp_' + 'A'.repeat(36)

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16, headSha: HEAD, baseSha: BASE,
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and nothing checks them.',
  changedFiles: [{ path: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -88,6 +88,37 @@\n context\n' }],
  diff: 'diff --git a/.github/workflows/publish.yml b/.github/workflows/publish.yml\n',
}
const FINDING: Finding = {
  file: '.github/workflows/publish.yml', line: 100, endLine: null, severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes', explanation: 'A tag pushed from any branch publishes it.',
  evidence: ['.github/workflows/publish.yml:100'], suggestion: null,
}
const OUTPUT: ReviewOutput = {
  summary: 'Adds a tag check to publish.yml.', intent: { verdict: 'matches', note: 'It does what it says.' },
  findings: [FINDING], inconclusive: [],
}
// A measured basic-tier run, at per-token API prices (design §8).
const USAGE: Usage = {
  costUsd: 0.345, inputTokens: 18, outputTokens: 3333, cacheReadTokens: 121_660,
  cacheWriteTokens: 19_864, turns: 10, durationMs: 51_900,
}
const RESULT: EngineResult = { output: OUTPUT, usage: USAGE, cutShort: false, wrapUpFired: false, failure: null }

const REQUEST: ReviewRequest = {
  repo: 'acme/widgets', pr: 16, headSha: HEAD, multi: true, tier: 'normal',
  requestedBy: 'crissmoldovan', requestId: 'gh-delivery-8f2c',
}
const PAYLOAD: FocusTaskPayload = { installationId: 12_345_678, request: REQUEST, baseSha: BASE, lens: 'security' }

type Harness = FocusTaskDeps & { logs: { message: string; fields: Record<string, unknown> }[]; checkouts: string[] }

const deps = (over: Partial<FocusTaskDeps> & { engine?: FocusTaskDeps['runReviewDeps']['runEngine'] } = {}): Harness => {
  const logs: Harness['logs'] = []
  const checkouts: string[] = []
  const { engine, ...rest } = over
  return {
    logs, checkouts,
    env: { CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL },
    identity: vi.fn(() => IDENTITY),
    deployment: () => defaultDeploymentConfig(),
    deadlineMs: 30 * 60 * 1000,
    installationToken: vi.fn(async () => ({ token: 'ghs_FAKE', expiresAt: '2026-10-15T11:00:00Z', repositories: ['acme/widgets'] })),
    makeOctokit: vi.fn(() => ({}) as Octokit),
    fetchPullRequest: vi.fn(async () => PR),
    fetchRepoConfig: vi.fn(async (): Promise<RepoConfig | null> => null),
    runReviewDeps: {
      // A real directory, so the run's removal of it is something a case can see.
      makeCheckoutDir: vi.fn(async () => { const d = mkdtempSync(join(tmpdir(), 'ra-focus-')); checkouts.push(d); return d }),
      downloadArchive: vi.fn(async (a: { destDir: string }) => ({ dir: a.destDir, removed: [], notWritten: [], caseCollisions: [] })),
      materialiseSkills: vi.fn(async () => []),
      skillCacheDir: () => join(tmpdir(), 'ra-focus-skills'),
      runEngine: engine ?? vi.fn(async () => RESULT),
    },
    log: (message, fields) => { logs.push({ message, fields }) },
    ...rest,
  }
}

const engineOf = (d: FocusTaskDeps) => vi.mocked(d.runReviewDeps.runEngine)

describe('a focus, run as a child task (spec 0.2.0 §8.3 point 4)', () => {
  it('is the task the review triggers', () => {
    expect(FOCUS_TASK_ID).toBe('review-agent-focus')
  })

  it('reviews the review’s own commit with one engine pass for its focus, and hands back what the engine said', async () => {
    const d = deps()
    const out = await focusTaskRun(PAYLOAD, {}, d)

    expect(d.installationToken).toHaveBeenCalledWith({ identity: IDENTITY, installationId: 12_345_678, repositories: ['widgets'] })
    // The settings file from the BASE commit the review read, and the archive at the head it reviewed.
    expect(vi.mocked(d.fetchRepoConfig).mock.calls[0][0]).toMatchObject({ baseRef: BASE })
    expect(vi.mocked(d.runReviewDeps.downloadArchive).mock.calls[0][0]).toMatchObject({ ref: HEAD })
    expect(engineOf(d)).toHaveBeenCalledTimes(1)
    const input: EngineInput = engineOf(d).mock.calls[0][0]
    expect(input.systemPrompt).toContain('Your focus: security')
    expect(input.systemPrompt).not.toContain('Your focus: intent')
    // The tier's whole budget, not a third of it: what a focus run in one process gets.
    expect(input.settings.budget).toEqual({ targetUsd: 3, wrapUpAtUsd: 2.1, ceilingUsd: 7.5 })
    // The model credential travels with the pass, named rather than inherited (spec 0.2.0 §3.2).
    expect(input.runtime?.credential?.kind).toBe('oauth-token')
    expect(out).toEqual({ lens: 'security', headSha: HEAD, result: RESULT, withheld: [] })
    expect(existsSync(d.checkouts[0])).toBe(false)
  })

  it('resolves exactly the settings its review resolved, from the same deployment, file and request', async () => {
    const deployment: DeploymentConfig = { ...defaultDeploymentConfig(), instructions: 'Money is in cents.' }
    const repoConfig: RepoConfig = { instructions: 'Every workflow change is security-relevant.' }
    const d = deps({ deployment: () => deployment, fetchRepoConfig: vi.fn(async () => repoConfig) })
    await focusTaskRun(PAYLOAD, {}, d)
    expect(engineOf(d).mock.calls[0][0].settings).toEqual(resolveSettings({ deployment, repo: repoConfig, request: REQUEST }))
  })

  it('cannot be made to spend more than the deployment allows: a payload names what was asked, never settings', async () => {
    // A trigger key can start any task; a focus payload asking for a $500 budget gets the tier's,
    // as a review payload would.
    const d = deps()
    await focusTaskRun({ ...PAYLOAD, request: { ...REQUEST, budgetUsd: 500 } }, {}, d)
    expect(engineOf(d).mock.calls[0][0].settings.budget.ceilingUsd).toBe(7.5)
  })

  it('refuses a payload that names no commit, repository or focus it can run, before anything is minted', async () => {
    for (const bad of [
      { ...PAYLOAD, lens: 'style' },
      { ...PAYLOAD, baseSha: 'main' },
      { ...PAYLOAD, request: { ...REQUEST, headSha: 'HEAD' } },
      { ...PAYLOAD, request: { ...REQUEST, repo: 'widgets' } },
      { ...PAYLOAD, installationId: 0 },
    ]) {
      const d = deps()
      await expect(focusTaskRun(bad as FocusTaskPayload, {}, d)).rejects.toBeInstanceOf(DoNotRetry)
      expect(d.installationToken).not.toHaveBeenCalled()
    }
  })

  it('refuses to start without exactly one model credential, or without the App identity', async () => {
    for (const over of [{ env: {} }, { identity: vi.fn((): AppIdentity => { throw new Error('the App identity is not set') }) }]) {
      const d = deps(over)
      await expect(focusTaskRun(PAYLOAD, {}, d)).rejects.toBeInstanceOf(DoNotRetry)
      expect(d.installationToken).not.toHaveBeenCalled()
    }
  })

  it('reviews nothing when the pull request has moved on from the commit its review is of', async () => {
    const d = deps({ fetchPullRequest: vi.fn(async () => ({ ...PR, headSha: MOVED })) })
    const thrown = await focusTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('moved on')
    expect(d.runReviewDeps.downloadArchive).not.toHaveBeenCalled()
    expect(engineOf(d)).not.toHaveBeenCalled()
  })

  it('lets a failure before the engine out as it is, so trigger.dev may try the free part again', async () => {
    const d = deps({
      runReviewDeps: { ...deps().runReviewDeps, downloadArchive: vi.fn(async () => { throw new Error('GitHub responded 502 on the tarball') }) },
    })
    const thrown = await focusTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).not.toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).toContain('502')
    expect(engineOf(d)).not.toHaveBeenCalled()
  })

  it('returns whatever the engine returned — a ceiling stop with partial findings, or a paid refusal — so a focus that ran never runs again', async () => {
    const cut: EngineResult = { ...RESULT, usage: { ...USAGE, costUsd: 7.5 }, cutShort: true, failure: { kind: 'budget', spentUsd: 7.5 } }
    const refused: EngineResult = { output: null, usage: { ...USAGE, costUsd: 1.02 }, cutShort: false, wrapUpFired: false, failure: { kind: 'refusal' } }
    for (const answer of [cut, refused]) {
      const out = await focusTaskRun(PAYLOAD, {}, deps({ engine: vi.fn(async () => answer) }))
      expect(out.result).toEqual(answer)
    }
  })

  it('does not run again an engine that threw, because what it spent is not known', async () => {
    const d = deps({ engine: vi.fn(async (): Promise<EngineResult> => { throw new Error(`spawn failed for ${LEAKED_TOKEN}`) }) })
    const thrown = await focusTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as Error).message).not.toContain(LEAKED_TOKEN)
    expect(existsSync(d.checkouts[0])).toBe(false)
  })

  it('does not run again a focus whose bookkeeping failed after its engine had spent', async () => {
    const d = deps({ log: () => { throw new Error('the logger rejected the batch') } })
    const thrown = await focusTaskRun(PAYLOAD, {}, d).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(DoNotRetry)
    expect((thrown as DoNotRetry).spentUsd).toBe(0.345)
  })

  it('never hands back an answer that matched a secret pattern — only where it matched, and what it cost', async () => {
    const leaky: EngineResult = { ...RESULT, output: { ...OUTPUT, summary: `the workflow used ${LEAKED_TOKEN}` } }
    const out = await focusTaskRun(PAYLOAD, {}, deps({ engine: vi.fn(async () => leaky) }))
    expect(out.result.output).toBeNull()
    expect(out.result.usage.costUsd).toBe(0.345)
    expect(out.withheld.length).toBeGreaterThan(0)
    expect(JSON.stringify(out)).not.toContain(LEAKED_TOKEN)
  })

  it('writes its findings’ paths as the repository does, against its own checkout', async () => {
    let checkout = ''
    const d = deps({
      engine: vi.fn(async (i: EngineInput) => {
        checkout = realpathSync(i.checkoutDir)
        return { ...RESULT, output: { ...OUTPUT, findings: [{ ...FINDING, file: join(checkout, '.github/workflows/publish.yml') }] } }
      }),
    })
    const out = await focusTaskRun(PAYLOAD, {}, d)
    expect(out.result.output?.findings[0].file).toBe('.github/workflows/publish.yml')
  })

  it('stops the engine at its own deadline, and hands back what it had', async () => {
    const stopped: EngineResult = { output: null, usage: { ...USAGE, costUsd: 0.2 }, cutShort: true, wrapUpFired: false, failure: { kind: 'crashed', code: null, stderr: 'killed' } }
    const d = deps({
      deadlineMs: 5,
      engine: vi.fn((i: EngineInput) => new Promise<EngineResult>((resolve) => {
        i.signal?.addEventListener('abort', () => { resolve(stopped) }, { once: true })
      })),
    })
    expect((await focusTaskRun(PAYLOAD, {}, d)).result).toEqual(stopped)
  })

  it('buys nothing for a focus trigger.dev cancelled before it started', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const d = deps()
    await expect(focusTaskRun(PAYLOAD, { signal: cancelled.signal }, d)).rejects.toBeInstanceOf(DoNotRetry)
    expect(d.installationToken).not.toHaveBeenCalled()
  })
})

describe('the review’s focuses, as child tasks (decision §14.18 (a))', () => {
  const answered = (lens: FocusTaskOutput['lens'], result: EngineResult = RESULT, withheld: FocusTaskOutput['withheld'] = []): FocusBatchRun =>
    ({ ok: true, id: `run_${lens}`, output: { lens, headSha: HEAD, result, withheld } })
  const batchAnswering = (runs: FocusBatchRun[]) => vi.fn(async (_items: FocusBatchItem[]) => ({ id: 'batch_1', runs }))
  const ASK = { multi: true as const, tier: 'normal' as const, requestedBy: 'crissmoldovan', requestId: 'gh-delivery-8f2c' }
  const SETTINGS = resolveSettings({ deployment: defaultDeploymentConfig(), repo: null, request: { ...ASK, repo: 'acme/widgets', pr: 16, headSha: HEAD } })

  it('starts all three in one batch and waits for them, each keyed on its focus and the commit', async () => {
    const batch = batchAnswering([answered('intent'), answered('impact'), answered('security')])
    const out = await focusesAsChildTasks({ installationId: 12_345_678, batch })({ pr: PR, ask: ASK, settings: SETTINGS })

    expect(batch).toHaveBeenCalledTimes(1)
    const items = batch.mock.calls[0][0]
    expect(items.map((i) => i.payload.lens)).toEqual(['intent', 'impact', 'security'])
    // Run-scoped by trigger.dev (a raw string from inside a run): one child per review run and focus.
    expect(items.map((i) => i.options.idempotencyKey)).toEqual([
      focusIdempotencyKey('intent', HEAD), focusIdempotencyKey('impact', HEAD), focusIdempotencyKey('security', HEAD),
    ])
    expect(new Set(items.map((i) => i.options.idempotencyKey)).size).toBe(3)
    expect(focusIdempotencyKey('intent', HEAD)).toContain(HEAD)
    expect(items[0].options.tags).toEqual(['repo:acme/widgets', 'pr:acme/widgets#16', `sha:${HEAD.slice(0, 12)}`, 'focus:intent'])
    expect(out.runs.map((r) => r.lens)).toEqual(['intent', 'impact', 'security'])
    expect(out.runs.every((r) => r.result === RESULT)).toBe(true)
    expect(out.withheld).toEqual([])
  })

  it('sends ids and what was asked — never settings, never the diff', async () => {
    const batch = batchAnswering([answered('intent'), answered('impact'), answered('security')])
    await focusesAsChildTasks({ installationId: 12_345_678, batch })({ pr: PR, ask: ASK, settings: SETTINGS })
    const payload = batch.mock.calls[0][0][0].payload
    expect(Object.keys(payload).sort()).toEqual(['baseSha', 'installationId', 'lens', 'request'])
    expect(payload).toEqual({
      installationId: 12_345_678, baseSha: BASE, lens: 'intent',
      request: { repo: 'acme/widgets', pr: 16, headSha: HEAD, ...ASK },
    })
    expect(JSON.stringify(payload)).not.toContain(PR.diff)
  })

  it('goes on without a focus whose child failed, and names it, its error scanned', async () => {
    const onFailure = vi.fn()
    const batch = batchAnswering([
      answered('intent'),
      { ok: false, id: 'run_impact', error: new Error(`HttpError: 401 (token ${LEAKED_TOKEN})`) },
      answered('security'),
    ])
    const out = await focusesAsChildTasks({ installationId: 12_345_678, batch })({ pr: PR, ask: ASK, settings: SETTINGS, onFailure })
    expect(out.runs.map((r) => [r.lens, r.result.failure?.kind ?? null])).toEqual([['intent', null], ['impact', 'crashed'], ['security', null]])
    expect(out.runs[1].result.usage.costUsd).toBe(0)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(onFailure.mock.calls[0][0]).toBe('impact')
    expect(JSON.stringify(out)).not.toContain(LEAKED_TOKEN)
    expect(String(onFailure.mock.calls[0][1])).not.toContain(LEAKED_TOKEN)
  })

  it('does not take an answer about another focus or another commit as this focus’s', async () => {
    const stale: FocusBatchRun = { ok: true, id: 'run_x', output: { lens: 'impact', headSha: MOVED, result: RESULT, withheld: [] } }
    const swapped: FocusBatchRun = answered('intent')
    const out = await focusesAsChildTasks({ installationId: 1, batch: batchAnswering([answered('intent'), stale, swapped]) })({ pr: PR, ask: ASK, settings: SETTINGS })
    expect(out.runs.map((r) => r.result.failure?.kind ?? null)).toEqual([null, 'crashed', 'crashed'])
  })

  it('throws, with the first error, only when no focus answered', async () => {
    const batch = batchAnswering([
      { ok: false, id: 'a', error: new Error('intent failed') },
      { ok: false, id: 'b', error: new Error('impact failed') },
      { ok: false, id: 'c', error: new Error('security failed') },
    ])
    await expect(focusesAsChildTasks({ installationId: 1, batch })({ pr: PR, ask: ASK, settings: SETTINGS })).rejects.toThrow('intent failed')
  })

  it('carries where a focus’s answer matched a secret pattern, named by its focus', async () => {
    const batch = batchAnswering([
      answered('intent'), answered('impact'),
      answered('security', { ...RESULT, output: null }, [{ pattern: 'github-token', where: 'summary' }]),
    ])
    const out = await focusesAsChildTasks({ installationId: 1, batch })({ pr: PR, ask: ASK, settings: SETTINGS })
    expect(out.withheld).toEqual([{ pattern: 'github-token', where: 'security:summary' }])
  })

  it('starts nothing for a review that was stopped before its focuses', async () => {
    const stop = new AbortController()
    stop.abort(new Error('the review was cancelled'))
    const batch = batchAnswering([])
    await expect(focusesAsChildTasks({ installationId: 1, batch })({ pr: PR, ask: ASK, settings: SETTINGS, signal: stop.signal }))
      .rejects.toThrow('cancelled')
    expect(batch).not.toHaveBeenCalled()
  })
})

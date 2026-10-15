import {
  defaultDeploymentConfig, resolveSettings, reviewSystemPrompt,
  type EngineInput, type EngineResult, type Lens,
} from '@review-agent/core'
import type { ReportHandle, Reporter, ReportStart, RunReviewDeps } from '@review-agent/github'
import { describe, expect, it } from 'vitest'
import { progressFor, watchedDeps, watchedReporter, type ProgressEvent } from './progress'

const collect = () => {
  const events: ProgressEvent[] = []
  return { events, progress: progressFor({ repo: 'acme/widgets', pr: 16, onProgress: (e) => { events.push(e) } }) }
}

describe('progressFor', () => {
  it('attributes a note to the stage the review last reached', () => {
    const { events, progress } = collect()
    progress.stage({ stage: 'downloading' })
    progress.note('removed 1 credential file from the checkout before the review: .env')
    progress.log('review published', { inline: 1 })
    expect(events).toEqual([
      { repo: 'acme/widgets', pr: 16, stage: 'downloading' },
      { repo: 'acme/widgets', pr: 16, stage: 'downloading', note: 'removed 1 credential file from the checkout before the review: .env', details: {} },
      { repo: 'acme/widgets', pr: 16, stage: 'downloading', note: 'review published', details: { inline: 1 } },
    ])
  })

  it('does nothing without a handler', () => {
    const progress = progressFor({ repo: 'acme/widgets', pr: 16, onProgress: null })
    expect(() => { progress.stage({ stage: 'preparing' }); progress.note('x') }).not.toThrow()
  })
})

const settings = (multi: boolean) => {
  const deployment = defaultDeploymentConfig()
  return resolveSettings({ deployment, repo: null, request: { repo: 'acme/widgets', pr: 16, headSha: 'a'.repeat(40), multi } })
}
const RESULT: EngineResult = {
  output: null, cutShort: false, wrapUpFired: false, failure: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 },
}
const base = (): RunReviewDeps => ({
  fetchPullRequest: async () => { throw new Error('not here') },
  fetchRepoConfig: async () => null,
  downloadArchive: async (a) => ({ dir: a.destDir, removed: [], notWritten: [], caseCollisions: [] }),
  materialiseSkills: async () => [],
  runEngine: async () => RESULT,
  runCheckPass: async () => ({ verdicts: [], usage: RESULT.usage }),
  runRecheckPass: async () => ({ judgements: [], usage: RESULT.usage, ran: false, skipped: 'nothing-to-ask' }),
  makeCheckoutDir: async () => '/tmp/review-agent-made',
  skillCacheDir: () => '/tmp/skills',
  now: () => new Date(0),
  note: () => undefined,
})
const input = (multi: boolean, lens?: Lens): EngineInput => {
  const s = settings(multi)
  return { checkoutDir: '/tmp/c', prompt: 'p', systemPrompt: reviewSystemPrompt({ settings: s, ...(lens !== undefined && { lens }) }), settings: s, schema: {}, skillDirs: [] }
}

describe('watchedDeps: each collaborator says which stage it starts, then does what it did', () => {
  it('names the focus a multi-reviewer engine run is, from its system prompt', async () => {
    const { events, progress } = collect()
    const deps = watchedDeps(base(), progress, [])
    for (const lens of ['security', 'intent'] as const) await deps.runEngine(input(true, lens))
    await deps.runEngine(input(false))
    // A prompt that matches no focus says less rather than naming the wrong one.
    await deps.runEngine({ ...input(true), systemPrompt: 'something else' })
    expect(events.map((e) => e.stage === 'reviewing' && e.note === undefined ? e.focus : 'other'))
      .toEqual(['security', 'intent', null, null])
  })

  it('remembers every checkout it made, so each can be removed', async () => {
    const made: string[] = []
    await watchedDeps(base(), collect().progress, made).makeCheckoutDir()
    expect(made).toEqual(['/tmp/review-agent-made'])
  })

  it('reports no check for a check pass with nothing to check', async () => {
    const { events, progress } = collect()
    const deps = watchedDeps(base(), progress, [])
    await deps.runCheckPass({ findings: [], input: input(false) })
    expect(events).toEqual([])
  })
})

describe('watchedReporter', () => {
  it("says reporting as the handle is finished, and reads the handle's fields live", async () => {
    // A commit status learns its URL only when finished: a copy taken at start would say null forever.
    let url: string | null = null
    const handle: ReportHandle = {
      kind: 'commit-status', id: null,
      get url() { return url },
      finish: async () => { url = 'https://github.com/acme/widgets/pull/16#issuecomment-1'; return 'success' },
    }
    const reporter: Reporter = { kind: 'commit-status', start: async () => handle }
    const { events, progress } = collect()
    const watched = await watchedReporter(reporter, progress).start({} as ReportStart)
    expect(watched?.url).toBeNull()
    expect(events).toEqual([])
    expect(await watched?.finish({ outcome: { kind: 'abandoned', headSha: 'a' } })).toBe('success')
    expect(watched?.url).toBe('https://github.com/acme/widgets/pull/16#issuecomment-1')
    expect(watched?.kind).toBe('commit-status')
    expect(events).toEqual([{ repo: 'acme/widgets', pr: 16, stage: 'reporting', report: 'commit-status' }])
  })

  it('passes a reporter with nothing to report through as nothing', async () => {
    const watched = watchedReporter({ kind: 'none', start: async () => null }, collect().progress)
    expect(await watched.start({} as ReportStart)).toBeNull()
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultDeploymentConfig } from '@review-agent/core'
import * as github from '@review-agent/github'
import { describe, expect, it } from 'vitest'
import { GITHUB_API_VERSION } from '../credentials'
import { sendRecordCallback } from './record-callback'
import {
  liveReviewTaskDeps, liveRunReviewDeps, octokitFor, pushAccessOf, runnerDeployment,
  runnerRecordCallback, runnerSweepTargets,
} from './review-job'

describe('the collaborators the deployed task actually uses', () => {
  it('pins the GitHub API version on every request, in the one place the client is built', async () => {
    const seen: Headers[] = []
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const octokit = octokitFor({ token: 'ghs_installation_FAKE', fetch })

    await octokit.request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'widgets' })

    // Task 6 says this header "is pinned once where the Octokit instance is built". Unpinned, every
    // posting and check-run call rides whatever default the API happens to serve that month.
    expect(seen[0]?.get('x-github-api-version')).toBe(GITHUB_API_VERSION)
  })

  it('gives each review its own new checkout directory, and an absolute skill cache', async () => {
    const d = liveRunReviewDeps({ note: () => undefined })
    const first = await d.makeCheckoutDir()
    const second = await d.makeCheckoutDir()
    try {
      expect(first).not.toBe(second)
      expect(existsSync(first) && existsSync(second)).toBe(true)
      // materialiseSkills throws on a relative cache dir (packages/core/src/skills.ts).
      expect(isAbsolute(d.skillCacheDir())).toBe(true)
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  // Spec 0.2.0 §9.3 P13. One `review-agent-skills` for every account on a machine let any of them plant
  // an entry under the name this runner looks up; the directory is now this user's own.
  it.skipIf(process.platform === 'win32')('caches skills in a directory of this user’s own under the temp directory', () => {
    const before = process.env.REVIEW_AGENT_SKILL_CACHE
    delete process.env.REVIEW_AGENT_SKILL_CACHE
    try {
      expect(liveRunReviewDeps({ note: () => undefined }).skillCacheDir())
        .toBe(join(tmpdir(), `review-agent-skills-${process.getuid?.()}`))
    } finally {
      if (before !== undefined) process.env.REVIEW_AGENT_SKILL_CACHE = before
    }
  })

  it('reviews under the built-in deployment, which has the disprove-it pass on for basic since Task 0', () => {
    // Criss, 2026-09-14 (decision 2) moved the one override this runner used to make into core's own
    // defaults, so the runner deviates from them in nothing. The pass costs $0.07-$0.58 a review at
    // per-token API prices (measured; design §8), or the same figure from the subscription allowance.
    expect(runnerDeployment()).toEqual(defaultDeploymentConfig())
    expect(runnerDeployment().tiers.basic.check).toBe(true)
  })

  it('sweeps no repository until the deployment names one', () => {
    // Criss, 2026-09-14 (answer 14). A deployment names its own repositories here; the product's
    // default reads no credential and closes nothing (Task 13b).
    expect(runnerSweepTargets()).toEqual([])
  })

  it('sends the finished record nowhere until the deployment names a callback', () => {
    // Criss, 2026-09-14 (answer 16). The product stores nothing and, by default, sends nothing.
    expect(runnerRecordCallback()).toBeNull()
    const live = liveReviewTaskDeps({
      identity: () => { throw new Error('not read by this test') },
      log: () => undefined, metric: () => undefined, startAnotherRun: null, checkRunMemory: null,
    })
    expect(live.recordCallback).toBeNull()
    expect(live.sendRecord).toBe(sendRecordCallback)
  })

  it('builds its client and asks about push access with the github package’s own, not a copy', () => {
    // Moved to @review-agent/github in 0.2.0 (spec 0.2.0 §3.1), where their cases now live
    // (octokit.test.ts). The runner must use those, so the CLI, the SDK and the App cannot drift.
    expect(octokitFor).toBe(github.octokitFor)
    expect(pushAccessOf).toBe(github.pushAccessOf)
    const live = liveReviewTaskDeps({
      identity: () => { throw new Error('not read by this test') },
      log: () => undefined, metric: () => undefined, startAnotherRun: null, checkRunMemory: null,
    })
    expect(live.hasPushAccess).toBe(github.pushAccessOf)
  })

  it('reviews with the real collaborators every way in shares (defaultRunReviewDeps)', () => {
    const d = liveRunReviewDeps({ note: () => undefined })
    const shared = github.defaultRunReviewDeps({ note: () => undefined })
    for (const k of ['fetchPullRequest', 'fetchRepoConfig', 'downloadArchive', 'materialiseSkills', 'runEngine', 'runCheckPass', 'runRecheckPass'] as const) {
      expect(d[k]).toBe(shared[k])
    }
  })

  it('never starts a hosted run from a review run in process', () => {
    // Criss, 2026-09-14 (answer 13, decision 14): Task 15 calls runReviewJob with one approved
    // review, paid on Criss's own key. A free failure there is reported and repeated by nobody; a new
    // run started from here would be a hosted review nobody approved. Read as text, because the
    // live port is only reachable by a real trigger.
    const source = readFileSync(fileURLToPath(new URL('./review-job.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/startAnotherRun: null\b/)
    expect(source).not.toMatch(/sdkTriggerPort/)
  })
})

// Added 2026-09-25 (an interface requirement a deployment raised). A deployment names its
// callback and its sweep targets in its ENVIRONMENT, so it deploys this product unchanged instead of
// editing these two functions in the source before every deploy. Unset means exactly what it meant
// before: no callback, no sweep.
describe('the deployment names its callback and sweep targets in its environment', () => {
  it('sends no record anywhere when REVIEW_AGENT_RECORD_URL is unset', () => {
    expect(runnerRecordCallback({})).toBeNull()
    expect(runnerRecordCallback({ REVIEW_AGENT_RECORD_URL: '' })).toBeNull()
  })

  it('names the callback from REVIEW_AGENT_RECORD_URL, with the secret under its default name', () => {
    expect(runnerRecordCallback({ REVIEW_AGENT_RECORD_URL: 'https://ops.example.test/api/review-agent/record' }))
      .toEqual({ url: 'https://ops.example.test/api/review-agent/record', secretEnv: 'REVIEW_AGENT_RECORD_SECRET' })
  })

  it('lets the deployment name the variable its secret lives in', () => {
    // A deployment may already hold the secret under its own name (e.g. ACME_REVIEW_CALLBACK_SECRET).
    expect(runnerRecordCallback({
      REVIEW_AGENT_RECORD_URL: 'https://ops.example.test/r', REVIEW_AGENT_RECORD_SECRET_ENV: 'ACME_REVIEW_CALLBACK_SECRET',
    })?.secretEnv).toBe('ACME_REVIEW_CALLBACK_SECRET')
  })

  it('passes a bad URL through for the sender to refuse, rather than refusing here', async () => {
    // sendRecordCallback already refuses `bad-url` and `bad-secret-name`, logged and never failing
    // the review. One place decides what a usable callback is.
    const cb = runnerRecordCallback({ REVIEW_AGENT_RECORD_URL: 'http://not-https.example.test' })
    expect(cb?.url).toBe('http://not-https.example.test')
  })

  it('sweeps nothing when REVIEW_AGENT_SWEEP_TARGETS is unset', () => {
    expect(runnerSweepTargets({})).toEqual([])
  })

  it('reads the sweep targets as JSON: installation id and owner/name repositories', () => {
    expect(runnerSweepTargets({
      REVIEW_AGENT_SWEEP_TARGETS: '[{"installationId":12345678,"repositories":["acme/widgets","acme/review-skills"]}]',
    })).toEqual([{ installationId: 12345678, repositories: ['acme/widgets', 'acme/review-skills'] }])
  })

  it.each([
    ['not JSON', 'widgets'],
    ['not a list', '{"installationId":1,"repositories":[]}'],
    ['an installation id that is not a positive integer', '[{"installationId":"55","repositories":["a/b"]}]'],
    ['a repository not written owner/name', '[{"installationId":1,"repositories":["widgets"]}]'],
  ])('refuses sweep targets that are %s, loudly — the sweep spends nothing, so a visible failure costs nothing', (_n, value) => {
    expect(() => runnerSweepTargets({ REVIEW_AGENT_SWEEP_TARGETS: value })).toThrow(/REVIEW_AGENT_SWEEP_TARGETS/)
  })
})

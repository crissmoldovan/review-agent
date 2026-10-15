import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKE_CLAUDE, fakeClaude, isolateEnv, type FakeClaude } from '../test/fake-claude'
import { fakeGitHub } from '../test/fake-github'
import type { ReviewOptions } from './options'
import { reviewPullRequest } from './review'

// Spec 0.2.0 §4.4: reviews in one process run concurrently and share nothing but the skill cache.
// The credential is the part that must hold: §3.2 exists because two reviews in one process would
// race on `process.env`, and a race there bills one account for another's review.

let restoreEnv: () => void
let claude: FakeClaude
const dirs: string[] = []
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

beforeEach(() => {
  restoreEnv = isolateEnv()
  // Held open, so the two reviews' Claude processes are alive at the same time.
  claude = fakeClaude({ sleepMs: 300 })
  // An ambient credential in the host's environment: neither review may let it ride along.
  process.env.ANTHROPIC_API_KEY = 'ambient-key-of-the-host'
})
afterEach(() => {
  restoreEnv()
  claude.remove()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const API_KEY_A = 'test-api-key-of-tenant-a'
const OAUTH_TOKEN_B = 'test-subscription-token-of-tenant-b'
/** Whether a Claude process ran in a checkout under `dir` — as given, or resolved: on macOS
 *  `/var/folders` is `/private/var/folders`, and the process sees the resolved one. */
const under = (dir: string, path: string): boolean =>
  [dir, realpathSync(dir)].some((d) => path.startsWith(d + sep))

describe('two reviews at once, in one process', () => {
  it('give each Claude process its own credential and no other', async () => {
    const skillCacheDir = tmp('ra-sdk-skills-')
    const workA = tmp('ra-sdk-work-a-')
    const workB = tmp('ra-sdk-work-b-')
    const gh = await fakeGitHub()
    const common = { repo: 'acme/widgets', github: { octokit: gh.octokit }, claude: { bin: FAKE_CLAUDE }, skillCacheDir }
    const [a, b] = await Promise.all([
      reviewPullRequest({ ...common, pr: 16, credential: { apiKey: API_KEY_A }, workDir: workA }),
      reviewPullRequest({ ...common, pr: 17, credential: { oauthToken: OAUTH_TOKEN_B }, workDir: workB }),
    ])
    expect(a.kind === 'reviewed' && a.record.request.pr).toBe(16)
    expect(b.kind === 'reviewed' && b.record.request.pr).toBe(17)

    const spawns = claude.spawns()
    // Each review's engine and check pass: four processes, which really did overlap.
    expect(spawns).toHaveLength(4)
    const ofA = spawns.filter((s) => under(workA, s.cwd))
    const ofB = spawns.filter((s) => under(workB, s.cwd))
    expect(ofA).toHaveLength(2)
    expect(ofB).toHaveLength(2)
    for (const s of ofA) {
      expect(s.env.ANTHROPIC_API_KEY).toBe(API_KEY_A)
      expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    }
    for (const s of ofB) {
      expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH_TOKEN_B)
      expect(s.env.ANTHROPIC_API_KEY).toBeUndefined()
    }
    // Their engines ran side by side: B's started before A's had answered, or the other way round.
    const [firstA, firstB] = [ofA[0], ofB[0]]
    expect(Math.abs(firstA.startedAt - firstB.startedAt)).toBeLessThan(300)
    // And each removed its own checkout.
    expect(readdirSync(workA)).toEqual([])
    expect(readdirSync(workB)).toEqual([])
    expect(process.env.ANTHROPIC_API_KEY).toBe('ambient-key-of-the-host')
  }, 20_000)

  it('keep nothing between calls: a later call without a credential does not reuse an earlier one', async () => {
    const gh = await fakeGitHub()
    const common: ReviewOptions = {
      repo: 'acme/widgets', pr: 16, github: { octokit: gh.octokit }, claude: { bin: FAKE_CLAUDE },
      workDir: tmp('ra-sdk-work-'), skillCacheDir: tmp('ra-sdk-skills-'),
    }
    await reviewPullRequest({ ...common, credential: { oauthToken: OAUTH_TOKEN_B } })
    const before = claude.spawns().length
    await reviewPullRequest(common)
    for (const s of claude.spawns().slice(before)) {
      expect(s.env.ANTHROPIC_API_KEY).toBe('ambient-key-of-the-host')
      expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    }
  }, 20_000)

  it("leave the caller's options as they were given", async () => {
    const gh = await fakeGitHub()
    const settings = { report: { checkRunName: 'review' }, skills: [] as never[] }
    const given: ReviewOptions = {
      repo: 'acme/widgets', pr: 16, github: { octokit: gh.octokit }, credential: { apiKey: API_KEY_A },
      claude: { bin: FAKE_CLAUDE }, workDir: tmp('ra-sdk-work-'), skillCacheDir: tmp('ra-sdk-skills-'), settings,
    }
    const snapshot = JSON.stringify({ ...given, github: null })
    await reviewPullRequest(given)
    expect(JSON.stringify({ ...given, github: null })).toBe(snapshot)
    expect(given.credential).toEqual({ apiKey: API_KEY_A })
  }, 20_000)
})


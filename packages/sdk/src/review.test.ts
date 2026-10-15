import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushAccessOf } from '@review-agent/github'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUDGET_FAILURE, CHECK_COST_USD, FAKE_CLAUDE, fakeClaude, FINDINGS, isolateEnv, REVIEW_COST_USD,
  untilSpawned, type FakeClaude,
} from '../test/fake-claude'
import {
  COMPLETE_RUN, CREATE_RUN, fakeGitHub, HEAD_SHA, PERMISSION, PULL, RETRY_FILE, REVIEW_CREATE, STATUS,
  SUMMARY_CREATE, TARBALL, USER, type FakeGitHub,
} from '../test/fake-github'
import type { ReviewOptions } from './options'
import type { ProgressEvent, StageEvent } from './progress'
import { reviewPullRequest } from './review'
import type { ReviewResult } from './result'

let restoreEnv: () => void
let claude: FakeClaude
let workDir: string
let skillCacheDir: string

beforeEach(() => {
  restoreEnv = isolateEnv()
  claude = fakeClaude()
  workDir = mkdtempSync(join(tmpdir(), 'ra-sdk-work-'))
  skillCacheDir = mkdtempSync(join(tmpdir(), 'ra-sdk-skills-'))
})
afterEach(() => {
  // Spec 0.2.0 §4.4: every checkout is removed at the end — also on failure and on abort. Asserted
  // after EVERY case in this file, whichever way its review ended.
  expect(readdirSync(workDir), 'a checkout was left in workDir').toEqual([])
  restoreEnv()
  claude.remove()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(skillCacheDir, { recursive: true, force: true })
})

const API_KEY = 'test-api-key-for-the-fake'
const OAUTH_TOKEN = 'test-subscription-token-for-the-fake'

const options = (gh: FakeGitHub, over: Partial<ReviewOptions> = {}): ReviewOptions => ({
  repo: 'acme/widgets', pr: 16, github: { octokit: gh.octokit },
  credential: { apiKey: API_KEY }, claude: { bin: FAKE_CLAUDE }, workDir, skillCacheDir,
  ...over,
})

const expectKind = <K extends ReviewResult['kind']>(r: ReviewResult, kind: K): Extract<ReviewResult, { kind: K }> => {
  if (r.kind !== kind) throw new Error(`expected ${kind}, got ${r.kind}: ${'reason' in r ? r.reason : ''}`)
  return r as Extract<ReviewResult, { kind: K }>
}

/** The two findings the fixtures leave said, as file, line and the check pass's severity. */
const SAID = [[RETRY_FILE, 24, 6], [RETRY_FILE, 10, 3]]
const said = (findings: { file: string; line: number; severity: number }[] | null) =>
  findings?.map((f) => [f.file, f.line, f.severity]) ?? null

const stagesOf = (events: ProgressEvent[]): string[] =>
  events.filter((e): e is StageEvent => e.note === undefined).map((e) => e.stage)

describe('printing (spec 0.2.0 §4.1: post defaults to false)', () => {
  it('reviews and returns what the review says, and writes nothing to GitHub', async () => {
    const gh = await fakeGitHub()
    const result = expectKind(await reviewPullRequest(options(gh)), 'reviewed')

    expect(gh.writes()).toEqual([])
    expect(result.posted).toBeNull()
    expect(result.report).toBeNull()
    expect(result.record.request).toMatchObject({ repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA })
    // After the check pass: the refuted finding and the one outside the checkout are not said; the
    // confirmed one is at the check's severity, and the uncertain one at its lowered severity.
    expect(said(result.findings)).toEqual(SAID)
    // The model's own list is kept whole on the record, with every verdict.
    expect(result.record.output?.findings).toHaveLength(FINDINGS.length)
    expect(result.record.checkVerdicts).toHaveLength(FINDINGS.length)
    expect(result.record.costUsd).toBeCloseTo(REVIEW_COST_USD + CHECK_COST_USD, 6)
    // Not even who the token is: a printed review asks GitHub nothing it does not need.
    expect(gh.only(USER)).toEqual([])
    expect(gh.only(TARBALL)).toHaveLength(1)
    expect(claude.spawns()).toHaveLength(2)
  })

  it('says, printed, exactly what the same review says when posted — the two cannot drift apart', async () => {
    // `wouldSay` re-derives what `publishReview` would select; this holds it to publishReview's own
    // answer on the same review. A change to either that the other does not follow fails here.
    const printed = expectKind(await reviewPullRequest(options(await fakeGitHub())), 'reviewed')
    const posted = expectKind(await reviewPullRequest(options(await fakeGitHub(), { post: true })), 'reviewed')
    expect(posted.posted).not.toBeNull()
    expect(printed.findings).toEqual(posted.findings)
    expect(said(printed.findings)).toEqual(SAID)
  })

  it('in silent mode, returns what it would have said', async () => {
    const gh = await fakeGitHub()
    const result = expectKind(await reviewPullRequest(options(gh, { settings: { report: { mode: 'silent' } } })), 'reviewed')
    expect(said(result.findings)).toEqual(SAID)
    expect(result.record.settings.report.mode).toBe('silent')
  })

  it('reads the report option even when it will not use it, but reports nothing', async () => {
    const gh = await fakeGitHub()
    const result = expectKind(await reviewPullRequest(options(gh, { report: 'check-run' })), 'reviewed')
    expect(result.report).toBeNull()
    expect(gh.writes()).toEqual([])
  })
})

describe('posting, and reporting on the commit (spec 0.2.0 §2.2)', () => {
  it("with a person's token: a review with one inline comment, the summary, and a commit status", async () => {
    const gh = await fakeGitHub({ user: 'alice' })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'reviewed')

    expect(gh.only(USER)).toHaveLength(1)
    expect(gh.only(CREATE_RUN)).toEqual([])
    const statuses = gh.only(STATUS).map((c) => c.params.state)
    expect(statuses).toEqual(['pending', 'success'])
    expect(result.report).toEqual({
      kind: 'commit-status', conclusion: 'success', id: null,
      url: expect.stringMatching(/^https:\/\/github\.com\/acme\/widgets\/pull\/16#issuecomment-\d+$/),
    })
    expect(result.posted).toMatchObject({
      mode: 'inline+summary', reviewId: 900, summaryUrl: result.report?.url,
      counts: { inline: 1, summaryOnly: 1, notInCheckout: 1, suppressed: 1 },
    })
    expect(result.posted?.comments).toEqual([
      expect.objectContaining({ file: RETRY_FILE, line: 24, commentId: expect.any(Number) }),
    ])
    expect(said(result.findings)).toEqual(SAID)
    // Spec 0.2.0 §5.6: whoever posted it, the summary says it is automated and how it was run.
    const summary = String(gh.only(SUMMARY_CREATE)[0]?.params.body)
    expect(summary).toContain('**Automated review**')
    expect(summary).toContain('via the SDK')
  })

  it('with an installation token: a check run, opened before the model and completed after', async () => {
    const gh = await fakeGitHub({ user: null })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'reviewed')

    expect(gh.only(STATUS)).toEqual([])
    expect(gh.only(CREATE_RUN)).toHaveLength(1)
    expect(gh.only(COMPLETE_RUN)[0]?.params.conclusion).toBe('success')
    expect(result.report).toEqual({
      kind: 'check-run', conclusion: 'success', id: 4242, url: 'https://github.com/acme/widgets/runs/4242',
    })
    // The check run was opened before anything was downloaded, so a refusal there costs nothing.
    const routes = gh.calls.map((c) => c.route)
    expect(routes.indexOf(CREATE_RUN)).toBeLessThan(routes.indexOf(TARBALL))
  })

  it("report: 'none' posts the review and reports nothing on the commit", async () => {
    const gh = await fakeGitHub({ user: null })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true, report: 'none' })), 'reviewed')
    expect(result.report).toBeNull()
    expect(result.posted).not.toBeNull()
    expect(gh.only(STATUS)).toEqual([])
    expect(gh.only(CREATE_RUN)).toEqual([])
  })

  it("report: 'commit-status' reports with a status even for an installation token", async () => {
    const gh = await fakeGitHub({ user: null })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true, report: 'commit-status' })), 'reviewed')
    expect(result.report?.kind).toBe('commit-status')
    expect(gh.only(CREATE_RUN)).toEqual([])
  })

  it("report: 'check-run' with a token that cannot create one fails before any money is spent", async () => {
    // Spec 0.2.0 §4.2: an error before any money is spent — a result, not a throw: the token is the
    // host's to change, and the call was well formed.
    const gh = await fakeGitHub({ user: 'alice', fail: { [CREATE_RUN]: 403 } })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true, report: 'check-run' })), 'failed')
    expect(result).toMatchObject({ stage: 'before-model', spentUsd: 0, retryable: true, record: null })
    expect(result.reason).toMatch(/could not be reported on the commit/)
    expect(gh.only(TARBALL)).toEqual([])
    expect(claude.spawns()).toEqual([])
  })

  it('fails before the model when GitHub will not say whose token it is', async () => {
    const gh = await fakeGitHub({ fail: { [USER]: 401 } })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'failed')
    expect(result).toMatchObject({ stage: 'before-model', spentUsd: 0, retryable: true })
    expect(result.reason).toMatch(/whose token/)
    expect(gh.writes()).toEqual([])
    expect(claude.spawns()).toEqual([])
  })
})

describe('authorize: a gate before anything is spent (spec 0.2.0 §4.2)', () => {
  it('refuses when it says no: nothing downloaded, nothing written, nothing spent', async () => {
    const gh = await fakeGitHub()
    const asked: unknown[] = []
    const result = await reviewPullRequest(options(gh, {
      post: true, requestedBy: 'mallory',
      authorize: async (who) => { asked.push({ ...who, octokit: who.octokit === gh.octokit }); return false },
    }))
    expect(expectKind(result, 'refused').reason).toMatch(/@mallory/)
    expect(asked).toEqual([{ octokit: true, owner: 'acme', repo: 'widgets', pr: 16, username: 'mallory', headSha: HEAD_SHA }])
    expect(gh.only(TARBALL)).toEqual([])
    expect(gh.writes()).toEqual([])
    expect(claude.spawns()).toEqual([])
  })

  it('takes pushAccessOf as it is, and reviews for someone who can push', async () => {
    const gh = await fakeGitHub({ push: true })
    const result = await reviewPullRequest(options(gh, { requestedBy: 'alice', authorize: pushAccessOf }))
    expect(result.kind).toBe('reviewed')
    expect(gh.only(PERMISSION)[0]?.params).toMatchObject({ owner: 'acme', repo: 'widgets', username: 'alice' })
  })

  it('refuses, with pushAccessOf, someone who cannot push', async () => {
    const gh = await fakeGitHub({ push: false })
    const result = await reviewPullRequest(options(gh, { requestedBy: 'mallory', authorize: pushAccessOf }))
    expect(result.kind).toBe('refused')
    expect(claude.spawns()).toEqual([])
  })

  it('returns a failure that spent nothing when the gate cannot answer', async () => {
    const gh = await fakeGitHub({ fail: { [PERMISSION]: 502 } })
    const result = expectKind(await reviewPullRequest(options(gh, { requestedBy: 'alice', authorize: pushAccessOf })), 'failed')
    expect(result).toMatchObject({ stage: 'before-model', spentUsd: 0, retryable: true })
    expect(result.reason).toMatch(/could not be authorized/)
    expect(gh.only(TARBALL)).toEqual([])
  })

  it('throws when the gate answers neither true nor false — a gate that forgot to answer is not a yes', async () => {
    const gh = await fakeGitHub()
    const forgetful = (async () => { /* no return */ }) as unknown as ReviewOptions['authorize']
    await expect(reviewPullRequest(options(gh, { requestedBy: 'alice', authorize: forgetful })))
      .rejects.toThrow(TypeError)
    expect(gh.only(TARBALL)).toEqual([])
    expect(claude.spawns()).toEqual([])
  })
})

describe('every outcome is returned, never thrown (spec 0.2.0 §4.3)', () => {
  it('unfinished: the model ran and produced nothing usable — the summary says so when posting', async () => {
    claude.remove()
    claude = fakeClaude({ review: BUDGET_FAILURE })
    const gh = await fakeGitHub({ user: 'alice' })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'unfinished')
    expect(result.reason).toMatch(/ceiling/)
    expect(result.spentUsd).toBeCloseTo(result.record.costUsd, 9)
    expect(result.spentUsd).toBeGreaterThan(0)
    // Spent, so a second run would pay again for the same answer.
    expect(result.retryable).toBe(false)
    expect(result.stopped).toBeNull()
    expect(result.posted?.summaryUrl).toMatch(/issuecomment/)
    expect(String(gh.only(SUMMARY_CREATE)[0]?.params.body)).toContain('This review did not complete')
    // A review that did not run is not a verdict: `neutral`, said by a status as `success`.
    expect(result.report).toMatchObject({ kind: 'commit-status', conclusion: 'neutral' })
    // Nothing to check: the check pass never ran.
    expect(claude.spawns()).toHaveLength(1)
  })

  it('failed, withheld: output matching a secret pattern is said nowhere', async () => {
    claude.remove()
    const token = 'ghp_' + 'A'.repeat(36)
    claude = fakeClaude({ findings: [{ ...FINDINGS[0], explanation: `the token ${token} is logged` }] })
    const gh = await fakeGitHub({ user: 'alice' })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'failed')
    expect(result).toMatchObject({ stage: 'withheld', retryable: false, record: null, findings: null })
    expect(result.spentUsd).toBeCloseTo(REVIEW_COST_USD, 6)
    expect(gh.only(SUMMARY_CREATE)).toEqual([])
    expect(gh.only(REVIEW_CREATE)).toEqual([])
    expect(JSON.stringify({ ...result, cause: null })).not.toContain(token)
  })

  it('failed at publish: paid for, and handed back with what it would have said so it is not lost', async () => {
    const gh = await fakeGitHub({ user: 'alice', fail: { [REVIEW_CREATE]: 500 } })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'failed')
    expect(result).toMatchObject({ stage: 'publish', retryable: false })
    expect(result.reason).toMatch(/could not be posted/)
    expect(result.record?.costUsd).toBeCloseTo(REVIEW_COST_USD + CHECK_COST_USD, 6)
    expect(result.spentUsd).toBeCloseTo(REVIEW_COST_USD + CHECK_COST_USD, 6)
    expect(said(result.findings)).toEqual(SAID)
    expect(result.report).toMatchObject({ kind: 'commit-status', conclusion: 'neutral' })
  })

  it('failed before the model: GitHub would not give the pull request', async () => {
    const gh = await fakeGitHub({ fail: { [PULL]: 404 } })
    const result = expectKind(await reviewPullRequest(options(gh, { post: true })), 'failed')
    expect(result).toMatchObject({ stage: 'before-model', spentUsd: 0, retryable: true, record: null, findings: null, report: null })
    expect(result.reason).toMatch(/could not be read/)
    expect(result.cause).toBeInstanceOf(Error)
    expect(gh.writes()).toEqual([])
    expect(claude.spawns()).toEqual([])
  })
})

describe('stopping (spec 0.2.0 §4.2: signal, deadlineMs)', () => {
  it('does nothing at all for a signal that has already aborted', async () => {
    const gh = await fakeGitHub()
    const result = expectKind(await reviewPullRequest(options(gh, { signal: AbortSignal.abort() })), 'failed')
    expect(result).toMatchObject({ stage: 'before-model', stopped: 'cancelled', spentUsd: 0, retryable: false })
    expect(gh.calls).toEqual([])
  })

  it('stops the model when the signal aborts mid-review, says error on the status, and keeps no checkout', async () => {
    claude.remove()
    claude = fakeClaude({ sleepMs: 30_000 })
    const gh = await fakeGitHub({ user: 'alice' })
    const controller = new AbortController()
    const running = reviewPullRequest(options(gh, { post: true, signal: controller.signal }))
    await untilSpawned(claude)
    controller.abort()
    const result = expectKind(await running, 'failed')
    expect(result).toMatchObject({ stage: 'model', stopped: 'cancelled', retryable: false })
    expect(result.reason).toMatch(/cancelled/)
    // Spec 0.2.0 §5.4: a run interrupted after `pending` says `error`, so it does not block a merge.
    expect(gh.only(STATUS).map((c) => c.params.state)).toEqual(['pending', 'error'])
    expect(gh.only(REVIEW_CREATE)).toEqual([])
  }, 20_000)

  it('stops itself at its deadline', async () => {
    claude.remove()
    claude = fakeClaude({ sleepMs: 30_000 })
    const gh = await fakeGitHub()
    const result = expectKind(await reviewPullRequest(options(gh, { deadlineMs: 1500 })), 'failed')
    expect(result).toMatchObject({ stage: 'model', stopped: 'deadline', retryable: false })
    expect(result.reason).toMatch(/deadline/)
  }, 20_000)
})

describe('onProgress (spec 0.2.0 §4.2)', () => {
  it('names each stage a printed review passes, in order, and ends with done', async () => {
    const events: ProgressEvent[] = []
    await reviewPullRequest(options(await fakeGitHub(), { onProgress: (e) => { events.push(e) } }))
    expect(stagesOf(events)).toEqual(['preparing', 'downloading', 'reviewing', 'checking', 'done'])
    expect(events.find((e) => e.stage === 'reviewing')).toMatchObject({ repo: 'acme/widgets', pr: 16, focus: null })
    expect(events.find((e) => e.stage === 'checking')).toMatchObject({ findings: FINDINGS.length })
    expect(events.at(-1)).toEqual({ repo: 'acme/widgets', pr: 16, stage: 'done', result: 'reviewed' })
  })

  it('adds publishing and reporting when posting, and passes the session’s log lines as notes', async () => {
    const events: ProgressEvent[] = []
    await reviewPullRequest(options(await fakeGitHub({ user: 'alice' }), { post: true, onProgress: (e) => { events.push(e) } }))
    expect(stagesOf(events)).toEqual(['preparing', 'downloading', 'reviewing', 'checking', 'publishing', 'reporting', 'done'])
    expect(events.find((e) => e.stage === 'reporting' && e.note === undefined)).toMatchObject({ report: 'commit-status' })
    // A note is a line inside the stage the review last reached, with the fields it was logged with.
    const published = events.find((e) => e.note === 'review published')
    expect(published).toMatchObject({ stage: 'reporting', details: { inline: 1, summaryOnly: 1 } })
  })

  it('names each focused reviewer as it starts on a multi-reviewer review', async () => {
    const events: ProgressEvent[] = []
    const result = await reviewPullRequest(options(await fakeGitHub(), {
      multi: { concurrency: 1 }, onProgress: (e) => { events.push(e) },
    }))
    const focuses = events.flatMap((e) => (e.note === undefined && e.stage === 'reviewing' ? [e.focus] : []))
    expect(focuses).toEqual(['intent', 'impact', 'security'])
    expect(expectKind(result, 'reviewed').record.focuses.map((f) => f.lens)).toEqual(['intent', 'impact', 'security'])
    // The deps note the review's own progress line, as the CLI prints it.
    expect(events.some((e) => e.note?.startsWith('running 3 focused reviewers') === true)).toBe(true)
  })

  it('runs one focus at a time when asked, so a small host is not handed three Claude processes at once', async () => {
    // Each fake holds 400 ms before answering. One at a time, each starts after the last answered;
    // all at once (the default), they start together. The gap between starts tells the two apart.
    const gaps = async (multi: ReviewOptions['multi']): Promise<number[]> => {
      claude.remove()
      claude = fakeClaude({ sleepMs: 400 })
      await reviewPullRequest(options(await fakeGitHub(), { multi, check: false }))
      const starts = claude.spawns().map((s) => s.startedAt)
      expect(starts).toHaveLength(3)
      return starts.slice(1).map((t, i) => t - starts[i])
    }
    for (const gap of await gaps({ concurrency: 1 })) expect(gap).toBeGreaterThanOrEqual(350)
    expect(Math.max(...await gaps(true))).toBeLessThan(350)
  }, 20_000)

  it('cannot fail a review: a handler that throws, or one that rejects, costs only the event', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const throwing = await reviewPullRequest(options(await fakeGitHub(), { onProgress: () => { throw new Error('ui') } }))
      const rejecting = await reviewPullRequest(options(await fakeGitHub(), {
        onProgress: (async () => { throw new Error('ui') }) as unknown as ReviewOptions['onProgress'],
      }))
      expect(throwing.kind).toBe('reviewed')
      expect(rejecting.kind).toBe('reviewed')
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('the model credential (spec 0.2.0 §2.3, §3.2)', () => {
  it('hands a subscription token to the Claude process unchanged, and only it', async () => {
    process.env.ANTHROPIC_API_KEY = 'ambient-key-that-must-not-ride-along'
    const events: ProgressEvent[] = []
    let envDuringReview: string[] = []
    const result = await reviewPullRequest(options(await fakeGitHub(), {
      credential: { oauthToken: OAUTH_TOKEN },
      onProgress: (e) => {
        events.push(e)
        if (e.stage === 'reviewing') envDuringReview = Object.values(process.env).filter((v): v is string => v !== undefined)
      },
    }))
    expect(result.kind).toBe('reviewed')
    for (const spawn of claude.spawns()) {
      expect(spawn.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH_TOKEN)
      expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined()
    }
    // Never through this process's environment, where a concurrent review would read it.
    expect(envDuringReview).not.toContain(OAUTH_TOKEN)
    expect(Object.values(process.env)).not.toContain(OAUTH_TOKEN)
    // Never logged, never returned.
    expect(JSON.stringify(events)).not.toContain(OAUTH_TOKEN)
    expect(JSON.stringify(result)).not.toContain(OAUTH_TOKEN)
  })

  it('takes exactly one credential from the environment when none is passed', async () => {
    process.env.ANTHROPIC_API_KEY = 'environment-key'
    const result = await reviewPullRequest({ ...options(await fakeGitHub()), credential: undefined })
    expect(result.kind).toBe('reviewed')
    for (const spawn of claude.spawns()) expect(spawn.env.ANTHROPIC_API_KEY).toBe('environment-key')
  })

  it("runs 'claude-login' with neither credential variable, whatever the environment holds", async () => {
    process.env.ANTHROPIC_API_KEY = 'ambient-key-that-must-not-ride-along'
    await reviewPullRequest(options(await fakeGitHub(), { credential: 'claude-login' }))
    for (const spawn of claude.spawns()) {
      expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawn.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    }
  })

  it('refuses ANTHROPIC_BASE_URL in this process even with a credential passed, before asking GitHub anything (§14.5)', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.test'
    const gh = await fakeGitHub()
    await expect(reviewPullRequest(options(gh))).rejects.toThrow(/ANTHROPIC_BASE_URL/)
    expect(gh.calls).toEqual([])
  })

  it('throws, before asking GitHub anything, when no credential is passed and the environment has none', async () => {
    const gh = await fakeGitHub()
    await expect(reviewPullRequest({ ...options(gh), credential: undefined })).rejects.toThrow(/no model credential/)
    expect(gh.calls).toEqual([])
  })
})

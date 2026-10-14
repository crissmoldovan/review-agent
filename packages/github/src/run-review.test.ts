import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, REVIEW_INSTRUCTIONS_VERSION, SecretLeak,
  type CheckVerdict, type EngineInput, type EngineResult, type Finding, type PreviousFinding,
  type RecheckJudgement, type RecheckPassResult, type ReviewOutput, type ReviewRequest, type Usage,
} from '@review-agent/core'
import { describe, expect, it, vi } from 'vitest'
import type { PullRequestContext } from './pr'
import { runReview, type ReviewAsk, type RunReviewDeps } from './run-review'

// The same two shas repo-config.test.ts uses, so base and head are told apart by eye in a failure.
const BASE_SHA = '0d5a1b3c9e7f2a4b6c8d0e2f4a6b8c0d2e4f6a8b'
const HEAD_SHA = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'

const PR: PullRequestContext = {
  owner: 'acme', repo: 'widgets', number: 16,
  headSha: HEAD_SHA, baseSha: BASE_SHA,
  title: 'ci(publish): refuse a tag that does not match package.json',
  body: 'Tags are pushed by hand, and nothing checks them.',
  changedFiles: [{ path: '.github/workflows/publish.yml', status: 'modified', patch: '@@ -88,6 +88,37 @@\n context\n' }],
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
// The usage numbers are a real basic-tier run: design §8, Opus 5 at low effort.
const USAGE: Usage = {
  costUsd: 0.9412, inputTokens: 32, outputTokens: 19350,
  cacheReadTokens: 514625, cacheWriteTokens: 50190, turns: 18, durationMs: 279107,
}
const RESULT: EngineResult = { output: OUTPUT, usage: USAGE, cutShort: false, wrapUpFired: false, failure: null }
const CHECK_USAGE: Usage = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104,
  cacheReadTokens: 61230, cacheWriteTokens: 18944, turns: 8, durationMs: 41022,
}
const VERDICT: CheckVerdict = {
  index: 0, verdict: 'refuted', severity: 2,
  reason: 'The job already guards on github.actor.',
  evidence: ['.github/workflows/publish.yml:104'],
}
const RECHECK_USAGE: Usage = {
  costUsd: 0.0968, inputTokens: 4, outputTokens: 1264,
  cacheReadTokens: 8493, cacheWriteTokens: 9206, turns: 4, durationMs: 41200,
}
const PREVIOUS: PreviousFinding = {
  file: '.github/workflows/publish.yml', line: 100, severity: 6, category: 'security',
  title: 'a tag on an unmerged branch still publishes',
}
const JUDGEMENT: RecheckJudgement = {
  index: 0, file: PREVIOUS.file, state: 'resolved',
  reason: 'The tag check is in place at :104.',
  evidence: ['.github/workflows/publish.yml:104'],
}
/** The default: nothing to ask about, so nothing spent. A first review's answer. */
const RECHECKED: RecheckPassResult = {
  judgements: [], usage: {
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turns: 0, durationMs: 0,
  }, ran: false, skipped: 'nothing-to-ask',
}

// The identity matters, not the contents: runReview must hand the caller's client to every call it
// makes and mint nothing of its own, because one caller holds a user token and the other an
// installation token.
const OCTOKIT = {} as Octokit

type Harness = RunReviewDeps & { notes: string[] }

const deps = (over: Partial<RunReviewDeps> = {}): Harness => {
  const notes: string[] = []
  // Two readings, so durationMs is a number a test can recognise: 4m39s, the measured wall clock of
  // a basic-tier review (design §8).
  const clock = ['2026-09-13T09:00:00.000Z', '2026-09-13T09:04:39.000Z']
  let tick = 0
  return {
    notes,
    note: (s: string) => { notes.push(s) },
    now: vi.fn(() => new Date(clock[Math.min(tick++, clock.length - 1)])),
    makeCheckoutDir: vi.fn(async () => '/tmp/ra-fake-checkout'),
    skillCacheDir: vi.fn(() => '/tmp/ra-fake-skill-cache'),
    fetchPullRequest: vi.fn(async () => PR),
    fetchRepoConfig: vi.fn(async () => null),
    downloadArchive: vi.fn(async (a: { destDir: string }) => ({ dir: a.destDir, removed: [] as string[] })),
    materialiseSkills: vi.fn(async () => []),
    runEngine: vi.fn(async () => RESULT),
    runCheckPass: vi.fn(async () => ({ verdicts: [] as CheckVerdict[], usage: CHECK_USAGE })),
    runRecheckPass: vi.fn(async () => RECHECKED),
    ...over,
  } as Harness
}

const run = (d: RunReviewDeps, ask: ReviewAsk = {}, previousFindings?: PreviousFinding[]) =>
  runReview({
    octokit: OCTOKIT, owner: 'acme', repo: 'widgets', number: 16,
    deployment: defaultDeploymentConfig(), ask, deps: d,
    ...(previousFindings !== undefined && { previousFindings }),
  })

describe('runReview', () => {
  it('reviews the pull request it was given and hands back the record of the run', async () => {
    const d = deps()
    const out = await run(d)

    expect(out.pr.headSha).toBe(HEAD_SHA)
    expect(out.request).toMatchObject({ repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA })
    expect(out.record.recordVersion).toBe(1)
    expect(out.record.instructions.version).toBe(REVIEW_INSTRUCTIONS_VERSION)
    expect(out.record.settings.tier).toBe('basic')
    expect(out.record.settings.effort).toBe('low')
    expect(out.record.usage.costUsd).toBe(0.9412)
    expect(out.record.output?.summary).toBe('Adds a tag check to publish.yml.')
    expect(out.record.timings).toEqual({
      startedAt: '2026-09-13T09:00:00.000Z',
      finishedAt: '2026-09-13T09:04:39.000Z',
      durationMs: 279_000,
    })

    const input = vi.mocked(d.runEngine).mock.calls[0][0]
    expect(input.checkoutDir).toBe('/tmp/ra-fake-checkout')
    expect(input.prompt).toContain('widgets')
    expect(input.systemPrompt).toContain('pull request reviewer')
    // report.maxFindings (50) caps what the MODEL may return; report.maxInline (15) caps what
    // GitHub is shown. Using maxInline here would tell the reviewer to stop finding things at 15.
    const schema = input.schema as { properties: { findings: { maxItems?: number } } }
    expect(schema.properties.findings.maxItems).toBe(50)
    // The whole list, unfiltered, and the cache directory comes from the deps.
    expect(d.materialiseSkills).toHaveBeenCalledWith([], '/tmp/ra-fake-skill-cache')
  })

  it('uses the caller’s own Octokit for every call and mints none of its own', async () => {
    const d = deps()
    await run(d)
    expect(vi.mocked(d.fetchPullRequest).mock.calls[0][0].octokit).toBe(OCTOKIT)
    expect(vi.mocked(d.downloadArchive).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets', ref: HEAD_SHA, destDir: '/tmp/ra-fake-checkout',
    })
    expect(vi.mocked(d.downloadArchive).mock.calls[0][0].octokit).toBe(OCTOKIT)
  })

  it('runs the check pass on the same checkout, and adds its cost to the record', async () => {
    const d = deps({ runCheckPass: vi.fn(async () => ({ verdicts: [VERDICT], usage: CHECK_USAGE })) })
    const out = await run(d, { check: true })

    const call = vi.mocked(d.runCheckPass).mock.calls[0][0]
    expect(call.findings).toEqual([FINDING])
    // The same checkout and the same engine input: the check must not download the tree again.
    expect(call.input.checkoutDir).toBe('/tmp/ra-fake-checkout')
    expect(d.downloadArchive).toHaveBeenCalledTimes(1)
    expect(out.check?.verdicts).toEqual([VERDICT])
    expect(out.record.checkVerdicts).toEqual([VERDICT])
    expect(out.record.costUsd).toBeCloseTo(1.0543, 6)
  })
})

describe('runReview: the re-review pass', () => {
  const recheckedOk: RecheckPassResult = {
    judgements: [JUDGEMENT], usage: RECHECK_USAGE, ran: true, skipped: null,
  }

  it('does not run on a first review, and spends nothing', async () => {
    // THE COST RULE. A first review has no previous run, so there is nothing to ask about and the
    // whole feature is free. Asserted on the dependency, not on a number: "it cost zero" would also
    // pass if the pass ran and happened to be free.
    const d = deps({ runRecheckPass: vi.fn(async () => recheckedOk) })
    const out = await run(d)
    expect(d.runRecheckPass).not.toHaveBeenCalled()
    expect(out.recheck).toBeNull()
    expect(out.record.recheckUsage).toBeNull()
    expect(out.record.recheckJudgements).toBeNull()
    expect(out.record.costUsd).toBeCloseTo(1.0543, 6)
  })

  it('runs on a re-review, on the same checkout, and adds its cost to the record', async () => {
    const d = deps({ runRecheckPass: vi.fn(async () => recheckedOk) })
    const out = await run(d, { check: true }, [PREVIOUS])

    const call = vi.mocked(d.runRecheckPass).mock.calls[0][0]
    expect(call.previous).toEqual([PREVIOUS])
    // The same checkout and the same engine input: it must not download the tree again.
    expect(call.input.checkoutDir).toBe('/tmp/ra-fake-checkout')
    expect(d.downloadArchive).toHaveBeenCalledTimes(1)
    expect(out.recheck?.judgements).toEqual([JUDGEMENT])
    // The ask travels with the answer, so whoever maps an index back to a row can prove the list it
    // was computed against is the list it is being read against.
    expect(out.recheck?.asked).toEqual([PREVIOUS])
    expect(out.record.recheckJudgements).toEqual([JUDGEMENT])
    expect(out.record.recheckUsage).toEqual(RECHECK_USAGE)
    // Labelled money, in the one place the product records money: engine + check + recheck, all
    // per-token API prices.
    expect(out.record.costUsd).toBeCloseTo(0.9412 + 0.1131 + 0.0968, 6)
  })

  it('tells the pass what has already been spent, so it can refuse its own cost', async () => {
    const d = deps({ runRecheckPass: vi.fn(async () => recheckedOk) })
    await run(d, { check: true }, [PREVIOUS])
    expect(vi.mocked(d.runRecheckPass).mock.calls[0][0].spentUsd).toBeCloseTo(0.9412 + 0.1131, 6)
  })

  it('runs after the check pass, never before', async () => {
    // The check decides what is SAID; this only refines an outcome. Ordering it second means a run
    // that dies in the check has not already bought a third pass.
    const order: string[] = []
    const d = deps({
      runCheckPass: vi.fn(async () => { order.push('check'); return { verdicts: [], usage: CHECK_USAGE } }),
      runRecheckPass: vi.fn(async () => { order.push('recheck'); return recheckedOk }),
    })
    await run(d, { check: true }, [PREVIOUS])
    expect(order).toEqual(['check', 'recheck'])
  })

  it('buys no pass at all when the review produced nothing to publish', async () => {
    const d = deps({
      runEngine: vi.fn(async () => ({ ...RESULT, output: null, failure: { kind: 'refusal' as const } })),
      runRecheckPass: vi.fn(async () => recheckedOk),
    })
    await run(d, { check: true }, [PREVIOUS])
    expect(d.runRecheckPass).not.toHaveBeenCalled()
  })

  it('buys nothing in a mode that writes no summary, because the answer would be thrown away', async () => {
    // Both consumers of the answer are behind `writesSummaryComment` — the marker write and the
    // comment edits, in publishReview — so in `check-only` and `silent` this pass spawned, spent and
    // was discarded, on every review, for ever. Reachable without anyone doing anything odd: a pull
    // request reviewed in `inline+summary` HAS a marker, and a repository may lower the mode from its
    // base branch at any time. The rows are still read, so the next review asks the same questions.
    for (const mode of ['check-only', 'silent'] as const) {
      const d = deps({ fetchRepoConfig: vi.fn(async () => ({ mode })) })
      const out = await run(d, { check: true }, [PREVIOUS])
      expect(d.runRecheckPass).not.toHaveBeenCalled()
      expect(out.recheck).toBeNull()
      expect(out.record.recheckUsage).toBeNull()
      expect(out.record.costUsd).toBeCloseTo(USAGE.costUsd + CHECK_USAGE.costUsd, 6)
    }
    // And it does run in the two modes that can write it down.
    for (const mode of ['summary-only', 'inline+summary'] as const) {
      const d = deps({
        fetchRepoConfig: vi.fn(async () => ({ mode })),
        runRecheckPass: vi.fn(async () => recheckedOk),
      })
      await run(d, { check: true }, [PREVIOUS])
      expect(d.runRecheckPass).toHaveBeenCalledTimes(1)
    }
  })

  it('runs even when the check pass is off: the two answer different questions', async () => {
    const d = deps({ runRecheckPass: vi.fn(async () => recheckedOk) })
    const out = await run(d, { check: false }, [PREVIOUS])
    expect(d.runCheckPass).not.toHaveBeenCalled()
    expect(d.runRecheckPass).toHaveBeenCalledTimes(1)
    expect(vi.mocked(d.runRecheckPass).mock.calls[0][0].spentUsd).toBeCloseTo(0.9412, 6)
    expect(out.record.costUsd).toBeCloseTo(0.9412 + 0.0968, 6)
  })

  it('does not fail the review when the pass throws — the review is worth more than the refinement', async () => {
    // `runCheckPass` is deliberately NOT like this: a throw there propagates and the review is never
    // posted. Here the review has already been produced and a reader is owed it.
    const d = deps({ runRecheckPass: vi.fn(async () => { throw new Error('spawn EAGAIN') }) })
    const out = await run(d, { check: true }, [PREVIOUS])
    expect(out.recheck?.judgements).toEqual([])
    expect(out.recheck?.ran).toBe(false)
    expect(out.record.output?.summary).toBe('Adds a tag check to publish.yml.')
    // Nothing is claimed about the money a throwing pass may or may not have spent: it reported none.
    expect(out.record.costUsd).toBeCloseTo(1.0543, 6)
  })

  it('does not fail the review when the pass leaks a secret either', async () => {
    // The check pass throws SecretLeak here and the whole review is withheld. This one cannot: the
    // pass already dropped its own judgements (core), so there is nothing carrying the secret left
    // to withhold, and every outcome simply stays `open`.
    const d = deps({
      runRecheckPass: vi.fn(async () => ({
        judgements: [], usage: RECHECK_USAGE, ran: false, skipped: 'withheld' as const,
      })),
    })
    const out = await run(d, { check: true }, [PREVIOUS])
    expect(out.recheck?.skipped).toBe('withheld')
    expect(out.record.output).not.toBeNull()
  })
})

describe('runReview: which commit the review is recorded against', () => {
  // `ReviewAsk` omits repo, pr and headSha so that no caller can name a commit that was not the one
  // reviewed (Task 1, Interfaces). The type is gone by the time a webhook payload — which can be
  // minutes old, and so carry a head sha that has already moved — is parsed into an ask, so the
  // order of the request literal is the only thing still enforcing it at runtime.
  const forged: ReviewAsk & Partial<Pick<ReviewRequest, 'repo' | 'pr' | 'headSha'>> = {
    repo: 'attacker/other-repo', pr: 999, headSha: 'a'.repeat(40), requestedBy: 'criss',
  }

  it('names the repo, pull request and head sha it fetched, whatever the ask carries', async () => {
    const d = deps()
    const out = await run(d, forged)

    expect(out.request).toMatchObject({ repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA })
    expect(out.record.request).toMatchObject({ repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA })
    // The record is what a later reader trusts about which commit was read, so it must not merely
    // disagree with the ask — it must carry nothing of it.
    expect(JSON.stringify(out.record.request)).not.toContain('attacker/other-repo')
    expect(JSON.stringify(out.record.request)).not.toContain('a'.repeat(40))
  })

  it('still honours everything else the same ask carries', async () => {
    // The guard is three keys, not a filter that quietly drops the rest of a request.
    const out = await run(deps(), forged)
    expect(out.record.request.requestedBy).toBe('criss')
  })
})

describe('runReview: the reviewed repository’s own file', () => {
  const CONFIGURED = { instructions: 'Care about the order of the migrations.' }

  it('reads .review-agent/review.md and lets it into the review', async () => {
    const d = deps({ fetchRepoConfig: vi.fn(async () => CONFIGURED) })
    const out = await run(d)

    // Until this task the CLI passed `repo: null` and fetchRepoConfig was called by nothing, so
    // this file — tested since sub-project 1 — had never reached a review (design §7).
    expect(out.settings.instructions).toBe('Care about the order of the migrations.')
    expect(vi.mocked(d.runEngine).mock.calls[0][0].systemPrompt)
      .toContain('Care about the order of the migrations.')
    expect(vi.mocked(d.fetchRepoConfig).mock.calls[0][0]).toMatchObject({
      owner: 'acme', repo: 'widgets',
    })
  })

  it('reads it from the base commit and never from the head', async () => {
    // Design §4.3: a pull request that can edit its reviewer's instructions is not reviewed, it is
    // negotiated with. The head sha is in this run — it is what gets checked out — so the only
    // thing that keeps the config honest is which sha this call is given.
    const d = deps({ fetchRepoConfig: vi.fn(async () => CONFIGURED) })
    await run(d)
    expect(vi.mocked(d.fetchRepoConfig).mock.calls[0][0].baseRef).toBe(BASE_SHA)
    expect(JSON.stringify(vi.mocked(d.fetchRepoConfig).mock.calls)).not.toContain(HEAD_SHA)
  })

  it('reviews on the deployment’s settings when the repository has no file', async () => {
    const d = deps()
    const out = await run(d)
    expect(d.fetchRepoConfig).toHaveBeenCalledTimes(1)
    expect(out.settings.instructions).toBeNull()
    expect(out.settings.severity.postInlineAtOrAbove).toBe(5)
  })
})

describe('runReview: what it says while a person waits', () => {
  it('says what the deployment refused and what was taken out of the checkout, before the engine starts', async () => {
    const d = deps({
      downloadArchive: vi.fn(async (x: { destDir: string }) => ({ dir: x.destDir, removed: ['.npmrc'] })),
      runEngine: vi.fn(async () => { throw new Error('the engine started before the notes were written') }),
    })
    // $25 on a $3 tier, so resolveSettings drops budgetUsd and the run has something to say.
    await expect(run(d, { tier: 'normal', budgetUsd: 25 })).rejects.toThrow('the engine started')
    expect(d.notes).toEqual([
      'ignored, the deployment does not allow it: budgetUsd',
      'removed 1 credential file from the checkout before the review: .npmrc',
    ])
  })

  it('counts the credential files it removed, and puts them on the record', async () => {
    // Credential files are deleted before the model starts, not judged (archive.ts). A reviewer who
    // later wonders why the review never mentioned a .npmrc should find out from this line.
    const d = deps({
      downloadArchive: vi.fn(async (x: { destDir: string }) => (
        { dir: x.destDir, removed: ['.npmrc', 'apps/web/.env.local'] }
      )),
    })
    const out = await run(d)
    expect(d.notes).toEqual([
      'removed 2 credential files from the checkout before the review: .npmrc, apps/web/.env.local',
    ])
    expect(out.record.checkout.removedCredentialFiles).toEqual(['.npmrc', 'apps/web/.env.local'])
  })

  it('says nothing when nothing was refused and nothing was removed', async () => {
    const d = deps()
    await run(d)
    expect(d.notes).toEqual([])
  })
})

describe('runReview: nothing that carries a secret leaves this function', () => {
  // 36 characters after the prefix: what the scanner's pattern actually matches.
  const TOKEN = 'ghp_' + 'A'.repeat(36)

  it('refuses a review that carries a secret, and pays for no check pass', async () => {
    const leaky: EngineResult = {
      ...RESULT, output: { ...OUTPUT, summary: `the workflow used ${TOKEN} directly` },
    }
    const d = deps({ runEngine: vi.fn(async () => leaky) })
    const failed = await run(d, { check: true }).catch((e: unknown) => e)

    expect(failed).toBeInstanceOf(SecretLeak)
    // A review that cannot be emitted must not buy a second model call.
    expect(d.runCheckPass).not.toHaveBeenCalled()
    expect((failed as Error).message).toContain('github-token')
    expect((failed as Error).message).toContain('summary:line 1')
    // The message goes into logs and possibly an alert; it must not spread the leak.
    expect((failed as Error).message).not.toContain(TOKEN)
  })

  it('refuses a check verdict that carries a secret', async () => {
    // A verdict's reason and evidence are model-written and both callers print or post them, so
    // they are a posting path in the sense of design §4.3 and get the same scan.
    const d = deps({
      runCheckPass: vi.fn(async () => ({
        verdicts: [{ ...VERDICT, reason: `the workflow used ${TOKEN}` }], usage: CHECK_USAGE,
      })),
    })
    const failed = await run(d, { check: true }).catch((e: unknown) => e)

    expect(failed).toBeInstanceOf(SecretLeak)
    expect((failed as Error).message).toContain('checkVerdicts[0].reason')
    expect((failed as Error).message).not.toContain(TOKEN)
  })

  it('scans the evidence of a verdict as well as its reason', async () => {
    const d = deps({
      runCheckPass: vi.fn(async () => ({
        verdicts: [{ ...VERDICT, evidence: ['ci.yml:12', `token: ${TOKEN}`] }], usage: CHECK_USAGE,
      })),
    })
    const failed = await run(d, { check: true }).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(SecretLeak)
    expect((failed as Error).message).toContain('checkVerdicts[0].evidence[1]')
  })
})

describe('runReview: stopping a review', () => {
  it('hands the abort signal it was given to the engine, so a review can be stopped', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const d = deps({ runEngine: vi.fn(async (i: EngineInput) => { seen = i.signal; return RESULT }) })
    // runReview directly, because run() passes no signal.
    await runReview({
      octokit: OCTOKIT, owner: 'acme', repo: 'widgets', number: 16,
      deployment: defaultDeploymentConfig(), ask: {}, deps: d, signal: controller.signal,
    })
    expect(seen).toBe(controller.signal)
  })

  it('leaves the engine with no signal when the caller gives none', async () => {
    // Seeded with a real signal, so the undefined below is something runReview did, not the default.
    let seen: AbortSignal | undefined = new AbortController().signal
    const d = deps({ runEngine: vi.fn(async (i: EngineInput) => { seen = i.signal; return RESULT }) })
    await run(d)
    expect(seen).toBeUndefined()
  })
})

describe('runReview: the downloaded code', () => {
  const realCheckout = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-checkout-'))
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    return dir
  }

  it('is removed when the review fails, because nothing will publish from it', async () => {
    const dir = realCheckout()
    const d = deps({ makeCheckoutDir: vi.fn(async () => dir), runEngine: vi.fn(async () => { throw new Error('engine exploded') }) })
    await expect(run(d)).rejects.toThrow(/engine exploded/)
    expect(existsSync(dir)).toBe(false)
  })

  it('is kept and handed back when the review succeeds, for publishing to read', async () => {
    const dir = realCheckout()
    const r = await run(deps({ makeCheckoutDir: vi.fn(async () => dir) }))
    expect(r.checkoutDir).toBe(dir)
    expect(existsSync(join(dir, 'a.ts'))).toBe(true)
  })
})

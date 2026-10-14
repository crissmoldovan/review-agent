import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultDeploymentConfig, resolveSettings, type ReviewRequest } from './config'
import type { EngineResult } from './engine'
import { REVIEW_INSTRUCTIONS_DIGEST, REVIEW_INSTRUCTIONS_VERSION } from './prompt'
import { buildReviewRecord, ENGINE_VERSION, type ReviewRecord } from './record'

const REQUEST: ReviewRequest = {
  repo: 'acme/widgets', pr: 16, headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
  tier: 'normal', requestedBy: 'crissmoldovan', requestId: '2411556677', budgetUsd: 25,
}
const SETTINGS = resolveSettings({
  deployment: defaultDeploymentConfig(), repo: null, request: REQUEST,
})
const RESULT: EngineResult = {
  output: {
    summary: 'Adds a tag check to publish.yml.',
    intent: { verdict: 'matches', note: 'It does what the brief says.' },
    findings: [{
      file: '.github/workflows/publish.yml', line: 100, endLine: null, severity: 6,
      category: 'security', title: 'a tag on an unmerged branch still publishes',
      explanation: 'e', evidence: ['.github/workflows/publish.yml:100'], suggestion: null,
    }],
    inconclusive: [{ question: 'Does the release job run on a protected runner?',
                    whatWouldSettleIt: 'The runner group settings, which are not in the repo.' }],
  },
  usage: { costUsd: 0.9412, inputTokens: 32, outputTokens: 19350,
           cacheReadTokens: 514625, cacheWriteTokens: 50190, turns: 18, durationMs: 279107 },
  cutShort: false, wrapUpFired: false, failure: null,
}

const record = (over: Partial<Parameters<typeof buildReviewRecord>[0]> = {}): ReviewRecord =>
  buildReviewRecord({
    request: REQUEST, settings: SETTINGS, result: RESULT, skills: [], check: null, recheck: null,
    removedFromCheckout: [],
    startedAt: new Date('2026-09-13T09:00:00.000Z'),
    finishedAt: new Date('2026-09-13T09:04:39.000Z'),
    ...over,
  })

describe('buildReviewRecord — the settings that produced the review', () => {
  it('records the tier, the model, the effort and the budget it actually ran on', () => {
    const r = record()
    expect(r.recordVersion).toBe(1)
    expect(r.settings.tier).toBe('normal')
    expect(r.settings.model).toBe('claude-opus-5')
    expect(r.settings.effort).toBe('medium')
    expect(r.settings.check).toBe(true)
    expect(r.settings.multi).toBe(false)
    expect(r.settings.budget).toEqual({ targetUsd: 3, wrapUpAtUsd: 2.1, ceilingUsd: 7.5 })
  })

  it('records what the request asked for and did not get', () => {
    const r = record()
    expect(r.request.repo).toBe('acme/widgets')
    expect(r.request.pr).toBe(16)
    expect(r.request.headSha).toBe('4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
    expect(r.request.requestedBy).toBe('crissmoldovan')
    expect(r.request.requestId).toBe('2411556677')
    // $25 on a $3 tier: a record that dropped this could not answer "why not".
    expect(r.request.droppedRequestKeys).toEqual(['budgetUsd'])
  })

  it('records every pass’s money separately and the sum of all three', () => {
    // Three passes, three bills, one total — all of them model spend at per-token API prices, which
    // is the only kind of figure this record holds. The total is what the public summary prints, so
    // a pass whose cost did not reach it would be an unlabelled, unrecorded charge.
    const usage = (costUsd: number) => ({
      costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      turns: 0, durationMs: 0,
    })
    const r = record({
      check: { verdicts: [], usage: usage(0.0803) },
      recheck: { judgements: [], usage: usage(0.0968), ran: true, skipped: null },
    })
    expect(r.usage.costUsd).toBe(0.9412)
    expect(r.checkUsage?.costUsd).toBe(0.0803)
    expect(r.recheckUsage?.costUsd).toBe(0.0968)
    expect(r.costUsd).toBeCloseTo(0.9412 + 0.0803 + 0.0968, 6)
  })

  it('says why the re-review pass produced nothing, and costs nothing when it never ran', () => {
    // "No outcome changed" and "the pass never ran" look identical from outside, and only one of
    // them is worth investigating.
    const refused = record({
      recheck: {
        judgements: [], ran: false, skipped: 'budget',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 },
      },
    })
    expect(refused.recheckSkipped).toBe('budget')
    expect(refused.recheckJudgements).toEqual([])
    expect(refused.costUsd).toBe(0.9412)
    // A first review buys no such pass at all, and says so with null rather than with a zero.
    expect(record().recheckUsage).toBeNull()
    expect(record().recheckJudgements).toBeNull()
    expect(record().recheckSkipped).toBeNull()
  })

  it('records the money, the tokens and the timings', () => {
    const r = record()
    expect(r.usage.costUsd).toBe(0.9412)
    expect(r.usage.cacheReadTokens).toBe(514625)
    expect(r.costUsd).toBe(0.9412)
    expect(r.wrapUpFired).toBe(false)
    expect(r.cutShort).toBe(false)
    expect(r.failure).toBeNull()
    expect(r.timings).toEqual({
      startedAt: '2026-09-13T09:00:00.000Z',
      finishedAt: '2026-09-13T09:04:39.000Z',
      durationMs: 279_000,
    })
  })
})

describe('buildReviewRecord — design §4.7: which instructions, which skills', () => {
  it('records the review instructions version and digest', () => {
    const r = record()
    expect(r.instructions.version).toBe(REVIEW_INSTRUCTIONS_VERSION)
    expect(r.instructions.digest).toBe(REVIEW_INSTRUCTIONS_DIGEST)
    expect(r.instructions.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // "Each run records the skills and versions it used" — for a git source the version IS the id,
  // because skillSourceId (Task 3) puts the pinned ref in it.
  it('records every skill it mounted, id first', () => {
    const r = record({ skills: [
      { id: '/opt/review-agent/skills/security-pass', path: '/opt/review-agent/skills/security-pass' },
      { id: 'crissmoldovan/review-skills@v0.3.0#test-coverage',
        path: '/cache/review-skills-9f2c1a4b7e10/test-coverage' },
    ] })
    expect(r.skills.map((s) => s.id)).toEqual([
      '/opt/review-agent/skills/security-pass',
      'crissmoldovan/review-skills@v0.3.0#test-coverage',
    ])
    expect(r.skills[1].id).toContain('@v0.3.0')
    expect(r.skills).not.toBe(record({ skills: [] }).skills)
  })

  it('records an empty list, not a missing one, when no skill was mounted', () => {
    expect(record().skills).toEqual([])
  })
})

const CHECK_USAGE = {
  costUsd: 0.1131, inputTokens: 11, outputTokens: 2104,
  cacheReadTokens: 61230, cacheWriteTokens: 18944, turns: 8, durationMs: 41022,
}
const VERDICTS = [{
  index: 0, verdict: 'refuted' as const, severity: 2,
  reason: 'The job already guards on github.actor.',
  evidence: ['.github/workflows/publish.yml:104'],
}]

describe('buildReviewRecord — the check pass', () => {
  it('separates "the pass did not run" from "the pass found nothing"', () => {
    expect(record().checkVerdicts).toBeNull()
    expect(record().checkUsage).toBeNull()
    expect(record({ check: { verdicts: [], usage: CHECK_USAGE } }).checkVerdicts).toEqual([])
  })

  it('adds the check to the cost, and keeps the two usages apart', () => {
    const r = record({ check: { verdicts: VERDICTS, usage: CHECK_USAGE } })
    expect(r.checkVerdicts).toEqual(VERDICTS)
    expect(r.usage.costUsd).toBe(0.9412)           // the review alone
    expect(r.checkUsage?.costUsd).toBe(0.1131)     // the pass alone
    expect(r.costUsd).toBeCloseTo(1.0543, 6)       // what the run cost, which is what a budget means
  })
})

// A deployment asked for this: the check run's name is a deployment setting, so a record that did
// not carry it could not answer "which check run was this review, and why is that branch rule red".
describe('buildReviewRecord — the name of the check run this review wrote', () => {
  it('records the name the settings resolved to', () => {
    expect(record().settings.report.checkRunName).toBe('review-agent')
  })

  it('records the deployment’s own name rather than the default', () => {
    const deployment = defaultDeploymentConfig()
    deployment.report.checkRunName = 'review-agent (staging)'
    const settings = resolveSettings({ deployment, repo: null, request: REQUEST })
    expect(record({ settings }).settings.report.checkRunName).toBe('review-agent (staging)')
  })
})

// Criss, 2026-09-13: credential files are removed from the working copy before the model starts
// rather than judged. A review that silently ran on a checkout with files taken out of it would be
// a review whose inputs nobody can reconstruct, so the record names them.
describe('buildReviewRecord — what was removed from the checkout before the review', () => {
  it('names the credential files the review never saw', () => {
    expect(record({ removedFromCheckout: ['.npmrc', 'apps/web/.env.local'] }).checkout)
      .toEqual({ removedCredentialFiles: ['.npmrc', 'apps/web/.env.local'], notWritten: [], caseCollisions: [] })
  })

  it('records an empty list rather than omitting the field', () => {
    expect(record().checkout).toEqual({ removedCredentialFiles: [], notWritten: [], caseCollisions: [] })
  })

  // Spec 0.2.0 §9.3 P10: an entry the extraction could not write was missing in silence, and two paths
  // one filesystem cannot tell apart left one file where the archive had two. Both are named now,
  // and RECORD_VERSION stays 1: the fields are new, nothing old changed meaning.
  it('names what was not written, and which paths collided by case', () => {
    const r = record({
      notWrittenToCheckout: [{ path: 'docs/CON', code: 'EINVAL' }],
      caseCollisions: [['README.md', 'Readme.md']],
    })
    expect(r.recordVersion).toBe(1)
    expect(r.checkout).toEqual({
      removedCredentialFiles: [],
      notWritten: [{ path: 'docs/CON', code: 'EINVAL' }],
      caseCollisions: [['README.md', 'Readme.md']],
    })
  })
})

// The `review_runs` ledger a deployment keeps. Its settings and cost columns exist because two
// reviews are only comparable when the tier, model, effort, skills and money behind them are known.
// Sub-project 2 writes the row; this table is the promise that it will have something to write.
const REVIEW_RUNS_SOURCES: [string, (r: ReviewRecord) => unknown][] = [
  ['repo', (r) => r.request.repo],
  ['pr_number', (r) => r.request.pr],
  ['head_sha', (r) => r.request.headSha],
  ['requested_by', (r) => r.request.requestedBy],
  ['request_id', (r) => r.request.requestId],
  ['tier', (r) => r.settings.tier],
  ['multi', (r) => r.settings.multi],
  ['model', (r) => r.settings.model],
  ['effort', (r) => r.settings.effort],
  ['check_enabled', (r) => r.settings.check],
  ['engine_version', (r) => r.engineVersion],
  ['review_skill', (r) => r.instructions.version],
  ['skills', (r) => r.skills],
  ['budget_usd', (r) => r.settings.budget.targetUsd],
  ['cost_usd', (r) => r.costUsd],
  ['prompt_tokens', (r) => r.usage.inputTokens],
  ['completion_tokens', (r) => r.usage.outputTokens],
  ['cache_read_tokens', (r) => r.usage.cacheReadTokens],
  ['cache_write_tokens', (r) => r.usage.cacheWriteTokens],
  ['turns', (r) => r.usage.turns],
  ['wrapup_fired', (r) => r.wrapUpFired],
  ['cut_short', (r) => r.cutShort],
  ['inconclusive', (r) => r.output?.inconclusive],
  ['started_at', (r) => r.timings.startedAt],
  ['finished_at', (r) => r.timings.finishedAt],
  ['findings.check_verdict', (r) => r.checkVerdicts?.[0]?.verdict],
  ['findings.check_severity', (r) => r.checkVerdicts?.[0]?.severity],
]

describe('ReviewRecord against a deployment\'s review_runs ledger', () => {
  const full = record({
    skills: [{ id: 'crissmoldovan/review-skills@v0.3.0', path: '/cache/x' }],
    check: { verdicts: VERDICTS, usage: CHECK_USAGE },
  })
  it.each(REVIEW_RUNS_SOURCES)('has a source for review_runs.%s', (_column, read) => {
    expect(read(full)).toBeDefined()
  })
})

it('records the version of the engine that produced it', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
  expect(ENGINE_VERSION).toBe(pkg.version)
})

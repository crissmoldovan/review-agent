import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultDeploymentConfig, resolveSettings,
  type CheckVerdict, type EngineFailure, type Finding, type ReviewRecord, type Usage,
} from '@review-agent/core'
import type {
  PublishedReview, RunReviewResult, SessionFailed, SessionReport, SessionStage, SessionUnfinished,
} from '@review-agent/github'
import { afterAll, describe, expect, it } from 'vitest'
import { BASE_SHA, HEAD_SHA, RETRY_FILE, RETRY_PATCH, RETRY_SOURCE } from '../test/fake-github'
import { resultOf, wouldSay } from './result'

const ROOT = mkdtempSync(join(tmpdir(), 'ra-sdk-result-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

/** A checkout that really holds the reviewed file: `wouldSay` checks every path against it. */
const checkout = (): string => {
  const dir = mkdtempSync(join(ROOT, 'checkout-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, RETRY_FILE), RETRY_SOURCE)
  return dir
}

const finding = (over: Partial<Finding>): Finding => ({
  file: RETRY_FILE, line: 24, endLine: null, severity: 6, category: 'correctness', title: 'a defect',
  explanation: 'e', evidence: [], suggestion: null, ...over,
})
const NOTHING: Usage = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0 }

/** The record only travels through the mapping; its identity is what is checked. */
const record = (costUsd: number): ReviewRecord => ({ costUsd, marker: 'the record' }) as unknown as ReviewRecord

const review = (a: {
  findings: Finding[]; verdicts?: CheckVerdict[] | null; failure?: EngineFailure | null; cutShort?: boolean
  mode?: 'inline+summary' | 'silent' | 'check-only'
}): RunReviewResult => {
  const deployment = defaultDeploymentConfig()
  deployment.report.mode = a.mode ?? 'inline+summary'
  const request = { repo: 'acme/widgets', pr: 16, headSha: HEAD_SHA }
  return {
    pr: {
      owner: 'acme', repo: 'widgets', number: 16, headSha: HEAD_SHA, baseSha: BASE_SHA, title: 't', body: '',
      changedFiles: [{ path: RETRY_FILE, status: 'modified', patch: RETRY_PATCH }], diff: '',
    },
    request,
    settings: resolveSettings({ deployment, repo: null, request }),
    result: {
      output: { summary: 's', intent: { verdict: 'matches', note: 'n' }, findings: a.findings, inconclusive: [] },
      usage: NOTHING, cutShort: a.cutShort ?? false, wrapUpFired: false, failure: a.failure ?? null,
    },
    check: a.verdicts === null || a.verdicts === undefined ? null : { verdicts: a.verdicts, usage: NOTHING },
    recheck: null, skills: [], checkoutDir: checkout(), removedFromCheckout: [], record: record(0.5),
  }
}

const verdict = (index: number, v: CheckVerdict['verdict'], severity: number, duplicateOf?: number | null): CheckVerdict => ({
  index, verdict: v, severity, reason: 'r', evidence: [], ...(duplicateOf !== undefined && { duplicateOf }),
})

const published = (findings: Finding[]): PublishedReview => ({
  mode: 'inline+summary', headSha: HEAD_SHA, completed: true, reviewId: 900, summaryCommentId: 8100,
  summaryUrl: 'https://github.com/acme/widgets/pull/16#issuecomment-8100',
  said: { inline: [], summaryOnly: findings }, findings, confirmed: null,
  counts: { inline: 1, summaryOnly: 1, droppedInline: 0, suppressed: 2, notInCheckout: 1, retracted: 0, reinstated: 0, retractionsWithheld: 0 },
  marker: { version: 1, runs: [
    { headSha: '1'.repeat(40), at: 't0', findings: [{ id: 'old', file: RETRY_FILE, line: 3, severity: 5, title: 'old', commentId: 11, outcome: 'open' }] },
    { headSha: HEAD_SHA, at: 't1', findings: [
      { id: 'abc', file: RETRY_FILE, line: 24, severity: 6, title: 'a defect', commentId: 77, outcome: 'open' },
      { id: 'def', file: RETRY_FILE, line: 10, severity: 3, title: 'summary only', commentId: null, outcome: 'open' },
    ] },
  ] },
  bodies: { review: 'r', inline: [], summary: 's' },
})

const REPORT: SessionReport = { kind: 'check-run', id: 4242, url: 'https://github.com/acme/widgets/runs/4242', conclusion: 'failure' }

describe('resultOf: the session’s outcome as the SDK returns it (spec 0.2.0 §4.3)', () => {
  it('reviewed and posted: the findings are what was posted, and the post and the report are described', () => {
    const r = review({ findings: [finding({})] })
    const said = [finding({ severity: 5, title: 'as posted' })]
    const p = published(said)
    const out = resultOf({
      kind: 'reviewed', review: r, record: r.record, published: p, report: REPORT, verdict: 'v',
      comments: [], stoppedAfterFinishing: false, checkoutDir: r.checkoutDir,
    })
    expect(out).toEqual({
      kind: 'reviewed', record: r.record, findings: said,
      posted: {
        mode: 'inline+summary', summaryUrl: p.summaryUrl, summaryCommentId: 8100, reviewId: 900, counts: p.counts,
        // This review's comments only, from the marker run it appended — never an earlier review's.
        comments: [{ findingId: 'abc', file: RETRY_FILE, line: 24, commentId: 77 }],
      },
      report: { kind: 'check-run', id: 4242, url: REPORT.url, conclusion: 'failure' },
    })
  })

  it('reviewed and not posted: the findings are what it would have said, read against the checkout', () => {
    const r = review({
      findings: [finding({ severity: 7 }), finding({ line: 5, title: 'refuted' }), finding({ file: 'src/ghost.ts', title: 'ghost' })],
      verdicts: [verdict(0, 'confirmed', 6), verdict(1, 'refuted', 2), verdict(2, 'confirmed', 6)],
    })
    const out = resultOf({
      kind: 'reviewed', review: r, record: r.record, published: null, report: null, verdict: null,
      comments: [], stoppedAfterFinishing: false, checkoutDir: r.checkoutDir,
    })
    expect(out).toMatchObject({ kind: 'reviewed', posted: null, report: null })
    expect(out.kind === 'reviewed' && out.findings).toEqual([finding({ severity: 6 })])
  })

  it('unfinished: every field the session decided, carried over', () => {
    const r = review({ findings: [] })
    const base: SessionUnfinished = {
      kind: 'unfinished', review: r, record: r.record, reason: 'the review stopped at its ceiling',
      spentUsd: 2.32, retryable: false, stopped: 'deadline', published: null, report: null, checkoutDir: null,
    }
    expect(resultOf(base)).toEqual({
      kind: 'unfinished', record: r.record, reason: base.reason, spentUsd: 2.32, retryable: false,
      stopped: 'deadline', posted: null, report: null,
    })
    const posted = resultOf({ ...base, stopped: null, published: published([]), report: { ...REPORT, conclusion: null } })
    expect(posted).toMatchObject({ posted: { summaryCommentId: 8100 }, report: { conclusion: null } })
  })

  it.each<SessionStage>(['before-model', 'model', 'withheld', 'publish'])('failed at %s: the stage, the money and the cause, carried over', (stage) => {
    const cause = new Error('underneath')
    const failed: SessionFailed = {
      kind: 'failed', stage, reason: 'a sentence', spentUsd: 0.4, engineStarted: stage !== 'before-model',
      retryable: stage === 'before-model', stopped: stage === 'model' ? 'cancelled' : null, review: null, report: REPORT, cause,
    }
    const out = resultOf(failed)
    expect(out).toEqual({
      kind: 'failed', stage, reason: 'a sentence', spentUsd: 0.4, retryable: stage === 'before-model',
      stopped: stage === 'model' ? 'cancelled' : null, record: null, findings: null,
      report: { kind: 'check-run', id: 4242, url: REPORT.url, conclusion: 'failure' }, cause,
    })
    expect(out.kind === 'failed' && out.cause).toBe(cause)
  })

  it('failed at publish with the review: the record and what it would have said, so it is not lost', () => {
    const r = review({ findings: [finding({})] })
    const out = resultOf({
      kind: 'failed', stage: 'publish', reason: 'the review ran and could not be posted', spentUsd: 0.5,
      engineStarted: true, retryable: false, stopped: null, review: r, report: null, cause: null,
    })
    expect(out).toMatchObject({ kind: 'failed', stage: 'publish', record: r.record, findings: [finding({})] })
  })
})

describe('wouldSay: chosen as publishReview chooses', () => {
  it('says a finding the check pass marked as a duplicate once, by position', () => {
    const r = review({
      findings: [finding({ title: 'first' }), finding({ title: 'the same, again' })],
      verdicts: [verdict(0, 'confirmed', 6, null), verdict(1, 'confirmed', 6, 0)],
    })
    expect(wouldSay(r).map((f) => f.title)).toEqual(['first'])
  })

  it('keeps the partial findings of a review its ceiling stopped', () => {
    const r = review({ findings: [finding({})], failure: { kind: 'budget', spentUsd: 5 }, cutShort: true })
    expect(wouldSay(r)).toEqual([finding({})])
  })

  it('in silent and check-only, says what it would have said', () => {
    for (const mode of ['silent', 'check-only'] as const) {
      expect(wouldSay(review({ findings: [finding({})], mode }))).toEqual([finding({})])
    }
  })

  it('caps findings below the medium band as a first review does', () => {
    const lows = [1, 2, 3, 2].map((severity, i) => finding({ severity, line: 20 + i, title: `low ${i}` }))
    expect(wouldSay(review({ findings: lows }))).toHaveLength(defaultDeploymentConfig().report.firstReviewLowBandCap)
  })

  it('says nothing for a review with no output', () => {
    const r = review({ findings: [] })
    expect(wouldSay({ ...r, result: { ...r.result, output: null } })).toEqual([])
  })
})

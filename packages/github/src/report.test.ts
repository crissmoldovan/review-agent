import { describe, expect, it } from 'vitest'
import {
  type DeploymentConfig, type Finding, type ResolvedSettings,
  defaultDeploymentConfig, resolveSettings,
} from '@review-agent/core'
import type { CheckVerdict } from '@review-agent/core'
import type { AnchorResult } from './anchor'
import { duplicatesIn, repeatsIn, selectForPosting } from './report'

// Settings are resolved, never hand-built: these tests are about what a deployment configures, so
// they must read the same values resolveSettings hands the rest of the product.
const settingsWith = (edit: (d: DeploymentConfig) => void = () => {}): ResolvedSettings => {
  const deployment = defaultDeploymentConfig()
  edit(deployment)
  return resolveSettings({
    deployment,
    repo: null,
    request: { repo: 'acme/widgets', pr: 16, headSha: 'b'.repeat(40) },
  })
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: '.github/workflows/publish.yml', line: 100, endLine: null,
  severity: 6, category: 'security', title: 't', explanation: 'e',
  evidence: [], suggestion: null, ...over,
})

const anchored = (inline: Finding[], summaryOnly: Finding[] = []): AnchorResult => ({
  inline: inline.map((f) => ({ finding: f, line: f.line, side: 'RIGHT' as const })),
  summaryOnly,
  dropped: [],
})

const firstReview = null
const laterReview = { headSha: 'a'.repeat(40) }

describe('selectForPosting: the inline threshold and the inline cap', () => {
  it('posts a finding at or above the threshold inline', () => {
    const plan = selectForPosting({
      anchored: anchored([finding({ severity: 6 })]),
      settings: settingsWith(), previous: firstReview,
    })
    expect(plan.inline).toHaveLength(1)
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed).toEqual([])
  })

  it('summarises a finding below the threshold instead of commenting on it', () => {
    const f = finding({ severity: 4 })   // above the low band, below postInlineAtOrAbove (5)
    const plan = selectForPosting({
      anchored: anchored([f]), settings: settingsWith(), previous: firstReview,
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly).toEqual([f])
  })

  it('caps inline comments at report.maxInline, worst first', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      finding({ title: `f${i}`, severity: i < 15 ? 6 : 9 }))
    const plan = selectForPosting({
      anchored: anchored(many), settings: settingsWith(), previous: firstReview,
    })
    expect(plan.inline).toHaveLength(15)
    expect(plan.inline.slice(0, 5).map((x) => x.finding.title)).toEqual(['f15', 'f16', 'f17', 'f18', 'f19'])
    expect(plan.summaryOnly.map((f) => f.title)).toEqual(['f10', 'f11', 'f12', 'f13', 'f14'])
    expect(plan.suppressed).toEqual([])
  })

  it('never inlines a finding anchoring could not place, however severe', () => {
    const f = finding({ severity: 10 })
    const plan = selectForPosting({
      anchored: anchored([], [f]), settings: settingsWith(), previous: firstReview,
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly).toEqual([f])
  })
})

describe('selectForPosting: report.mode', () => {
  const two = () => anchored([finding({ severity: 9, title: 'inline-able' })], [finding({ severity: 8, title: 'not-placeable' })])

  it('summary-only posts no inline comments and keeps every finding', () => {
    const plan = selectForPosting({
      anchored: two(),
      settings: settingsWith((d) => { d.report.mode = 'summary-only' }),
      previous: firstReview,
    })
    expect(plan.inline).toHaveLength(0)
    expect(plan.summaryOnly.map((f) => f.title)).toEqual(['inline-able', 'not-placeable'])
    expect(plan.suppressed).toEqual([])
  })

  it('check-only says nothing in a comment', () => {
    const plan = selectForPosting({
      anchored: two(),
      settings: settingsWith((d) => { d.report.mode = 'check-only' }),
      previous: firstReview,
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed).toHaveLength(2)
  })

  it('silent records the review and posts nothing', () => {
    // Design §3.1: a deployment can watch the reviewer for a fortnight before letting it speak.
    // `suppressed` is what the review's own record still lists, so the trial has something to read.
    const plan = selectForPosting({
      anchored: two(),
      settings: settingsWith((d) => { d.report.mode = 'silent' }),
      previous: firstReview,
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed.map((f) => f.title)).toEqual(['inline-able', 'not-placeable'])
  })
})

describe('selectForPosting: the low band', () => {
  // Below severity.bands.medium (4) is the low band: severities 1-3.
  const nits = () => anchored([
    finding({ title: 'n3a', severity: 3 }), finding({ title: 'n3b', severity: 3 }),
    finding({ title: 'n2a', severity: 2 }), finding({ title: 'n2b', severity: 2 }),
    finding({ title: 'n1', severity: 1 }),
  ])

  it('mentions at most firstReviewLowBandCap of them on a first review', () => {
    const plan = selectForPosting({ anchored: nits(), settings: settingsWith(), previous: firstReview })
    expect(plan.inline).toEqual([])                       // all below postInlineAtOrAbove (5)
    expect(plan.summaryOnly.map((f) => f.title)).toEqual(['n3a', 'n3b', 'n2a'])
    expect(plan.suppressed.map((f) => f.title)).toEqual(['n2b', 'n1'])
  })

  it('mentions none of them on a later review', () => {
    const plan = selectForPosting({ anchored: nits(), settings: settingsWith(), previous: laterReview })
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed).toHaveLength(5)
  })

  it('gives the cap back on a later review when repeatNits is on', () => {
    const plan = selectForPosting({
      anchored: nits(),
      settings: settingsWith((d) => { d.report.repeatNits = true }),
      previous: laterReview,
    })
    expect(plan.summaryOnly.map((f) => f.title)).toEqual(['n3a', 'n3b', 'n2a'])
    expect(plan.suppressed).toHaveLength(2)
  })

  it('posts them inline when the deployment lowers the threshold, still capped', () => {
    const plan = selectForPosting({
      anchored: nits(),
      settings: settingsWith((d) => { d.severity.postInlineAtOrAbove = 2 }),
      previous: firstReview,
    })
    expect(plan.inline.map((x) => x.finding.title)).toEqual(['n3a', 'n3b', 'n2a'])
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed.map((f) => f.title)).toEqual(['n2b', 'n1'])
  })

  it('never resurrects a finding anchoring dropped', () => {
    const kept = finding({ title: 'kept', severity: 7 })
    const binned = finding({ title: 'binned', file: 'src/invented.ts', severity: 10 })
    const plan = selectForPosting({
      anchored: { ...anchored([kept]), dropped: [{ finding: binned, why: 'path is not a file in the checkout' }] },
      settings: settingsWith(), previous: firstReview,
    })
    const said = [...plan.inline.map((x) => x.finding), ...plan.summaryOnly, ...plan.suppressed]
    expect(said.map((f) => f.title)).toEqual(['kept'])
  })
})

// ── THE CHECK PASS DECIDES WHAT IS POSTED ────────────────────────────────────────────────────────
// Criss, 2026-09-13, after the first trial: a refuted finding never posts, and a confirmed or
// uncertain one posts at the CHECK's severity, not the reviewer's. The trial found the reviewer
// rating a guess 5 and a fact the pull request already disclosed 7, while the check proposed 3 for
// both — and nothing consumed those verdicts, so the inflated number was what would have been
// posted. Design §4.6 describes the pass but never said what its verdict DOES; this is that rule.

const verdict = (over: Partial<CheckVerdict> = {}): CheckVerdict => ({
  index: 0, verdict: 'confirmed', severity: 3, reason: 'r', evidence: [], ...over,
})

describe('selectForPosting: the check pass decides', () => {
  it('never posts a refuted finding, however severe the reviewer called it', () => {
    const f = finding({ severity: 9, title: 'refuted one' })
    const plan = selectForPosting({
      anchored: anchored([f]), settings: settingsWith(), previous: firstReview,
      check: { findings: [f], verdicts: [verdict({ verdict: 'refuted', severity: 1 })] },
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly).toEqual([])
    expect(plan.suppressed.map((x) => x.title)).toEqual(['refuted one'])
  })

  it('posts a confirmed finding at the check severity, so a downgrade drops it out of inline', () => {
    const f = finding({ severity: 9 })
    const plan = selectForPosting({
      anchored: anchored([f]), settings: settingsWith(), previous: firstReview,
      check: { findings: [f], verdicts: [verdict({ severity: 3 })] },
    })
    expect(plan.inline).toEqual([])
    expect(plan.summaryOnly.map((x) => x.severity)).toEqual([3])
  })

  it('posts an uncertain finding, at the check severity', () => {
    const f = finding({ severity: 2 })
    const plan = selectForPosting({
      anchored: anchored([f]), settings: settingsWith(), previous: firstReview,
      check: { findings: [f], verdicts: [verdict({ verdict: 'uncertain', severity: 7 })] },
    })
    expect(plan.inline.map((x) => x.finding.severity)).toEqual([7])
  })

  it('leaves a finding the check did not judge exactly as it was', () => {
    const judged = finding({ title: 'judged', severity: 9 })
    const unjudged = finding({ title: 'unjudged', severity: 6 })
    const plan = selectForPosting({
      anchored: anchored([judged, unjudged]), settings: settingsWith(), previous: firstReview,
      check: { findings: [judged], verdicts: [verdict({ verdict: 'refuted' })] },
    })
    expect(plan.inline.map((x) => x.finding.title)).toEqual(['unjudged'])
    expect(plan.inline.map((x) => x.finding.severity)).toEqual([6])
  })

  it('spends the inline cap on the worst finding AFTER the check has re-rated it', () => {
    const loud = finding({ title: 'loud', severity: 9 })
    const quiet = finding({ title: 'quiet', severity: 6 })
    const plan = selectForPosting({
      anchored: anchored([loud, quiet]),
      settings: settingsWith((d) => { d.report.maxInline = 1 }), previous: firstReview,
      check: { findings: [loud], verdicts: [verdict({ severity: 5 })] },
    })
    expect(plan.inline.map((x) => x.finding.title)).toEqual(['quiet'])
    expect(plan.summaryOnly.map((x) => x.title)).toEqual(['loud'])
  })

  it('matches a verdict to its finding by identity, not by position in the anchored list', () => {
    const first = finding({ title: 'first', severity: 8 })
    const second = finding({ title: 'second', severity: 8 })
    // The check judged them in the reviewer's order; anchoring hands them over in the other one.
    const plan = selectForPosting({
      anchored: anchored([second, first]), settings: settingsWith(), previous: firstReview,
      check: {
        findings: [first, second],
        verdicts: [verdict({ index: 0, verdict: 'refuted' }), verdict({ index: 1, severity: 8 })],
      },
    })
    expect(plan.inline.map((x) => x.finding.title)).toEqual(['second'])
    expect(plan.suppressed.map((x) => x.title)).toEqual(['first'])
  })

  it('ignores a verdict whose index is not a finding, rather than throwing', () => {
    const f = finding({ severity: 6 })
    const plan = selectForPosting({
      anchored: anchored([f]), settings: settingsWith(), previous: firstReview,
      check: { findings: [f], verdicts: [verdict({ index: 7, verdict: 'refuted' })] },
    })
    expect(plan.inline).toHaveLength(1)
  })

  it('counts a downgraded finding against the low-band cap, because the check made it a nit', () => {
    const findings = [1, 2, 3].map((n) => finding({ title: `n${n}`, severity: 9 }))
    const plan = selectForPosting({
      anchored: anchored(findings),
      settings: settingsWith((d) => { d.report.firstReviewLowBandCap = 2 }), previous: firstReview,
      check: {
        findings,
        verdicts: findings.map((_, i) => verdict({ index: i, severity: 1 })),
      },
    })
    expect(plan.summaryOnly).toHaveLength(2)
    expect(plan.suppressed).toHaveLength(1)
  })

  it('takes the more conservative verdict when two findings share an id', () => {
    // findingId is file+category+title, so a reviewer that reports the same title twice collides.
    const a = finding({ title: 'same', severity: 8 })
    const b = finding({ title: 'same', severity: 8, line: 200 })
    const plan = selectForPosting({
      anchored: anchored([a, b]), settings: settingsWith(), previous: firstReview,
      check: {
        findings: [a, b],
        verdicts: [verdict({ index: 0, severity: 8 }), verdict({ index: 1, verdict: 'refuted' })],
      },
    })
    expect(plan.inline).toEqual([])
    expect(plan.suppressed).toHaveLength(2)
  })
})

// Spec 0.2.0 §8.3, decision §14.17: the check pass of a multi-reviewer review marks a finding that
// repeats an earlier one, and that finding is not said.
describe('duplicatesIn', () => {
  const v = (index: number, duplicateOf?: number | null): CheckVerdict => ({
    index, verdict: 'confirmed', severity: 6, reason: 'r', evidence: [],
    ...(duplicateOf !== undefined && { duplicateOf }),
  })

  it('names, by position, each finding the check pass said repeats an earlier one', () => {
    const findings = [finding({ title: 'a' }), finding({ title: 'b' }), finding({ title: 'a, again' }), finding({ title: 'b, again' })]
    expect([...duplicatesIn({ findings, verdicts: [v(0, null), v(1, null), v(2, 0), v(3, 1)] })]).toEqual([2, 3])
  })

  // The case `verdictsById` cannot tell apart: two findings with one id. Position can.
  it('drops the second of two identical findings and keeps the first', () => {
    const same = finding()
    expect([...duplicatesIn({ findings: [same, { ...same }], verdicts: [v(0, null), v(1, 0)] })]).toEqual([1])
  })

  it('trusts no pointer that is not to an earlier finding, so a pair can never silence each other', () => {
    const findings = [finding(), finding(), finding()]
    // Each other, itself, a later one, out of range, negative, a fraction.
    const verdicts = [v(0, 1), v(1, 1), v(2, 2), { ...v(1), duplicateOf: 7 }, { ...v(2), duplicateOf: -1 }, { ...v(2), duplicateOf: 0.5 }]
    expect([...duplicatesIn({ findings, verdicts })]).toEqual([])
    // A verdict about a finding that is not in the list names nothing either.
    expect([...duplicatesIn({ findings, verdicts: [v(5, 0)] })]).toEqual([])
  })

  it('names nothing when no check pass ran, or when it was not asked', () => {
    expect(duplicatesIn(null).size).toBe(0)
    expect(duplicatesIn({ findings: [finding(), finding()], verdicts: [v(0), v(1)] }).size).toBe(0)
  })
})

// Criss, 2026-10-15: which findings repeat a comment an earlier review left open.
describe('repeatsIn', () => {
  const v = (index: number, repeats?: number | null, verdict: CheckVerdict['verdict'] = 'confirmed'): CheckVerdict => ({
    index, verdict, severity: 6, reason: 'r', evidence: [], ...(repeats !== undefined && { repeats }),
  })
  const findings = [finding({ title: 'a' }), finding({ title: 'b' }), finding({ title: 'c' })]

  it('maps each finding the check pass linked to the earlier comment it repeats', () => {
    expect([...repeatsIn({ findings, verdicts: [v(0, 1), v(1, null), v(2, 0, 'uncertain')] }, 2)]).toEqual([[0, 1], [2, 0]])
  })

  // A refuted finding is said nowhere, so it may not tell an earlier comment its defect is still there
  // — and through `findingId`, it would otherwise carry its twin onto that comment with it.
  it('takes no link from a finding the check pass refuted', () => {
    expect(repeatsIn({ findings, verdicts: [v(0, 0, 'refuted')] }, 2).size).toBe(0)
  })

  it('trusts no link outside the list the pass was shown, nor one about a finding that is not there', () => {
    const verdicts = [v(0, 2), v(1, -1), { ...v(2), repeats: 0.5 }, v(7, 0)]
    expect(repeatsIn({ findings, verdicts }, 2).size).toBe(0)
  })

  it('names nothing when no check pass ran, or it was shown nothing earlier', () => {
    expect(repeatsIn(null, 3).size).toBe(0)
    expect(repeatsIn({ findings, verdicts: [v(0), v(1)] }, 0).size).toBe(0)
  })
})

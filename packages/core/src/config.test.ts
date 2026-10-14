import { describe, expect, it } from 'vitest'
import { defaultDeploymentConfig, resolveSettings, skillSourceId } from './config'
import type { RepoConfig, ReviewRequest, SkillSource } from './config'

describe('defaultDeploymentConfig', () => {
  // Every value here is a product decision from design §3.1, not an implementation detail.
  // Asserted one by one rather than with toMatchSnapshot, because a snapshot is re-recorded by
  // anyone who runs vitest -u, and these are exactly the numbers that should require a
  // conversation before they move.
  it('is the table in design §3.1', () => {
    const c = defaultDeploymentConfig()

    expect(c.command).toBe('/review')
    expect(c.model).toBe('claude-opus-5')
    expect(c.effort).toBe('low')
    expect(c.autoReview).toBe('open+ready')
    expect(c.skills).toEqual([])

    expect(c.severity.bands).toEqual({ critical: 9, high: 7, medium: 4 })
    expect(c.severity.postInlineAtOrAbove).toBe(5)

    expect(c.report).toEqual({
      mode: 'inline+summary',
      maxInline: 15,
      maxFindings: 50,
      repeatNits: false,
      firstReviewLowBandCap: 3,
      checkRunName: 'review-agent',
      // Criss, 2026-09-14 (decision 5): a finished review with nothing at the gate concludes
      // `success`. null is the gate OFF, and off is the default, so installing the reviewer
      // cannot fail anyone's build.
      failAtOrAbove: null,
      // Criss, 2026-09-14 (decision 6): off, and a deployment turns it on when it is ready to gate.
      gateRequiresConfirmed: false,
    })
  })

  it('presets the three tiers from the measured numbers', () => {
    const c = defaultDeploymentConfig()
    expect(c.tiers.basic).toEqual({ agents: 1, effort: 'low', check: true, budgetUsd: 2 })
    expect(c.tiers.normal).toEqual({ agents: 1, effort: 'medium', check: true, budgetUsd: 3 })
    expect(c.tiers.thorough).toEqual({ agents: 3, effort: 'high', check: true, budgetUsd: 8 })
  })

  it('hands out a fresh object each call', () => {
    const a = defaultDeploymentConfig()
    a.report.maxInline = 1
    expect(defaultDeploymentConfig().report.maxInline).toBe(15)
  })

  it('leaves the disprove-it check pass ON for basic, which is where an unasked review lands', () => {
    // Criss, 2026-09-14 (decision 2). `basic` is the tier an automatic review and a bare /review
    // both resolve to, so this is the setting that decides whether a POSTED severity is the
    // check's or the reviewer's (design §4.6). $0.07-$0.58 a review at per-token API prices.
    expect(defaultDeploymentConfig().tiers.basic.check).toBe(true)
  })

  it('resolves check: true for a request that names no tier and no --check', () => {
    const s = resolveSettings({
      deployment: defaultDeploymentConfig(), repo: null,
      request: { repo: 'crissmoldovan/review-agent-proving-ground', pr: 1, headSha: '4f8e2a1' },
    })
    expect(s.tier).toBe('basic')
    expect(s.check).toBe(true)
  })

  it('still lets a request turn it off, because --skip-check is a flag people use', () => {
    const s = resolveSettings({
      deployment: defaultDeploymentConfig(), repo: null,
      request: {
        repo: 'crissmoldovan/review-agent-proving-ground', pr: 1, headSha: '4f8e2a1', check: false,
      },
    })
    expect(s.check).toBe(false)
  })

  it('does not move the basic budget: $2 target, $5 ceiling (Criss, decision 16)', () => {
    // The check pass runs on its own budget (CHECK_BUDGET_FRACTION in check-pass.ts), so turning
    // it on does not spend the review's. Pinned here so a later "the reviews cost more now"
    // instinct has to argue with a test.
    const b = defaultDeploymentConfig().tiers.basic
    expect(b.budgetUsd).toBe(2)
  })
})

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  repo: 'acme/widgets',
  pr: 9,
  headSha: 'a'.repeat(40),
  ...over,
})

const resolve = (repo: RepoConfig | null, over: Partial<ReviewRequest> = {}) =>
  resolveSettings({ deployment: defaultDeploymentConfig(), repo, request: request(over) })

describe('resolveSettings precedence', () => {
  it('falls back to the basic tier when the request names none', () => {
    const s = resolve(null)
    expect(s.tier).toBe('basic')
    expect(s.effort).toBe('low')
    expect(s.check).toBe(true)
    expect(s.multi).toBe(false)
    expect(s.model).toBe('claude-opus-5')
    expect(s.instructions).toBeNull()
    expect(s.brief).toBeNull()
    expect(s.droppedRequestKeys).toEqual([])
  })

  it('takes effort, check and multi from the tier the request named', () => {
    const s = resolve(null, { tier: 'thorough' })
    expect(s.effort).toBe('high')
    expect(s.check).toBe(true)
    expect(s.multi).toBe(true)
    expect(s.budget.targetUsd).toBe(8)
  })

  it('lets the request override the tier preset', () => {
    const s = resolve(null, { tier: 'basic', effort: 'max', check: true, model: 'claude-sonnet-5' })
    expect(s.effort).toBe('max')
    expect(s.check).toBe(true)
    expect(s.model).toBe('claude-sonnet-5')
    expect(s.droppedRequestKeys).toEqual([])
  })

  it('carries the repo instructions and the requester brief through', () => {
    const s = resolve({ instructions: 'Care about the migration order.' },
                      { brief: 'Look at the retry loop.' })
    expect(s.instructions).toBe('Care about the migration order.')
    expect(s.brief).toBe('Look at the retry loop.')
  })

  it('lets only the deployment decide whether the check run can fail a build', () => {
    expect(resolve(null).report.failAtOrAbove).toBeNull()
    const deployment = defaultDeploymentConfig()
    deployment.report.failAtOrAbove = 9
    // The reviewed repository has a say in how loud the review is and in nothing else: there is
    // no `failAtOrAbove` in RepoConfig, so a pull request cannot switch its own gate off.
    const s = resolveSettings({ deployment, repo: { mode: 'summary-only' }, request: request() })
    expect(s.report.failAtOrAbove).toBe(9)
  })

  it('lets only the deployment demand that the check pass confirmed a finding first', () => {
    expect(resolve(null).report.gateRequiresConfirmed).toBe(false)
    const deployment = defaultDeploymentConfig()
    deployment.report.failAtOrAbove = 8
    deployment.report.gateRequiresConfirmed = true
    const s = resolveSettings({ deployment, repo: { mode: 'summary-only' }, request: request() })
    expect(s.report.gateRequiresConfirmed).toBe(true)
    // Same reason as the threshold: RepoConfig has no such key, so a pull request cannot relax
    // the gate that is judging it.
  })
})

describe('resolveSettings: a request may lower cost, never raise it', () => {
  it('accepts a budget below the tier target and records nothing as dropped', () => {
    const s = resolve(null, { tier: 'normal', budgetUsd: 1.5 })
    expect(s.budget.targetUsd).toBe(1.5)
    expect(s.droppedRequestKeys).toEqual([])
  })

  it('refuses a budget above the tier target and says so', () => {
    const s = resolve(null, { tier: 'normal', budgetUsd: 25 })
    expect(s.budget.targetUsd).toBe(3)
    expect(s.droppedRequestKeys).toContain('budgetUsd')
  })

  it('refuses a nonsense budget', () => {
    for (const budgetUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = resolve(null, { tier: 'normal', budgetUsd })
      expect(s.budget.targetUsd).toBe(3)
      expect(s.droppedRequestKeys).toContain('budgetUsd')
    }
  })

  it('falls back to basic when the request names a tier that does not exist', () => {
    // ReviewRequest.tier is typed, but a request can be built by parsing "/review --tier turbo"
    // out of a pull request comment, so the runtime guard is real.
    const s = resolve(null, { tier: 'turbo' as never })
    expect(s.tier).toBe('basic')
    expect(s.droppedRequestKeys).toContain('tier')
  })
})

describe('resolveSettings: the repo file may tighten, never loosen', () => {
  // The repo's config is read from the base branch (design §7, Task 9b) but it is still written by
  // the people whose pull requests this tool judges. It may make the review stricter or quieter; it
  // may never make it louder or laxer.
  it('lets the repo raise the inline posting threshold', () => {
    const s = resolve({ postInlineAtOrAbove: 8 })
    expect(s.severity.postInlineAtOrAbove).toBe(8)
  })

  it('ignores a repo that tries to lower the inline posting threshold', () => {
    const s = resolve({ postInlineAtOrAbove: 1 })
    expect(s.severity.postInlineAtOrAbove).toBe(5)
  })

  it('lets the repo choose a quieter reporting mode', () => {
    expect(resolve({ mode: 'summary-only' }).report.mode).toBe('summary-only')
    expect(resolve({ mode: 'silent' }).report.mode).toBe('silent')
  })

  it('ignores a repo that tries to make a silent deployment speak', () => {
    const deployment = defaultDeploymentConfig()
    deployment.report.mode = 'silent'
    const s = resolveSettings({ deployment, repo: { mode: 'inline+summary' }, request: request() })
    expect(s.report.mode).toBe('silent')
  })
})

describe('resolveSettings: the check run has a name the deployment chooses', () => {
  // A deployment asked for this, and it is the last of the three interface requirements it
  // raised. The name is what GitHub shows on the pull request and what a branch protection
  // rule keys on, so a deployment that runs two reviewers — or a staging one beside production —
  // needs to tell them apart, and nobody can do that by editing the product's source.
  it('names it review-agent unless the deployment says otherwise', () => {
    expect(resolve(null).report.checkRunName).toBe('review-agent')
  })

  it('carries the name the deployment chose', () => {
    const deployment = defaultDeploymentConfig()
    deployment.report.checkRunName = 'review-agent (staging)'
    const s = resolveSettings({ deployment, repo: null, request: request() })
    expect(s.report.checkRunName).toBe('review-agent (staging)')
  })

  it('is untouched by a repo that quietens the report', () => {
    // The repo file may lower `mode`; resolveSettings rebuilds `report` around that decision, and
    // this is the assertion that it rebuilds the rest of the block rather than replacing it.
    const s = resolve({ mode: 'summary-only' })
    expect(s.report.mode).toBe('summary-only')
    expect(s.report.checkRunName).toBe('review-agent')
    expect(s.report.maxInline).toBe(15)
  })
})

const sources: SkillSource[] = [
  { kind: 'dir', path: '/opt/review-agent/skills/security-pass' },
  { kind: 'git', repo: 'crissmoldovan/review-skills', ref: 'v0.3.0', path: 'test-coverage' },
]

describe('skillSourceId', () => {
  it('names a directory by its path and a git source by repo, ref and path', () => {
    expect(skillSourceId(sources[0])).toBe('/opt/review-agent/skills/security-pass')
    expect(skillSourceId(sources[1])).toBe('crissmoldovan/review-skills@v0.3.0#test-coverage')
  })
})

describe('resolveSettings: skills come from the deployment only', () => {
  const withSkills = (repo: RepoConfig | null) => {
    const deployment = defaultDeploymentConfig()
    deployment.skills = sources
    return resolveSettings({ deployment, repo, request: request() })
  }

  it('gives a repo that selects nothing every source the deployment allows', () => {
    expect(withSkills(null).skills).toEqual(sources)
    expect(withSkills({ instructions: 'x' }).skills).toEqual(sources)
  })

  it('lets a repo select a subset, by full id or by short name', () => {
    expect(withSkills({ skills: ['security-pass'] }).skills).toEqual([sources[0]])
    expect(withSkills({ skills: ['crissmoldovan/review-skills@v0.3.0#test-coverage'] }).skills)
      .toEqual([sources[1]])
  })

  it('finds the short name of a Windows directory source, whose separator is a backslash', () => {
    // Spec 0.2.0 §9.3 P12. Split on `/` alone, `C:\…\security-pass` had one segment — the whole path —
    // so a repository on a Windows deployment could select it only by its full filesystem path.
    const deployment = defaultDeploymentConfig()
    deployment.skills = [{ kind: 'dir', path: 'C:\\review-agent\\skills\\security-pass' }]
    expect(resolveSettings({ deployment, repo: { skills: ['security-pass'] }, request: request() }).skills)
      .toEqual(deployment.skills)
  })

  it('drops a source the deployment never allowed', () => {
    // Design §4.7, measured: a skill planted in the repository under review was refused. The same
    // rule at the configuration layer — a repo may choose among the deployment's sources, and can
    // never add one, however it spells it.
    expect(withSkills({ skills: ['/tmp/evil', 'security-pass'] }).skills).toEqual([sources[0]])
    expect(withSkills({ skills: ['evil'] }).skills).toEqual([])
  })
})

describe('resolveSettings: added instructions keep their source', () => {
  it('keeps the deployment’s added instructions apart from the repo’s', () => {
    const deployment = defaultDeploymentConfig()
    deployment.instructions = 'This deployment reviews Terraform; open the modules a change touches.'
    const s = resolveSettings({
      deployment,
      repo: { instructions: 'Care about the migration order.' },
      request: request(),
    })
    expect(s.deploymentInstructions).toBe('This deployment reviews Terraform; open the modules a change touches.')
    expect(s.instructions).toBe('Care about the migration order.')
  })

  it('is null on both when neither layer added any', () => {
    const s = resolve(null)
    expect(s.deploymentInstructions).toBeNull()
    expect(s.instructions).toBeNull()
  })
})

import { budgetFor, roundUsd, type BudgetPolicy } from './budget'

export type Tier = 'basic' | 'normal' | 'thorough'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReportMode = 'inline+summary' | 'summary-only' | 'check-only' | 'silent'

/** Does a review in this mode write the summary comment?
 *
 *  One definition, in `core`, because two halves of the product turn on the answer and they must not
 *  drift apart: `publishReview` writes the marker and edits inline comments only in these two modes,
 *  and `runReview` refuses to BUY the re-review pass in the other two — a pass whose only two
 *  consumers are behind this test is a pass whose answer is thrown away, and it is not free
 *  (Criss, 2026-09-16). */
export const writesSummaryComment = (mode: ReportMode): boolean =>
  mode === 'inline+summary' || mode === 'summary-only'

export type SkillSource =
  | { kind: 'dir'; path: string }
  | { kind: 'git'; repo: string; ref: string; path?: string }

/** `agents` is not read since 0.2.0: how many reviewers run is the multi-reviewer mode's, asked for per
 *  request (`resolveSettings`). Kept so a deployment's own tier table still type-checks. */
export type TierSettings = { agents: number; effort: Effort; check: boolean; budgetUsd: number }
export type SeverityBands = { critical: number; high: number; medium: number }

export type DeploymentConfig = {
  command: string
  model: string
  effort: Effort
  tiers: Record<Tier, TierSettings>
  severity: { bands: SeverityBands; postInlineAtOrAbove: number }
  report: {
    mode: ReportMode
    maxInline: number // how many INLINE COMMENTS may be posted (Task 10b)
    maxFindings: number // how many FINDINGS the model may return (reviewJsonSchema, Task 12)
    repeatNits: boolean
    firstReviewLowBandCap: number
    /** The name GitHub shows on the check run this deployment writes — the last of the three
     *  interface requirements the product owed its first deployment (plan 2, Task 2).
     *  A setting rather than a constant for two reasons: a branch protection rule keys on this
     *  exact string, so an adopter who already gates on a name of their own must be able to keep
     *  it; and two deployments against the same repository — staging beside production, or a
     *  second reviewer — are indistinguishable on the pull request if they share a name. */
    checkRunName: string
    /** The severity at or above which the check run concludes `failure` instead of `success`.
     *  `null` is the gate off, and off is the default: a reviewer that fails builds on the day it
     *  is installed gets uninstalled. Deployment-only — `RepoConfig` has no equivalent, so a pull
     *  request cannot lower or lift its own gate.
     *  What it is compared against is the CHECK-ADJUSTED set: the disprove-it pass's severities,
     *  never a refuted finding (design §4.6, Criss 2026-09-14 decision 6). */
    failAtOrAbove: number | null
    /** Whether only a finding the disprove-it pass CONFIRMED may fail a build. Off by default;
     *  a deployment turns it on when it wants the gate that strict. With it on, an `uncertain`
     *  verdict reports but cannot gate.
     *  A deployment that turns this on while the tier's check pass is off has disarmed its own
     *  gate — nothing is ever confirmed — and the check run's output says so rather than pretending
     *  the gate is armed. */
    gateRequiresConfirmed: boolean
  }
  skills: SkillSource[]
  /** Extra review instructions from the deployment. Composed after the fixed safety rules by
   *  `reviewSystemPrompt` (design §4.7); it can never replace them. */
  instructions?: string
  autoReview: 'open+ready' | 'off'
  /** Whether a request may ask for the multi-reviewer mode (`--multi`, spec 0.2.0 §8.3). On by default:
   *  it is only ever on request — an automatic review never runs it — and in the App only from someone
   *  with push access, the gate every requested review already passes (decision §14.19). Off, a
   *  `--multi` is refused and named in the summary, and the review runs one reviewer. It costs roughly
   *  the tier's cost once per focus, so a deployment paying for every request may want it off. */
  allowMulti: boolean
}

export type RepoConfig = {
  instructions?: string
  postInlineAtOrAbove?: number
  mode?: ReportMode
  skills?: string[]
}

export type ReviewRequest = {
  repo: string
  pr: number
  headSha: string
  tier?: Tier
  multi?: boolean
  model?: string
  effort?: Effort
  check?: boolean
  brief?: string
  budgetUsd?: number
  requestedBy?: string
  requestId?: string
}

export type ResolvedSettings = {
  tier: Tier
  model: string
  effort: Effort
  check: boolean
  multi: boolean
  budget: BudgetPolicy
  report: DeploymentConfig['report']
  severity: DeploymentConfig['severity']
  skills: SkillSource[]
  deploymentInstructions: string | null // the deployment's added instructions (design §4.7)
  instructions: string | null // the reviewed repo's `.review-agent/review.md` (design §7)
  brief: string | null
  droppedRequestKeys: string[]
}

/** The built-in defaults: design §3.1's table, and §3's tier presets.
 *  `thorough` is ONE reviewer at `high` effort, in every way in (spec 0.2.0 §8.1, decision §14.1).
 *  It used to say `agents: 3` — the three lenses the two measured three-reviewer runs used — which
 *  made every `thorough` review record `multi: true` while one reviewer ran. Breadth is the separate
 *  multi-reviewer mode (§8.3), asked for on its own and combined with any tier. Its $8 target is
 *  unchanged and still unmeasured for one reviewer (§8.1): the measured three-reviewer runs cost
 *  $2.84 and $5.91 at per-token API prices (§8), so it is a target with headroom.
 *  `maxFindings` is not in the design text; it is the cap the findings schema puts on the model,
 *  50 being well above the 5 findings the most productive measured review returned, so it is a
 *  runaway guard and not a quality lever.
 *  `firstReviewLowBandCap` is not in the design text either; it is defined here as: the most
 *  findings below `severity.bands.medium` that the FIRST review of a pull request MENTIONS AT ALL —
 *  inline or in the summary. Later reviews mention none of them unless `report.repeatNits` is true.
 *  It bounds what a human has to read, not only where it appears: low-band findings are already kept
 *  out of inline comments by `postInlineAtOrAbove`, so a cap on inline alone would cap nothing.
 *  (Corrected 2026-09-13: this comment used to say "may post inline", which is not what report.ts
 *  does and would have invited someone to change the code to match it.)
 *  `packages/github/src/report.ts` (Task 10b) implements those two sentences and no other reading
 *  of them. */
export const defaultDeploymentConfig = (): DeploymentConfig => ({
  command: '/review',
  model: 'claude-opus-5',
  effort: 'low',
  tiers: {
    // Criss, 2026-09-14 (decision 2): the disprove-it pass is ON here, not only in `normal` and
    // `thorough`. `basic` is where an automatic review and a bare `/review` land, so with the pass
    // off the product would post the REVIEWER's severities and read no verdict at all — the defect
    // design §4.6 was written after. §4.6: "cheap enough to leave on wherever findings are posted".
    // $0.07-$0.58 a review at per-token API prices (measured, design §8), or the same figure drawn
    // from the subscription allowance when the credential is a subscription token. `budgetUsd` does
    // NOT move (decision 16): the check pass has its own budget, a quarter of this target.
    basic: { agents: 1, effort: 'low', check: true, budgetUsd: 2 },
    normal: { agents: 1, effort: 'medium', check: true, budgetUsd: 3 },
    thorough: { agents: 1, effort: 'high', check: true, budgetUsd: 8 },
  },
  severity: { bands: { critical: 9, high: 7, medium: 4 }, postInlineAtOrAbove: 5 },
  report: {
    mode: 'inline+summary',
    maxInline: 15,
    maxFindings: 50,
    repeatNits: false,
    firstReviewLowBandCap: 3,
    checkRunName: 'review-agent',
    failAtOrAbove: null,
    gateRequiresConfirmed: false,
  },
  skills: [],
  autoReview: 'open+ready',
  allowMulti: true,
})

/** The string a repo writes in `.review-agent/review.md` to select a source the deployment already
 *  allows, and the key Task 5b caches a materialised source under. `SkillSource` carries no name,
 *  so the id is derived from what identifies it: a directory is its path; a git source is repo,
 *  ref and sub-path. */
export const skillSourceId = (s: SkillSource): string =>
  s.kind === 'dir' ? s.path : `${s.repo}@${s.ref}${s.path === undefined ? '' : `#${s.path}`}`

/** The last path segment of an id, so a repo can write "security-pass" rather than a full
 *  filesystem path. Ambiguous when two sources end in the same segment; a deployment that allows
 *  two such sources has named them badly. Split on either separator (spec 0.2.0 §9.3 P12): a `dir`
 *  source on Windows is `C:\skills\security-pass`, whose short name is still `security-pass`. */
const shortSkillName = (id: string): string => {
  const head = id.split(/[@#]/)[0] ?? id
  const segments = head.split(/[\\/]/).filter((p) => p.length > 0)
  return segments[segments.length - 1] ?? id
}

const selectSkills = (allowed: SkillSource[], wanted: string[] | undefined): SkillSource[] => {
  if (wanted === undefined) return allowed
  return allowed.filter((s) => {
    const id = skillSourceId(s)
    return wanted.some((w) => w === id || w === shortSkillName(id))
  })
}

const TIERS: readonly Tier[] = ['basic', 'normal', 'thorough']

/** How loud each mode is. A repo may move down this ladder, never up. */
const LOUDNESS: Record<ReportMode, number> = {
  silent: 0,
  'check-only': 1,
  'summary-only': 2,
  'inline+summary': 3,
}

export const resolveSettings = (a: {
  deployment: DeploymentConfig
  repo: RepoConfig | null
  request: ReviewRequest
}): ResolvedSettings => {
  const { deployment, repo, request } = a
  const droppedRequestKeys: string[] = []
  const builtIn = defaultDeploymentConfig()

  const asked = request.tier
  const tier: Tier = asked !== undefined && TIERS.includes(asked) ? asked : 'basic'
  if (asked !== undefined && asked !== tier) droppedRequestKeys.push('tier')

  // `tiers` can come from a deployment's own JSON, so a missing tier or a missing field falls back
  // to the built-in preset rather than throwing at review time.
  const tierSettings = deployment.tiers?.[tier] ?? builtIn.tiers[tier]

  const model = request.model ?? deployment.model
  const effort = request.effort ?? tierSettings.effort ?? deployment.effort
  const check = request.check ?? tierSettings.check
  // Asked for, never configured (spec 0.2.0 §14.16 and §14.19). It used to fall back to the tier's
  // `agents > 1`, which cost nothing while nothing ran several reviewers; since 0.2.0 it runs them, and
  // that fallback would let a deployment's tier table turn an AUTOMATIC review — and a bare
  // `--tier` — into one that costs three, which decision §14.19 took (a) to rule out. `agents` is
  // read by nothing now; it stays in `TierSettings` so a deployment's existing table still parses.
  // And only where the deployment allows it (§14.19). Every doorway refuses a disallowed `--multi`
  // before it gets here, in words of its own (`refuseUnbuilt`); this is the same rule for a caller that
  // reaches `runReview` past every doorway, and it is named like any other key the deployment refused.
  const multiAllowed = deployment.allowMulti !== false
  const multi = request.multi === true && multiAllowed
  if (request.multi === true && !multiAllowed) droppedRequestKeys.push('multi')

  const budget = budgetFor(tierSettings, request.budgetUsd)
  if (request.budgetUsd !== undefined && budget.targetUsd !== roundUsd(request.budgetUsd)) {
    droppedRequestKeys.push('budgetUsd')
  }

  return {
    tier,
    model,
    effort,
    check,
    multi,
    budget,
    report: {
      ...deployment.report,
      mode:
        repo?.mode !== undefined && LOUDNESS[repo.mode] < LOUDNESS[deployment.report.mode]
          ? repo.mode
          : deployment.report.mode,
    },
    severity: {
      bands: { ...deployment.severity.bands },
      postInlineAtOrAbove: Math.max(
        deployment.severity.postInlineAtOrAbove,
        repo?.postInlineAtOrAbove ?? Number.NEGATIVE_INFINITY,
      ),
    },
    skills: selectSkills(deployment.skills, repo?.skills),
    deploymentInstructions: deployment.instructions ?? null,
    instructions: repo?.instructions ?? null,
    brief: request.brief ?? null,
    droppedRequestKeys,
  }
}

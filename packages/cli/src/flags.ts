import type { Effort, Tier } from '@review-agent/core'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

const TIERS: readonly Tier[] = ['basic', 'normal', 'thorough']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ReviewFlags = {
  repo?: string; pr?: string; tier?: string; model?: string; effort?: string
  check?: boolean; skipCheck?: boolean; brief?: string; budget?: string; post?: boolean; json?: boolean
}
export type ValidatedFlags = {
  owner: string; repo: string; pr: number
  tier?: Tier; model?: string; effort?: Effort; check?: boolean
  brief?: string; budgetUsd?: number; json: boolean
}

export const parseFlags = (f: ReviewFlags): ValidatedFlags => {
  // Checked first, on purpose: somebody who typed --post wants to know that it will not post before
  // they are told their repo string is malformed.
  if (f.post === true) {
    throw new UsageError(
      '--post is not implemented in this version: posting a review needs the App installation ' +
      'credentials, which the `app` package owns (sub-project 2). Run without --post, or use --json ' +
      'and post from your own tooling.',
    )
  }
  if (f.repo === undefined) throw new UsageError('--repo is required, as owner/name')
  const parts = f.repo.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new UsageError(`--repo must be owner/name, got ${JSON.stringify(f.repo)}`)
  }
  if (f.pr === undefined) throw new UsageError('--pr is required')
  const pr = Number(f.pr)
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new UsageError(`--pr must be a positive whole number, got ${JSON.stringify(f.pr)}`)
  }

  let tier: Tier | undefined
  if (f.tier !== undefined) {
    if (!(TIERS as readonly string[]).includes(f.tier)) {
      throw new UsageError(`--tier must be one of ${TIERS.join(', ')}, got ${JSON.stringify(f.tier)}`)
    }
    tier = f.tier as Tier
  }
  let effort: Effort | undefined
  if (f.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(f.effort)) {
      throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(f.effort)}`)
    }
    effort = f.effort as Effort
  }
  let budgetUsd: number | undefined
  if (f.budget !== undefined) {
    budgetUsd = Number(f.budget)
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new UsageError(`--budget must be a positive number of dollars, got ${JSON.stringify(f.budget)}`)
    }
  }
  if (f.check === true && f.skipCheck === true) {
    throw new UsageError('--check and --skip-check contradict each other')
  }
  const check = f.check === true ? true : f.skipCheck === true ? false : undefined

  return {
    owner: parts[0], repo: parts[1], pr,
    ...(tier !== undefined && { tier }),
    ...(f.model !== undefined && { model: f.model }),
    ...(effort !== undefined && { effort }),
    ...(check !== undefined && { check }),
    ...(f.brief !== undefined && { brief: f.brief }),
    ...(budgetUsd !== undefined && { budgetUsd }),
    json: f.json === true,
  }
}

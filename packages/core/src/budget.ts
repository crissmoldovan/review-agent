import type { TierSettings } from './config'

export type BudgetPolicy = {
  targetUsd: number
  wrapUpAtUsd: number
  ceilingUsd: number
}

/** Money, to whole cents. Exported because `resolveSettings` compares a requested budget
 *  against the resolved one and must round it the same way. */
export const roundUsd = (n: number): number => Math.round(n * 100) / 100

export const budgetFor = (tier: TierSettings, requestBudgetUsd?: number): BudgetPolicy => {
  const tierTarget = roundUsd(tier.budgetUsd)
  const asked = requestBudgetUsd === undefined ? null : roundUsd(requestBudgetUsd)

  // A request may only lower. Anything that is not a positive, finite number below the tier's
  // target is ignored in silence here; `resolveSettings` compares this result against what was
  // asked for and puts "budgetUsd" in `droppedRequestKeys` so the requester is told.
  const targetUsd =
    asked !== null && Number.isFinite(asked) && asked > 0 && asked < tierTarget ? asked : tierTarget

  return {
    targetUsd,
    wrapUpAtUsd: roundUsd(targetUsd * 0.7),
    ceilingUsd: roundUsd(targetUsd * 2.5),
  }
}

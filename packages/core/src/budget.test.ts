import { describe, expect, it } from 'vitest'
import { budgetFor, roundUsd } from './budget'
import type { TierSettings } from './config'

const tier = (budgetUsd: number): TierSettings => ({
  agents: 1,
  effort: 'low',
  check: false,
  budgetUsd,
})

describe('budgetFor', () => {
  // Written with toBe, not toBeCloseTo, on purpose. 3 * 0.7 is 2.0999999999999996 in IEEE-754
  // and 8 * 0.7 is 5.6000000000000005, so an unrounded implementation passes toBeCloseTo and
  // then prints "$2.0999999999999996" in a pull request comment. toBe forces the rounding to
  // whole cents to be real.
  it('sets the wrap-up at 70% and the ceiling at 2.5x, in whole cents', () => {
    expect(budgetFor(tier(2))).toEqual({ targetUsd: 2, wrapUpAtUsd: 1.4, ceilingUsd: 5 })
    expect(budgetFor(tier(3))).toEqual({ targetUsd: 3, wrapUpAtUsd: 2.1, ceilingUsd: 7.5 })
    expect(budgetFor(tier(8))).toEqual({ targetUsd: 8, wrapUpAtUsd: 5.6, ceilingUsd: 20 })
  })
})

describe('budgetFor: a request may lower the target, never raise it', () => {
  // A budget is the deployment's money (design §7: budgets "belong to whoever pays for the
  // run"). A requester may spend less of it; a comment on a pull request may not spend more.
  it('takes a request below the tier target', () => {
    expect(budgetFor(tier(3), 1.5)).toEqual({
      targetUsd: 1.5,
      wrapUpAtUsd: 1.05,
      ceilingUsd: 3.75,
    })
  })

  it('ignores a request above the tier target', () => {
    expect(budgetFor(tier(3), 25).targetUsd).toBe(3)
    expect(budgetFor(tier(3), 3.01).targetUsd).toBe(3)
  })

  it('treats a request equal to the tier target as no change', () => {
    expect(budgetFor(tier(3), 3)).toEqual(budgetFor(tier(3)))
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores the nonsense budget %s',
    (asked) => {
      expect(budgetFor(tier(3), asked).targetUsd).toBe(3)
    },
  )

  it('scales the wrap-up and ceiling to the lowered target, not the tier', () => {
    const lowered = budgetFor(tier(8), 2)
    expect(lowered.wrapUpAtUsd).toBe(1.4)
    expect(lowered.ceilingUsd).toBe(5)
  })
})

describe('roundUsd', () => {
  it('rounds to whole cents', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3)
    expect(roundUsd(1.2494105)).toBe(1.25) // the cost of a recorded Opus-low review
    expect(roundUsd(2.0999999999999996)).toBe(2.1)
    expect(roundUsd(0.005)).toBe(0.01)
    expect(roundUsd(0)).toBe(0)
  })
})

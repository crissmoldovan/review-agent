import { describe, expect, it } from 'vitest'
import { MULTI_REFUSED, THOROUGH_REFUSED, refuseUnbuilt } from './refusals'

describe('refuseUnbuilt (Criss, decision 4)', () => {
  it('drops --multi and names it, until the multi-reviewer mode is built', () => {
    const got = refuseUnbuilt({ multi: true, check: true, budgetUsd: 1.5 })
    expect(got.request).toEqual({ check: true, budgetUsd: 1.5 })
    expect(got.refused).toEqual([MULTI_REFUSED])
    expect(MULTI_REFUSED).toBe('`--multi` — the multi-reviewer fan-out is not built yet, so one reviewer ran.')
  })

  it('honours a thorough tier, which is one reviewer at high effort in every way in (spec 0.2.0 §14.1)', () => {
    // It used to be dropped with `multi`, and the review ran at the default tier. Now it buys exactly
    // what it says, so nothing about it is refused.
    expect(refuseUnbuilt({ tier: 'thorough' })).toEqual({ request: { tier: 'thorough' }, refused: [] })
    expect(refuseUnbuilt({ tier: 'thorough', multi: true })).toEqual({ request: { tier: 'thorough' }, refused: [MULTI_REFUSED] })
  })

  it('takes `multi: false` off the request too, saying nothing, because there is nothing to refuse', () => {
    expect(refuseUnbuilt({ multi: false, tier: 'normal' })).toEqual({ request: { tier: 'normal' }, refused: [] })
  })

  it('keeps the old thorough sentence exported, word for word, for code that imported it', () => {
    expect(THOROUGH_REFUSED).toBe('`--tier thorough` — the multi-reviewer fan-out is not built yet, so this review ran at the deployment’s default tier.')
  })
})

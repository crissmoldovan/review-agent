import { describe, expect, it } from 'vitest'
import { MULTI_REFUSED, MULTI_REFUSED_AUTOMATIC, THOROUGH_REFUSED, refuseUnbuilt } from './refusals'

describe('refuseUnbuilt (Criss, decision 4; spec 0.2.0 §14.19)', () => {
  it('honours --multi now that the multi-reviewer mode is built (spec 0.2.0 §8.3)', () => {
    const got = refuseUnbuilt({ multi: true, check: true, budgetUsd: 1.5 })
    expect(got).toEqual({ request: { multi: true, check: true, budgetUsd: 1.5 }, refused: [] })
    expect(refuseUnbuilt({ multi: true }, { allowMulti: true })).toEqual({ request: { multi: true }, refused: [] })
  })

  it('refuses --multi a deployment switched off, names it, and keeps everything else', () => {
    const got = refuseUnbuilt({ multi: true, tier: 'normal', check: true }, { allowMulti: false })
    expect(got.request).toEqual({ tier: 'normal', check: true })
    expect(got.refused).toEqual([MULTI_REFUSED])
    expect(MULTI_REFUSED).toBe('`--multi` — this deployment does not run several reviewers on one review, so one reviewer ran.')
  })

  // Decision §14.19: never automatic. No doorway puts `multi` on an automatic review; a payload built
  // by hand can, and it costs three reviews on nobody's say-so.
  it('refuses multi on an automatic review, whatever the deployment allows, and names it', () => {
    for (const allowMulti of [true, false]) {
      const got = refuseUnbuilt({ multi: true, tier: 'basic' }, { allowMulti, automatic: true })
      expect(got).toEqual({ request: { tier: 'basic' }, refused: [MULTI_REFUSED_AUTOMATIC] })
    }
    expect(MULTI_REFUSED_AUTOMATIC).toContain('nobody asked for this review')
  })

  it('honours a thorough tier, which is one reviewer at high effort in every way in (spec 0.2.0 §14.1)', () => {
    // It used to be dropped with `multi`, and the review ran at the default tier. Now it buys exactly
    // what it says, so nothing about it is refused — and it combines with --multi (§14.16).
    expect(refuseUnbuilt({ tier: 'thorough' })).toEqual({ request: { tier: 'thorough' }, refused: [] })
    expect(refuseUnbuilt({ tier: 'thorough', multi: true })).toEqual({ request: { tier: 'thorough', multi: true }, refused: [] })
  })

  it('takes `multi: false` off the request, saying nothing, because there is nothing to refuse', () => {
    expect(refuseUnbuilt({ multi: false, tier: 'normal' })).toEqual({ request: { tier: 'normal' }, refused: [] })
    expect(refuseUnbuilt({ multi: false }, { allowMulti: false, automatic: true })).toEqual({ request: {}, refused: [] })
  })

  it('keeps the old thorough sentence exported, word for word, for code that imported it', () => {
    expect(THOROUGH_REFUSED).toBe('`--tier thorough` — the multi-reviewer fan-out is not built yet, so this review ran at the deployment’s default tier.')
  })
})

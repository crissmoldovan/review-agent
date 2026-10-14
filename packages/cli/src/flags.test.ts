import { describe, expect, it } from 'vitest'
import { parseFlags, UsageError } from './flags'

describe('parseFlags', () => {
  it('splits owner/name and parses the PR number', () => {
    expect(parseFlags({ repo: 'acme/widgets', pr: '16' })).toEqual({
      owner: 'acme', repo: 'widgets', pr: 16, json: false,
    })
  })

  it('refuses a repo that is not owner/name', () => {
    expect(() => parseFlags({ repo: 'widgets', pr: '16' })).toThrow(UsageError)
    expect(() => parseFlags({ repo: 'a/b/c', pr: '16' })).toThrow('--repo must be owner/name')
  })

  it('refuses a missing or non-numeric PR', () => {
    expect(() => parseFlags({ repo: 'a/b' })).toThrow('--pr is required')
    expect(() => parseFlags({ repo: 'a/b', pr: 'nine' })).toThrow('--pr must be a positive whole number')
    expect(() => parseFlags({ repo: 'a/b', pr: '0' })).toThrow('--pr must be a positive whole number')
  })

  it('accepts the known tiers and efforts and refuses anything else', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1', tier: 'thorough' }).tier).toBe('thorough')
    expect(parseFlags({ repo: 'a/b', pr: '1', effort: 'xhigh' }).effort).toBe('xhigh')
    expect(() => parseFlags({ repo: 'a/b', pr: '1', tier: 'deep' }))
      .toThrow('--tier must be one of basic, normal, thorough')
    expect(() => parseFlags({ repo: 'a/b', pr: '1', effort: 'ultra' }))
      .toThrow('--effort must be one of low, medium, high, xhigh, max')
  })

  it('reads --budget as dollars and refuses a nonsense one', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1', budget: '1.5' }).budgetUsd).toBe(1.5)
    expect(() => parseFlags({ repo: 'a/b', pr: '1', budget: '-1' }))
      .toThrow('--budget must be a positive number of dollars')
  })

  // Three states, not two: `undefined` means "take the tier's setting" and is the common case.
  it('leaves check undefined unless asked, and refuses both at once', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1' }).check).toBeUndefined()
    expect(parseFlags({ repo: 'a/b', pr: '1', check: true }).check).toBe(true)
    expect(parseFlags({ repo: 'a/b', pr: '1', skipCheck: true }).check).toBe(false)
    expect(() => parseFlags({ repo: 'a/b', pr: '1', check: true, skipCheck: true }))
      .toThrow('--check and --skip-check contradict each other')
  })

  it('refuses --post and says which sub-project owns posting', () => {
    expect(() => parseFlags({ repo: 'a/b', pr: '1', post: true }))
      .toThrow('--post is not implemented in this version')
    expect(() => parseFlags({ repo: 'a/b', pr: '1', post: true }))
      .toThrow('sub-project 2')
  })
})

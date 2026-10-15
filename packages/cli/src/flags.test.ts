import { describe, expect, it } from 'vitest'
import { apiBaseUrlFor, parseFlags, parseGitHubHost, UsageError } from './flags'

describe('parseFlags', () => {
  it('splits owner/name and parses the PR number, with every other setting at its default', () => {
    expect(parseFlags({ repo: 'acme/widgets', pr: '16' })).toEqual({
      owner: 'acme', repo: 'widgets', pr: 16, json: false,
      post: false, report: 'auto', reReview: false, host: 'github.com', keepCheckout: false, yes: false, multi: false,
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

  it('carries --multi, --keep-checkout and --yes through', () => {
    const f = parseFlags({ repo: 'a/b', pr: '1', multi: true, keepCheckout: true, yes: true })
    expect([f.multi, f.keepCheckout, f.yes]).toEqual([true, true, true])
  })
})

// Spec 0.2.0 §5.2.
describe('parseFlags: posting', () => {
  it('posts only when asked', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1' }).post).toBe(false)
    expect(parseFlags({ repo: 'a/b', pr: '1', post: true }).post).toBe(true)
  })

  it('reads --report as the CLI spells it, `status` being a commit status', () => {
    const report = (r: string) => parseFlags({ repo: 'a/b', pr: '1', post: true, report: r }).report
    expect(report('auto')).toBe('auto')
    expect(report('check-run')).toBe('check-run')
    expect(report('status')).toBe('commit-status')
    expect(report('none')).toBe('none')
    expect(parseFlags({ repo: 'a/b', pr: '1', post: true }).report).toBe('auto')
    expect(() => report('commit-status')).toThrow('--report must be one of auto, check-run, status, none')
    // Not an object's own property, so not a report kind either.
    expect(() => report('toString')).toThrow('--report must be one of')
  })

  it('re-reviews by default when posting, unless told not to', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1', post: true }).reReview).toBe(true)
    expect(parseFlags({ repo: 'a/b', pr: '1', post: true, reReview: true }).reReview).toBe(true)
    expect(parseFlags({ repo: 'a/b', pr: '1', post: true, reReview: false }).reReview).toBe(false)
  })

  it('never re-reviews a review that only prints', () => {
    expect(parseFlags({ repo: 'a/b', pr: '1' }).reReview).toBe(false)
    expect(parseFlags({ repo: 'a/b', pr: '1', reReview: false }).reReview).toBe(false)
  })

  it('refuses a posting flag that would do nothing without --post, rather than ignoring it', () => {
    expect(() => parseFlags({ repo: 'a/b', pr: '1', report: 'status' })).toThrow('add --post, or leave it out')
    expect(() => parseFlags({ repo: 'a/b', pr: '1', reReview: true })).toThrow('add --post, or leave it out')
    // --yes is not one of them: a script that always passes it is not wrong.
    expect(parseFlags({ repo: 'a/b', pr: '1', yes: true }).yes).toBe(true)
  })
})

describe('--github-host', () => {
  it('is github.com unless named, and GitHub Enterprise Server’s /api/v3 when named', () => {
    expect(parseGitHubHost(undefined)).toBe('github.com')
    expect(apiBaseUrlFor('github.com')).toBeUndefined()
    expect(parseGitHubHost('GitHub.Example.com')).toBe('github.example.com')
    expect(apiBaseUrlFor('github.example.com')).toBe('https://github.example.com/api/v3')
    expect(parseFlags({ repo: 'a/b', pr: '1', githubHost: 'ghe.example.com:8443' }).host).toBe('ghe.example.com:8443')
  })

  it('refuses anything that is not a host name, so it never becomes a URL nobody meant', () => {
    for (const bad of ['https://github.example.com', 'github.example.com/api', 'user@github.example.com', '', '-x.example', 'a b']) {
      expect(() => parseGitHubHost(bad)).toThrow('--github-host must be a host name')
    }
  })
})

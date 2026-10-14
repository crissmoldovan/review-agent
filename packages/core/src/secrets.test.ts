import { describe, expect, it } from 'vitest'
import { assertNoSecrets, scanForSecrets, SecretLeak } from './secrets'
import type { ReviewOutput } from './findings'

describe('scanForSecrets', () => {
  it('catches a GitHub token', () => {
    const hits = scanForSecrets('the workflow used ghp_' + 'A'.repeat(36) + ' directly')
    expect(hits).toEqual([{ pattern: 'github-token', where: 'line 1' }])
  })

  it('catches an Anthropic API key', () => {
    const hits = scanForSecrets('ANTHROPIC_API_KEY=sk-ant-api03-' + 'b'.repeat(40))
    expect(hits.map((h) => h.pattern)).toEqual(['anthropic-key'])
  })

  // Added 2026-09-13 after a security review of the archive audit: npm's own access tokens were not
  // covered, so a literal token under a key npm ignores (`_AUTHTOKEN`) or embedded in a registry URL
  // survived as real secret material in the checkout. npm prints them as `npm_` + 36 characters.
  it('catches an npm access token', () => {
    const hits = scanForSecrets('registry=https://u:npm_' + 'c'.repeat(36) + '@registry.npmjs.org/')
    expect(hits.map((h) => h.pattern)).toEqual(['npm-token'])
  })

  it('does not fire on the word npm_ in prose, or on a short npm_ identifier', () => {
    expect(scanForSecrets('set npm_config_registry before install; npm_package_version is 1.0.0')).toEqual([])
  })

  it('catches a PEM private key block', () => {
    const text = ['intro', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEow…', '-----END RSA PRIVATE KEY-----'].join('\n')
    expect(scanForSecrets(text)).toEqual([{ pattern: 'private-key', where: 'line 2' }])
  })

  // The expensive failure is the false positive, not the false negative: a hit refuses the whole
  // review (CLI exit 3), and a reviewer quotes code and identifiers all day long. Every one of
  // these strings is the kind of line the measured review outputs carried.
  it('does not fire on ordinary review prose', () => {
    const prose = [
      'The token is read from `secrets.GITHUB_TOKEN` and never logged.',
      'See scripts/upload-report.sh:49 — `[ "$attempt" -lt 3 ]`.',
      'This is a private key rotation runbook, not a key.',
      'commit cbb6c4d9f1a2b3c4d5e6f708192a3b4c5d6e7f80 introduced the check.',
      'sk-ant is the prefix Anthropic uses; do not commit one.',
      'ghp_ tokens are 40 characters long.',
    ].join('\n')
    expect(scanForSecrets(prose)).toEqual([])
  })
})

const review = (over: Partial<ReviewOutput> = {}): ReviewOutput => ({
  summary: 'The PR adds a cache in front of the price lookup.',
  intent: { verdict: 'matches', note: 'Both claimed changes are present.' },
  findings: [],
  inconclusive: [],
  ...over,
})

const finding = (over = {}) => ({
  file: 'a.ts', line: 1, endLine: null, severity: 5, category: 'correctness' as const,
  title: 't', explanation: 'e', evidence: ['a.ts:1'], suggestion: null, ...over,
})

describe('assertNoSecrets', () => {
  it('passes a clean review', () => {
    expect(() => assertNoSecrets(review({ findings: [finding()] }))).not.toThrow()
  })

  // Every field is a posting path: summary and intent.note go in the summary comment, a finding's
  // explanation and suggestion go inline, evidence is quoted verbatim. A scan that covered only
  // the summary would post the leak in a comment instead.
  it.each([
    ['summary', (t: string) => review({ summary: t })],
    ['intent.note', (t: string) => review({ intent: { verdict: 'unclear', note: t } })],
    ['findings[0].explanation', (t: string) => review({ findings: [finding({ explanation: t })] })],
    ['findings[0].suggestion', (t: string) => review({ findings: [finding({ suggestion: t })] })],
    ['findings[0].evidence[0]', (t: string) => review({ findings: [finding({ evidence: [t] })] })],
    ['inconclusive[0].whatWouldSettleIt',
      (t: string) => review({ inconclusive: [{ question: 'q', whatWouldSettleIt: t }] })],
  ])('throws when a secret is in %s', (path, build) => {
    const token = 'ghp_' + 'A'.repeat(36)
    expect(() => assertNoSecrets(build(`leaked ${token} here`))).toThrow(SecretLeak)
    try {
      assertNoSecrets(build(`leaked ${token} here`))
    } catch (e) {
      const leak = e as SecretLeak
      expect(leak.hits[0]).toEqual({ pattern: 'github-token', where: `${path}:line 1` })
      // The message goes into logs, a check run, possibly a Slack alert. Putting the secret in it
      // would spread the leak while reporting it.
      expect(leak.message).not.toContain(token)
      expect(leak.message).toContain(path)
    }
  })
})

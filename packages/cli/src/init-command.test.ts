import { type AppManifest, type ConvertedApp, secret } from '@review-agent/app'
import { describe, expect, it } from 'vitest'
import { type InitDeps, runInitCommand } from './init-command'

const PLANTED_PEM = '-----BEGIN RSA PRIVATE KEY-----\nPLANTEDKEYMATERIAL\n-----END RSA PRIVATE KEY-----'
const PLANTED_WEBHOOK = 'planted-webhook-secret-9f2b'
const PLANTED_CLIENT = 'planted-client-secret-4a71'

const converted: ConvertedApp = {
  id: 1234567,
  slug: 'acme-reviewer',
  clientId: 'Iv23liEXAMPLE',
  permissions: { checks: 'write', pull_requests: 'write', contents: 'read', metadata: 'read', issues: 'read' },
  clientSecret: secret(PLANTED_CLIENT),
  webhookSecret: secret(PLANTED_WEBHOOK),
  pem: secret(PLANTED_PEM),
}

type Seen = { out: string[]; err: string[]; manifest: AppManifest | null; registrationUrl: string }

const depsFor = (seen: Seen): InitDeps => ({
  listenForManifestCode: async (i) => {
    seen.registrationUrl = i.registrationUrl
    seen.manifest = i.manifestFor('http://127.0.0.1:51234/callback')
    return { formUrl: 'http://127.0.0.1:51234', code: Promise.resolve('the-one-hour-code'), close: async () => {} }
  },
  convertManifest: async ({ code }) => {
    expect(code).toBe('the-one-hour-code')
    return converted
  },
  makeRequester: () => ({ request: async () => ({ data: null }) }),
  randomState: () => 'state-1234',
  stdout: (s) => seen.out.push(s),
  stderr: (s) => seen.err.push(s),
})

const blank = (): Seen => ({ out: [], err: [], manifest: null, registrationUrl: '' })

describe('review-agent init', () => {
  it('prints none of the three secrets GitHub just returned', async () => {
    const seen = blank()
    const code = await runInitCommand(
      { name: 'Acme Reviewer', url: 'https://reviewer.example.com', webhookUrl: 'https://reviewer.example.com/api/github/webhook' },
      depsFor(seen),
    )
    const printed = seen.out.join('') + seen.err.join('')
    expect(code).toBe(0)
    expect(printed).not.toContain('PLANTEDKEYMATERIAL')
    expect(printed).not.toContain(PLANTED_WEBHOOK)
    expect(printed).not.toContain(PLANTED_CLIENT)
    expect(printed).not.toContain('BEGIN RSA PRIVATE KEY')
  })

  it('tells the operator the five things only they can do, in order', async () => {
    const seen = blank()
    await runInitCommand(
      { name: 'Acme Reviewer', url: 'https://reviewer.example.com', webhookUrl: 'https://reviewer.example.com/api/github/webhook' },
      depsFor(seen),
    )
    const printed = seen.out.join('')
    expect(printed).toContain('Generate a private key')
    // Criss, 2026-09-14 (decision 11): GitHub's registration-time copies stay live until deleted.
    expect(printed).toContain('Delete the private key that was created with the registration')
    expect(printed).toContain('Delete the client secret that was created with the registration')
    expect(printed.indexOf('Generate a private key'))
      .toBeLessThan(printed.indexOf('Delete the private key that was created with the registration'))
    expect(printed).toContain('Webhook -> Secret')
    expect(printed).toContain('Install App')
    expect(printed).toContain('docs/deploying.md')
    // The non-secret identifiers are the whole point of printing anything at all.
    expect(printed).toContain('1234567')
    expect(printed).toContain('acme-reviewer')
    expect(printed).toContain('Iv23liEXAMPLE')
  })

  it('registers under an organisation when it is given one, and under the account otherwise', async () => {
    const org = blank()
    await runInitCommand(
      { name: 'Acme Reviewer', url: 'https://reviewer.example.com', webhookUrl: 'https://reviewer.example.com/api/github/webhook', org: 'acme' },
      depsFor(org),
    )
    expect(org.registrationUrl).toBe('https://github.com/organizations/acme/settings/apps/new?state=state-1234')

    const personal = blank()
    await runInitCommand(
      { name: 'Acme Reviewer', url: 'https://reviewer.example.com', webhookUrl: 'https://reviewer.example.com/api/github/webhook' },
      depsFor(personal),
    )
    expect(personal.registrationUrl).toBe('https://github.com/settings/apps/new?state=state-1234')
  })

  it('hands GitHub a read-only manifest pointed at the deployment webhook', async () => {
    const seen = blank()
    await runInitCommand(
      { name: 'Acme Reviewer', url: 'https://reviewer.example.com', webhookUrl: 'https://reviewer.example.com/api/github/webhook' },
      depsFor(seen),
    )
    expect(seen.manifest?.default_permissions.contents).toBe('read')
    expect(seen.manifest?.hook_attributes.url).toBe('https://reviewer.example.com/api/github/webhook')
    expect(seen.manifest?.redirect_url).toBe('http://127.0.0.1:51234/callback')
  })

  it('registers the App with its webhook off when asked to, for a test that needs no delivery', async () => {
    // Criss, 2026-09-14 (decision 9). Task 15's throwaway App.
    const seen = blank()
    await runInitCommand(
      {
        name: 'review-agent proving ground', url: 'https://github.com/crissmoldovan/review-agent',
        webhookUrl: 'https://example.invalid/no-deliveries', webhookInactive: true,
      },
      depsFor(seen),
    )
    expect(seen.manifest?.hook_attributes).toEqual({ url: 'https://example.invalid/no-deliveries', active: false })
  })

  it('exits 2 and names the flag when one is missing', async () => {
    const seen = blank()
    const code = await runInitCommand({ url: 'https://reviewer.example.com' }, depsFor(seen))
    expect(code).toBe(2)
    expect(seen.err.join('')).toContain('--name')
  })
})

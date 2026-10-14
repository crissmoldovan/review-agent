import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  ManifestConversionError,
  buildManifest,
  convertManifest,
  secret,
} from './manifest'

const input = {
  name: 'Acme Reviewer',
  url: 'https://reviewer.example.com',
  webhookUrl: 'https://reviewer.example.com/api/github/webhook',
  redirectUrl: 'http://127.0.0.1:51234/callback',
}

describe('the App manifest', () => {
  it('asks for exactly the five permissions design §5 lists', () => {
    expect(buildManifest(input).default_permissions).toEqual({
      checks: 'write', pull_requests: 'write', contents: 'read', metadata: 'read', issues: 'read',
    })
  })

  it('never asks for contents: write, however the permission set is edited', () => {
    const writes = Object.entries(buildManifest(input).default_permissions)
      .filter(([, level]) => level === 'write').map(([name]) => name).sort()
    expect(writes).toEqual(['checks', 'pull_requests'])
    expect(APP_PERMISSIONS.contents).toBe('read')
  })

  it('keeps issues: read, which is the only reason a /review comment ever arrives', () => {
    expect(buildManifest(input).default_permissions.issues).toBe('read')
  })

  it('subscribes to the three events the triggers of design §5 need', () => {
    expect(buildManifest(input).default_events).toEqual(['pull_request', 'issue_comment', 'check_run'])
    expect(APP_EVENTS).toContain('issue_comment')
  })

  it('sends GitHub the webhook URL, the redirect, and an App that is not listed publicly', () => {
    const m = buildManifest(input)
    expect(m.hook_attributes).toEqual({ url: 'https://reviewer.example.com/api/github/webhook', active: true })
    expect(m.redirect_url).toBe('http://127.0.0.1:51234/callback')
    expect(m.url).toBe('https://reviewer.example.com')
    expect(m.public).toBe(false)
  })

  it('registers the webhook switched off when asked, for an App that must receive no delivery', () => {
    // Criss, 2026-09-14 (decision 9): Task 15's throwaway App calls the job in process. Only an
    // explicit `false` turns it off; leaving the field out keeps a real deployment's webhook on.
    expect(buildManifest({ ...input, webhookActive: false }).hook_attributes.active).toBe(false)
    expect(buildManifest({ ...input, webhookActive: true }).hook_attributes.active).toBe(true)
  })
})

describe('a secret the conversion returns', () => {
  const pem = secret('-----BEGIN RSA PRIVATE KEY-----\nKEYMATERIAL\n-----END RSA PRIVATE KEY-----')

  it('prints as [redacted] in a template literal, a JSON dump and a string cast', () => {
    expect(`${pem}`).toBe('[redacted]')
    expect(JSON.stringify({ pem })).toBe('{"pem":"[redacted]"}')
    expect(String(pem)).toBe('[redacted]')
  })

  it('keeps the value out of the object, so an inspector cannot reach it either', () => {
    expect(Object.values(pem).some((v) => typeof v === 'string')).toBe(false)
    expect(inspect(pem)).not.toContain('KEYMATERIAL')
  })

  it('gives the value up only to a caller that asks for it by name', () => {
    expect(pem.reveal()).toContain('KEYMATERIAL')
  })
})

const response = {
  id: 1234567,
  slug: 'acme-reviewer',
  client_id: 'Iv23liEXAMPLE',
  client_secret: 'client-secret-value',
  webhook_secret: 'webhook-secret-value',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nKEYMATERIAL\n-----END RSA PRIVATE KEY-----',
  permissions: { checks: 'write', pull_requests: 'write', contents: 'read', metadata: 'read', issues: 'read' },
  events: ['pull_request', 'issue_comment', 'check_run'],
}

const requesterFor = (data: unknown) => ({
  request: async (route: string, params: { code: string }) => {
    expect(route).toBe('POST /app-manifests/{code}/conversions')
    expect(params.code).toBe('the-one-hour-code')
    return { data }
  },
})

describe('converting the one-hour code', () => {
  it('reads back the App id, the slug, the client id and the three secrets', async () => {
    const app = await convertManifest({ requester: requesterFor(response), code: 'the-one-hour-code' })
    expect(app.id).toBe(1234567)
    expect(app.slug).toBe('acme-reviewer')
    expect(app.clientId).toBe('Iv23liEXAMPLE')
    expect(app.pem.reveal()).toContain('KEYMATERIAL')
    expect(app.webhookSecret.reveal()).toBe('webhook-secret-value')
    expect(app.clientSecret.reveal()).toBe('client-secret-value')
  })

  it('carries nothing secret into a JSON dump of the whole App', async () => {
    const app = await convertManifest({ requester: requesterFor(response), code: 'the-one-hour-code' })
    const dumped = JSON.stringify(app)
    expect(dumped).not.toContain('KEYMATERIAL')
    expect(dumped).not.toContain('webhook-secret-value')
    expect(dumped).not.toContain('client-secret-value')
    expect(dumped).toContain('1234567')
  })

  it('refuses a registration that came back with more permission than it asked for', async () => {
    const wider = { ...response, permissions: { ...response.permissions, contents: 'write' } }
    await expect(convertManifest({ requester: requesterFor(wider), code: 'the-one-hour-code' }))
      .rejects.toThrow(ManifestConversionError)
  })

  it('refuses a registration that is not subscribed to issue_comment', async () => {
    const deaf = { ...response, events: ['pull_request', 'check_run'] }
    await expect(convertManifest({ requester: requesterFor(deaf), code: 'the-one-hour-code' }))
      .rejects.toThrow(/issue_comment/)
  })

  it('names the missing field rather than returning a half-built App', async () => {
    const noKey: Record<string, unknown> = { ...response }
    delete noKey.pem
    await expect(convertManifest({ requester: requesterFor(noKey), code: 'the-one-hour-code' }))
      .rejects.toThrow(/pem/)
  })
})

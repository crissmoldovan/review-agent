import { buildManifest } from '@review-agent/app'
import { describe, expect, it } from 'vitest'
import { listenForManifestCode } from './init-server'

const manifestFor = (redirectUrl: string) => buildManifest({
  name: 'Acme Reviewer',
  url: 'https://reviewer.example.com',
  webhookUrl: 'https://reviewer.example.com/api/github/webhook',
  redirectUrl,
})

const REGISTRATION = 'https://github.com/organizations/acme/settings/apps/new?state=state-1234'

describe('the page that posts the manifest, and the callback that catches the code', () => {
  it('serves a form aimed at the registration URL, carrying a read-only manifest', async () => {
    const listener = await listenForManifestCode({
      registrationUrl: REGISTRATION, state: 'state-1234', manifestFor, note: () => {},
    })
    const page = await fetch(listener.formUrl).then((r) => r.text())
    expect(page).toContain(`action="${REGISTRATION}"`)
    expect(page).toContain('name="manifest"')
    // The manifest is HTML-escaped inside the form value, so this is what read-only looks like on
    // the page the operator is about to post.
    expect(page).toContain('&quot;contents&quot;:&quot;read&quot;')
    expect(page).toContain('&quot;redirect_url&quot;:&quot;http://127.0.0.1:')
    await listener.close()
  })

  it('takes the code from a callback carrying the state it issued', async () => {
    const listener = await listenForManifestCode({
      registrationUrl: REGISTRATION, state: 'state-1234', manifestFor, note: () => {},
    })
    const answer = await fetch(`${listener.formUrl}/callback?code=abc123&state=state-1234`)
    expect(answer.status).toBe(200)
    expect(await listener.code).toBe('abc123')
    await listener.close()
  })

  it('refuses a callback carrying somebody else state, and keeps waiting', async () => {
    const listener = await listenForManifestCode({
      registrationUrl: REGISTRATION, state: 'state-1234', manifestFor, note: () => {},
    })
    const answer = await fetch(`${listener.formUrl}/callback?code=abc123&state=state-9999`)
    expect(answer.status).toBe(400)
    expect(await Promise.race([listener.code, Promise.resolve('still waiting')])).toBe('still waiting')
    await listener.close()
  })

  it('accepts a callback with no state at all, and says that is what happened', async () => {
    const notes: string[] = []
    const listener = await listenForManifestCode({
      registrationUrl: REGISTRATION, state: 'state-1234', manifestFor, note: (s) => notes.push(s),
    })
    await fetch(`${listener.formUrl}/callback?code=zz99`)
    expect(await listener.code).toBe('zz99')
    expect(notes).toContain('GitHub did not echo `state` on the redirect.')
    await listener.close()
  })

  it('stops waiting when the hour GitHub allows has run out', async () => {
    const listener = await listenForManifestCode({
      registrationUrl: REGISTRATION, state: 'state-1234', manifestFor, note: () => {}, timeoutMs: 5,
    })
    await expect(listener.code).rejects.toThrow(/one hour/)
    await listener.close()
  })
})

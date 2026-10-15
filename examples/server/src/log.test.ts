import { SecretValue } from '@review-agent/sdk'
import { describe, expect, it } from 'vitest'
import { createLogger, REDACTED, WITHHELD } from './log'

const KNOWN = 'a-webhook-secret-this-process-holds'

const capture = () => {
  const lines: string[] = []
  const log = createLogger({ secrets: () => [KNOWN], write: (l) => lines.push(l), now: () => new Date(0) })
  return { log, lines, last: () => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown> }
}

describe('createLogger', () => {
  it('writes one JSON object per line, with the time, the level and the message first', () => {
    const c = capture()
    c.log.info('review queued', { repo: 'acme/widgets', pr: 7 })
    expect(c.lines).toEqual(['{"time":"1970-01-01T00:00:00.000Z","level":"info","msg":"review queued","repo":"acme/widgets","pr":7}'])
  })

  it('replaces a secret it was told about, wherever it appears', () => {
    const c = capture()
    c.log.warn(`secret ${KNOWN} in the message`, { nested: { list: [`and ${KNOWN} here`] } })
    expect(c.lines[0]).not.toContain(KNOWN)
    expect(c.last()).toMatchObject({ msg: `secret ${REDACTED} in the message`, nested: { list: [`and ${REDACTED} here`] } })
  })

  it('withholds a string that matches a secret pattern it was never told about', () => {
    const c = capture()
    const token = `ghs_${'x'.repeat(36)}`
    c.log.error('review failed', { error: new Error(`Bad credentials ${token}`) })
    expect(c.lines[0]).not.toContain(token)
    expect(c.last()).toMatchObject({ error: { name: 'Error', message: WITHHELD } })
  })

  it('redacts a field named for a credential, and a SecretValue, whatever their text', () => {
    const c = capture()
    c.log.info('request', { authorization: 'token short', apiKey: new SecretValue('sk-not-matched'), wrapped: new SecretValue('plain') })
    expect(c.last()).toMatchObject({ authorization: REDACTED, apiKey: REDACTED, wrapped: REDACTED })
  })
})

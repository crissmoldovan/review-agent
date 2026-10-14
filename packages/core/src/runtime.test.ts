import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { credentialVariable, modelCredentialFromEnv, SecretValue, type ModelCredential } from './runtime'

// Shaped like the real thing so a leak would look like one, and fake so a leak would cost nothing.
const KEY = 'sk-ant-api03-FAKE-not-a-real-key'
const TOKEN = 'sk-ant-oat01-FAKE-not-a-real-token'

describe('SecretValue — a credential that does not print itself', () => {
  // Spec 0.2.0 §3.2: credentials now travel as values, through options objects people log and errors
  // people serialise. Every ordinary way of turning one into text must say [redacted].
  it('prints [redacted] through String, a template, JSON and util.inspect', () => {
    const credential: ModelCredential = { kind: 'api-key', value: new SecretValue(KEY) }
    const seen = [
      String(credential.value),
      `${credential.value}`,
      // `+ ''` is the one coercion that asks for a primitive with no hint.
      (credential.value as unknown as string) + '',
      JSON.stringify(credential),
      JSON.stringify({ runtime: { credential } }),
      inspect(credential, { depth: 10, showHidden: true }),
      new Error(`could not use ${credential.value}`).message,
    ]
    for (const text of seen) {
      expect(text).not.toContain(KEY)
      expect(text).toContain('[redacted]')
    }
  })

  it('carries nothing a spread or Object.keys can reach', () => {
    const value = new SecretValue(KEY)
    expect(Object.keys(value)).toEqual([])
    expect(JSON.stringify({ ...value })).toBe('{}')
  })

  it('gives the value back only when asked for it by name', () => {
    expect(new SecretValue(KEY).reveal()).toBe(KEY)
  })
})

describe('modelCredentialFromEnv — exactly one, or the reason why not', () => {
  it('returns the one credential that is set, wrapped', () => {
    const key = modelCredentialFromEnv({ ANTHROPIC_API_KEY: KEY }, { allowLogin: false })
    expect(key.kind).toBe('api-key')
    expect(key.kind !== 'claude-login' && key.value.reveal()).toBe(KEY)
    const token = modelCredentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, { allowLogin: true })
    expect(token.kind).toBe('oauth-token')
    expect(token.kind !== 'claude-login' && token.value.reveal()).toBe(TOKEN)
  })

  it('treats an empty variable as unset', () => {
    expect(modelCredentialFromEnv({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, { allowLogin: false }).kind)
      .toBe('oauth-token')
  })

  // Decision §14.4: two credentials means nobody can say which account a review was billed to — now
  // refused for the CLI too, which used to let Claude Code pick.
  it('refuses both, naming both variables and neither value, whoever asks', () => {
    for (const allowLogin of [false, true]) {
      const e = (() => {
        try {
          modelCredentialFromEnv({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, { allowLogin })
          return null
        } catch (x) { return x as Error }
      })()
      expect(e?.message).toMatch(/2 model credentials are set \(ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN\); set exactly one/)
      expect(e?.message).not.toContain(KEY)
      expect(e?.message).not.toContain(TOKEN)
    }
  })

  it('uses this machine’s claude login when neither is set, only where a login is allowed', () => {
    expect(modelCredentialFromEnv({}, { allowLogin: true })).toEqual({ kind: 'claude-login' })
    // The runner's message, unchanged since 0.1: a deployment that set nothing is told both names.
    expect(() => modelCredentialFromEnv({}, { allowLogin: false }))
      .toThrow(/^no model credential: set exactly one of ANTHROPIC_API_KEY .* or CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('refuses ANTHROPIC_BASE_URL before anything else, naming no value (decision 10)', () => {
    for (const allowLogin of [false, true]) {
      expect(() => modelCredentialFromEnv(
        { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://gateway.example/v1' }, { allowLogin },
      )).toThrow(/^ANTHROPIC_BASE_URL is set:/)
    }
  })

  it('does not take a gateway token for a credential', () => {
    expect(() => modelCredentialFromEnv({ ANTHROPIC_AUTH_TOKEN: 'gateway-FAKE' }, { allowLogin: false }))
      .toThrow(/no model credential/)
  })
})

describe('credentialVariable — what the Claude process is handed', () => {
  it('names the variable each kind belongs in, and none for a claude login', () => {
    expect(credentialVariable({ kind: 'api-key', value: new SecretValue(KEY) }))
      .toEqual({ name: 'ANTHROPIC_API_KEY', value: KEY })
    expect(credentialVariable({ kind: 'oauth-token', value: new SecretValue(TOKEN) }))
      .toEqual({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN })
    expect(credentialVariable({ kind: 'claude-login' })).toBeNull()
  })

  // A JavaScript caller can pass anything. A bare string where the wrapper belongs is refused rather
  // than handed on, and the refusal does not repeat it.
  it('refuses a bare string, an empty value and an unknown kind, without echoing a value', () => {
    const bare = { kind: 'api-key', value: KEY } as unknown as ModelCredential
    expect(() => credentialVariable(bare)).toThrow(/must be a SecretValue/)
    try { credentialVariable(bare) } catch (e) { expect((e as Error).message).not.toContain(KEY) }
    expect(() => credentialVariable({ kind: 'oauth-token', value: new SecretValue('') })).toThrow(/empty value/)
    expect(() => credentialVariable({ kind: 'gateway' } as unknown as ModelCredential)).toThrow(/unknown kind: gateway/)
  })
})

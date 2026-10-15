import { describe, expect, it } from 'vitest'
import { configFromEnv, DEFAULTS, type Env } from './config'

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n'
const BASE: Env = {
  GITHUB_WEBHOOK_SECRET: 'the-webhook-secret',
  REVIEW_AGENT_APP_CLIENT_ID: 'Iv23liExampleClientId',
  REVIEW_AGENT_APP_PRIVATE_KEY: PEM,
  ANTHROPIC_API_KEY: 'test-api-key',
}
const noFile = (): string => { throw new Error('no file should be read') }

describe('configFromEnv', () => {
  it('reads a complete environment, with the defaults for everything optional', () => {
    const c = configFromEnv(BASE, noFile)
    expect(c).toMatchObject({
      port: DEFAULTS.port, concurrency: 1, queueLimit: DEFAULTS.queueLimit, drainMs: 0,
      webhookSecret: 'the-webhook-secret', identity: { clientId: 'Iv23liExampleClientId', privateKeyPem: PEM },
    })
    expect(c.apiKey.reveal()).toBe('test-api-key')
  })

  it("reads the App's key from a file", () => {
    const { REVIEW_AGENT_APP_PRIVATE_KEY: _key, ...rest } = BASE
    const c = configFromEnv({ ...rest, REVIEW_AGENT_APP_PRIVATE_KEY_FILE: '/run/secrets/app.pem' }, (p) => {
      expect(p).toBe('/run/secrets/app.pem')
      return PEM
    })
    expect(c.identity.privateKeyPem).toBe(PEM)
  })

  it('takes concurrency, queue limit, drain time and port from the environment', () => {
    const c = configFromEnv({
      ...BASE, REVIEW_AGENT_CONCURRENCY: '2', REVIEW_AGENT_QUEUE_LIMIT: '5', REVIEW_AGENT_DRAIN_SECONDS: '30', PORT: '3000',
    }, noFile)
    expect(c).toMatchObject({ concurrency: 2, queueLimit: 5, drainMs: 30_000, port: 3000 })
  })
})

describe('configFromEnv refuses', () => {
  const refused = (env: Env, message: RegExp) => {
    expect(() => configFromEnv(env, noFile)).toThrow(message)
  }

  it('no webhook secret', () => refused({ ...BASE, GITHUB_WEBHOOK_SECRET: '' }, /GITHUB_WEBHOOK_SECRET is not set/))

  it('the key both as a file and as a variable', () =>
    refused({ ...BASE, REVIEW_AGENT_APP_PRIVATE_KEY_FILE: '/run/secrets/app.pem' }, /both set/))

  it('a subscription token: a server reviewing for others takes an API key (spec 0.2.0 §2.3)', () => {
    const { ANTHROPIC_API_KEY: _key, ...rest } = BASE
    refused({ ...rest, CLAUDE_CODE_OAUTH_TOKEN: 'test-subscription-token' }, /takes an Anthropic API key/)
  })

  it('two model credentials', () => refused({ ...BASE, CLAUDE_CODE_OAUTH_TOKEN: 'test-subscription-token' }, /2 model credentials/))

  it('ANTHROPIC_BASE_URL set', () => refused({ ...BASE, ANTHROPIC_BASE_URL: 'https://gateway.example.com' }, /ANTHROPIC_BASE_URL/))

  it('a concurrency that is not a whole number of at least 1', () => refused({ ...BASE, REVIEW_AGENT_CONCURRENCY: '0' }, /REVIEW_AGENT_CONCURRENCY/))

  it('a relative data directory', () => refused({ ...BASE, REVIEW_AGENT_DATA_DIR: 'data' }, /absolute path/))

  it('never with a value in the message', () => {
    try {
      configFromEnv({ ...BASE, REVIEW_AGENT_APP_PRIVATE_KEY: 'pasted-the-app-id-instead' }, noFile)
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).not.toContain('pasted-the-app-id-instead')
    }
  })
})

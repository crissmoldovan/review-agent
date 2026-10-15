import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { APP_IDENTITY_VARS, appIdentityFromEnv, type AppIdentity } from '@review-agent/app'
import { modelCredentialFromEnv } from '@review-agent/core'
import { SecretValue } from '@review-agent/sdk'

export type Env = Record<string, string | undefined>

export type ServerConfig = {
  port: number
  /** GitHub's webhook secret, as set on the App. */
  webhookSecret: string
  identity: AppIdentity
  /** The one model credential, wrapped so nothing this process prints can show it. */
  apiKey: SecretValue
  /** How many reviews run at once. */
  concurrency: number
  /** How many reviews may wait behind those; one more is answered 503. */
  queueLimit: number
  /** How long a running review may go on after SIGTERM before it is cancelled. */
  drainMs: number
  /** Checkouts go in `<dataDir>/checkouts`, skills in `<dataDir>/skills`, each `0700`. */
  dataDir: string
  /** Something worth knowing at start-up that stops nothing. */
  warnings: string[]
}

/** The variables this server reads, by name — never by value in any message. */
export const VARS = {
  webhookSecret: 'GITHUB_WEBHOOK_SECRET',
  clientId: APP_IDENTITY_VARS.clientId,
  privateKey: APP_IDENTITY_VARS.privateKey,
  privateKeyFile: 'REVIEW_AGENT_APP_PRIVATE_KEY_FILE',
  apiKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  concurrency: 'REVIEW_AGENT_CONCURRENCY',
  queueLimit: 'REVIEW_AGENT_QUEUE_LIMIT',
  drainSeconds: 'REVIEW_AGENT_DRAIN_SECONDS',
  dataDir: 'REVIEW_AGENT_DATA_DIR',
  port: 'PORT',
} as const

export const DEFAULTS = { port: 8080, concurrency: 1, queueLimit: 20, drainSeconds: 0 } as const

const set = (env: Env, name: string): boolean => (env[name] ?? '') !== ''

const wholeNumber = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name] ?? ''
  if (raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}

/** Everything the server runs on, read once at start-up, or an Error naming the variable to fix. Every
 *  rule that can be checked before the first delivery is checked here: a server that accepted
 *  webhooks and then failed every review would look healthy to GitHub and to Docker. */
export function configFromEnv(env: Env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): ServerConfig {
  const warnings: string[] = []

  const webhookSecret = env[VARS.webhookSecret] ?? ''
  if (webhookSecret === '') {
    // `verifyDelivery` refuses an empty secret too; failing here says so before anything listens.
    throw new Error(`${VARS.webhookSecret} is not set: the webhook secret you set on the App's settings page`)
  }

  // The App's key, from a file (spec 0.2.0 §7: "with the App's key in a file only that user can read")
  // or, where a secret store hands values over as variables, from the variable the App runner reads.
  // Exactly one, so it is never unclear which key signed a token.
  const fromFile = set(env, VARS.privateKeyFile)
  if (fromFile && set(env, VARS.privateKey)) {
    throw new Error(`${VARS.privateKeyFile} and ${VARS.privateKey} are both set: set one, so it is clear which key the App signs with`)
  }
  let identityEnv = env
  if (fromFile) {
    const path = env[VARS.privateKeyFile] ?? ''
    let pem: string
    try {
      pem = readFile(path)
    } catch (e) {
      throw new Error(`${VARS.privateKeyFile} names a file this process cannot read (${(e as NodeJS.ErrnoException).code ?? 'error'}): ${path}`)
    }
    identityEnv = { ...env, [VARS.privateKey]: pem }
    const loose = groupOrOtherCanRead(path)
    if (loose) warnings.push(`${VARS.privateKeyFile}: the key file can be read by users other than its owner; chmod 0400 it`)
  }
  // Throws naming the variables and never a value (packages/app/src/credentials.ts).
  const identity = appIdentityFromEnv(identityEnv)

  // Exactly one model credential, no gateway — the rules every way in applies (`modelCredentialFromEnv`)
  // — and it must be an API key: a server that reviews everybody's pull requests is a shared
  // deployment, and Anthropic's terms keep a subscription to its owner's own use (spec 0.2.0 §2.3, UC-7).
  const credential = modelCredentialFromEnv(env, { allowLogin: false })
  if (credential.kind !== 'api-key') {
    throw new Error(
      `${VARS.oauthToken} is set: this server reviews other people's pull requests, which takes an Anthropic API key ` +
      `(${VARS.apiKey}) — a subscription token is for its owner's own use (spec 0.2.0 §2.3). Unset it and set ${VARS.apiKey}.`,
    )
  }

  const dataDir = env[VARS.dataDir] ?? ''
  if (dataDir !== '' && !isAbsolute(dataDir)) throw new Error(`${VARS.dataDir} must be an absolute path`)

  return {
    port: wholeNumber(env, VARS.port, DEFAULTS.port, 1, 65535),
    webhookSecret,
    identity,
    apiKey: credential.value,
    concurrency: wholeNumber(env, VARS.concurrency, DEFAULTS.concurrency, 1, 32),
    queueLimit: wholeNumber(env, VARS.queueLimit, DEFAULTS.queueLimit, 0, 10_000),
    drainMs: wholeNumber(env, VARS.drainSeconds, DEFAULTS.drainSeconds, 0, 3600) * 1000,
    // Per user by default (spec 0.2.0 §9.2: "a per-user 0700 cache directory"), so two services on one
    // machine never share a checkout or a skill cache.
    dataDir: dataDir !== '' ? dataDir : join(tmpdir(), `review-agent-server-${process.getuid?.() ?? 'user'}`),
    warnings,
  }
}

/** POSIX permission bits only mean something off Windows, and a file that cannot be stat'ed has
 *  already failed the read above. */
const groupOrOtherCanRead = (path: string): boolean => {
  if (process.platform === 'win32') return false
  try {
    return (statSync(path).mode & 0o044) !== 0
  } catch {
    return false
  }
}

/** Every secret this configuration holds, for the logger to keep out of every line. */
export const secretsOf = (c: ServerConfig): string[] => [c.webhookSecret, c.apiKey.reveal(), c.identity.privateKeyPem]

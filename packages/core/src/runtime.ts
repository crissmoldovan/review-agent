import { inspect } from 'node:util'

const REDACTED = '[redacted]'

/** A credential's value, held so that nothing prints it by accident (spec 0.2.0 §3.2).
 *
 *  An embedding service passes credentials as values now, not only through its own environment, and a
 *  value travels: into an options object somebody logs, an error somebody serialises, a record somebody
 *  posts. Every ordinary way of turning this into text — `String()`, a template literal,
 *  `JSON.stringify`, `console.log` / `util.inspect` — prints `[redacted]`. The one way to read it is
 *  `reveal()`, called in exactly one place: where the Claude process's environment is built.
 *
 *  A private field, not a property, so `Object.keys`, a spread and a structured clone do not carry the
 *  value either. This is a guard against accidents, not against code that sets out to read it. */
export class SecretValue {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  reveal(): string {
    return this.#value
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}

/** Which account a review is billed to (spec 0.2.0 §2.3, §3.2). Three kinds and no fourth: an API key, a
 *  subscription token from `claude setup-token`, or this machine's own `claude login`. A gateway is not a
 *  kind — see `gatewayBaseUrlRefusal`. */
export type ModelCredential =
  | { kind: 'api-key'; value: SecretValue }
  /** Passed through to the Claude process, never stored (§2.3: Anthropic's terms forbid a product
   *  intermediating a subscription on somebody else's behalf). */
  | { kind: 'oauth-token'; value: SecretValue }
  /** The Claude Code login on this machine: no variable is set, and the process finds its own. */
  | { kind: 'claude-login' }

/** What travels with ONE review to the Claude process it starts (spec 0.2.0 §3.2). Two reviews in one
 *  process cannot race on `process.env` for any of this: each carries its own.
 *
 *  - `credential`: when given, the process gets that credential and no other — any credential variable
 *    in this process's environment is removed from the child's. When absent, the child gets whichever
 *    one the environment holds, as before.
 *  - `bin`: the Claude Code binary for this review, in place of `REVIEW_AGENT_CLAUDE_BIN`, and held to
 *    the same rules — absolute, and not inside the checkout.
 *  - `passEnv`: further variables the child may see, BY NAME, read from this process's environment
 *    (§14.13: a proxy, a CA bundle). Names, never values, so a deployment cannot hand the child a value
 *    nobody can see in its configuration. Some names are refused outright — see `childEnv`. */
export type ClaudeRuntime = {
  credential?: ModelCredential
  bin?: string
  passEnv?: string[]
}

/** The two variables that are a model credential (Criss, 2026-09-14, decision 10): an Anthropic API
 *  key, or a subscription token from `claude setup-token`. There is no third — the gateway pair is
 *  refused, and neither of its names is on `CHILD_ENV_ALLOWLIST`. One list, here, because the runner,
 *  the CLI, the child's environment and the record callback's refusals all have to agree on it. */
export const MODEL_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

/** Criss, 2026-09-14 (decision 10): the reviewer refuses to run when ANTHROPIC_BASE_URL is set.
 *  Not forwarding it (the allow-list in cli-process.ts) is silent — an operator who pointed the CLI at
 *  a gateway would get a review from Anthropic and believe it came from somewhere else. One sentence,
 *  one place: spawnClaude uses it, `modelCredentialFromEnv` uses it before any GitHub call, and so
 *  every way in does. Names the variable, never its value. */
export const gatewayBaseUrlRefusal = (env: Record<string, string | undefined>): string | null =>
  (env.ANTHROPIC_BASE_URL ?? '') === ''
    ? null
    : 'ANTHROPIC_BASE_URL is set: this reviewer sends the reviewed code only to Anthropic, with an ' +
      'Anthropic API key or a subscription token, and refuses to run pointed anywhere else. Unset it.'

/** The model credential this environment names, or why there is none to use (spec 0.2.0 §3.2).
 *
 *  Exactly one, never "at least one": with two set, nobody can say which account a review was billed
 *  to, and this product does not leave money ambiguous (decision §14.4 extends that to the CLI). With
 *  none set, `allowLogin` decides: the CLI runs as a person on their own machine and may use its
 *  `claude login`; the App runner and any shared deployment may not, because a login on a server is
 *  somebody's personal account paying for everybody's reviews.
 *
 *  Called before the first GitHub call, so a misconfigured environment fails before anything is
 *  downloaded or paid for. Names variables, NEVER prints a value: the names are enough to fix it. */
export const modelCredentialFromEnv = (
  env: Record<string, string | undefined>,
  opts: { allowLogin: boolean },
): ModelCredential => {
  // Decision 10: checked first. The base URL would apply whichever credential was chosen.
  const gateway = gatewayBaseUrlRefusal(env)
  if (gateway !== null) throw new Error(gateway)
  const set = MODEL_CREDENTIAL_VARS.filter((k) => (env[k] ?? '') !== '')
  if (set.length > 1) {
    throw new Error(
      `${set.length} model credentials are set (${set.join(', ')}); set exactly one, so that ` +
      'what a review costs is billed somewhere a person can name' +
      (opts.allowLogin ? ", or neither, to use this machine's `claude login`." : '.'),
    )
  }
  const [only] = set
  if (only === 'ANTHROPIC_API_KEY') return { kind: 'api-key', value: new SecretValue(env[only] ?? '') }
  if (only === 'CLAUDE_CODE_OAUTH_TOKEN') return { kind: 'oauth-token', value: new SecretValue(env[only] ?? '') }
  if (opts.allowLogin) return { kind: 'claude-login' }
  throw new Error(
    'no model credential: set exactly one of ANTHROPIC_API_KEY (an Anthropic API key) or ' +
    'CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, a Claude subscription). ' +
    'No review can run without one.',
  )
}

/** The variable a credential is handed to the Claude process in, and its value — or nothing, for a
 *  `claude login`. Validated here because a JavaScript caller can pass anything: a bare string where a
 *  `SecretValue` belongs would otherwise fail deep in a spawn, or not at all. */
export const credentialVariable = (c: ModelCredential): { name: string; value: string } | null => {
  if (c.kind === 'claude-login') return null
  if (c.kind !== 'api-key' && c.kind !== 'oauth-token') {
    throw new Error(`runtime.credential has an unknown kind: ${String((c as { kind?: unknown }).kind)}`)
  }
  const value = (c.value as { reveal?: unknown } | undefined)?.reveal
  if (typeof value !== 'function') {
    throw new Error(`runtime.credential.value must be a SecretValue (new SecretValue(...)), so it is never printed by accident`)
  }
  const text = c.value.reveal()
  if (text === '') throw new Error(`runtime.credential is an ${c.kind} with an empty value`)
  return { name: c.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN', value: text }
}

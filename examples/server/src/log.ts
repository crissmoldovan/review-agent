import { scanForSecrets } from '@review-agent/core'

export type Fields = Record<string, unknown>
export type Level = 'info' | 'warn' | 'error'
export type Logger = Record<Level, (message: string, fields?: Fields) => void>

/** What a known secret's value is replaced with, wherever it appears in a line. */
export const REDACTED = '[redacted]'
/** What a whole string becomes when it matches one of the product's secret patterns (a GitHub token,
 *  an Anthropic key, a private key…) that this process was not told about — an installation token
 *  minted a minute ago, or a key quoted back in an error message. */
export const WITHHELD = '[withheld: matched a secret pattern]'

/** Fields whose value is a credential by name, whatever it looks like. */
const SECRET_FIELD = /^(authorization|token|apikey|api_key|secret|password|privatekey|privatekeypem|pem)$/i

/** Shorter than this, a "secret" would redact ordinary words. Every secret this server holds is far
 *  longer: a webhook secret worth having, an API key, a PEM. */
const MIN_SECRET_CHARS = 8
const MAX_DEPTH = 5

/** One JSON object per line on stdout, so `docker logs` and any log shipper can parse it. Every string
 *  in every line passes two filters before it is written: the secret VALUES this process holds are
 *  replaced, and anything that matches a secret PATTERN is withheld whole (spec 0.2.0 §10; the same
 *  patterns the reviewer scans its own output with, `scanForSecrets`). A log line is a place a
 *  credential must never go, and the second filter is there for the one nobody thought to name. */
export function createLogger(a: {
  /** Read at every line, so a secret learnt after start-up is covered as soon as it is added. */
  secrets: () => readonly string[]
  write?: (line: string) => void
  now?: () => Date
}): Logger {
  const write = a.write ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const now = a.now ?? (() => new Date())
  const line = (level: Level) => (message: string, fields: Fields = {}): void => {
    const known = a.secrets().filter((s) => s.length >= MIN_SECRET_CHARS)
    const clean = (value: unknown, depth: number): unknown => scrub(value, depth, known)
    const entry = {
      time: now().toISOString(),
      level,
      msg: clean(message, 0),
      ...(clean(fields, 0) as Fields),
    }
    write(JSON.stringify(entry))
  }
  return { info: line('info'), warn: line('warn'), error: line('error') }
}

const scrubText = (text: string, known: readonly string[]): string => {
  let out = text
  for (const secret of known) out = out.split(secret).join(REDACTED)
  return scanForSecrets(out).length > 0 ? WITHHELD : out
}

const scrub = (value: unknown, depth: number, known: readonly string[]): unknown => {
  if (typeof value === 'string') return scrubText(value, known)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[too deep]'
  // An Error's own fields are not enumerable, and its stack repeats its message: the name and the
  // message, scrubbed, are what a log needs.
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message, known) }
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, known))
  // A `SecretValue` and anything else with its own toJSON says for itself how it is written — for a
  // SecretValue, `[redacted]` — and is scrubbed after.
  const asJson = (value as { toJSON?: unknown }).toJSON
  if (typeof asJson === 'function') return scrub(asJson.call(value), depth + 1, known)
  const out: Fields = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) ? REDACTED : scrub(v, depth + 1, known)
  }
  return out
}

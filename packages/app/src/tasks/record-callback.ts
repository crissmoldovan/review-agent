import { createHmac } from 'node:crypto'
import { scanForSecrets } from '@review-agent/core'
import { APP_IDENTITY_VARS } from '../credentials'
import { MODEL_CREDENTIAL_VARS, type ReviewTaskResult } from './review-run'

/** GitHub's `X-Hub-Signature-256` shape under this product's own name, so a receiver verifies a record
 *  with the `verifySignature` it already calls for webhooks (Task 9). */
export const RECORD_SIGNATURE_HEADER = 'x-review-agent-signature-256'

/** A bound, not a measurement: a finished review does not wait on a slow receiver. */
export const RECORD_CALLBACK_TIMEOUT_MS = 10_000

/** Criss, 2026-09-14 (answer 16). `secretEnv` is the NAME of the variable holding the secret, so the
 *  setting can live in code and the secret cannot. */
export type RecordCallback = { url: string; secretEnv: string }
export type RecordCallbackBody = { version: 1; result: Extract<ReviewTaskResult, { kind: 'reviewed' }> }
export type RecordCallbackRefusal =
  | 'not-configured' | 'bad-url' | 'bad-secret-name' | 'no-secret' | 'withheld'
  | 'rejected' | 'timeout' | 'unreachable'
export type RecordCallbackOutcome =
  | { sent: true; status: number }
  | { sent: false; why: RecordCallbackRefusal; status?: number }

/** `sha256=` and the hex HMAC-SHA256 of the bytes, exactly what `verifySignature` recomputes. */
export const signRecordBody = (a: { rawBody: Uint8Array; secret: string }): string =>
  `sha256=${createHmac('sha256', a.secret).update(a.rawBody).digest('hex')}`

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/

/** A secret shared with a receiver is made for that receiver: signing with the model key or the App
 *  key would put a copy of it wherever the callback is verified. */
const NOT_A_CALLBACK_SECRET: ReadonlySet<string> = new Set<string>([
  ...MODEL_CREDENTIAL_VARS, APP_IDENTITY_VARS.clientId, APP_IDENTITY_VARS.privateKey,
])

/** Every string anywhere in the body, as its own value. Scanning `JSON.stringify(body)` alone is not
 *  enough and the reason is exact: every pattern in `packages/core/src/secrets.ts` but `private-key`
 *  is anchored with `\b`, and `JSON.stringify` rewrites a newline or tab INSIDE a string as the two
 *  characters `\` and `n`. A token that begins a line becomes `…\nghp_AAAA…`, where `n` is a word
 *  character, so there is no word boundary before `g` and the pattern does not match. Verified
 *  2026-09-14 against the real patterns: a `ghp_` + 36 characters is found in `"see\n<token>"` and in
 *  `"x\t<token>"` as raw strings, and missed in both once JSON-encoded; it is still found after a
 *  space, which is the only case a serialised-text scan was ever tested on. Both scans run: this one
 *  sees the values as the model wrote them, the serialised one sees the bytes that actually leave. */
const stringLeaves = (value: unknown, into: string[] = []): string[] => {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, into)
  else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) stringLeaves(v, into)
  }
  return into
}

/** Sends one finished review, once, and never rejects: every way it can go wrong is an outcome the
 *  caller logs (Criss, answer 16: a failed callback never fails, retries or re-runs the review). */
export const sendRecordCallback = async (a: {
  callback: RecordCallback | null
  env: Record<string, string | undefined>
  body: RecordCallbackBody
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<RecordCallbackOutcome> => {
  try {
    if (a.callback === null) return { sent: false, why: 'not-configured' }
    let url: URL
    try {
      url = new URL(a.callback.url)
    } catch {
      return { sent: false, why: 'bad-url' }
    }
    // https only, and no credentials in the address: the record is signed, not hidden, and a password
    // in a URL is a secret in a setting.
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      return { sent: false, why: 'bad-url' }
    }
    if (!VARIABLE_NAME.test(a.callback.secretEnv) || NOT_A_CALLBACK_SECRET.has(a.callback.secretEnv)) {
      return { sent: false, why: 'bad-secret-name' }
    }
    // Never unsigned: an empty secret would let anyone sign anything (Task 9 refuses one too).
    const secret = a.env[a.callback.secretEnv] ?? ''
    if (secret === '') return { sent: false, why: 'no-secret' }
    const text = JSON.stringify(a.body)
    // The review already passed runReview's scan (Task 1, Step 16); this is it once more, twice
    // (design §4.3). The LEAVES first, because they are the strings as they were written — a token
    // after a newline survives JSON-encoding as `\n` + token and matches no `\b`-anchored pattern.
    // Then the serialised text, because those are the bytes that actually leave.
    if (stringLeaves(a.body).some((s) => scanForSecrets(s).length > 0)) {
      return { sent: false, why: 'withheld' }
    }
    if (scanForSecrets(text).length > 0) return { sent: false, why: 'withheld' }
    const send = a.fetch ?? fetch
    const res = await send(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RECORD_SIGNATURE_HEADER]: signRecordBody({ rawBody: Buffer.from(text, 'utf8'), secret }),
      },
      // A string body is sent as its UTF-8 bytes, which are the bytes signed above.
      body: text,
      redirect: 'error',
      signal: AbortSignal.timeout(a.timeoutMs ?? RECORD_CALLBACK_TIMEOUT_MS),
    })
    return res.ok ? { sent: true, status: res.status } : { sent: false, why: 'rejected', status: res.status }
  } catch (e) {
    const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
    return { sent: false, why: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' }
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-hub-signature-256'

/** SHA-1, which GitHub still sends alongside the real one. It is legacy and is never accepted,
 *  not even as a fallback when the SHA-256 header is missing. */
export const LEGACY_SIGNATURE_HEADER = 'x-hub-signature'

export type VerifyFailure =
  | 'empty-secret' | 'missing-header' | 'duplicate-header' | 'malformed-header'
  | 'legacy-sha1-refused' | 'mismatch'

export type VerifyResult = { ok: true } | { ok: false; why: VerifyFailure }

const fail = (why: VerifyFailure): VerifyResult => ({ ok: false, why })

// GitHub sends `sha256=` followed by 64 lowercase hex digits. Anything else is not a signature
// this function can compare, and checking the shape first keeps unequal-length buffers away from
// timingSafeEqual, which throws on them.
const SHA256_SIGNATURE = /^sha256=[0-9a-f]{64}$/

export function verifySignature(a: {
  rawBody: Uint8Array
  signature: string | null | undefined
  secret: string
}): VerifyResult {
  if (!(a.rawBody instanceof Uint8Array)) {
    // A caller who reached for `request.json()` or `JSON.stringify(body)` has already lost the
    // bytes GitHub signed. That is a programmer error, so it throws rather than returning a
    // verification failure that would read like a bad request.
    throw new TypeError(
      'verifySignature needs the RAW request body as bytes, e.g. new Uint8Array(await request.arrayBuffer()); ' +
      'a parsed and re-serialised body is not what GitHub signed',
    )
  }
  if (a.secret === '') return fail('empty-secret')
  if (a.signature === null || a.signature === undefined || a.signature === '') return fail('missing-header')
  if (a.signature.startsWith('sha1=')) return fail('legacy-sha1-refused')
  if (!SHA256_SIGNATURE.test(a.signature)) return fail('malformed-header')

  const expected = Buffer.from(`sha256=${createHmac('sha256', a.secret).update(a.rawBody).digest('hex')}`, 'utf8')
  const given = Buffer.from(a.signature, 'utf8')
  if (expected.length !== given.length) return fail('malformed-header')
  return timingSafeEqual(expected, given) ? { ok: true } : fail('mismatch')
}

/** Whatever the adopter's framework hands them: a fetch `Headers` (Next.js route handlers, Hono,
 *  Workers) or Node's own lowercase-keyed record. */
export type HeaderLookup = Headers | Record<string, string | string[] | undefined>

/** EVERY value the record carries for this header, not the first one that matches. A record is a
 *  plain object, so the same header can arrive as two keys that differ only in case — and as an
 *  array under one key, and as both at once. Returning the first match would pick one of two
 *  signatures, which is the decision this function exists to refuse. A fetch `Headers` has no such
 *  shape: `get` joins repeats with ", ", so duplicates reach the caller as one unparseable string. */
const lookupAll = (headers: HeaderLookup, name: string): string[] => {
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? [] : [value]
  }
  const found: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue
    if (Array.isArray(value)) found.push(...value)
    else found.push(value)
  }
  return found
}

export function verifyDelivery(a: {
  rawBody: Uint8Array
  headers: HeaderLookup
  secret: string
}): VerifyResult {
  const signatures = lookupAll(a.headers, SIGNATURE_HEADER)
  // Two signature headers is an attack shape, not a configuration quirk: whichever one is picked,
  // the other was chosen by somebody else. Identical duplicates are refused with them, because
  // telling those apart means comparing attacker-supplied values to decide whether to keep going.
  if (signatures.length > 1) return fail('duplicate-header')
  const signature = signatures[0] ?? null
  if (signature === null && lookupAll(a.headers, LEGACY_SIGNATURE_HEADER).length > 0) return fail('legacy-sha1-refused')
  return verifySignature({ rawBody: a.rawBody, signature, secret: a.secret })
}

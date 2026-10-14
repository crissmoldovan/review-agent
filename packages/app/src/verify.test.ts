import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// GitHub's own guidance: compare with crypto.timingSafeEqual and never with ==. Nothing about a
// unit test's output can tell those apart, so this spy is the lock: swap in `===` and it fails.
// Typed, so the arguments it recorded can be read back below without a cast.
const timingSafeEqualSpy = vi.hoisted(() => vi.fn<(a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => boolean>())
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual)
  return { ...actual, timingSafeEqual: timingSafeEqualSpy }
})

import { verifyDelivery, verifySignature } from './verify'

const SECRET = 'a-webhook-secret-from-the-manifest-conversion'

// Pretty-printed, with a non-ASCII character in it, both on purpose: JSON.stringify of the parsed
// object produces neither the indentation nor the same byte length, which is what the
// re-serialisation test below relies on.
const RAW = Buffer.from(JSON.stringify({
  action: 'opened',
  pull_request: { number: 25, title: 'Raise the ceiling — measured' },
  repository: { full_name: 'acme/widgets' },
}, null, 2), 'utf8')

const sign = (body: Uint8Array, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('verifySignature', () => {
  it('accepts the signature GitHub computed over these exact bytes', () => {
    expect(verifySignature({ rawBody: RAW, signature: sign(RAW), secret: SECRET })).toEqual({ ok: true })
  })
})

describe('verifySignature refuses', () => {
  it('a body altered by one byte', () => {
    const altered = Buffer.from(RAW)
    altered[altered.indexOf(0x32 /* the "2" of pull request 25 */)] = 0x33

    expect(verifySignature({ rawBody: altered, signature: sign(RAW), secret: SECRET }))
      .toEqual({ ok: false, why: 'mismatch' })
  })

  it('a signature that is right at its start and wrong at its end', () => {
    // The case above cannot see a comparison that stops early: an HMAC avalanches, so a changed
    // body changes the first hex digits too and a 16-byte prefix compare still refuses it. What a
    // truncated comparison really does is drop the work of forging a signature from 2^256 to
    // 2^(4 × digits compared). Only a signature that agrees with the real one until its tail can
    // tell a whole comparison from a partial one, so that is what this one is.
    const correct = sign(RAW)
    const tailFlipped = `${correct.slice(0, -1)}${correct.endsWith('0') ? '1' : '0'}`

    expect(tailFlipped).not.toBe(correct)
    expect(verifySignature({ rawBody: RAW, signature: tailFlipped, secret: SECRET }))
      .toEqual({ ok: false, why: 'mismatch' })
  })

  it('a signature computed with a different secret', () => {
    expect(verifySignature({ rawBody: RAW, signature: sign(RAW, 'the-wrong-secret'), secret: SECRET }))
      .toEqual({ ok: false, why: 'mismatch' })
  })

  it('a body that was parsed and serialised again — the trap this function exists for', () => {
    // Same object, different bytes. A receiver that hands over `JSON.stringify(await req.json())`
    // gets a mismatch here rather than a verification that quietly means nothing.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8')) as unknown), 'utf8')

    expect(reserialised.toString('utf8')).not.toBe(RAW.toString('utf8'))
    expect(verifySignature({ rawBody: reserialised, signature: sign(RAW), secret: SECRET }))
      .toEqual({ ok: false, why: 'mismatch' })
  })

  it('a missing header, without throwing', () => {
    expect(verifySignature({ rawBody: RAW, signature: undefined, secret: SECRET }))
      .toEqual({ ok: false, why: 'missing-header' })
    expect(verifySignature({ rawBody: RAW, signature: null, secret: SECRET }))
      .toEqual({ ok: false, why: 'missing-header' })
  })

  it('a malformed header, without throwing', () => {
    for (const signature of ['sha256=', 'sha256=zz', 'deadbeef', `sha256=${'a'.repeat(63)}`, `sha256=${'A'.repeat(64)}`]) {
      expect(verifySignature({ rawBody: RAW, signature, secret: SECRET }))
        .toEqual({ ok: false, why: 'malformed-header' })
    }
  })

  it('the legacy SHA-1 signature, rather than falling back to it', () => {
    const legacy = `sha1=${createHmac('sha1', SECRET).update(RAW).digest('hex')}`

    expect(verifySignature({ rawBody: RAW, signature: legacy, secret: SECRET }))
      .toEqual({ ok: false, why: 'legacy-sha1-refused' })
  })

  it('an empty secret, which would let anyone sign anything', () => {
    expect(verifySignature({ rawBody: RAW, signature: sign(RAW, ''), secret: '' }))
      .toEqual({ ok: false, why: 'empty-secret' })
  })
})

describe('verifySignature when the caller hands over the wrong thing', () => {
  it('throws, rather than failing verification, when given a string', () => {
    // JavaScript callers exist: this package ships compiled, and TypeScript cannot stop a
    // webhook receiver written in plain JS from passing the string it already has.
    const misuse = { rawBody: RAW.toString('utf8') as unknown as Uint8Array, signature: sign(RAW), secret: SECRET }

    expect(() => verifySignature(misuse)).toThrow(TypeError)
    expect(() => verifySignature(misuse)).toThrow(/RAW request body as bytes/)
  })
})

describe('how the comparison is made', () => {
  it('compares with crypto.timingSafeEqual, not with an early-exit string compare', () => {
    timingSafeEqualSpy.mockClear()

    expect(verifySignature({ rawBody: RAW, signature: sign(RAW), secret: SECRET })).toEqual({ ok: true })
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses a wrong signature through timingSafeEqual too, with nothing deciding in front of it', () => {
    // The case above only watches the path that succeeds, and the timing oracle lives on the path
    // that fails. A fast `if (!expected.equals(given)) return fail('mismatch')` in front of the safe
    // call leaves every other case in this file green while exiting at the first differing byte, so
    // response latency hands an attacker the expected HMAC one hex digit at a time. The refusal has
    // to come out of the safe call: called once, over the whole signature rather than a prefix, and
    // returning the `false` the verdict is made of.
    timingSafeEqualSpy.mockClear()
    const correct = sign(RAW)
    const tailFlipped = `${correct.slice(0, -1)}${correct.endsWith('0') ? '1' : '0'}`

    expect(verifySignature({ rawBody: RAW, signature: tailFlipped, secret: SECRET }))
      .toEqual({ ok: false, why: 'mismatch' })
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
    for (const compared of timingSafeEqualSpy.mock.calls[0] ?? []) {
      expect(compared.byteLength).toBe(correct.length)
    }
    expect(timingSafeEqualSpy).toHaveNthReturnedWith(1, false)
  })

  it('never hands timingSafeEqual two buffers of different lengths', () => {
    timingSafeEqualSpy.mockClear()

    // A short signature would make timingSafeEqual throw; the shape check must catch it first.
    expect(verifySignature({ rawBody: RAW, signature: 'sha256=abc', secret: SECRET }))
      .toEqual({ ok: false, why: 'malformed-header' })
    expect(timingSafeEqualSpy).not.toHaveBeenCalled()
  })
})

describe('verifyDelivery', () => {
  it('reads the signature from a fetch Headers object', () => {
    const headers = new Headers({ 'X-Hub-Signature-256': sign(RAW), 'X-GitHub-Event': 'pull_request' })

    expect(verifyDelivery({ rawBody: RAW, headers, secret: SECRET })).toEqual({ ok: true })
  })

  it('reads it from a Node request header record, whatever the case', () => {
    expect(verifyDelivery({ rawBody: RAW, headers: { 'X-Hub-Signature-256': sign(RAW) }, secret: SECRET }))
      .toEqual({ ok: true })
    expect(verifyDelivery({ rawBody: RAW, headers: { 'x-hub-signature-256': sign(RAW) }, secret: SECRET }))
      .toEqual({ ok: true })
  })

  it('refuses a delivery that carries only the legacy SHA-1 header', () => {
    const headers = { 'x-hub-signature': `sha1=${createHmac('sha1', SECRET).update(RAW).digest('hex')}` }

    // Not `missing-header`: the distinction tells an operator that deliveries ARE arriving and
    // something in front of the endpoint is stripping the modern header.
    expect(verifyDelivery({ rawBody: RAW, headers, secret: SECRET }))
      .toEqual({ ok: false, why: 'legacy-sha1-refused' })
  })

  it('refuses two signature headers rather than picking one', () => {
    const headers = { 'x-hub-signature-256': [sign(RAW), sign(RAW, 'the-wrong-secret')] }

    expect(verifyDelivery({ rawBody: RAW, headers, secret: SECRET }))
      .toEqual({ ok: false, why: 'duplicate-header' })
  })

  it('refuses two signature headers that differ only in the case of their name', () => {
    // A Node header record is a plain object, so `X-Hub-Signature-256` and `x-hub-signature-256`
    // are two distinct keys that are the same header. Reading the first match picks one of two
    // signatures, and the one it did not pick was chosen by somebody else — the array shape's
    // attack wearing a different hat, and the reason this reads every matching key.
    const both = (first: string, second: string) => ({
      'X-Hub-Signature-256': first, 'x-hub-signature-256': second,
    })

    // Attacker first: refused already, but for the wrong reason — as a mismatch, which reads like
    // a misconfigured secret rather than like two signatures.
    expect(verifyDelivery({ rawBody: RAW, headers: both(sign(RAW, 'the-wrong-secret'), sign(RAW)), secret: SECRET }))
      .toEqual({ ok: false, why: 'duplicate-header' })
    // Attacker second: this is the dangerous order. The real signature verifies, the delivery is
    // accepted, and the second header — a body somebody else signed — is never looked at.
    expect(verifyDelivery({ rawBody: RAW, headers: both(sign(RAW), sign(RAW, 'the-wrong-secret')), secret: SECRET }))
      .toEqual({ ok: false, why: 'duplicate-header' })
  })

  it('refuses the same header given once as a string and once inside an array', () => {
    // Node's own record type allows both shapes at once, and a repair that counted only array
    // entries, or only keys, would let this one through.
    const headers = { 'x-hub-signature-256': sign(RAW), 'X-HUB-SIGNATURE-256': [sign(RAW, 'the-wrong-secret')] }

    expect(verifyDelivery({ rawBody: RAW, headers, secret: SECRET }))
      .toEqual({ ok: false, why: 'duplicate-header' })
  })

  it('refuses two signature headers arriving as a fetch Headers object too', () => {
    // The case above covers the Node record, where duplicates arrive as an array. A fetch Headers
    // has no array: `get` joins repeats with ", ", so the same attack reaches this function as one
    // long string. It must still be refused. The reason reads `malformed-header` rather than
    // `duplicate-header` — the joined value is genuinely not a signature — and that is the whole
    // point of pinning it: the tempting repair for that diagnosis is to split on ", " and take the
    // first, which is picking one of two signatures somebody else chose.
    const headers = new Headers()
    headers.append('x-hub-signature-256', sign(RAW))
    headers.append('x-hub-signature-256', sign(RAW, 'the-wrong-secret'))

    expect(verifyDelivery({ rawBody: RAW, headers, secret: SECRET })).toEqual({ ok: false, why: 'malformed-header' })
  })

  it('reports a missing signature header without throwing', () => {
    expect(verifyDelivery({ rawBody: RAW, headers: { 'x-github-event': 'ping' }, secret: SECRET }))
      .toEqual({ ok: false, why: 'missing-header' })
  })
})

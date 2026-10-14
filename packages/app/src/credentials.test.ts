import { createVerify, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_IDENTITY_VARS,
  GITHUB_API_VERSION,
  JWT_BACKDATE_SECONDS,
  JWT_TTL_SECONDS,
  MAX_SCOPED_REPOSITORIES,
  REVIEW_TOKEN_PERMISSIONS,
  type TokenTransport,
  appIdentityFromEnv,
  appJwt,
  installationToken,
  normalisePrivateKeyPem,
} from './credentials'

// PKCS#1 ("BEGIN RSA PRIVATE KEY") is the shape `POST /app-manifests/{code}/conversions` returns
// in `pem`, so the tests sign with the same encoding an adopter will actually paste in.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const identity = { clientId: 'Iv23liR3v13wAg3nt', privateKeyPem: privateKey }
const NOW = Date.parse('2026-09-14T10:00:00.000Z')
const NOW_S = NOW / 1000

const parts = (jwt: string) => {
  const [header, payload, signature] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, number | string>,
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  }
}

describe('appJwt', () => {
  it('is an RS256 JWT the App private key really signed', () => {
    const { header, signed, signature } = parts(appJwt({ identity, now: NOW }))

    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(createVerify('RSA-SHA256').update(signed).verify(publicKey, signature)).toBe(true)
  })

  it('backdates iat by a minute and expires inside GitHub ten-minute maximum', () => {
    const { claims } = parts(appJwt({ identity, now: NOW }))

    // Each constant gets two assertions: a WIRING one, that the JWT honours the exported number,
    // and a PROPERTY one, measured from NOW, that the number is still a usable one. A wiring
    // assertion alone moves with the constant and so cannot fail when the constant is the thing
    // that is wrong — setting JWT_BACKDATE_SECONDS to 0 left the original three cases green.
    expect(claims.iat).toBe(NOW_S - JWT_BACKDATE_SECONDS)
    // A machine whose clock is a little fast must not mint a JWT GitHub reads as issued in future.
    expect(Number(claims.iat)).toBeLessThan(NOW_S)

    expect(Number(claims.exp) - Number(claims.iat)).toBe(JWT_TTL_SECONDS)
    // GitHub measures `exp` against ITS clock, so the numbers that must hold are the ones measured
    // from now: the JWT is still alive when it arrives, and never longer-lived than GitHub allows.
    expect(Number(claims.exp)).toBeGreaterThan(NOW_S)
    expect(Number(claims.exp) - NOW_S).toBeLessThanOrEqual(600)
  })

  it('issues the JWT as the App client id, which is what GitHub recommends', () => {
    expect(parts(appJwt({ identity, now: NOW })).claims.iss).toBe('Iv23liR3v13wAg3nt')
  })
})

describe('appJwt with an unusable key', () => {
  it('refuses a key that is not a PEM, without quoting it back', () => {
    const planted = 'MIIEpAIBAAKCAQEA-not-a-real-key-PLANTED-SECRET-MATERIAL'
    const bad = { clientId: 'Iv23liR3v13wAg3nt', privateKeyPem: `-----BEGIN RSA PRIVATE KEY-----\n${planted}\n-----END RSA PRIVATE KEY-----\n` }

    expect(() => appJwt({ identity: bad, now: NOW })).toThrow(/not a usable PEM private key/)
    // The whole point of the catch: OpenSSL error text can carry what it was decoding.
    try {
      appJwt({ identity: bad, now: NOW })
    } catch (e) {
      expect(String(e)).not.toContain(planted)
      expect((e as Error).stack ?? '').not.toContain(planted)
    }
  })
})

/** A real operator-facing defect, not a hypothetical: on 2026-09-15 the first hosted run died 6.2 s
 *  in, at this exact function, with "the App private key is not a usable PEM private key" — $0 of
 *  model spend and nothing posted. The key in the deployment's `REVIEW_AGENT_APP_PRIVATE_KEY` was
 *  intact; its NEWLINES were not, having been flattened when the .pem was pasted into a web form.
 *  Both shapes below were measured against a throwaway key on Node 26.7.0 / OpenSSL 3.5.7: each is
 *  refused with `error:1E08010C:DECODER routines::unsupported`, the very error the hosted run hit.
 *  Whoever sets up a production App pastes the same file into the same kind of box. */
describe('a private key a web form has mangled', () => {
  const clientId = 'Iv23liR3v13wAg3nt'
  // Asserting the JWT VERIFIES, not merely that nothing threw: a normaliser that quietly produced
  // some other usable key would pass a "does not throw" test and sign with the wrong identity.
  const signsCorrectly = (privateKeyPem: string) => {
    const { signed, signature } = parts(appJwt({ identity: { clientId, privateKeyPem }, now: NOW }))
    return createVerify('RSA-SHA256').update(signed).verify(publicKey, signature)
  }

  it('signs with a key whose newlines a form turned into spaces', () => {
    expect(signsCorrectly(privateKey.replace(/\n/g, ' '))).toBe(true)
  })

  it('signs with a key whose newlines were stored as literal backslash-n', () => {
    expect(signsCorrectly(privateKey.replace(/\n/g, '\\n'))).toBe(true)
  })

  it('hands a good PEM back byte-identical, so the common path is not rewritten at all', () => {
    // The strongest form of "a working key is untouched": not "still parses" but the same bytes.
    expect(normalisePrivateKeyPem(privateKey)).toBe(privateKey)
  })

  it('reconstructs every whitespace-mangled shape into exactly the original file', () => {
    // Why the two signing cases above can be trusted: repair is not approximate. Whatever OpenSSL
    // would have made of a nearly-right PEM never arises, because the output IS the original.
    // Which shape the deployment's variable actually holds was never read — it is Criss's key — so
    // the rule is "whatever a form did to the whitespace", not the two shapes that were guessed.
    // Each of these is refused by `createPrivateKey` as it stands, measured, and each comes back
    // byte-identical. `\t` and a doubled space are here because a form is not obliged to pick ' '.
    expect(normalisePrivateKeyPem(privateKey.replace(/\n/g, ' '))).toBe(privateKey)
    expect(normalisePrivateKeyPem(privateKey.replace(/\n/g, '\\n'))).toBe(privateKey)
    expect(normalisePrivateKeyPem(privateKey.replace(/\n/g, ''))).toBe(privateKey)
    expect(normalisePrivateKeyPem(privateKey.replace(/\n/g, '\t'))).toBe(privateKey)
    expect(normalisePrivateKeyPem(`  ${privateKey.replace(/\n/g, '   ')}  `)).toBe(privateKey)
    // The literal-CRLF shape a Windows paste produces, which the `\\r\\n` branch exists for.
    expect(normalisePrivateKeyPem(privateKey.replace(/\n/g, '\\r\\n'))).toBe(privateKey)
  })

  it('hands a value that is not a PEM through untouched, so a broken key still fails', () => {
    expect(normalisePrivateKeyPem('hello, I am not a key')).toBe('hello, I am not a key')
    // A mismatched BEGIN/END pair is not a PEM either, and is not stitched into one.
    const mismatched = privateKey.replace(/\n/g, ' ').replace('END RSA PRIVATE KEY', 'END DSA PRIVATE KEY')
    expect(normalisePrivateKeyPem(mismatched)).toBe(mismatched)
  })

  it('still refuses a key whose body is genuinely corrupt, rather than papering over it', () => {
    // One base64 character short. Tolerating whitespace must not become tolerating a broken key:
    // if this ever passes, the normaliser has started inventing a key rather than repairing one.
    const corrupt = privateKey.replace(/\n/g, ' ').replace(/[A-Za-z0-9+/]/, '')

    expect(() => appJwt({ identity: { clientId, privateKeyPem: corrupt }, now: NOW }))
      .toThrow(/not a usable PEM private key/)
  })

  it('still refuses something that is not a key at all', () => {
    expect(() => appJwt({ identity: { clientId, privateKeyPem: 'hello, I am not a key' }, now: NOW }))
      .toThrow(/not a usable PEM private key/)
  })

  it('names no key material when it refuses, and does not chain what OpenSSL said', () => {
    // The assertion that MATTERS is the second pair, not the planted string. Measured on this
    // runtime: `createPrivateKey` refuses every one of these inputs with the same eleven words and
    // quotes none of them back, so a test that only greps for the planted text passes whatever the
    // code does with the cause — it cannot catch a chained error here, and would not have caught
    // one in the case above it either. What can be asserted, and is, is the MECHANISM the module's
    // own comment promises: the original error is dropped, not chained. That holds on an OpenSSL
    // build chattier than this one, which is the build this guard exists for.
    const planted = 'PLANTEDxSECRETxMATERIALxFROMxTHExKEY'
    const mangled = `-----BEGIN RSA PRIVATE KEY----- ${planted} -----END RSA PRIVATE KEY-----`

    try {
      appJwt({ identity: { clientId, privateKeyPem: mangled }, now: NOW })
      expect.unreachable('a PEM whose body is not a key must not produce a JWT')
    } catch (e) {
      const error = e as Error
      expect(error.message).toMatch(/not a usable PEM private key/)
      expect(String(e)).not.toContain(planted)
      expect(error.stack ?? '').not.toContain(planted)
      // Normalising rewrites the value; the rewritten form must not reach the message either.
      expect(String(e)).not.toContain(planted.slice(0, 12))
      expect(error.message).not.toMatch(/DECODER|error:[0-9A-F]{8}/)
      expect(error.cause).toBeUndefined()
    }
  })
})

const tokenResponse = {
  token: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
  expires_at: '2026-09-14T11:00:00Z',
  repositories: [{ full_name: 'acme/widgets' }],
}
const transportReturning = (data: unknown, status = 201): TokenTransport =>
  vi.fn(async () => ({ status, data }))

describe('installationToken', () => {
  it('asks for a token scoped to the one repository the review needs', async () => {
    const transport = transportReturning(tokenResponse)

    await installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport,
    })

    expect(transport).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(transport).mock.calls[0][0]
    expect(sent.installationId).toBe(4242)
    expect(sent.body).toEqual({ repositories: ['widgets'] })
    expect(parts(sent.jwt).claims.iss).toBe('Iv23liR3v13wAg3nt')
  })

  it('returns the token, when it dies, and what it can reach', async () => {
    const got = await installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW,
      transport: transportReturning(tokenResponse),
    })

    expect(got).toEqual({
      token: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
      expiresAt: '2026-09-14T11:00:00Z',
      repositories: ['acme/widgets'],
    })
  })
})

describe('installationToken refuses a credential wider than the job', () => {
  // Both cases assert the request was never SENT, not merely that the promise rejected. GitHub
  // mints the credential the moment the POST lands; a guard that runs after the transport lets the
  // wide token exist on GitHub's side and hides it only from the caller. Rejection alone cannot
  // tell those apart — moving both guards below the transport call left all 12 cases green.
  it('will not mint an installation-wide token', async () => {
    // Omitting `repositories` is what GitHub treats as "everything this installation can reach".
    // A review of one pull request never needs that, so the function has no way to ask for it.
    const transport = transportReturning(tokenResponse)

    await expect(installationToken({
      identity, installationId: 4242, repositories: [], now: NOW, transport,
    })).rejects.toThrow(/at least one repository/)

    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses more repositories than GitHub will scope to', async () => {
    const tooMany = Array.from({ length: MAX_SCOPED_REPOSITORIES + 1 }, (_, i) => `repo-${i}`)
    const transport = transportReturning(tokenResponse)

    await expect(installationToken({
      identity, installationId: 4242, repositories: tooMany, now: NOW, transport,
    })).rejects.toThrow(/at most 500 repositories/)

    expect(transport).not.toHaveBeenCalled()
  })

  it('sends permissions verbatim when it is given them, and no key at all when it is not', async () => {
    const withPerms = transportReturning(tokenResponse)
    await installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport: withPerms,
      permissions: { checks: 'write', contents: 'read' },
    })
    expect(vi.mocked(withPerms).mock.calls[0][0].body.permissions).toEqual({ checks: 'write', contents: 'read' })

    const without = transportReturning(tokenResponse)
    await installationToken({ identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport: without })
    // Not `{}`: an empty permissions object is a different request from an absent one.
    expect(Object.keys(vi.mocked(without).mock.calls[0][0].body)).toEqual(['repositories'])
  })
})

describe('the permissions ceiling a review token is held to', () => {
  // REVIEW_TOKEN_PERMISSIONS used to be exported, tested and read by nothing — a claim about how
  // narrow the credential is, with no code behind it. It is the ceiling: what this function will
  // ask GitHub for at most. It is still not the DEFAULT, because whether `pull_requests: write`
  // alone carries the summary comment is settled by Task 15's one real posted review.
  it('refuses contents: write, the one permission the design says the reviewer never gets', async () => {
    // Global Constraints: "The reviewer never gets `contents: write`." This is that sentence as
    // code. The ceiling itself is asserted too, so widening the constant cannot quietly widen the
    // credential — the whole rule is one edit away from meaning nothing.
    expect(REVIEW_TOKEN_PERMISSIONS.contents).toBe('read')
    const transport = transportReturning(tokenResponse)

    await expect(installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport,
      permissions: { contents: 'write' },
    })).rejects.toThrow(/contents: write.*a review exercises contents: read/)

    // Before the POST, like the repository guards: GitHub mints the credential the moment the
    // request lands, so a guard that runs afterwards hides a wide token rather than preventing it.
    expect(transport).not.toHaveBeenCalled()
  })

  it('refuses a permission a review does not exercise, even one the App was granted', async () => {
    // `issues: read` is one of the App's five (it exists because GitHub delivers pull request
    // comments as `issue_comment`), and a review still never needs it on a token.
    const transport = transportReturning(tokenResponse)

    await expect(installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport,
      permissions: { issues: 'read' },
    })).rejects.toThrow(/issues.*a review exercises checks, pull_requests, contents, metadata/)

    expect(transport).not.toHaveBeenCalled()
  })

  it('lets every permission a review does exercise through, at the access the ceiling names', async () => {
    // The ceiling must not be a wall: the four it names have to reach GitHub unchanged, or the
    // refusals above would be indistinguishable from a function that sends nothing.
    const transport = transportReturning(tokenResponse)

    await installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport,
      permissions: { ...REVIEW_TOKEN_PERMISSIONS },
    })

    expect(vi.mocked(transport).mock.calls[0][0].body.permissions).toEqual({
      checks: 'write', pull_requests: 'write', contents: 'read', metadata: 'read',
    })
  })
})

describe('installationToken when GitHub says no', () => {
  it('names the status and the installation, and never the credentials', async () => {
    const transport = transportReturning({ message: 'Bad credentials' }, 401)

    await expect(installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport,
    })).rejects.toThrow(/installation 4242: HTTP 401 — Bad credentials/)

    const jwt = vi.mocked(transport).mock.calls[0][0].jwt
    await installationToken({ identity, installationId: 4242, repositories: ['widgets'], now: NOW, transport })
      .catch((e: unknown) => { expect(String(e)).not.toContain(jwt) })
  })

  it('refuses a 201 that carries no token rather than returning an empty one', async () => {
    await expect(installationToken({
      identity, installationId: 4242, repositories: ['widgets'], now: NOW,
      transport: transportReturning({ expires_at: '2026-09-14T11:00:00Z' }),
    })).rejects.toThrow(/did not carry a token/)
  })
})

afterEach(() => { vi.unstubAllGlobals() })

describe('the default transport', () => {
  it('POSTs to the access_tokens endpoint as the App, with the scoped body', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(tokenResponse), {
      status: 201, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const got = await installationToken({ identity, installationId: 4242, repositories: ['widgets'], now: NOW })

    expect(got.token).toBe('ghs_16C7e42F292c6912E7710c838347Ae178B4a')
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/app/installations/4242/access_tokens')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(headers['x-github-api-version']).toBe(GITHUB_API_VERSION)
    expect(JSON.parse(String(init.body)) as unknown).toEqual({ repositories: ['widgets'] })
  })
})

describe('appIdentityFromEnv', () => {
  it('reads the identity from the two variables a deployment sets, and names them once', () => {
    expect(APP_IDENTITY_VARS).toEqual({
      clientId: 'REVIEW_AGENT_APP_CLIENT_ID', privateKey: 'REVIEW_AGENT_APP_PRIVATE_KEY',
    })
    expect(appIdentityFromEnv({
      REVIEW_AGENT_APP_CLIENT_ID: 'Iv23liR3v13wAg3nt',
      REVIEW_AGENT_APP_PRIVATE_KEY: privateKey,
    })).toEqual({ clientId: 'Iv23liR3v13wAg3nt', privateKeyPem: privateKey })
  })

  it('names every variable that is missing, so one deploy fixes the lot', () => {
    const message = String((() => {
      try { appIdentityFromEnv({}); return '' } catch (e) { return e instanceof Error ? e.message : String(e) }
    })())
    expect(message).toContain('REVIEW_AGENT_APP_CLIENT_ID')
    expect(message).toContain('REVIEW_AGENT_APP_PRIVATE_KEY')
  })

  it('refuses a private key that is not a PEM, without echoing what it was handed', () => {
    // The same planted string the JWT tests use: if it ever appears in a message, key material
    // reaches a log, and a log is not where a private key belongs (design §4.3).
    const planted = 'MIIEpAIBAAKCAQEA-not-a-real-key-PLANTED-SECRET-MATERIAL'
    const message = String((() => {
      try {
        appIdentityFromEnv({
          REVIEW_AGENT_APP_CLIENT_ID: 'Iv23liR3v13wAg3nt', REVIEW_AGENT_APP_PRIVATE_KEY: planted,
        })
        return ''
      } catch (e) { return e instanceof Error ? e.message : String(e) }
    })())
    expect(message).toContain('REVIEW_AGENT_APP_PRIVATE_KEY')
    expect(message).not.toContain(planted)
  })
})

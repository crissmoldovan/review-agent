import { createPrivateKey, createSign } from 'node:crypto'
import { z } from 'zod'

/** The App's CLIENT id (`Iv23li…`), not the numeric App id: GitHub's own guidance for the JWT
 *  `iss` claim is "Use of the client ID is recommended". */
export type AppIdentity = { clientId: string; privateKeyPem: string }

/** GitHub: set `iat` 60 seconds in the past, because a machine whose clock is a little fast would
 *  otherwise mint a token GitHub considers issued in the future. */
export const JWT_BACKDATE_SECONDS = 60

/** `exp - iat`. GitHub rejects more than 600. 540 leaves a minute of headroom on top of the
 *  backdate, so a clock a minute out in EITHER direction still produces a JWT inside the maximum.
 *  Nothing depends on the lifetime: the JWT is minted to buy one installation token, immediately. */
export const JWT_TTL_SECONDS = 540

const b64url = (b: Buffer): string => b.toString('base64url')

export function appJwt(a: { identity: AppIdentity; now?: number }): string {
  const nowSeconds = Math.floor((a.now ?? Date.now()) / 1000)
  const iat = nowSeconds - JWT_BACKDATE_SECONDS
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8'))
  const claims = b64url(
    Buffer.from(JSON.stringify({ iat, exp: iat + JWT_TTL_SECONDS, iss: a.identity.clientId }), 'utf8'),
  )
  const signed = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKeyOf(a.identity))
  return `${signed}.${b64url(signature)}`
}

/** `-----BEGIN <LABEL>-----<body>-----END <LABEL>-----`, with the label captured so the closing line
 *  must repeat it: a block whose BEGIN and END disagree is not a PEM and is left for OpenSSL to
 *  refuse, rather than being stitched into a plausible-looking one here. */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/

/** Repairs a PEM whose NEWLINES a web form destroyed, and nothing else.
 *
 *  This is not defensive tidiness. Task 15's first hosted run died 6.2 seconds in, here, having
 *  spent $0 and posted nothing, because the .pem pasted into the deployment's
 *  `REVIEW_AGENT_APP_PRIVATE_KEY` box arrived with its line breaks flattened. The key was whole;
 *  only its whitespace was gone. Measured on Node 26.7.0 / OpenSSL 3.5.7 against a throwaway key:
 *  newlines turned into spaces, and newlines stored as the two characters `\` and `n`, are each
 *  refused with `error:1E08010C:DECODER routines::unsupported` — and each is byte-identical to the
 *  original once put back through here. A key whose header and footer sit on their own lines but
 *  whose body is one long line already works untouched, which is why an existing newline is taken
 *  as "this PEM still has its structure" and the value returned unread.
 *
 *  What it deliberately does NOT do is rescue a key that is actually broken: the body is only
 *  re-wrapped, never repaired, so a corrupt key, a mismatched BEGIN/END pair and a value that is
 *  not a PEM at all are all handed straight through to be refused. Tolerating whitespace must not
 *  become tolerating a bad credential. */
export const normalisePrivateKeyPem = (value: string): string => {
  const unescaped = value.includes('\\n') ? value.replace(/\\r\\n|\\n/g, '\n') : value
  if (unescaped.includes('\n')) return unescaped
  const block = PEM_BLOCK.exec(unescaped)
  if (block === null) return unescaped
  const body = block[2].replace(/\s+/g, '')
  return `-----BEGIN ${block[1]}-----\n${body.replace(/.{1,64}/g, '$&\n')}-----END ${block[1]}-----\n`
}

/** This module handles the App private key, so the original error is deliberately dropped rather
 *  than chained: a stack trace that carries key material into a log is worse than a vague message.
 *  The normaliser is inside the `try` for the same reason — whatever it does with the value, the
 *  only thing that escapes this function is the sentence below. */
const privateKeyOf = (identity: AppIdentity) => {
  try {
    return createPrivateKey(normalisePrivateKeyPem(identity.privateKeyPem))
  } catch {
    throw new Error('the App private key is not a usable PEM private key')
  }
}

/** Current GitHub docs examples send this header. Pinning it deliberately (rather than letting the
 *  API default drift) means a future breaking version cannot arrive without a diff in this repo. */
export const GITHUB_API_VERSION = '2026-03-10'

/** GitHub's documented cap on the `repositories` array of a scoped token request. */
export const MAX_SCOPED_REPOSITORIES = 500

/** The permissions a review actually exercises, out of the five the App is granted (design §5), and
 *  the CEILING this module holds every token request to: `installationToken` will not ask GitHub for
 *  a permission this record does not name, nor for `write` where it says `read`, so Global
 *  Constraints' "the reviewer never gets `contents: write`" is a line of code rather than a habit.
 *  It is the ceiling and not the DEFAULT: nothing is sent unless a caller asks, because whether
 *  `pull_requests: write` alone carries the summary comment — which is posted through the issues
 *  endpoint — is settled by Task 15's one real posted review and not by a guess here. Repository
 *  scoping already narrows the credential in the dimension that matters most: one repository
 *  instead of every repository in the installation.
 *  Widening this record widens what a token may be minted with, which is why the test asserts its
 *  contents as well as the refusals. Task 15 may add `issues: write` here, with its reason. */
export const REVIEW_TOKEN_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  checks: 'write',
  pull_requests: 'write',
  contents: 'read',
  metadata: 'read',
})

const ACCESS_RANK: Readonly<Record<'read' | 'write', number>> = { read: 1, write: 2 }

/** Throws on the first permission that exceeds the ceiling, naming it and what a review exercises
 *  instead. Never called after the transport: GitHub mints the credential the moment the request
 *  lands, so a guard that runs afterwards hides a wide token rather than preventing one. */
const withinReviewPermissions = (permissions: Record<string, 'read' | 'write'>): void => {
  const exercised = Object.keys(REVIEW_TOKEN_PERMISSIONS).join(', ')
  for (const [name, access] of Object.entries(permissions)) {
    const ceiling = REVIEW_TOKEN_PERMISSIONS[name]
    if (ceiling === undefined) {
      throw new Error(`a review token may not ask for ${name}: a review exercises ${exercised}, and nothing else`)
    }
    if (ACCESS_RANK[access] > ACCESS_RANK[ceiling]) {
      throw new Error(`a review token may not ask for ${name}: ${access} — a review exercises ${name}: ${ceiling}`)
    }
  }
}

export type TokenTransport = (a: {
  installationId: number
  jwt: string
  body: { repositories: string[]; permissions?: Record<string, 'read' | 'write'> }
}) => Promise<{ status: number; data: unknown }>

/** `expiresAt` is passed through as GitHub wrote it, not parsed into a Date: the caller's only job
 *  is to notice that the token dies in an hour, which is why one is minted per review rather than
 *  cached anywhere. */
export type InstallationToken = { token: string; expiresAt: string; repositories: string[] }

const TokenResponse = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
})
const ErrorBody = z.object({ message: z.string() })

const githubTransport: TokenTransport = async ({ installationId, jwt, body }) => {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'content-type': 'application/json',
      'user-agent': 'review-agent',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = null // a proxy's HTML error page is not worth a parse failure; the status is the signal
  }
  return { status: res.status, data }
}

export async function installationToken(a: {
  identity: AppIdentity
  installationId: number
  repositories: string[]
  permissions?: Record<string, 'read' | 'write'>
  now?: number
  transport?: TokenTransport
}): Promise<InstallationToken> {
  // The scope is not advice. A token that can reach every repository in the installation is a
  // wider credential than a review of one pull request needs, so this function cannot produce one.
  if (a.repositories.length === 0) {
    throw new Error('an installation token must be scoped to at least one repository')
  }
  if (a.repositories.length > MAX_SCOPED_REPOSITORIES) {
    throw new Error(`GitHub scopes a token to at most ${MAX_SCOPED_REPOSITORIES} repositories`)
  }
  if (a.permissions !== undefined) withinReviewPermissions(a.permissions)
  const { status, data } = await (a.transport ?? githubTransport)({
    installationId: a.installationId,
    jwt: appJwt({ identity: a.identity, ...(a.now !== undefined && { now: a.now }) }),
    body: {
      repositories: a.repositories,
      ...(a.permissions !== undefined && { permissions: a.permissions }),
    },
  })
  if (status !== 201) {
    const message = ErrorBody.safeParse(data)
    throw new Error(
      `GitHub refused an installation token for installation ${a.installationId}: HTTP ${status}` +
      (message.success ? ` — ${message.data.message.slice(0, 200)}` : ''),
    )
  }
  const parsed = TokenResponse.safeParse(data)
  if (!parsed.success) {
    throw new Error('the installation token response did not carry a token and an expiry')
  }
  return {
    token: parsed.data.token,
    expiresAt: parsed.data.expires_at,
    repositories: (parsed.data.repositories ?? []).map((r) => r.full_name),
  }
}

/** The two variables a deployment sets so the runner can mint tokens. Named once, here, beside the
 *  only code that touches the key: the internet-facing half never holds it (plan 2's Global
 *  Constraints), and Task 8's import-graph test enforces that.
 *  The CLIENT id, not the App id: the JWT's `iss` is the client ID ("Use of the client ID is
 *  recommended", docs/plans/2026-09-14-verified-api-facts.md, "Installation tokens"). */
export const APP_IDENTITY_VARS = {
  clientId: 'REVIEW_AGENT_APP_CLIENT_ID',
  privateKey: 'REVIEW_AGENT_APP_PRIVATE_KEY',
} as const

/** Reads the App identity, or throws naming the variables and never a value. The PEM test is a
 *  shape check only — header and footer — because whether the key actually parses is `appJwt`'s
 *  business, and it already fails without echoing key material. It exists so that the commonest
 *  mistake (pasting the App id, or half a file) is caught where the fix is, rather than inside a
 *  signature failure an hour later. */
export const appIdentityFromEnv = (env: Record<string, string | undefined>): AppIdentity => {
  const clientId = env[APP_IDENTITY_VARS.clientId] ?? ''
  const privateKeyPem = env[APP_IDENTITY_VARS.privateKey] ?? ''
  const missing = [
    ...(clientId === '' ? [APP_IDENTITY_VARS.clientId] : []),
    ...(privateKeyPem === '' ? [APP_IDENTITY_VARS.privateKey] : []),
  ]
  if (missing.length > 0) {
    throw new Error(
      `the App identity is not set: ${missing.join(' and ')}. The client id is on the App's ` +
      'General page; the private key is the .pem generated there. No review can mint a token ' +
      'without both.',
    )
  }
  if (!privateKeyPem.includes('-----BEGIN') || !privateKeyPem.includes('PRIVATE KEY-----')) {
    throw new Error(
      `${APP_IDENTITY_VARS.privateKey} is set but is not a PEM private key: no ` +
      '"BEGIN … PRIVATE KEY" header. Paste the whole .pem file, header and footer included.',
    )
  }
  return { clientId, privateKeyPem }
}

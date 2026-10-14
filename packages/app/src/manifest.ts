/** The App manifest and its conversion — design §5. Nothing in this file touches the filesystem:
 *  the three secrets the conversion returns are carried in memory, wrapped, and dropped by the
 *  caller. Only the operator handles credentials (Criss, 2026-09-14). */

/** Design §5, and plan 2's Global Constraints, which this product adopts: the
 *  reviewer reads code and writes reviews, so `contents` is READ and nothing in this product has a
 *  push path. `issues: read` is not decoration — GitHub delivers a pull request comment as an
 *  `issue_comment` event, so without it the `/review` command never arrives at all. */
export const APP_PERMISSIONS = {
  checks: 'write',
  pull_requests: 'write',
  contents: 'read',
  metadata: 'read',
  issues: 'read',
} as const satisfies Record<string, 'read' | 'write'>

/** `pull_request` for opened and first-ready-for-review, `issue_comment` for the command word,
 *  `check_run` for the Re-run button's `requested_action` (design §5). Nothing else is subscribed:
 *  an event the product ignores is a delivery it pays to verify and throw away. */
export const APP_EVENTS = ['pull_request', 'issue_comment', 'check_run'] as const

/** A wire document, which is why the keys are snake_case while the rest of the codebase is not. */
export type AppManifest = {
  name: string
  url: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  public: boolean
  default_events: string[]
  default_permissions: Record<string, 'read' | 'write'>
}

export type ManifestInput = {
  name: string
  /** GitHub requires a homepage on the manifest. */
  url: string
  /** Where deliveries go: whatever receiver the deployment runs. */
  webhookUrl: string
  /** Where GitHub sends the operator back with the one-hour code. */
  redirectUrl: string
  /** Default false: an App one deployment installs has no reason to be listed publicly. */
  public?: boolean
  /** Default true. `false` registers the App with its webhook off — for an App, like Task 15's
   *  throwaway one, that is driven in process and must never be delivered to (decision 9). */
  webhookActive?: boolean
}

export const buildManifest = (i: ManifestInput): AppManifest => ({
  name: i.name,
  url: i.url,
  hook_attributes: { url: i.webhookUrl, active: i.webhookActive !== false },
  redirect_url: i.redirectUrl,
  public: i.public === true,
  default_events: [...APP_EVENTS],
  default_permissions: { ...APP_PERMISSIONS },
})

export const REDACTED = '[redacted]'

/** A value the operator owns and this product only carries. The value lives in a closure, so
 *  `console.log(app)` and `util.inspect` cannot reach it, and `toString`/`toJSON` cover the two
 *  ways it would otherwise reach a terminal: a template literal and a JSON dump of a whole result.
 *  Reading it is one call that greps as `.reveal()`, so every place it happens can be found. */
export type Secret = {
  reveal: () => string
  toString: () => string
  toJSON: () => string
}

export const secret = (value: string): Secret => ({
  reveal: () => value,
  toString: () => REDACTED,
  toJSON: () => REDACTED,
})

export class ManifestConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestConversionError'
  }
}

/** Injected, not imported: the conversion is authenticated by the one-hour code and nothing else,
 *  so the package that will later hold the App's private key never constructs an authenticated
 *  client in order to register one. */
export type ManifestRequester = {
  request: (route: string, params: { code: string }) => Promise<{ data: unknown }>
}

export type ConvertedApp = {
  id: number
  slug: string
  clientId: string
  /** Exactly `APP_PERMISSIONS`: a conversion answering with anything else is rejected below. */
  permissions: typeof APP_PERMISSIONS
  clientSecret: Secret
  webhookSecret: Secret
  pem: Secret
}

const asRecord = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ManifestConversionError(`${what} is not an object`)
  }
  return v as Record<string, unknown>
}

const str = (o: Record<string, unknown>, key: string): string => {
  const v = o[key]
  if (typeof v !== 'string' || v === '') {
    throw new ManifestConversionError(`the conversion response carried no ${key}`)
  }
  return v
}

const int = (o: Record<string, unknown>, key: string): number => {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ManifestConversionError(`the conversion response carried no ${key}`)
  }
  return v
}

const list = (o: Record<string, unknown>, key: string): unknown[] => {
  const v = o[key]
  if (!Array.isArray(v)) throw new ManifestConversionError(`the conversion response carried no ${key}`)
  return v
}

const sortedEntries = (o: Record<string, unknown>): [string, unknown][] =>
  Object.entries(o).sort(([a], [b]) => a.localeCompare(b))

/** Reads the 201 body of `POST /app-manifests/{code}/conversions`. Two of these checks are not
 *  validation, they are the point of the function: an App registered with a permission the manifest
 *  did not ask for, or missing the event the command word arrives on, is a registration to delete
 *  and redo — not a warning to print. */
export const readConversion = (data: unknown): ConvertedApp => {
  const o = asRecord(data, 'the conversion response')
  const permissions = asRecord(o.permissions, 'the registered permissions')
  if (JSON.stringify(sortedEntries(permissions)) !== JSON.stringify(sortedEntries({ ...APP_PERMISSIONS }))) {
    throw new ManifestConversionError(
      `GitHub registered ${JSON.stringify(permissions)}, which is not what the manifest asked for ` +
      `(${JSON.stringify(APP_PERMISSIONS)}). Delete the App on GitHub and register it again.`,
    )
  }
  const events = list(o, 'events')
  if (!APP_EVENTS.every((e) => events.includes(e))) {
    throw new ManifestConversionError(
      `GitHub registered events ${JSON.stringify(events)}, which is missing one the triggers need ` +
      `(design §5 needs ${APP_EVENTS.join(', ')}).`,
    )
  }
  return {
    id: int(o, 'id'),
    slug: str(o, 'slug'),
    clientId: str(o, 'client_id'),
    permissions: { ...APP_PERMISSIONS },
    clientSecret: secret(str(o, 'client_secret')),
    webhookSecret: secret(str(o, 'webhook_secret')),
    pem: secret(str(o, 'pem')),
  }
}

export const convertManifest = async (
  { requester, code }: { requester: ManifestRequester; code: string },
): Promise<ConvertedApp> => {
  // POST /app-manifests/{code}/conversions → 201 with the App plus client_secret, webhook_secret
  // and pem. GitHub gives the whole manifest flow one hour, and the code is its only credential.
  const { data } = await requester.request('POST /app-manifests/{code}/conversions', { code })
  return readConversion(data)
}

import { type ConvertedApp, type ManifestRequester, buildManifest, convertManifest } from '@review-agent/app'
import { EXIT_BAD_USAGE, EXIT_ENGINE_FAILURE, EXIT_OK } from './exit-codes'
import { UsageError } from './flags'
import type { listenForManifestCode } from './init-server'

export type InitFlags = {
  name?: string
  url?: string
  webhookUrl?: string
  org?: string
  /** Register with the webhook off (decision 9): for an App driven in process, like Task 15's. */
  webhookInactive?: boolean
}

/** No filesystem and no logger in here, on purpose: a dependency set with nowhere to write is how
 *  "init never stores a credential" stays true after somebody edits this file. */
export type InitDeps = {
  listenForManifestCode: typeof listenForManifestCode
  convertManifest: typeof convertManifest
  makeRequester: () => ManifestRequester
  randomState: () => string
  stdout: (s: string) => void
  stderr: (s: string) => void
}

const required = (value: string | undefined, flag: string, what: string): string => {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required: ${what}`)
  return value
}

/** What the operator is told, and what they are not. GitHub returned a private key, a webhook
 *  secret and a client secret a few lines ago; this prints none of them and the caller drops them.
 *  Criss, 2026-09-14: only the operator handles credentials, and a printed secret is in scrollback,
 *  in shell history and in whatever records the terminal. Nothing is lost by discarding GitHub's
 *  copies — the App's own settings page mints all three again, which is the only place they should
 *  ever exist. Discarding this process's copy does not delete GitHub's, so the list ends with the
 *  operator deleting the registration-time key and client secret (Criss, 2026-09-14, decision 11). */
const instructions = (app: ConvertedApp): string => [
  '',
  `Registered. App id ${app.id}, slug ${app.slug}, client id ${app.clientId}.`,
  `Permissions GitHub stored: ${Object.entries(app.permissions).map(([k, v]) => `${k}: ${v}`).join(', ')}.`,
  '',
  'GitHub also returned a private key, a webhook secret and a client secret with that registration.',
  'review-agent did not print them, did not store them, and has dropped them. GitHub has not: its',
  'copies stay live on the App until you delete them. Only you handle credentials. Open the App on',
  'GitHub (Settings -> Developer settings -> GitHub Apps -> your App) and do these five things, in order:',
  '',
  '  1. Private keys -> Generate a private key. Keep the downloaded .pem out of any repository.',
  '  2. Private keys -> Delete the private key that was created with the registration (the older',
  '     one, not the one you just generated). Nothing uses it, and an unused key is still a key.',
  '  3. Client secrets -> Delete the client secret that was created with the registration. This',
  '     reviewer never uses a client secret.',
  '  4. Webhook -> Secret. Choose a value, save it on GitHub, keep the same value for the deployment.',
  '     Saving it replaces the secret GitHub generated. (An App registered with --webhook-inactive',
  '     receives no deliveries; it needs no secret.)',
  '  5. Install App -> install it on the repositories it should review, and nothing else.',
  '',
  'docs/deploying.md names the environment variable each value goes into, and shows the three calls',
  'a receiver makes.',
  '',
].join('\n')

export const runInitCommand = async (flags: InitFlags, deps: InitDeps): Promise<number> => {
  try {
    const name = required(flags.name, '--name', 'the App name GitHub will show')
    const url = required(flags.url, '--url', 'the App homepage; GitHub requires one on the manifest')
    const webhookUrl = required(
      flags.webhookUrl, '--webhook-url',
      // A neutral example on purpose: this string is bundled into the published CLI, and a public
      // npm tarball names no deployment (Task 16's customer-name lock reads dist for exactly this).
      'where GitHub delivers events, e.g. https://example.com/api/github/webhook',
    )
    const state = deps.randomState()
    const registrationUrl = flags.org === undefined || flags.org === ''
      ? `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/organizations/${encodeURIComponent(flags.org)}` +
        `/settings/apps/new?state=${encodeURIComponent(state)}`
    const listener = await deps.listenForManifestCode({
      registrationUrl,
      state,
      note: (s) => deps.stderr(s),
      manifestFor: (redirectUrl) => buildManifest({
        name, url, webhookUrl, redirectUrl, webhookActive: flags.webhookInactive !== true,
      }),
    })
    deps.stdout(
      `Open this page and press the button: ${listener.formUrl}\n` +
      `It posts the manifest to ${flags.org === undefined || flags.org === '' ? 'your account' : flags.org}; ` +
      'GitHub shows you what it will create before anything exists.\n' +
      'GitHub gives this flow one hour.\n',
    )
    const code = await listener.code
    await listener.close()
    const app = await deps.convertManifest({ requester: deps.makeRequester(), code })
    deps.stdout(instructions(app))
    return EXIT_OK
  } catch (e) {
    if (e instanceof UsageError) {
      deps.stderr(e.message)
      return EXIT_BAD_USAGE
    }
    // 1 is the CLI's failure code. `init` has no engine, and the exit-code table does not grow a
    // fourth entry for one command: a registration that did not finish is this command failing.
    deps.stderr(e instanceof Error ? e.message : String(e))
    return EXIT_ENGINE_FAILURE
  }
}

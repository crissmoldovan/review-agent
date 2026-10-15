import type { Octokit } from '@octokit/core'
import { defaultDeploymentConfig, gatewayBaseUrlRefusal, MODEL_CREDENTIAL_VARS } from '@review-agent/core'
import { pushAccessOf, tokenIdentityOf, type TokenIdentity } from '@review-agent/github'
import { EXIT_BAD_USAGE, EXIT_OK } from './exit-codes'
import { apiBaseUrlFor, GITHUB_COM, parseGitHubHost, parseRepo, UsageError } from './flags'
import { findGitHubToken, noTokenAdvice, tokenNeeds, type GhCli, type GitHubTokenSource } from './github-token'

export type DoctorFlags = { repo?: string; githubHost?: string }

/** Everything doctor touches, so every line it can print is reachable from a test with fakes, and no
 *  test runs a real `claude`, a real `gh` or a real request to GitHub. */
export type DoctorDeps = {
  env: Record<string, string | undefined>
  /** `process.versions.node`. */
  nodeVersion: string
  /** For the install command a fix names. */
  platform: NodeJS.Platform
  /** core's `resolveClaudeBinary`, bound to this environment: the binary a review would run, or why
   *  there is none. */
  resolveClaudeBinary: () => string
  claudeVersion: (bin: string) => Promise<string>
  gh: GhCli
  makeOctokit: (a: { token: string; baseUrl?: string }) => Octokit
  stdout: (s: string) => void
  stderr: (s: string) => void
}

type Mark = '✓' | '✗' | '!'
/** One finding about this machine. `✗` is something `review --post` cannot do without, and always
 *  carries a fix; `!` is worth knowing and blocks nothing. */
type Line = { mark: Mark; text: string; fix?: string }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown): number | null =>
  typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number'
    ? (e as { status: number }).status
    : null

const installClaude = (platform: NodeJS.Platform): string =>
  "install Claude Code with Anthropic's installer — " +
  (platform === 'win32'
    ? 'in PowerShell, irm https://claude.ai/install.ps1 | iex, or winget install Anthropic.ClaudeCode'
    : 'curl -fsSL https://claude.ai/install.sh | bash') +
  ' — or set REVIEW_AGENT_CLAUDE_BIN to the absolute path of the real binary'

const sourceOf = (source: GitHubTokenSource, host: string): string => {
  switch (source) {
    case 'GITHUB_TOKEN': return 'GITHUB_TOKEN'
    case 'GH_TOKEN': return 'GH_TOKEN (GITHUB_TOKEN is not set)'
    case 'gh': return `the GitHub CLI's login for ${host} (gh auth token)`
  }
}

/** What the token can reach, as far as GitHub says (spec 0.2.0 §10): names and scopes, never a value. */
const identityLine = (id: TokenIdentity, host: string): string => {
  const on = host === GITHUB_COM ? '' : ` on ${host}`
  if (id.kind === 'installation') {
    return `GitHub identity${on}: an App installation token (GitHub Actions' GITHUB_TOKEN is one) — ` +
      'it reaches only the repositories it was issued for'
  }
  if (id.scopes === undefined) {
    return `GitHub identity${on}: @${id.login} — GitHub lists no scopes for this token, as for a fine-grained ` +
      'token: it reaches the repositories it was given'
  }
  return `GitHub identity${on}: @${id.login} — scopes: ${id.scopes.length === 0 ? 'none' : id.scopes.join(', ')} — ` +
    `a classic token or a gh login reaches every repository @${id.login} can, within its scopes`
}

/** `review-agent doctor` (spec 0.2.0 §5.1): is this machine ready for `review-agent review --post`?
 *
 *  One line per check, `✓`, `✗` or `!`, and a fix under every `✗`. Exit 0 when nothing is `✗`, 2
 *  otherwise — 2 being the CLI's "something is missing" (§5.5).
 *
 *  It READS and never writes: no check run, no status, no comment, and no model call, so it costs
 *  nothing and can run anywhere. That is also its limit, said on the lines it applies to: whether a
 *  fine-grained token may set a status, or whether `claude login` is logged in, cannot be learned
 *  without doing the thing.
 *
 *  It never prints a token, a key or any credential's value: credentials by NAME and kind, the GitHub
 *  token by where it came from, the identity by login and scope names. And in case an error message
 *  quotes one, every value it holds is taken out of what it prints. */
export const runDoctorCommand = async (flags: DoctorFlags, deps: DoctorDeps): Promise<number> => {
  let host: string
  let target: { owner: string; repo: string } | null
  try {
    host = parseGitHubHost(flags.githubHost)
    target = flags.repo === undefined ? null : parseRepo(flags.repo)
  } catch (e) {
    if (e instanceof UsageError) { deps.stderr(e.message); return EXIT_BAD_USAGE }
    throw e
  }

  // Every value this command can hold that must never be printed: the model credentials, the GitHub
  // token once found (it may have come from gh rather than the environment). Short values are left
  // alone — replacing every "1" in the output would say nothing and hide everything.
  const secrets = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
    .map((k) => deps.env[k] ?? '').filter((v) => v.length >= 8))
  const lines: Line[] = []
  const say = (mark: Mark, text: string, fix?: string): void => { lines.push({ mark, text, ...(fix !== undefined && { fix }) }) }

  // ── This machine ──────────────────────────────────────────────────────────────────────────────
  const nodeMajor = Number(deps.nodeVersion.replace(/^v/, '').split('.')[0])
  if (Number.isInteger(nodeMajor) && nodeMajor >= 22) say('✓', `Node.js ${deps.nodeVersion}`)
  else say('✗', `Node.js ${deps.nodeVersion}: review-agent needs 22 or newer`, 'install Node.js 22 or newer from https://nodejs.org')

  let bin: string | null = null
  try {
    bin = deps.resolveClaudeBinary()
    say('✓', `Claude Code: ${bin}`)
  } catch (e) {
    // core's own sentence, which names the file it found (npm's placeholder) or says none was found.
    say('✗', messageOf(e), installClaude(deps.platform))
  }
  if (bin !== null) {
    try {
      say('✓', `Claude Code version: ${await deps.claudeVersion(bin)}`)
    } catch (e) {
      say('✗', `Claude Code did not answer --version: ${messageOf(e)}`,
        `run ${bin} --version yourself to see why; if it fails there too, ${installClaude(deps.platform)}`)
    }
  }

  // ── The model credential: by name and kind, never a value (spec 0.2.0 §2.3, decision §14.4) ──────
  if (gatewayBaseUrlRefusal(deps.env) !== null) {
    say('✗', 'ANTHROPIC_BASE_URL is set: the reviewer sends the reviewed code only to Anthropic, and refuses to run pointed anywhere else',
      deps.platform === 'win32' ? 'unset it: Remove-Item Env:ANTHROPIC_BASE_URL' : 'unset it: unset ANTHROPIC_BASE_URL')
  } else {
    say('✓', 'ANTHROPIC_BASE_URL is not set')
  }
  const set = MODEL_CREDENTIAL_VARS.filter((k) => (deps.env[k] ?? '') !== '')
  if (set.length > 1) {
    say('✗', `model credential: ${set.join(' and ')} are both set, so nobody could say which account a review is billed to`,
      'unset one of them; or both, to use this machine’s `claude login`')
  } else if (set[0] === 'ANTHROPIC_API_KEY') {
    say('✓', 'model credential: ANTHROPIC_API_KEY — an Anthropic API key, billed at per-token API prices')
  } else if (set[0] === 'CLAUDE_CODE_OAUTH_TOKEN') {
    say('✓', "model credential: CLAUDE_CODE_OAUTH_TOKEN — a subscription token, drawn from that subscription's allowance")
  } else {
    say('!', "model credential: none set, so Claude Code's own login (`claude login`) will be used — doctor cannot " +
      'tell whether it is logged in without starting a session; a review that is not says "Not logged in"')
  }

  // ── GitHub ────────────────────────────────────────────────────────────────────────────────────
  const slug = target === null ? null : `${target.owner}/${target.repo}`
  const found = await findGitHubToken({ env: deps.env, host, gh: deps.gh })
  let identity: TokenIdentity | null = null
  let octokit: Octokit | null = null
  if (found.kind === 'none') {
    say('✗', 'GitHub token: none found', noTokenAdvice({ host, gh: found.gh, need: 'post', repo: slug }))
  } else {
    if (found.token.length >= 8) secrets.add(found.token)
    say('✓', `GitHub token: from ${sourceOf(found.source, host)}`)
    const baseUrl = apiBaseUrlFor(host)
    octokit = deps.makeOctokit({ token: found.token, ...(baseUrl !== undefined && { baseUrl }) })
    try {
      identity = await tokenIdentityOf(octokit)
      say('✓', identityLine(identity, host))
    } catch (e) {
      if (statusOf(e) === 401) {
        say('✗', `GitHub refused the token from ${sourceOf(found.source, host)} (401): it is wrong, expired or revoked`,
          `make a new one and set it again, or run gh auth login --web --hostname ${host}`)
      } else {
        say('✗', `could not ask GitHub who the token belongs to: ${messageOf(e)}`,
          host === GITHUB_COM ? 'check the network connection, and try again'
            : `check the network connection, and that ${host} is a GitHub Enterprise Server`)
      }
    }
  }

  // ── What it can do on the repository ──────────────────────────────────────────────────────────
  if (identity !== null && octokit !== null) {
    const name = defaultDeploymentConfig().report.checkRunName
    if (target === null || slug === null) {
      say('!', 'no --repo given: what this token can do on a repository was not checked (review-agent doctor --repo owner/name)')
    } else {
      let isPrivate: boolean | null = null
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}', { owner: target.owner, repo: target.repo })
        isPrivate = (res.data as { private?: unknown }).private === true
        say('✓', `${slug}: readable (${isPrivate ? 'private' : 'public'})`)
      } catch (e) {
        if (statusOf(e) === 404) {
          say('✗', `${slug}: not found, or this token cannot read it`,
            `check the name; the token needs ${tokenNeeds('read', slug)}`)
        } else {
          say('✗', `${slug}: GitHub would not say whether it is readable: ${messageOf(e)}`, 'try again; if it persists, check the token')
        }
      }
      if (isPrivate !== null) {
        if (identity.kind === 'user') {
          try {
            if (await pushAccessOf({ octokit, owner: target.owner, repo: target.repo, username: identity.login })) {
              say('✓', `@${identity.login} has push access to ${slug}, which a commit status needs`)
            } else {
              say('✗', `@${identity.login} has no push access to ${slug}, and a commit status needs it`,
                'ask for write access to it, or post without a status: review-agent review --post --report none')
            }
          } catch (e) {
            say('!', `could not tell whether @${identity.login} has push access to ${slug}: ${messageOf(e)}`)
          }
          if (identity.scopes !== undefined) {
            const enough = identity.scopes.includes('repo') || (!isPrivate && identity.scopes.includes('public_repo'))
            if (!enough) {
              say('✗', `this token's scopes (${identity.scopes.length === 0 ? 'none' : identity.scopes.join(', ')}) cannot post to ${slug}`,
                'give it the repo scope — public_repo is enough for a public repository — or use another token')
            }
          } else {
            say('!', `GitHub does not list what this token may do: to post on ${slug} a fine-grained token needs ` +
              'Contents: Read, Pull requests: Read and Write, and Commit statuses: Write, which doctor cannot check without writing')
          }
        } else {
          say('!', "an installation token's permissions are not listed by GitHub: to post, a workflow needs " +
            'pull-requests: write, and checks: write for a check run (or statuses: write for a commit status)')
        }
      }
    }
    // Spec 0.2.0 §5.4: said wherever a status is mentioned.
    if (identity.kind === 'user') {
      say('!', `report: a commit status "${name}" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone ` +
        'with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App')
    } else {
      say('✓', `report: a check run "${name}" (a commit status if the token cannot create check runs)`)
    }
  }

  const failed = lines.filter((l) => l.mark === '✗').length
  const scrub = (s: string): string => [...secrets].reduce((t, v) => t.split(v).join('[redacted]'), s)
  const text = [
    ...lines.flatMap((l) => [`${l.mark} ${l.text}`, ...(l.fix === undefined ? [] : [`  fix: ${l.fix}`])]),
    '',
    failed === 0
      ? 'Ready for `review-agent review --post`.'
      : `Not ready for \`review-agent review --post\`: ${failed} ${failed === 1 ? 'problem' : 'problems'} above.`,
  ].join('\n') + '\n'
  deps.stdout(scrub(text))
  return failed === 0 ? EXIT_OK : EXIT_BAD_USAGE
}

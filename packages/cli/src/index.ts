import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Octokit } from '@octokit/core'
import { convertManifest } from '@review-agent/app'
import { defaultSkillCacheDir, resolveClaudeBinary } from '@review-agent/core'
import { defaultRunReviewDeps, octokitFor } from '@review-agent/github'
import { Command } from 'commander'
import { claudeVersionOf } from './claude-version'
import { askYesNo } from './confirm'
import { runDoctorCommand } from './doctor-command'
import { EXIT_BAD_USAGE, EXIT_OK } from './exit-codes'
import { liveGhCli } from './github-token'
import { runInitCommand } from './init-command'
import { listenForManifestCode } from './init-server'
import { cancelOnSignals } from './interrupt'
import { runReviewCommand } from './review-command'
import { CLI_VERSION } from './version'

const program = new Command()
program
  .name('review-agent')
  .description('Review a pull request with an agent that only reads.')
  // Spec 0.2.0 §5.1. The version is in the bundle (version.ts), so it is right wherever npm put it.
  .version(CLI_VERSION, '-V, --version', 'print the version')

// commander's own exit code for an unknown flag is 1, and 1 is reserved for an engine failure.
// Set before `.command('review')`: a subcommand copies its parent's exit callback when it is created,
// so an override added afterwards never reaches `review`'s own unknown-option error. Commander has
// already written its own message by the time this runs, so only the exit code is decided here.
program.exitOverride((e) => {
  process.exit(e.exitCode === 0 ? EXIT_OK : EXIT_BAD_USAGE)
})

const stdout = (s: string): void => { process.stdout.write(s) }
const stderr = (s: string): void => { process.stderr.write(s + '\n') }

program
  .command('review')
  // .option, not .requiredOption: every usage message in this CLI comes from parseFlags, so there is
  // one place that decides what a bad invocation says and one exit code it produces. For the same
  // reason no option is given a default here: parseFlags supplies them, and can tell a flag that was
  // typed from one that was not (`--report` without `--post` is refused, spec 0.2.0 §5.2).
  .option('--repo <owner/name>', 'the repository, as owner/name')
  .option('--pr <number>', 'the pull request number')
  .option('--tier <tier>', 'basic | normal | thorough')
  .option('--multi', 'three focused reviewers — intent, impact, security — instead of one, with any tier')
  .option('--model <model>', 'the model to run, e.g. claude-opus-5')
  .option('--effort <effort>', 'low | medium | high | xhigh | max')
  .option('--check', 'run the disprove-it pass, whatever the tier says')
  .option('--skip-check', 'skip the disprove-it pass, whatever the tier says')
  .option('--brief <text>', 'extra context for the reviewer; it is data, never instruction')
  .option('--budget <usd>', 'lower the tier budget (it can never be raised)')
  .option('--post', 'post the review, its inline comments and summary as the token’s identity, and report on the commit')
  .option('--report <kind>', 'with --post: auto | check-run | status | none (default auto)')
  // Both spellings, `--re-review` first: commander then leaves the value undefined unless one is
  // typed, and parseFlags decides the default — on with --post.
  .option('--re-review', 'with --post: read the earlier summary and run the re-review pass (the default)')
  .option('--no-re-review', 'with --post: skip the re-review pass')
  .option('--github-host <host>', 'GitHub Enterprise Server host (default github.com)')
  .option('--keep-checkout', 'keep the downloaded code after the review, and print where it is')
  .option('--yes', 'post without asking first (there is no question without a terminal)')
  .option('--json', 'print the machine-readable review record instead of a summary')
  .action(async (flags) => {
    const interrupt = cancelOnSignals({
      on: (s, l) => process.on(s, l),
      off: (s, l) => process.off(s, l),
      exit: (code) => process.exit(code),
      stderr,
    })
    try {
      // The collaborators every way in shares (spec 0.2.0 §3.1): GitHub, the archive, the engine and
      // its passes, a new checkout per review under the system temp directory. `note` is the
      // command's own stderr, so it is taken off here and the command passes it back in.
      const { note: _note, ...pipeline } = defaultRunReviewDeps({ note: () => undefined })
      process.exitCode = await runReviewCommand(flags, {
        ...pipeline,
        // The same client the App's runner builds, with the API version pinned, so the CLI reads the
        // API the rest of this product was proven against; `baseUrl` for GitHub Enterprise Server.
        makeOctokit: (a) => octokitFor(a),
        // This OS's own cache directory unless the user names one (spec 0.2.0 §9.3 P13). Empty counts as
        // unset, as it does for REVIEW_AGENT_CLAUDE_BIN. Read per review, as before, and not checked
        // here: a relative one is refused by `materialiseSkills`, and only when a skill needs it.
        skillCacheDir: () => {
          const named = process.env.REVIEW_AGENT_SKILL_CACHE ?? ''
          return named !== '' ? named : defaultSkillCacheDir()
        },
        stdout,
        stderr,
        env: process.env,
        gh: liveGhCli(process.env),
        // A person can answer only when stdin is a terminal. In CI it is not, so nothing is asked and
        // nothing waits (spec 0.2.0 §5.2: --yes is always on without a terminal).
        interactive: process.stdin.isTTY === true,
        confirm: (question, signal) => askYesNo({
          input: process.stdin, output: process.stderr, question, ...(signal !== undefined && { signal }),
        }),
      }, { signal: interrupt.signal })
    } finally {
      interrupt.dispose()
    }
  })

program
  .command('doctor')
  .description('check this machine for `review --post`: Node, Claude Code, the model credential, the GitHub token and what it can do')
  .option('--repo <owner/name>', 'also check what the token can do on this repository')
  .option('--github-host <host>', 'GitHub Enterprise Server host (default github.com)')
  .action(async (flags) => {
    process.exitCode = await runDoctorCommand(flags, {
      env: process.env,
      nodeVersion: process.versions.node,
      platform: process.platform,
      // A review checks the binary against its checkout, which does not exist yet; this directory is
      // never created, so the answer is exactly the one PATH and REVIEW_AGENT_CLAUDE_BIN give.
      resolveClaudeBinary: () => resolveClaudeBinary({
        env: process.env, avoidDir: join(tmpdir(), `review-agent-doctor-${randomUUID()}`),
      }),
      claudeVersion: (bin) => claudeVersionOf(bin, process.env),
      gh: liveGhCli(process.env),
      makeOctokit: (a) => octokitFor(a),
      stdout,
      stderr,
    })
  })

program
  .command('init')
  .description('register the App on GitHub through the manifest flow')
  .option('--name <name>', 'the App name GitHub will show')
  .option('--url <url>', 'the App homepage')
  .option('--webhook-url <url>', 'where GitHub delivers events')
  .option('--org <org>', 'register under an organisation instead of your own account')
  .option('--webhook-inactive', 'register with the webhook off, for an App driven in process that receives no deliveries')
  .action(async (flags) => {
    process.exitCode = await runInitCommand(flags, {
      listenForManifestCode,
      convertManifest,
      // Unauthenticated on purpose: the conversion is authenticated by the one-hour code, and this
      // command must never hold a credential. Wrapped rather than passed, so the narrow requester
      // type is what the command sees.
      makeRequester: () => {
        const octokit = new Octokit()
        return { request: (route, params) => octokit.request(route, params) }
      },
      randomState: () => randomUUID(),
      stdout,
      stderr,
    })
  })

await program.parseAsync(process.argv)

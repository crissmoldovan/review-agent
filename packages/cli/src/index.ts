import { randomUUID } from 'node:crypto'
import { Octokit } from '@octokit/core'
import { convertManifest } from '@review-agent/app'
import { defaultSkillCacheDir } from '@review-agent/core'
import { defaultRunReviewDeps, octokitFor } from '@review-agent/github'
import { Command } from 'commander'
import { EXIT_BAD_USAGE, EXIT_OK } from './exit-codes'
import { runInitCommand } from './init-command'
import { listenForManifestCode } from './init-server'
import { cancelOnSignals } from './interrupt'
import { runReviewCommand } from './review-command'

const program = new Command()
program.name('review-agent').description('Review a pull request with an agent that only reads.')

// commander's own exit code for an unknown flag is 1, and 1 is reserved for an engine failure.
// Set before `.command('review')`: a subcommand copies its parent's exit callback when it is created,
// so an override added afterwards never reaches `review`'s own unknown-option error. Commander has
// already written its own message by the time this runs, so only the exit code is decided here.
program.exitOverride((e) => {
  process.exit(e.exitCode === 0 ? EXIT_OK : EXIT_BAD_USAGE)
})

program
  .command('review')
  // .option, not .requiredOption: every usage message in this CLI comes from parseFlags, so there is
  // one place that decides what a bad invocation says and one exit code it produces.
  .option('--repo <owner/name>', 'the repository, as owner/name')
  .option('--pr <number>', 'the pull request number')
  .option('--tier <tier>', 'basic | normal | thorough')
  .option('--model <model>', 'the model to run, e.g. claude-opus-5')
  .option('--effort <effort>', 'low | medium | high | xhigh | max')
  .option('--check', 'run the disprove-it pass, whatever the tier says')
  .option('--skip-check', 'skip the disprove-it pass, whatever the tier says')
  .option('--brief <text>', 'extra context for the reviewer; it is data, never instruction')
  .option('--budget <usd>', 'lower the tier budget (it can never be raised)')
  .option('--post', 'post the review to the pull request (not in this version)')
  .option('--json', 'print the machine-readable review record instead of a summary')
  .action(async (flags) => {
    const interrupt = cancelOnSignals({
      on: (s, l) => process.on(s, l),
      off: (s, l) => process.off(s, l),
      exit: (code) => process.exit(code),
      stderr: (s) => { process.stderr.write(s + '\n') },
    })
    try {
      // The collaborators every way in shares (spec 0.2.0 §3.1): GitHub, the archive, the engine and
      // its passes, a new checkout per review under the system temp directory. `note` is the
      // command's own stderr, so it is taken off here and the command passes it back in.
      // `runRecheckPass` is among them, and never reached: `runReviewCommand` reads no marker, so it
      // passes no previous findings and `runReview` buys no third pass.
      const { note: _note, ...pipeline } = defaultRunReviewDeps({ note: () => undefined })
      process.exitCode = await runReviewCommand(flags, {
        ...pipeline,
        // The same client the App's runner builds, with the API version pinned, so the CLI reads the
        // API the rest of this product was proven against.
        makeOctokit: (token) => octokitFor({ token }),
        // This OS's own cache directory unless the user names one (spec 0.2.0 §9.3 P13). Empty counts as
        // unset, as it does for REVIEW_AGENT_CLAUDE_BIN. Read per review, as before, and not checked
        // here: a relative one is refused by `materialiseSkills`, and only when a skill needs it.
        skillCacheDir: () => {
          const named = process.env.REVIEW_AGENT_SKILL_CACHE ?? ''
          return named !== '' ? named : defaultSkillCacheDir()
        },
        stdout: (s) => { process.stdout.write(s) },
        stderr: (s) => { process.stderr.write(s + '\n') },
        env: process.env,
      }, { signal: interrupt.signal })
    } finally {
      interrupt.dispose()
    }
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
      stdout: (s) => { process.stdout.write(s) },
      stderr: (s) => { process.stderr.write(s + '\n') },
    })
  })

await program.parseAsync(process.argv)

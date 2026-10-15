// The $0 Claude Code smoke test (spec 0.2.0 §12.1): on a CI runner of each OS, with the pinned Claude
// Code installed and NO model credential anywhere, run the real engine once over an empty directory.
// Claude Code answers "Not logged in" without reaching a model, so this costs nothing — and it proves
// what unit tests with a fake cannot: that the reviewer finds the real binary on this OS (including
// npm's Windows layout), starts it with its real flags, and reads the envelope it writes back.
//
// It refuses to run if a credential is set, so it can never spend money by accident.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPrompt, defaultDeploymentConfig, resolveClaudeBinary, resolveSettings, reviewJsonSchema, reviewSystemPrompt,
  runEngine,
} from '../packages/core/dist/index.js'

for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
  if ((process.env[name] ?? '') !== '') {
    console.error(`refusing to run: ${name} is set, and this check must never spend money`)
    process.exit(2)
  }
}

// A developer's machine may be logged in to Claude Code (on macOS, through the Keychain, which no
// environment variable shows), and then this would reach a model. A CI runner has no login.
if (process.env.CI !== 'true') {
  console.error('refusing to run outside CI: this machine may be logged in to Claude Code, and this check must cost nothing')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'claude-smoke-'))
try {
  const bin = resolveClaudeBinary({ env: process.env, avoidDir: dir })
  console.log(`Claude Code resolved to: ${bin}`)
  const settings = resolveSettings({
    deployment: defaultDeploymentConfig(), repo: null,
    request: { repo: 'acme/widgets', pr: 1, headSha: '0'.repeat(40) },
  })
  const result = await runEngine({
    checkoutDir: dir,
    prompt: buildPrompt({
      pr: { owner: 'acme', repo: 'widgets', number: 1, headSha: '0'.repeat(40), baseSha: '0'.repeat(40),
        title: 'smoke', body: '', changedFiles: [], diff: '' },
      brief: null,
    }),
    systemPrompt: reviewSystemPrompt({ settings }),
    settings,
    schema: reviewJsonSchema({ maxFindings: settings.report.maxFindings }),
    skillDirs: [],
    // The machine's own login, of which a CI runner has none: "Not logged in", at no cost.
    runtime: { credential: { kind: 'claude-login' } },
  })
  const f = result.failure
  console.log(`failure: ${JSON.stringify(f)} · cost $${result.usage.costUsd}`)
  if (f?.kind !== 'cli-error' || result.usage.costUsd !== 0) {
    console.error('expected a cli-error at $0 ("Not logged in"): the binary did not run as the reviewer runs it')
    process.exit(1)
  }
  console.log('ok: the real Claude Code ran with the reviewer\'s flags and answered, at $0')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

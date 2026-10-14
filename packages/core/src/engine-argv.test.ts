import { describe, expect, it } from 'vitest'
import { buildArgv } from './engine'
import { inputFixture, settingsFixture } from '../test/helpers/engine-input'

describe('buildArgv', () => {
  // One exact-equality test, not fifteen `toContain` assertions. The flag set IS the security
  // boundary (design §4.2, §4.3): a reviewer that silently gained Bash, or lost --restricted,
  // would still pass every `toContain` test ever written. Equality is the only assertion that
  // notices a flag that should not be there.
  it('produces exactly the flags the design fixes, in a stable order', () => {
    const i = inputFixture()
    expect(buildArgv(i)).toEqual([
      '-p',
      '--restricted',
      '--strict-mcp-config',
      '--tools', 'Read,Grep,Glob',
      '--allowedTools', 'Read,Grep,Glob',
      '--model', 'claude-opus-5',
      '--effort', 'low',
      '--max-budget-usd', '5.00',
      '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(i.schema),
      '--append-system-prompt',
      'You are the Acme PR reviewer.\n\nBudget: the budget for this review is about $2.00. ' +
      'Read what you need and no more. If you have been exploring for a long time, stop opening ' +
      'new files and write up the findings you can already support with evidence you have read.',
    ])
  })

  // --safe-mode is NOT here on purpose. It looks like the safer flag and the throwaway spike
  // harness (spike/run-review.sh line 22) did pass it — so anyone porting those flags by hand
  // will bring it along. It disables every customisation *including skills*, which would kill
  // the external-skill support of design §4.7 that was measured and decided on. --restricted is
  // what actually protects the run: it ignores user, project and local settings files, and a
  // skill planted in the reviewed repo was refused under it in measurement.
  it('never passes --safe-mode, which would disable skills entirely', () => {
    expect(buildArgv(inputFixture())).not.toContain('--safe-mode')
    expect(buildArgv(inputFixture({ skillDirs: ['/srv/skills/security'] }))).not.toContain('--safe-mode')
  })

  // A second guard, in the other direction: nothing may appear that is not on this list. The
  // equality test above only covers the default input; this one covers inputs that add flags.
  it('emits no flag outside the allowlist, whatever the input', () => {
    const allowed = new Set([
      '-p', '--restricted', '--strict-mcp-config', '--tools', '--allowedTools', '--model',
      '--effort', '--max-budget-usd', '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections', '--output-format', '--json-schema',
      '--append-system-prompt', '--plugin-dir',
    ])
    const argv = buildArgv(inputFixture({
      skillDirs: ['/srv/skills/security', '/srv/skills/coverage'],
      settings: settingsFixture({ effort: 'max', model: 'claude-sonnet-5' }),
    }))
    const flags = argv.filter((a) => a.startsWith('--') || a === '-p')
    expect([...new Set(flags)].filter((f) => !allowed.has(f))).toEqual([])
  })

  it('appends one --plugin-dir per skill dir, in order, at the end', () => {
    const argv = buildArgv(inputFixture({ skillDirs: ['/srv/skills/security', '/srv/skills/coverage'] }))
    expect(argv.slice(-4)).toEqual([
      '--plugin-dir', '/srv/skills/security',
      '--plugin-dir', '/srv/skills/coverage',
    ])
  })

  it('passes no --plugin-dir when the deployment configured no skills', () => {
    expect(buildArgv(inputFixture())).not.toContain('--plugin-dir')
  })

  // Measured 2026-09-12: a skill planted in the reviewed repository was refused by --restricted.
  // That is the CLI protecting us, and we do not want to depend on it: if a caller ever resolves
  // a repo-selected skill name to a path under the checkout (design §7 lets a repo *choose* among
  // the deployment's sources), the PR author would be writing the reviewer's instructions.
  it('refuses a skill dir inside the checkout', () => {
    expect(() =>
      buildArgv(inputFixture({ checkoutDir: '/tmp/checkout', skillDirs: ['/tmp/checkout/.claude/skills/x'] })),
    ).toThrow(/inside the checkout/)
  })

  it('is not fooled by a sibling directory with the same prefix', () => {
    expect(() =>
      buildArgv(inputFixture({ checkoutDir: '/tmp/checkout', skillDirs: ['/tmp/checkout-skills/x'] })),
    ).not.toThrow()
  })

  it('spends up to the hard ceiling, not the soft target', () => {
    const argv = buildArgv(inputFixture({
      settings: settingsFixture({ budget: { targetUsd: 3, wrapUpAtUsd: 2.1, ceilingUsd: 7.5 } }),
    }))
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('7.50')
  })

  // The prompt reached the CLI on stdin in the spike (`printf '%s' "$PROMPT" | claude …`) and must
  // keep doing so: the measured inputs run to 47 KB, which is both an E2BIG risk and a diff
  // visible in `ps` to every user on the box.
  it('keeps the prompt out of argv', () => {
    const argv = buildArgv(inputFixture({ prompt: 'SECRET-DIFF-MARKER' }))
    expect(argv.join(' ')).not.toContain('SECRET-DIFF-MARKER')
  })

  it('serialises the schema as JSON, not as [object Object]', () => {
    const schema = { type: 'object', required: ['summary'] }
    const argv = buildArgv(inputFixture({ schema }))
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe('{"type":"object","required":["summary"]}')
  })
})

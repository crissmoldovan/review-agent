import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildArgv, runEngine } from './engine'
import { fixturePath, readFixture } from '../test/fixture'
import { inputFixture, settingsFixture } from '../test/helpers/engine-input'

describe('the wrap-up', () => {
  // The cheapest half of the mechanism, and the only half that needs no undocumented behaviour:
  // the model is told the number up front. It does not replace an injected instruction — a model
  // cannot see its own spend — but on a run where nothing interrupts it, this is what stands
  // between us and the measured outcome of four runs that died with nothing to show.
  it('tells the model its soft target in the system prompt', () => {
    const argv = buildArgv(inputFixture({
      systemPrompt: 'You are the reviewer.',
      settings: settingsFixture({ budget: { targetUsd: 2, wrapUpAtUsd: 1.4, ceilingUsd: 5 } }),
    }))
    const sys = argv[argv.indexOf('--append-system-prompt') + 1]
    expect(sys).toContain('You are the reviewer.')
    expect(sys).toMatch(/budget for this review is about \$2\.00/)
    expect(sys).toMatch(/stop opening new files/i)
  })

  // The negative result of the wrap-up spike run during development, wired to something that can fail. The delivery
  // half is proven; what is missing is the trigger, and this is the thing that would have to change
  // for the wrap-up to become buildable. When this test fails, the CLI has started telling a hook
  // what a run has spent — go and read the spike.
  it('records that the hook event still carries no spend to fire on', () => {
    const event = readFixture('hook/post-tool-use.json') as Record<string, unknown>
    expect(event.hook_event_name).toBe('PostToolUse')
    const costish = Object.keys(event).filter((k) => /cost|usd|spend|usage|token|budget/i.test(k))
    expect(costish).toEqual([])
  })
})

describe('runEngine — the wrap-up that does not exist yet', () => {
  let checkout: string
  beforeEach(() => {
    // Same seam as engine-run.test.ts: a real empty cwd, and the fake CLI instead of a real bill.
    checkout = mkdtempSync(join(tmpdir(), 'checkout-'))
    process.env.REVIEW_AGENT_CLAUDE_BIN = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url))
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json')
  })
  afterEach(() => {
    for (const k of ['REVIEW_AGENT_CLAUDE_BIN', 'FAKE_CLAUDE_FIXTURE']) delete process.env[k]
  })

  it('wrapUpFired is always false until a mechanism exists (the wrap-up spike)', async () => {
    const r = await runEngine(inputFixture({ checkoutDir: checkout }))
    // A completed run, output and all — and still no wrap-up, because nothing can fire one.
    expect(r.output?.findings).toHaveLength(4)
    expect(r.wrapUpFired).toBe(false)
    // And no hook is mounted: --settings would spawn a process per tool call for nothing.
    expect(buildArgv(inputFixture({ checkoutDir: checkout }))).not.toContain('--settings')
  })
})

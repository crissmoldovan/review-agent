import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { importedSpecifiers, runtimeClosure } from '../test/import-graph'

// The SAME check twice over, in two ways that fail differently: the import graph, read; and the
// module, loaded with `@trigger.dev/sdk` made impossible to load. `test/publishing.test.ts` holds the
// third, over the bundle that is actually published.
vi.mock('@trigger.dev/sdk', () => {
  throw new Error('@trigger.dev/sdk was loaded')
})

const SRC = fileURLToPath(new URL('.', import.meta.url))
const RUNNER = join(SRC, 'runner.ts')
const PACKAGES = join(SRC, '..', '..')

/** A non-type import of trigger.dev — static, side-effect or dynamic — anywhere `entry` reaches. */
const triggerImports = (entry: string): string[] =>
  [entry, ...runtimeClosure(entry)].flatMap((file) => importedSpecifiers(file)
    .filter((e) => !e.typeOnly && e.specifier.startsWith('@trigger.dev/'))
    .map((e) => `${file} imports ${e.specifier}`))

/** Every package `entry` imports at run time, by name. */
const packagesOf = (entry: string): Set<string> => new Set([entry, ...runtimeClosure(entry)].flatMap((file) =>
  importedSpecifiers(file)
    .filter((e) => !e.typeOnly && !e.specifier.startsWith('.') && !isBuiltin(e.specifier))
    .map((e) => (e.specifier.startsWith('@') ? e.specifier.split('/').slice(0, 2).join('/') : e.specifier.split('/')[0]))))

type Manifest = { dependencies?: Record<string, string> }
const manifestOf = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest

describe('@review-agent/app/runner never loads trigger.dev (spec 0.2.0 §3.1, plan Stage 6)', () => {
  it('reaches no module that imports it, statically or dynamically', () => {
    expect(triggerImports(RUNNER)).toEqual([])
  })

  it('sees an import of it where there is one, so the verdict above means something', () => {
    // The positive control: the deployed task does import the SDK, through more than one module.
    expect(triggerImports(join(SRC, 'tasks', 'review-task.ts'))).not.toEqual([])
    expect(triggerImports(join(SRC, 'tasks', 'focus-task.ts'))).not.toEqual([])
  })

  it('reaches only packages that do not depend on it either', () => {
    const reached = packagesOf(RUNNER)
    expect([...reached].filter((p) => p.startsWith('@trigger.dev/'))).toEqual([])
    // The workspace's own packages are bare names the walk does not follow; their manifests answer.
    for (const [name, dir] of [['@review-agent/core', 'core'], ['@review-agent/github', 'github']] as const) {
      expect(reached.has(name)).toBe(true)
      expect(Object.keys(manifestOf(dir).dependencies ?? {}).filter((d) => d.startsWith('@trigger.dev/'))).toEqual([])
    }
  })

  it('loads, with everything it exports, when trigger.dev cannot be loaded at all', async () => {
    const runner = await import('./runner')
    expect(typeof runner.runReviewJob).toBe('function')
    expect(typeof runner.DoNotRetry).toBe('function')
    expect(typeof runner.RetryThis).toBe('function')
    expect(typeof runner.runnerDeployment).toBe('function')
  })

  it('cannot load a module that does import it, under the same rule — so the rule is live', async () => {
    await expect(import('./tasks/trigger-error')).rejects.toThrow()
  })
})

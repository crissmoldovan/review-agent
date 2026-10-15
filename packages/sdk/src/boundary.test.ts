import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// The walker `packages/app/src/boundary.test.ts` proves over planted violations, shared rather than
// copied, as `packages/cli/src/init-boundary.test.ts` shares it.
import { importedSpecifiers } from '../../app/test/import-graph'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const PACKAGES = join(SRC, '..', '..')

type Manifest = { name: string; version: string; dependencies?: Record<string, string> }
const manifestOf = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest

/** The workspace's packages by name, so a `workspace:*` dependency can be followed to its manifest. */
const WORKSPACE = new Map(readdirSync(PACKAGES).map((dir) => [manifestOf(dir).name, dir]))

/** Every package an install of `name` brings in, as far as this workspace can see: its own
 *  dependencies, and the dependencies of each workspace package among them, all the way down. */
const installedWith = (name: string): Set<string> => {
  const seen = new Set<string>()
  const queue = [name]
  while (queue.length > 0) {
    const dir = WORKSPACE.get(queue.pop() as string)
    if (dir === undefined) continue
    for (const dep of Object.keys(manifestOf(dir).dependencies ?? {})) {
      if (seen.has(dep)) continue
      seen.add(dep)
      queue.push(dep)
    }
  }
  return seen
}

/** What a module must never be: the App's package, or trigger.dev's. */
const forbidden = (pkg: string): boolean => pkg === '@review-agent/app' || pkg.startsWith('@trigger.dev/')

const sourceFiles = (): string[] =>
  readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(SRC, f)).sort()

describe('what embedding the reviewer installs (spec 0.2.0 §3.1)', () => {
  it('depends on core, github and the Octokit types, and nothing else', () => {
    const sdk = manifestOf('sdk')
    expect(Object.keys(sdk.dependencies ?? {}).sort()).toEqual(['@octokit/core', '@review-agent/core', '@review-agent/github'])
    // The same Octokit the github package builds clients with, so a host's `{ octokit }` and the one
    // built from `{ token }` are one type.
    expect(sdk.dependencies?.['@octokit/core']).toBe(manifestOf('github').dependencies?.['@octokit/core'])
  })

  it('never installs the App or trigger.dev, at any depth', () => {
    // "The SDK does not depend on it, so embedding the reviewer never installs trigger.dev."
    const all = installedWith('@review-agent/sdk')
    expect([...all].filter(forbidden)).toEqual([])
    // The positive control: the walk does follow workspace packages down to their own dependencies.
    expect(all).toContain('tar')
    expect([...installedWith('@review-agent/cli')].filter(forbidden)).not.toEqual([])
  })

  it('imports neither from any module it ships', () => {
    const files = sourceFiles()
    expect(files.map((f) => f.slice(SRC.length))).toContain('index.ts')
    const named = files.flatMap((f) => importedSpecifiers(f).map((e) => e.specifier))
    expect(named).toContain('@review-agent/github')
    expect(named.filter(forbidden)).toEqual([])
  })
})

/** An assignment to, or a deletion from, the process's environment — in any of the ways one is
 *  written. Comments are text, and a comment saying "never written to process.env" is not a write. */
const ENV_WRITE = /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:=(?!=)|\+=|\?\?=|\|\|=)|delete\s+process\.env|Object\.assign\(\s*process\.env/
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('the credential never travels through the environment (spec 0.2.0 §3.2)', () => {
  it('recognises a write to process.env however it is written', () => {
    for (const write of [
      'process.env.ANTHROPIC_API_KEY = key', "process.env['CLAUDE_CODE_OAUTH_TOKEN'] = t", 'process.env[name] ??= v',
      'delete process.env.ANTHROPIC_API_KEY', 'Object.assign(process.env, { A: 1 })',
    ]) expect(write).toMatch(ENV_WRITE)
    for (const read of ['const k = process.env.ANTHROPIC_API_KEY', 'if (process.env.X === "1")', 'normalise(options, process.env)']) {
      expect(read).not.toMatch(ENV_WRITE)
    }
  })

  it('no module this package ships writes to process.env', () => {
    // Two reviews in one process would race on it, and a credential written there is one every
    // later review — and the reviewed code's own process, through the allow-list — could read.
    for (const f of sourceFiles()) expect(code(readFileSync(f, 'utf8')), f).not.toMatch(ENV_WRITE)
  })
})

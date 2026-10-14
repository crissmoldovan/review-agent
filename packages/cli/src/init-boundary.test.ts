import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// One walker, shared with `packages/app/src/boundary.test.ts`, which already proves it over a graph
// with planted violations in it. A second copy would drift from the one that is proved.
import { importedSpecifiers, namedClosure } from '../../app/test/import-graph'
import { codeOf } from '../test/code'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const APP_SRC = join(SRC, '..', '..', 'app', 'src')
const FIXTURES = join(SRC, '..', 'test', 'fixtures', 'init-boundary')

/** Task 14's one rule: **this code never writes a secret to a file, a log or a terminal.** The
 *  three secrets exist for a few hundred microseconds — GitHub returns a private key, a webhook
 *  secret and a client secret from the manifest conversion, and `init` drops all three — and the
 *  test that watches the printed output can only see what goes through the sinks `InitDeps`
 *  injects. `writeFileSync(path, app.pem.reveal())` added to `init-command.ts` bypasses `InitDeps`
 *  entirely: it left the CLI suite 33/33 green and an 80-byte file containing the App private key
 *  on disk. So this rule is not about the output, it is about the CAPABILITY: the modules the three
 *  secrets pass through may not so much as name a filesystem, a child process or a terminal. */

/** The names the conversion's output cannot travel under anything else. A module that can hold one
 *  of the three secrets has to say one of these — it receives a `ConvertedApp`, or calls the
 *  conversion, or opens a `Secret` with `.reveal()`. This is how enrolment happens: by what a
 *  module NAMES, found rather than remembered, so a module nobody adds to a list is still checked.
 *  `Secret` itself is deliberately not here: `review-command.ts` names `SecretLeak`, an unrelated
 *  error class from `@review-agent/core`, and a rule that cried wolf on it would be turned off. */
const SECRET_SURFACE = ['ConvertedApp', 'convertManifest', 'clientSecret', 'webhookSecret', 'reveal('] as const

/** The ONE module excused, and the reason: the composition root names `convertManifest` because it
 *  hands the function to `runInitCommand` as a dependency — it never calls it, and what comes back
 *  never passes through this file. It is also the only module in the package that legitimately
 *  holds the capabilities this rule forbids: it opens `node:fs/promises` for `review`'s checkout
 *  directory and wraps `process.stdout` into the sinks. The case below is what pays for the excuse,
 *  and it is checkable rather than a promise: an `index.ts` that CALLS the conversion fails it. */
const EXCUSED = 'index.ts'

/** Node built-ins that can put bytes somewhere `init` has no business putting them. Not a list of
 *  everything dangerous — `node:http` is on the init half's critical path and stays legal, because
 *  the command's whole job is a browser round trip to GitHub. What each one buys an author:
 *  `fs` a file; `child_process` a process that writes any of these on its behalf; `module`
 *  (`createRequire`) any of the others by name at runtime; `worker_threads` a thread running code
 *  this rule never saw; `v8` a heap snapshot, which is every secret in memory written to a file;
 *  `inspector` a debugger port and a profile on disk; `repl` an evaluator. */
const FORBIDDEN_BUILTINS: ReadonlySet<string> = new Set([
  'fs', 'fs/promises', 'child_process', 'module', 'worker_threads', 'v8', 'inspector', 'repl',
])

/** The packages the init half may LOAD. A short list on purpose: a logger, a crash reporter or
 *  `write-file-atomic` enters a codebase as one unremarkable import line, and the capability it
 *  brings is invisible unless adding one has to be argued for here. `@review-agent/app` is on it
 *  because the conversion lives there and the init half is its only caller; what that package does
 *  with the secrets is not taken on trust, it is seeded below and checked line by line.
 *
 *  A type-only edge is not held to this list — TypeScript erases it, so it loads nothing and can
 *  carry no capability. `flags.ts`, shared with `review`, names `@review-agent/core` that way for
 *  two string unions, and failing it would teach the next author that this rule cries wolf. The
 *  forbidden built-ins below ARE held to it in any form, because there is no innocent reason for
 *  the init half to name a filesystem at all, and the gap to a real import is one keyword. */
const MAY_NAME: ReadonlySet<string> = new Set(['@review-agent/app'])

/** Identifiers that are a terminal, or the door to one. `process` is banned whole rather than as
 *  `process.stdout`: the init half reads no environment variable and owns no exit code, so the
 *  identifier has no legitimate use here, and banning the object stops `const p = process` as well
 *  as the obvious line. `eval` and `Function` run text no static rule can read. */
const FORBIDDEN_TOKENS: readonly (readonly [RegExp, string])[] = [
  [/\bconsole\b/, 'console'],
  [/\bprocess\b/, 'process'],
  [/\bcreateRequire\b/, 'createRequire'],
  [/\beval\s*\(/, 'eval('],
  [/\bFunction\s*\(/, 'Function('],
]

const modulesUnder = (root: string): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) return []
      return [full]
    })
  return walk(root).sort()
}

/** A test file is not enrolled, and that is a scope statement rather than an oversight: nothing in
 *  `packages/cli/test` or `*.test.ts` ships or ever sees a real credential — the secrets in those
 *  files are planted fixtures, which is what makes them able to fail. */
const holdsASecret = (file: string): boolean => {
  const code = codeOf(file)
  return SECRET_SURFACE.some((name) => code.includes(name))
}

/** The module that MINTS the three secrets, found by its export rather than by its path, so moving
 *  or renaming it cannot quietly take it out of the rule. It lives in `@review-agent/app`, on the
 *  other side of a package boundary the walker does not cross, so it is seeded instead. */
const mintsThem = (): string => {
  const found = modulesUnder(APP_SRC).filter((f) => /export const convertManifest\b/.test(codeOf(f)))
  if (found.length !== 1) {
    throw new Error(`expected exactly one module exporting convertManifest, found ${found.length}`)
  }
  return found[0]
}

/** Enrolled by existing, not by being listed: every module of this package that names the secret
 *  surface, the module that mints the secrets, and everything those name in turn — type-only edges
 *  included, because `init-command.ts` names `./init-server` type-only and that module is still
 *  half of what `review-agent init` is. Called per case rather than captured, because the planted
 *  module below appears in `src` mid-run. */
const seeds = (): string[] => [
  ...modulesUnder(SRC).filter((f) => holdsASecret(f) && relative(SRC, f) !== EXCUSED),
  mintsThem(),
]

const enrolled = (): string[] => {
  const out = new Set<string>()
  for (const seed of seeds()) {
    out.add(seed)
    for (const reached of namedClosure(seed, codeOf)) out.add(reached)
  }
  return [...out].sort()
}

/** The rule, as one function, so the fixtures are held to exactly the predicate the real modules
 *  are held to. It answers with the reasons, because a failure that names the offending line is
 *  worth more at 3am than a bare `false`.
 *
 *  What it cannot see, stated rather than implied: a dynamic `import()` of a computed string, a
 *  capability reached through a package it is allowed to name, and an author determined to launder
 *  `globalThis` into a local. What it does see is every shape the leak would actually take. */
const waysItCanWrite = (entry: string): string[] => {
  const reasons: string[] = []
  for (const file of [entry, ...namedClosure(entry, codeOf)]) {
    for (const { specifier, typeOnly } of importedSpecifiers(file, codeOf)) {
      if (isBuiltin(specifier)) {
        if (FORBIDDEN_BUILTINS.has(specifier.replace(/^node:/, ''))) reasons.push(`${file} names ${specifier}`)
      } else if (!typeOnly && !specifier.startsWith('.') && !MAY_NAME.has(specifier)) {
        reasons.push(`${file} loads the package ${specifier}, which this rule has never been told about`)
      }
    }
    const code = codeOf(file)
    for (const [pattern, name] of FORBIDDEN_TOKENS) {
      if (pattern.test(code)) reasons.push(`${file} uses ${name}`)
    }
  }
  return reasons
}

describe('the three secrets `review-agent init` is handed', () => {
  it('is checked against real files, so a clean verdict means something', () => {
    // The positive control, and it is not a fixture: the composition root really does import
    // node:fs/promises and really does wrap process.stdout, so the rule must condemn it as it
    // stands. If this ever passes, the rule has stopped looking at anything.
    expect(waysItCanWrite(join(SRC, EXCUSED))).not.toEqual([])
  })

  it('enrols the init half by what a module names, rather than by a list a future edit can miss', () => {
    const found = enrolled().map((f) => relative(SRC, f))

    expect(found).toContain('init-command.ts')
    // Named type-only by `init-command.ts` and enrolled anyway: it holds the one-hour code, which
    // is what the three secrets are made from, and the composition root wires the real one in.
    expect(found).toContain('init-server.ts')
    // Reached across the package boundary by seeding, which is the half a `packages/cli` grep for
    // `node:fs` would never have covered: the secrets are BORN in `@review-agent/app`.
    expect(found).toContain(relative(SRC, join(APP_SRC, 'manifest.ts')))
    // Not everything in the package: a rule that enrolled the whole CLI would forbid `review` from
    // reading a checkout, and would be relaxed within a week.
    expect(found).not.toContain('review-command.ts')
    expect(found).not.toContain(EXCUSED)
  })

  it('excuses the composition root only because the conversion passes through it unopened', () => {
    const code = codeOf(join(SRC, EXCUSED))

    // Why it needs an excuse at all: it names the conversion.
    expect(code).toContain('convertManifest')
    // And why it gets one: it hands the function on as a dependency and never calls it, so nothing
    // it can write to is ever holding a secret. An `index.ts` that opened the result fails here.
    expect(code).not.toMatch(/\bconvertManifest\s*\(/)
    expect(code).not.toContain('ConvertedApp')
    expect(code).not.toContain('reveal(')
  })

  it('leaves the init half no way to write a secret to a file, a log or a terminal', () => {
    for (const entry of enrolled()) {
      expect(waysItCanWrite(entry)).toEqual([])
    }
  })
})

/** The rule, held to the house standard: a lock that cannot fail when you break what it guards is
 *  not a lock. One fixture per shape the mistake takes, and one module nobody enrolled. */
describe('the rule that keeps the registration secrets off every surface', () => {
  const shapes = [
    ['the write that stayed green before this rule existed', 'writes-the-key-to-a-file.ts'],
    ['a write laundered through a helper that names no secret', 'writes-the-key-through-a-helper.ts'],
    ['the filesystem loaded by a dynamic import, below the import list', 'loads-fs-by-dynamic-import.ts'],
    ['a type-only mention of the filesystem, one keyword from a real one', 'names-fs-type-only.ts'],
    ['a console.log, which no injected sink can see', 'prints-the-key-with-console.ts'],
    ['a write straight to process.stdout', 'prints-the-key-on-process-stdout.ts'],
    ['a child process, which writes anywhere this one can', 'spawns-a-child-process.ts'],
    ['createRequire, which loads the filesystem by name at runtime', 'loads-fs-through-create-require.ts'],
    ['a package this rule has never been told about', 'pulls-in-a-package-nobody-vetted.ts'],
  ] as const

  for (const [shape, fixture] of shapes) {
    it(`catches ${shape}`, () => {
      expect(waysItCanWrite(join(FIXTURES, fixture))).not.toEqual([])
    })
  }

  it('clears a module that reaches a network, its own helpers and an injected sink only', () => {
    // The negative control. Its comments MENTION console.log, process.stdout and an import of
    // node:fs, and it is still clean: comments are blanked before anything is searched, which is
    // the only reason this rule can be applied to files whose comments explain it.
    expect(waysItCanWrite(join(FIXTURES, 'writes-nothing-dangerous.ts'))).toEqual([])
  })

  it('reads a `//` inside a string as a URL, not as the start of a comment', () => {
    // The other side of the same coin: blanking from the first `//` to the end of the line would
    // lose the print that follows this URL and call the file clean.
    expect(waysItCanWrite(join(FIXTURES, 'hides-a-print-behind-a-url.ts'))).not.toEqual([])
  })

  /** Planted into `src` for one case and removed in a `finally`. It is also in `.gitignore`, so a
   *  run killed mid-case leaves a file that cannot be committed by accident. */
  const PLANTED = join(SRC, 'planted-by-init-boundary-test.ts')

  it('catches a module that holds the conversion and is on no list, because nothing imports it yet', () => {
    rmSync(PLANTED, { force: true }) // a previous run killed mid-case
    copyFileSync(join(FIXTURES, 'would-slip-through.ts.txt'), PLANTED)
    try {
      // Enrolment first — a rule nothing is enrolled in checks nothing — then the rule itself.
      expect(seeds()).toContain(PLANTED)
      expect(enrolled()).toContain(PLANTED)
      expect(waysItCanWrite(PLANTED)).not.toEqual([])
    } finally {
      rmSync(PLANTED, { force: true })
    }
    expect(existsSync(PLANTED)).toBe(false)
  })
})

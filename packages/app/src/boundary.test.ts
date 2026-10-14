import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importedSpecifiers, runtimeClosure } from '../test/import-graph'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const CREDENTIALS = join(SRC, 'credentials.ts')
const FIXTURES = join(SRC, '..', 'test', 'fixtures', 'boundary')

/** The credential half, by name, and the ONLY two modules excused from the rule below:
 *  `credentials.ts` holds the App private key, and `index.ts` is the package entry that re-exports
 *  it on purpose. Everything else under `src` is receiver code and is enrolled by EXISTING — this
 *  used to be the other way round, a hand-written list of receiver modules, and a batch-3 verifier
 *  walked straight past it by adding `src/webhook.ts`, which was on nobody's list and therefore
 *  checked by nothing. A name added here is checked by the second case below, so this set cannot be
 *  used as a way out either. */
const CREDENTIAL_HALF: ReadonlySet<string> = new Set(['credentials.ts', 'index.ts'])

/** The RUNNER half (Task 13), and the reason it is not receiver code: it mints the installation
 *  token, so it holds the App identity by design — that is the job design §3.1 gives it. The rule
 *  above is about the INTERNET-FACING half, which is `./receiver` and what package.json exports
 *  under that subpath; a rule that also forbade the runner would forbid the product from working.
 *  This is not an escape hatch, and the case below is what keeps it from becoming one: whatever is
 *  put in here is still caught the moment the receiver can reach it, because the receiver's own
 *  closure is asserted to contain nothing from this directory. Dropping a receiver module in here
 *  buys nothing — it only stops being checked while nothing on the receiver side imports it, and
 *  the instant something does, the receiver's closure fails. */
const RUNNER_HALF = 'tasks'

/** Every receiver module that exists right now, found rather than remembered. Called per case, not
 *  captured in a constant, because the planted-module case below adds a file mid-run. */
const receiverModules = (
  root: string, excused: ReadonlySet<string> = new Set(), skipDirs: ReadonlySet<string> = new Set(),
): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return skipDirs.has(relative(root, full)) ? [] : walk(full)
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) return []
      return excused.has(relative(root, full)) ? [] : [full]
    })
  return walk(root).sort()
}

const enrolled = (): string[] => receiverModules(SRC, CREDENTIAL_HALF, new Set([RUNNER_HALF]))

/** The rule, as one function, so the fixtures below hold it to exactly the predicate the receiver
 *  half is held to. It answers with the reasons a file is a violation, because a failure that names
 *  the offending edge is worth more at 3am than a bare `false`. */
const waysItReachesTheKey = (entry: string): string[] => {
  const closure = runtimeClosure(entry)
  const reasons = closure.includes(CREDENTIALS) ? [`${entry} reaches ${CREDENTIALS} at runtime`] : []
  for (const file of [entry, ...closure]) {
    for (const edge of importedSpecifiers(file)) {
      // Type-only too: the receiver half has no business naming this module in any form.
      if (edge.specifier.includes('credentials')) reasons.push(`${file} names ${edge.specifier}`)
    }
  }
  return reasons
}

describe('the App private key and the receiver half', () => {
  it('walks a real import graph, so its verdicts mean something', () => {
    // The positive control: index.ts re-exports credentials, and the walker must find it.
    expect(runtimeClosure(join(SRC, 'index.ts'))).toContain(CREDENTIALS)
  })

  it('excuses only modules that really are the credential half', () => {
    // The escape hatch, closed. Enrolment is automatic, so the only way to dodge the rule is to
    // name a module up there — and a module may only be named there if it holds the App private key
    // or reaches it, which is the one thing the rule below forbids everyone else.
    for (const name of CREDENTIAL_HALF) {
      const file = join(SRC, name)
      expect(existsSync(file)).toBe(true)
      expect(file === CREDENTIALS || runtimeClosure(file).includes(CREDENTIALS)).toBe(true)
    }
  })

  it('enrols every other module under src, by existing rather than by being listed', () => {
    // Not an inventory — a new receiver module must not have to be added anywhere to be checked.
    // What is pinned is that discovery really reaches the receiver half and really skips the
    // credential half, so the case below is iterating something.
    const found = enrolled().map((f) => relative(SRC, f))

    expect(found).toContain('receiver.ts')
    expect(found).toContain('verify.ts')
    expect(found).toContain('dispatch.ts')
    expect(found).not.toContain('credentials.ts')
    expect(found).not.toContain('boundary.test.ts')
    // The runner half is out of this rule's scope, and the next case is what pays for that.
    expect(found.some((f) => f.startsWith(`${RUNNER_HALF}/`))).toBe(false)
  })

  it('excuses the runner half only because the internet-facing half cannot reach it', () => {
    // The price of the RUNNER_HALF excuse. `./receiver` is the subpath package.json exports and the
    // only thing an adopter's webhook endpoint imports, so what it can reach is the whole question
    // the boundary asks. A receiver module hidden under `tasks/` to dodge enrolment is inert until
    // something on this side imports it — and this assertion fails the moment one does.
    const closure = runtimeClosure(join(SRC, 'receiver.ts'))
    const tasks = join(SRC, RUNNER_HALF)
    expect(closure.filter((f) => f.startsWith(`${tasks}/`))).toEqual([])
    // And the rule itself, on the entry a deployment actually imports.
    expect(waysItReachesTheKey(join(SRC, 'receiver.ts'))).toEqual([])
  })

  it('lets no receiver module reach the module that holds the App private key', () => {
    for (const entry of enrolled()) {
      expect(waysItReachesTheKey(entry)).toEqual([])
    }
  })
})

/** The rule that used to cover a list of filenames. These cases are what stops it going back:
 *  a module nobody wrote down, and one file per shape the mistake can take. */
describe('the rule that guards the App private key', () => {
  /** Planted into `src` for one case and removed in a `finally`. It is also in `.gitignore`, so a
   *  run killed mid-case leaves a file that cannot be committed by accident. */
  const PLANTED = join(SRC, 'planted-by-boundary-test.ts')

  it('catches a receiver module nobody enrolled, which is how one slipped through before', () => {
    rmSync(PLANTED, { force: true }) // a previous run killed mid-case
    copyFileSync(join(FIXTURES, 'would-slip-through.ts.txt'), PLANTED)
    try {
      // Exactly what the batch-3 verifier did: a new module appears in `src` and is on no list.
      expect(enrolled()).toContain(PLANTED)
      expect(waysItReachesTheKey(PLANTED)).not.toEqual([])
    } finally {
      rmSync(PLANTED, { force: true })
    }
    expect(existsSync(PLANTED)).toBe(false)
  })

  const shapes = [
    ['a plain import of the credentials module', 'reaches-the-key-directly.ts'],
    ['an import of a helper that reaches it', 'reaches-the-key-through-a-helper.ts'],
    ['a dynamic import inside a function', 'reaches-the-key-by-dynamic-import.ts'],
    ['a type-only import that names it', 'names-the-key-type-only.ts'],
  ] as const

  for (const [shape, fixture] of shapes) {
    it(`catches ${shape}`, () => {
      expect(waysItReachesTheKey(join(FIXTURES, fixture))).not.toEqual([])
    })
  }

  it('follows the graph rather than reading one file, so a helper cannot launder the reach', () => {
    // The entry of this fixture never names the credentials; only the helper it imports does. The
    // closure — not the specifier list — is what has to fail it.
    const entry = join(FIXTURES, 'reaches-the-key-through-a-helper.ts')
    expect(importedSpecifiers(entry).map((e) => e.specifier)).not.toContain('../../../src/credentials')
    expect(runtimeClosure(entry)).toContain(CREDENTIALS)
  })

  it('clears a module that reaches node built-ins and its own helpers only', () => {
    expect(waysItReachesTheKey(join(FIXTURES, 'reaches-nothing-dangerous.ts'))).toEqual([])
  })
})

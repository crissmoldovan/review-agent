import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SHIP_SOURCEMAPS as APP_SOURCEMAPS } from '../packages/app/sourcemaps'
import { SHIP_SOURCEMAPS as CLI_SOURCEMAPS } from '../packages/cli/sourcemaps'
import { SHIP_SOURCEMAPS as CORE_SOURCEMAPS } from '../packages/core/sourcemaps'
import { SHIP_SOURCEMAPS as GITHUB_SOURCEMAPS } from '../packages/github/sourcemaps'

const REPO = join(import.meta.dirname, '..')

/** The packages this workspace publishes, each with the one switch that decides whether its
 *  tarball carries source maps. The first test below reads `packages/` back, so a package added
 *  later cannot be published without appearing here first. */
const PUBLISHED: readonly { dir: string; shipSourcemaps: boolean }[] = [
  { dir: 'app', shipSourcemaps: APP_SOURCEMAPS },
  { dir: 'cli', shipSourcemaps: CLI_SOURCEMAPS },
  { dir: 'core', shipSourcemaps: CORE_SOURCEMAPS },
  { dir: 'github', shipSourcemaps: GITHUB_SOURCEMAPS },
]

/** Packed whatever `files` says: pnpm adds the manifest, and the workspace root's LICENSE when the
 *  package has none of its own. Those two, and nothing else.
 *
 *  README.md is deliberately NOT here. pnpm 11.22.0 does not glob a workspace-root README into a
 *  package tarball — its pack globs only `LICEN{S,C}E{,.*}` from the workspace root, and only when
 *  the packed list has no licence file of its own — and no packages/<name>/README.md exists. So a
 *  README appearing in a tarball means a person put one in that package, and prose is where an
 *  internal name slips in: it has to be read before it ships to a public registry for ever. When a
 *  reviewed per-package README is added, add 'README.md' here in the SAME commit. Added with 0.1.1:
 *  each package's README is the page npm shows, and the name sweep below reads it like any other
 *  shipped file. */
const ALWAYS_PACKED = ['LICENSE', 'package.json', 'README.md']

type ExportCondition = string | { types?: string; import?: string }
type Manifest = {
  name: string
  version: string
  private?: boolean
  main?: string
  types?: string
  bin?: Record<string, string>
  exports?: Record<string, ExportCondition>
  dependencies?: Record<string, string>
  engines?: { node?: string }
  repository?: { type: string; url: string; directory: string }
  publishConfig?: { access?: string }
}
type Packed = { dir: string; name: string; version: string; paths: string[]; manifest: Manifest; tarball: string }

/** `pnpm pack --json` prints the tarball's absolute path and its contents. The manifest is read out
 *  of the tarball rather than off disk, because the interesting differences — publishConfig
 *  applied, workspace: ranges resolved — exist only in the packed copy. */
const packOne = (dir: string, destination: string): Packed => {
  const output = execFileSync('pnpm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: join(REPO, 'packages', dir),
    encoding: 'utf8',
  })
  const result = JSON.parse(output) as { name: string; version: string; filename: string; files: { path: string }[] }
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOzf', result.filename, 'package/package.json'], { encoding: 'utf8' }),
  ) as Manifest
  return {
    dir,
    name: result.name,
    version: result.version,
    paths: result.files.map((f) => f.path),
    manifest,
    tarball: result.filename,
  }
}

const entryPoints = (m: Manifest): string[] => {
  const entries = [m.main, m.types, ...Object.values(m.bin ?? {})]
  for (const condition of Object.values(m.exports ?? {})) {
    if (typeof condition === 'string') entries.push(condition)
    else entries.push(condition.types, condition.import)
  }
  return entries.filter((e): e is string => e !== undefined)
}

/** The bare specifiers a built bundle imports. esbuild emits externals as top-level static imports
 *  and strips the `node:` prefix, so `fs` here is the builtin — `isBuiltin` is what tells them
 *  apart. Dynamic `import("…")` is matched too, for the same reason. */
const bareImports = (source: string): string[] => {
  const specifiers = new Set<string>()
  for (const m of source.matchAll(/(?:^|\n)import\s+(?:[^'"]*?from\s*)?["']([^"']+)["']/g)) specifiers.add(m[1])
  for (const m of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1])
  return [...specifiers].filter((s) => !s.startsWith('.') && !isBuiltin(s))
}

const packageOf = (specifier: string): string =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

/** Names that must never reach a published file — organisations, customers and internal projects
 *  this product was built near — stored as hashes so that this file does not publish them either.
 *
 *  The scheme: a name is lower-cased, its words are joined with `-` (`Some Org` and `some_org` are
 *  both `some-org`), and it is stored as the hex SHA-256 of `NAME_SALT` followed by that string. To
 *  add one, hash it the same way and add the hex here:
 *
 *    printf 'review-agent/never-shipped:%s' 'some-org' | shasum -a 256
 *
 *  This keeps the names out of a casual read and out of search; it is not secrecy. A short name can
 *  be recovered by trying candidates, so a name whose mere presence here would be a disclosure goes
 *  in REVIEW_AGENT_NEVER_SHIPPED instead (comma-separated, read at test time, never committed).
 *  Nothing is printed when a name is found except the file, the position and the hash's prefix. */
const NAME_SALT = 'review-agent/never-shipped:'
const NEVER_SHIPPED_NAME_HASHES: readonly string[] = [
  '6d2cf7296db999faacd13605f7b4a03b13b4d88fdb1fbdd147f8ef8ae929bf99',
  '7d785ed640b04302d8149089e1e2a63d2e3433a8667cd8561a1995f3615bda9b',
  '88c21d60f7e0e94757e792dfcda9e96f7f5723d5df912ae1eee80cc9d68c1482',
  '92020c3310fb759cac1aa48c1dd8a2d8f075488e908412c240903954d00ad483',
  'a9cc282308f3a99d7ac26af3f5a4f1e435925709f5df9922d90afd306ba115c3',
  'b35e2f73f3855b624575812ecdf77186c170114c7fc14fd9bcf285b0ac7681f6',
  'cffb909e67957ede7dccdb9d871217688d68c110b531e378c652d5907d733c3e',
  'dbe70fe6d688d3851b5242ff68f72bc8eaba1fbe8c06492843a87328b5348788',
  'fec65b2792b393c64560602e526eecea3a7ad462a111bcb1024aed785cb63133',
]
/** Not names: the prefixes of a trigger.dev project ref and of a GitHub token, matched as text. */
const NEVER_SHIPPED_STRINGS = ['proj_', 'ghp_']
/** At least as many words as the longest name above. A candidate longer than this cannot be one. */
const LISTED_MAX_WORDS = 3

const nameKey = (words: readonly string[]): string => words.join('-')
const nameHash = (key: string): string => createHash('sha256').update(NAME_SALT + key).digest('hex')
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '')

type NeverShipped = { hashes: ReadonlySet<string>; maxWords: number }

/** Every name a published file must not contain: the list above, plus whatever the environment
 *  adds, and the most words any of them has. */
const neverShipped = (env: string | undefined): NeverShipped => {
  const extra = (env ?? '').split(',').map(wordsOf).filter((words) => words.length > 0)
  return {
    hashes: new Set([...NEVER_SHIPPED_NAME_HASHES, ...extra.map((words) => nameHash(nameKey(words)))]),
    maxWords: Math.max(LISTED_MAX_WORDS, ...extra.map((words) => words.length)),
  }
}

/** Every listed name a text contains, as `line:column` and a hash prefix — never the name itself.
 *  The text is read as a sequence of words — runs of letters and digits — and every one to
 *  `maxWords` consecutive words is checked, whatever separates them: a name is found written with
 *  spaces, hyphens, dots, underscores or slashes (`Some Org`, `ops.some-org.dev`, `SOME_ORG_KEY`,
 *  `some-org/repo`). Matching is on whole words, so a name inside a longer word — or inside
 *  camelCase — is not a hit. */
const namesIn = (text: string, { hashes, maxWords }: NeverShipped, seen: Map<string, boolean>): string[] => {
  const hits: string[] = []
  const words = [...text.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({ word: m[0].toLowerCase(), at: m.index }))
  for (let start = 0; start < words.length; start++) {
    for (let n = 1; n <= maxWords && start + n <= words.length; n++) {
      const key = nameKey(words.slice(start, start + n).map((w) => w.word))
      let listed = seen.get(key)
      if (listed === undefined) {
        listed = hashes.has(nameHash(key))
        seen.set(key, listed)
      }
      if (listed) {
        const before = text.slice(0, words[start].at)
        const line = before.split('\n').length
        const column = words[start].at - before.lastIndexOf('\n')
        hits.push(`${line}:${column} (${nameHash(key).slice(0, 8)})`)
      }
    }
  }
  return hits
}

describe('what a published tarball carries', () => {
  let destination = ''
  let packed: Packed[] = []

  beforeAll(() => {
    // What ships is what the build makes NOW. Packing against a stale dist would let this suite
    // pass on files nobody has built since the last change. No `prepack` script does this for us
    // on purpose: pnpm runs those with their output on stdout, which would break `--json` above.
    execFileSync('pnpm', ['-r', 'build'], { cwd: REPO, stdio: 'pipe' })
    destination = mkdtempSync(join(tmpdir(), 'review-agent-pack-'))
    packed = PUBLISHED.map((p) => packOne(p.dir, destination))
  }, 300_000)

  afterAll(() => {
    if (destination !== '') rmSync(destination, { recursive: true, force: true })
  })

  it('knows every package in the workspace, so a new one cannot be published unwatched', () => {
    expect(readdirSync(join(REPO, 'packages')).sort()).toEqual(PUBLISHED.map((p) => p.dir).sort())
  })

  it('ships dist, the licence and the manifest, and nothing else', () => {
    // Measured on 2026-09-14, before `files` existed: github packed its test fixtures (a recorded
    // diff of another project's code), cli packed test/e2e/baseline.json (which named the pull
    // request it reviewed and what that review cost), and core packed test/fixtures/cli/*.json and
    // the README beside them. A published version can never be reused, so this is the test that
    // has to hold.
    for (const p of packed) {
      const strays = p.paths.filter((path) => !path.startsWith('dist/') && !ALWAYS_PACKED.includes(path))
      expect(strays, `${p.name} packs files that are neither dist/ nor licence, manifest or README`).toEqual([])
    }
    for (const p of packed) expect(p.paths, `${p.name} licence`).toContain('LICENSE')
  })

  it('names no customer anywhere inside the files it ships', () => {
    // The test above is path-only: anything under dist/ passes unread. That is not enough, because
    // tsup strips no comments — not from the bundle, and not from the .d.ts it emits — and the house
    // style is a dated decision comment citing the measurement it came from. Measured 2026-09-14:
    // packages/core/dist/index.js carries `// Criss, 2026-09-13. On macOS the Claude CLI finds a
    // `claude` login in the keychain through USER; …` verbatim.
    //
    // The list is not a guess, and the first one was wrong. A grep of the built dist on 2026-09-14
    // found ONE hit, in a declaration file: packages/core/dist/index.d.ts carried a prompt.ts
    // comment naming an organisation by its bare initials, which none of the seven strings the first
    // version of this list held would catch. So names are matched as whole words, and a domain is
    // split into its words, rather than searched for as fixed strings.
    const names = neverShipped(process.env.REVIEW_AGENT_NEVER_SHIPPED)
    const seen = new Map<string, boolean>()
    for (const p of packed) {
      for (const path of p.paths.filter((f) => f.startsWith('dist/') || f === 'README.md')) {
        const source = execFileSync('tar', ['-xOzf', p.tarball, `package/${path}`], { encoding: 'utf8' })
        expect(namesIn(source, names, seen), `${p.name} ${path} names a never-shipped name at`).toEqual([])
        for (const needle of NEVER_SHIPPED_STRINGS) {
          expect(source, `${p.name} ${path} carries ${needle}`).not.toContain(needle)
        }
      }
    }
  })

  it('recognises a listed name however it is written, and only as a whole word', () => {
    // The sweep above passes on a clean dist whether or not it can see anything, so its matcher is
    // pinned here, against names listed only for this test and given the way
    // REVIEW_AGENT_NEVER_SHIPPED gives them.
    const names = neverShipped('Example Org, a four word name')
    const hit = (text: string) => namesIn(text, names, new Map()).length > 0
    expect(hit('// built for Example-Org, 2026')).toBe(true)
    expect(hit('Built for Example Org on 2026-09-14.')).toBe(true)
    expect(hit('https://ops.example-org.dev/hook')).toBe(true)
    expect(hit('EXAMPLE_ORG_SECRET')).toBe(true)
    expect(hit('example.org')).toBe(true)
    expect(hit('an example organisation')).toBe(false)
    expect(hit('exampleOrgFactory')).toBe(false)
    expect(hit('this is A Four Word Name, longer than any listed one')).toBe(true)
    expect(namesIn('one\ntwo example-org', names, new Map())).toEqual([`2:5 (${nameHash('example-org').slice(0, 8)})`])
    // And the stored list is what it claims to be: lower-case hex digests, no plain text beside them.
    for (const h of NEVER_SHIPPED_NAME_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('carries a source map only where this package says it should', () => {
    // tsup's maps embed sourcesContent: a shipped map is the whole source. Default OFF until Criss
    // decides (2026-09-14); the decision lives in packages/<name>/sourcemaps.ts and nowhere else.
    for (const p of packed) {
      const maps = p.paths.filter((path) => path.endsWith('.map'))
      const wanted = PUBLISHED.find((s) => s.dir === p.dir)?.shipSourcemaps === true
      if (wanted) expect(maps.length, `${p.name} ships maps`).toBeGreaterThan(0)
      else expect(maps, `${p.name} must ship no source map`).toEqual([])
    }
  })

  it('points every entry point into dist, at a file the tarball actually carries', () => {
    // In the workspace these resolve to ./src/*.ts, which an installed package does not contain;
    // publishConfig is what swings them to dist at pack time. A types entry naming a file the dts
    // build never emitted is the failure this catches.
    for (const p of packed) {
      const entries = entryPoints(p.manifest)
      expect(entries.length, `${p.name} names no entry point`).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry, `${p.name} entry`).toMatch(/^\.\/dist\//)
        expect(p.paths, `${p.name} names ${entry}`).toContain(entry.slice(2))
      }
    }
  })

  it('replaces every workspace link with the version being published', () => {
    // pnpm rewrites workspace:* to the target's EXACT version, so the four packages move in
    // lockstep: github@0.1.0 requires core@0.1.0 and nothing else will do.
    const versions = new Map(packed.map((p) => [p.name, p.version]))
    for (const p of packed) {
      for (const [dep, range] of Object.entries(p.manifest.dependencies ?? {})) {
        expect(range, `${p.name} depends on ${dep}`).not.toContain('workspace:')
        const sibling = versions.get(dep)
        if (sibling !== undefined) expect(range, `${p.name} depends on ${dep}`).toBe(sibling)
      }
    }
  })

  it('imports nothing it does not declare, so an adopter who installs it can run it', () => {
    for (const p of packed) {
      const declared = Object.keys(p.manifest.dependencies ?? {})
      for (const path of p.paths.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
        const source = execFileSync('tar', ['-xOzf', p.tarball, `package/${path}`], { encoding: 'utf8' })
        for (const specifier of bareImports(source)) {
          expect(declared, `${p.name} ${path} imports ${specifier}`).toContain(packageOf(specifier))
        }
      }
    }
  })

  it('is publishable, says which Node it needs, and says where its source is', () => {
    for (const p of packed) {
      expect(p.manifest.private, `${p.name} is still private`).toBeUndefined()
      expect(p.manifest.engines?.node, `${p.name} engines`).toBe('>=22')
      expect(p.manifest.repository?.directory, `${p.name} repository`).toBe(`packages/${p.dir}`)
    }
  })

  it('declares public access itself, so no publish depends on someone typing --access public', () => {
    // Every one of these is scoped, and npm's documented default for a scoped package is
    // `restricted` — a private package, which the organisation's free plan does not carry, so the
    // first publish fails outright or (worse, on a paid plan) succeeds privately. `--access public`
    // on the command line fixes that only for the person who remembers to type it, and a version
    // published under the wrong access can never be re-published under another. In the manifest the
    // package says it for itself, on every machine and in every later release.
    //
    // Asserted on the PACKED manifest, like everything else here, and that is not the same file as
    // the one on disk: pnpm 11.22.0 consumes `main`, `types` and `exports` out of publishConfig at
    // pack time and writes them at the top level, leaving publishConfig holding only what it does
    // not understand. `access` surviving that is what this checks.
    for (const p of packed) {
      expect(p.manifest.publishConfig?.access, `${p.name} publishConfig.access`).toBe('public')
    }
  })

  it('leaves the workspace root unpublishable', () => {
    // The root manifest is the one thing here that must NEVER lose its private flag: it has no
    // files field and packing it would ship the whole repository.
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Manifest
    expect(root.private).toBe(true)
  })
})

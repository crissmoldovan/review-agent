import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type Edge = { specifier: string; typeOnly: boolean }

// Deliberately not a TypeScript parse: the test must stay readable and dependency-free. The
// middle of a statement may span lines (a long import list) but may not contain a quote or a
// semicolon, which keeps one statement from swallowing the next.
const FROM = /(?:^|[\s;])(import|export)(\s+type\b)?[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT = /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** How a file's text is read before the patterns above are matched. The default is the file as it
 *  is on disk; `packages/cli/src/init-boundary.test.ts` passes a reader that blanks comments,
 *  because its rule also searches the text for `console` and `process` and a comment that MENTIONS
 *  one is prose, not a violation. The contract a reader must keep is one-way: it may blank, never
 *  rewrite, so an import the patterns would have found in the file is still there to be found. */
export type SourceReader = (file: string) => string

const fileOnDisk: SourceReader = (file) => readFileSync(file, 'utf8')

export function importedSpecifiers(file: string, sourceOf: SourceReader = fileOnDisk): Edge[] {
  const source = sourceOf(file)
  const edges: Edge[] = []
  for (const m of source.matchAll(FROM)) edges.push({ specifier: m[3], typeOnly: m[2] !== undefined })
  for (const m of source.matchAll(SIDE_EFFECT)) edges.push({ specifier: m[1], typeOnly: false })
  for (const m of source.matchAll(DYNAMIC)) edges.push({ specifier: m[1], typeOnly: false })
  return edges
}

/** A bare specifier is a package edge and is not followed: this walker maps files. Inside
 *  `@review-agent/app` that loses nothing, because the package is not linked into its own
 *  `node_modules` — a sibling module can only be named by a relative path — and a module of
 *  ANOTHER package cannot reach this one's credentials, nothing depending on it. The blind spot
 *  that remains is a dynamic `import()` of a computed string, which no static walker can see. */
const resolveRelative = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) if (existsSync(candidate)) return candidate
  return null
}

const walk = (entry: string, followTypeOnly: boolean, sourceOf: SourceReader): string[] => {
  const seen = new Set<string>()
  const queue = [resolve(entry)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const edge of importedSpecifiers(file, sourceOf)) {
      if (edge.typeOnly && !followTypeOnly) continue
      const next = resolveRelative(file, edge.specifier)
      if (next !== null) queue.push(next)
    }
  }
  seen.delete(resolve(entry))
  return [...seen]
}

/** Every file reachable from `entry` by an import that SURVIVES compilation. `import type` edges
 *  are erased by TypeScript and cannot carry a value at runtime, so they are not followed — the
 *  boundary test bans them separately, by name, which is the stricter of the two rules. */
export function runtimeClosure(entry: string, sourceOf: SourceReader = fileOnDisk): string[] {
  return walk(entry, false, sourceOf)
}

/** Every file the entry NAMES, type-only edges included. The two walks answer different questions:
 *  "what can this file reach at runtime" (above) and "what is this file made of" (here). The init
 *  lock asks the second, because `init-command.ts` names `./init-server` type-only and that module
 *  is still half of what `review-agent init` is — the composition root wires the real one in. */
export function namedClosure(entry: string, sourceOf: SourceReader = fileOnDisk): string[] {
  return walk(entry, true, sourceOf)
}

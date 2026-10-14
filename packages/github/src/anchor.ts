import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Finding } from '@review-agent/core'
import type { PullRequestContext } from './pr'

/** The line numbers a comment may be anchored to on the RIGHT (new) side of a file, read out of
 *  one file's unified-diff patch.
 *
 *  The trailing newline is stripped before splitting. A patch read from a file ends with one, and
 *  `''.split` would hand back a final empty element that looks exactly like an unpadded context
 *  line — which would claim one line past the end of the hunk. GitHub never emits a bare empty
 *  body line inside a hunk (an empty context line is a single space), so after the strip there is
 *  nothing left for `raw === ''` to mean. */
export function newSideLines(patch: string): Set<number> {
  const lines = new Set<number>()
  let n = 0
  for (const raw of patch.replace(/\n$/, '').split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) { n = Number(header[1]); continue }
    if (n === 0) continue                 // anything before the first hunk header
    if (raw.startsWith('-')) continue      // left side only: not addressable on RIGHT
    if (raw.startsWith('\\')) continue      // "\ No newline at end of file"
    if (raw.startsWith('+') || raw.startsWith(' ')) { lines.add(n); n += 1 }
  }
  return lines
}

/** Design §4.3: no model-written string addresses a resource until it has been checked against the
 *  checkout. `resolve` collapses `..` and absolutises, so the prefix test is the whole guard. */
export function fileInCheckout(checkoutDir: string, p: string): boolean {
  const root = resolve(checkoutDir)
  const target = resolve(root, p)
  if (!target.startsWith(root + sep)) return false
  if (!existsSync(target)) return false
  return statSync(target).isFile()
}

// THE SOURCE-LINE ANCHOR IS GONE (Criss, 2026-09-16). `anchorOfLine`, `anchorsAtHead`, `anchorKey`
// and `AnchorResult.anchors` lived here and are deleted rather than left as an unused path somebody
// later trusts.
//
// They were the second attempt at inferring a repair from two snapshots: hash the source line a
// finding was placed on, and call the finding gone when that hash is no longer anywhere in the file.
// It failed on the first real repair it met. A fix that WRAPS a line rather than deleting it leaves
// the line present — measured, `if (attempt < attempts - 1) { ... }` wrapped two lines and
// re-indented them, whitespace is normalised before hashing, both survived verbatim, and a genuine
// repair read as unfixed. The information needed to tell a repair from an edit is not in two
// snapshots, so the product asks a model instead: `runRecheckPass` in core.
//
// `MarkerFinding.anchor` still decodes, because 0.1.0 wrote one and design point 7 keeps every
// marker this product has written readable at version 1. Nothing reads it.
//
// What stays here is unrelated to any of that: placement. `anchorFindings` decides which findings
// GitHub will take on a line, and `fileInCheckout` is design §4.3's guard on every model-written
// path — neither has anything to do with matching.

export type AnchoredFinding = { finding: Finding; line: number; side: 'RIGHT' }
export type AnchorResult = {
  inline: AnchoredFinding[]
  summaryOnly: Finding[]
  dropped: { finding: Finding; why: string }[]
}

/** The only reason this module bins a finding. Design §4.3: a model-written path that does not
 *  resolve to a file inside the checkout addresses nothing, so nothing can be done with it. */
export const DROP_NOT_IN_CHECKOUT = 'path is not a file in the checkout'

export function anchorFindings(a: {
  findings: Finding[]; pr: PullRequestContext; checkoutDir: string
}): AnchorResult {
  const { findings, pr, checkoutDir } = a
  const changed = new Map(pr.changedFiles.map((f) => [f.path, f]))
  const inline: AnchoredFinding[] = []
  const summaryOnly: Finding[] = []
  const dropped: { finding: Finding; why: string }[] = []

  for (const finding of findings) {
    // Gate 1 — safety. The only drop.
    if (!fileInCheckout(checkoutDir, finding.file)) {
      dropped.push({ finding, why: DROP_NOT_IN_CHECKOUT })
      continue
    }
    // Gate 2 — the PR's file list. A real finding in an untouched file still gets said, in the
    // summary; GitHub just has no line of diff to hang it on.
    const file = changed.get(finding.file)
    if (file === undefined) { summaryOnly.push(finding); continue }
    // Gate 3 — the diff itself. Binary or too-large files come back with no patch at all.
    if (file.patch === undefined) { summaryOnly.push(finding); continue }
    if (newSideLines(file.patch).has(finding.line)) inline.push({ finding, line: finding.line, side: 'RIGHT' })
    else summaryOnly.push(finding)
  }
  return { inline, summaryOnly, dropped }
}

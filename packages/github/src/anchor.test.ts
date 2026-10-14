import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Finding } from '@review-agent/core'
import { DROP_NOT_IN_CHECKOUT, anchorFindings, fileInCheckout, newSideLines } from './anchor'
import type { PullRequestContext } from './pr'

// `test/fixtures/workflow.patch.txt` is a `patch` field in the shape
// GET /repos/{owner}/{repo}/pulls/{number}/files returns it — invented, for a fictional workflow:
// one file, one hunk, 3 context + 31 added + 3 context. Read from disk, so it carries the trailing
// newline that a patch handed straight from the API does not — the case this function has to get right.
const PATCH = readFileSync(new URL('../test/fixtures/workflow.patch.txt', import.meta.url), 'utf8')

describe('newSideLines', () => {
  it('covers the whole new side of the hunk, context included', () => {
    const lines = newSideLines(PATCH)
    expect(lines.has(88)).toBe(true)    // first context line
    expect(lines.has(100)).toBe(true)   // an added line
    expect(lines.has(124)).toBe(true)   // last context line
    expect(lines.has(87)).toBe(false)   // before the hunk
    expect(lines.has(125)).toBe(false)  // after the hunk — the trailing newline is not a line
    expect(lines.size).toBe(37)         // 3 context + 31 added + 3 context
  })

  it('does not advance the new-side counter on a deleted line', () => {
    const patch = ['@@ -10,3 +10,2 @@', ' kept', '-gone', ' after'].join('\n')
    expect([...newSideLines(patch)]).toEqual([10, 11])
  })

  it('handles several hunks and the no-newline marker', () => {
    const patch = ['@@ -1,1 +1,1 @@', '+a', '\\ No newline at end of file', '@@ -50,1 +60,1 @@', '+b'].join('\n')
    expect([...newSideLines(patch)]).toEqual([1, 60])
  })
})

/** 130 lines, because an anchor is a hash of the line a finding points at and the findings in this
 *  file point at line 100. A one-line fixture would leave every anchor absent and the feature
 *  untested. Each line differs from the others, so a hash tells them apart. */
const WORKFLOW = Array.from({ length: 130 }, (_, i) => `    - run: step-${i + 1}`).join('\n') + '\n'

function checkout(): string {
  const base = mkdtempSync(join(tmpdir(), 'ra-anchor-'))
  writeFileSync(join(base, 'outside-secret.txt'), 'not part of the checkout\n')
  const dir = join(base, 'co')
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(dir, '.github/workflows/publish.yml'), WORKFLOW)
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

describe('fileInCheckout', () => {
  const dir = checkout()
  it('accepts a file that is there', () => {
    expect(fileInCheckout(dir, '.github/workflows/publish.yml')).toBe(true)
  })
  it('refuses a file that is not', () => {
    expect(fileInCheckout(dir, 'src/nope.ts')).toBe(false)
  })
  it('refuses a directory', () => {
    expect(fileInCheckout(dir, 'src')).toBe(false)
  })
  it('refuses a path that climbs out, even to a real file', () => {
    expect(fileInCheckout(dir, '../outside-secret.txt')).toBe(false)
    expect(fileInCheckout(dir, '/etc/hosts')).toBe(false)
  })
})

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: '.github/workflows/publish.yml', line: 100, endLine: null,
    severity: 6, category: 'security', title: 't', explanation: 'e',
    evidence: ['.github/workflows/publish.yml:100'], suggestion: null,
    ...over,
  }
}
function pullRequest(files: PullRequestContext['changedFiles']): PullRequestContext {
  return {
    owner: 'acme', repo: 'widgets', number: 16,
    headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f', baseSha: '0'.repeat(40),
    title: 't', body: 'b', changedFiles: files, diff: '',
  }
}

describe('anchorFindings', () => {
  const dir = checkout()
  const pr = pullRequest([{ path: '.github/workflows/publish.yml', status: 'modified', patch: PATCH }])
  const untouched = pullRequest([{ path: 'other.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x\n' }])

  it('posts inline when the line is in the diff', () => {
    const out = anchorFindings({ findings: [finding({ line: 100 })], pr, checkoutDir: dir })
    expect(out.inline).toEqual([{ finding: finding({ line: 100 }), line: 100, side: 'RIGHT' }])
    expect(out.summaryOnly).toEqual([])
    expect(out.dropped).toEqual([])
  })

  it('sends a line outside the diff to the summary, not to the bin', () => {
    const out = anchorFindings({ findings: [finding({ line: 200 })], pr, checkoutDir: dir })
    expect(out.inline).toEqual([])
    expect(out.summaryOnly).toEqual([finding({ line: 200 })])
    expect(out.dropped).toEqual([])
  })

  it('summarises a real file the PR did not touch, and does not drop it', () => {
    // Whole-repo reading is the point (design §4.1). GitHub has nowhere to hang the comment; the
    // summary comment carries "any finding that could not be placed inline" (§5).
    const out = anchorFindings({ findings: [finding()], pr: untouched, checkoutDir: dir })
    expect(out.summaryOnly).toEqual([finding()])
    expect(out.dropped).toEqual([])
  })

  it('summarises a changed file GitHub gave no patch for', () => {
    const binary = pullRequest([{ path: '.github/workflows/publish.yml', status: 'modified' }])
    const out = anchorFindings({ findings: [finding()], pr: binary, checkoutDir: dir })
    expect(out.summaryOnly).toHaveLength(1)
    expect(out.dropped).toEqual([])
  })

  it('drops a path that is not a file in the checkout, with a reason', () => {
    const out = anchorFindings({ findings: [finding({ file: 'src/invented.ts' })], pr, checkoutDir: dir })
    expect(out.dropped).toEqual([
      { finding: finding({ file: 'src/invented.ts' }), why: DROP_NOT_IN_CHECKOUT },
    ])
    expect(out.summaryOnly).toEqual([])
  })

  it('checks the checkout before anything else', () => {
    // A path that climbs out AND is absent from the PR's file list. The safety gate must be the one
    // that answers, or a traversal would arrive in the summary comment instead of the bin.
    const out = anchorFindings({
      findings: [finding({ file: '../outside-secret.txt' })], pr: untouched, checkoutDir: dir,
    })
    expect(out.dropped[0].why).toBe(DROP_NOT_IN_CHECKOUT)
    expect(out.summaryOnly).toEqual([])
  })
})

// The source-line anchor that used to be tested from here to the end of this file is gone
// (Criss, 2026-09-16), and so are its tests: `anchorOfLine`, `anchorKey`, `anchorsAtHead` and
// `AnchorResult.anchors`. They were the second attempt at INFERRING a repair from two snapshots —
// "the finding is gone when a hash of its source line is no longer in the file" — and a repair that
// wraps a line rather than deleting it leaves the line there. The product asks a model now, and
// `packages/core/src/recheck-pass.test.ts` is where that is tested.
//
// What is left above is placement and safety, which never had anything to do with matching.

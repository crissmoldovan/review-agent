import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The examples repeat a few facts that live elsewhere in this repository. Each is pinned here to its
// source, so the day one changes, the examples change with it or this fails (spec 0.2.0 §7, §9.2).

const ROOT = join(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const WORKFLOW = 'examples/github-actions/review.yml'
const DOCKERFILE = 'examples/server/Dockerfile'

/** The keys directly under a top-level YAML key, read as text: two-space indented, comments skipped.
 *  Enough for the two blocks asserted below, and no YAML parser to add to the workspace. */
const childKeys = (yaml: string, key: string): string[] => {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `${key}:`)
  if (start === -1) return []
  const keys: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const m = /^ {2}([A-Za-z_][\w-]*):/.exec(line)
    if (m !== null) keys.push(m[1])
  }
  return keys
}

describe('the examples pin the Claude Code the App runner pins', () => {
  const pinned = /const CLAUDE_CODE_VERSION = '([^']+)'/.exec(read('packages/app/trigger.config.ts'))?.[1]

  it('in the server image', () => {
    expect(pinned).toBeDefined()
    expect(/^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(read(DOCKERFILE))?.[1]).toBe(pinned)
  })

  it('in the workflow', () => {
    const versions = [...read(WORKFLOW).matchAll(/@anthropic-ai\/claude-code@(\S+)/g)].map((m) => m[1])
    expect(versions.length).toBeGreaterThan(0)
    expect(new Set(versions)).toEqual(new Set([pinned]))
  })
})

describe('the workflow', () => {
  const workflow = read(WORKFLOW)

  it('runs on pull_request and issue_comment, and never on pull_request_target (spec 0.2.0 §10)', () => {
    expect(childKeys(workflow, 'on')).toEqual(['pull_request', 'issue_comment'])
  })

  it('asks for exactly the permissions a posted review with a check run needs (spec 0.2.0 §9.2)', () => {
    expect(childKeys(workflow, 'permissions').sort()).toEqual(['checks', 'contents', 'pull-requests', 'statuses'])
    expect(workflow).toMatch(/^ {2}contents: read\b/m)
  })

  it('skips a pull request from a fork before anything is installed', () => {
    const gate = workflow.indexOf('id: gate')
    expect(gate).toBeGreaterThan(-1)
    expect(workflow.indexOf('.head.repo.full_name', gate)).toBeGreaterThan(gate)
    expect(workflow.indexOf('.head.repo.full_name')).toBeLessThan(workflow.indexOf('npm install --global'))
  })
})

describe('the server image', () => {
  const dockerfile = read(DOCKERFILE)

  it('runs as a user that is not root', () => {
    const users = [...dockerfile.matchAll(/^USER (\S+)$/gm)].map((m) => m[1])
    expect(users.at(-1)).toBeDefined()
    expect(users.at(-1)).not.toMatch(/^(root|0)$/)
  })

  it("fails the build when Claude Code's binary is npm's placeholder, and when it does not run", () => {
    expect(dockerfile).toMatch(/test "\$\(wc -c < [^)]*bin\/claude\.exe\)" -gt 1048576/)
    expect(dockerfile).toMatch(/^RUN "\$\{REVIEW_AGENT_CLAUDE_BIN\}" --version$/m)
  })
})

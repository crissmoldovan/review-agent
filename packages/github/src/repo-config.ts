import { z } from 'zod'
import type { RepoConfig } from '@review-agent/core'
import type { Octokit } from '@octokit/core'

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

const unquote = (s: string): string =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s

/** Reads the small, fixed subset of front matter `.review-agent/review.md` may carry: `key: value`,
 *  `key: [a, b]`, and a `key:` followed by `- item` lines. **This is not a YAML parser and must not
 *  become one** — if the file ever needs anchors, nesting or multi-line scalars, add `yaml` to
 *  packages/github/package.json in Task 1 and delete this function. Anything it does not
 *  understand is skipped, never thrown: a malformed config must not fail a review. */
export function parseFrontMatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const fenced = FENCE.exec(text)
  if (fenced === null) return { data: {}, body: text }
  const data: Record<string, string | string[]> = {}
  let key: string | null = null
  for (const raw of fenced[1].split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && key !== null) {
      const held = data[key]
      data[key] = Array.isArray(held) ? [...held, unquote(item[1].trim())] : [unquote(item[1].trim())]
      continue
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) { key = null; continue }
    key = pair[1]
    const value = pair[2].trim()
    const inline = /^\[(.*)\]$/.exec(value)
    if (value === '') data[key] = []                      // a block list is expected to follow
    else if (inline !== null) data[key] = inline[1].split(',').map((s) => unquote(s.trim())).filter((s) => s !== '')
    else data[key] = unquote(value)
  }
  return { data, body: text.slice(fenced[0].length) }
}

export const REPO_CONFIG_PATH = '.review-agent/review.md'

/** This text is pasted into the review prompt (Task 4b's `reviewSystemPrompt`). A repository that
 *  commits a megabyte of "instructions" would otherwise buy itself the whole context window. */
export const MAX_INSTRUCTIONS_CHARS = 16_000

const FrontMatterSchema = z.object({
  postInlineAtOrAbove: z.coerce.number().int().min(1).max(10).optional().catch(undefined),
  mode: z.enum(['inline+summary', 'summary-only', 'check-only', 'silent']).optional().catch(undefined),
  skills: z.union([z.string().transform((s) => [s]), z.array(z.string().min(1))]).optional().catch(undefined),
})

/** Every field carries `.catch(undefined)`, so this cannot throw: a repo whose config is nonsense
 *  gets the deployment's settings and a review, not a failure. Unknown keys are stripped by zod —
 *  `budgetUsd`, `model` and `skills` the deployment never allowed have no effect here and are
 *  rejected again in `resolveSettings` (Task 3). */
export function parseRepoConfig(text: string): RepoConfig {
  const { data, body } = parseFrontMatter(text)
  const front = FrontMatterSchema.parse(data)
  const config: RepoConfig = {}
  const instructions = body.trim()
  if (instructions !== '') {
    config.instructions = instructions.length > MAX_INSTRUCTIONS_CHARS
      ? `${instructions.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[${REPO_CONFIG_PATH} truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`
      : instructions
  }
  if (front.postInlineAtOrAbove !== undefined) config.postInlineAtOrAbove = front.postInlineAtOrAbove
  if (front.mode !== undefined) config.mode = front.mode
  if (front.skills !== undefined) config.skills = front.skills
  return config
}

/** What the contents endpoint returns for a file. `encoding` is `'none'` for anything over 1 MB and
 *  the response is an array for a directory — both fail this parse, which is the intent: a
 *  megabyte-plus `review.md` is a payload, not a set of instructions. */
const ContentSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string(),
})

/** Reads the reviewed repository's own configuration **from the base branch** (design §7, §4.3).
 *  `baseRef` is `PullRequestContext.baseSha` — a commit the pull request under review cannot
 *  change. Never call this with a head sha or a head branch name: the file would then be written
 *  by the same change it is used to judge. Returns null when there is no readable file. */
export async function fetchRepoConfig(a: {
  octokit: Octokit; owner: string; repo: string; baseRef: string
}): Promise<RepoConfig | null> {
  const { octokit, owner, repo, baseRef } = a
  let data: unknown
  try {
    data = (await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path: REPO_CONFIG_PATH, ref: baseRef,
    })).data
  } catch (error) {
    // 404 is the ordinary case: most repositories carry no config. Anything else — 403 on a
    // permission the App was not granted, 5xx, a rate limit — must reach the caller, because a
    // review run with the wrong settings in silence is worse than a review that did not run.
    if (typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404) return null
    throw error
  }
  const file = ContentSchema.safeParse(data)
  if (!file.success) return null
  return parseRepoConfig(Buffer.from(file.data.content, 'base64').toString('utf8'))
}

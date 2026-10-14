import type { Octokit } from '@octokit/core'
import { scanForSecrets } from '@review-agent/core'
import type { closeStaleCheckRuns } from '@review-agent/github'
import { z } from 'zod'
import type { AppIdentity, installationToken } from '../credentials'

/** The scheduled task's id, named once here: the wrapper, sweep-task.ts, is imported by nothing and
 *  read as text by its test. */
export const SWEEP_TASK_ID = 'review-agent-sweep-stale-check-runs'

/** Every hour on the hour, UTC — a string cron is always UTC (verified facts, scheduled tasks §2).
 *  Hourly because STALE_AFTER_MS is an hour: a check run abandoned just after one sweep is closed
 *  within two hours. */
export const SWEEP_CRON = '0 * * * *'

/** Pages of 100, GitHub's largest page for this list according to its endpoint page (read
 *  2026-09-14; not in the verified-facts file). A repository with more open pull requests than ten
 *  pages hold is swept as far as it was listed, and the result says the list was not complete. */
export const MAX_OPEN_PULL_PAGES = 10
const PAGE = 100

/** The two fields the sweep reads, in the shape Step 1 recorded. A head that is not 40 lowercase hex
 *  characters is not a commit this sweep will address, so the page does not parse. */
const OpenPullsSchema = z.array(z.object({
  number: z.number().int(),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
}))

/** The head commit of every OPEN pull request of one repository, each once. `complete` is false when
 *  a page did not parse or the page limit was reached: the heads returned are real, and they are not
 *  all of them. */
export const listOpenPullHeads = async (a: {
  octokit: Octokit; owner: string; repo: string
}): Promise<{ heads: string[]; complete: boolean }> => {
  const heads = new Set<string>()
  for (let page = 1; page <= MAX_OPEN_PULL_PAGES; page += 1) {
    const res = await a.octokit.request('GET /repos/{owner}/{repo}/pulls', {
      owner: a.owner, repo: a.repo, state: 'open', per_page: PAGE, page,
    })
    const parsed = OpenPullsSchema.safeParse(res.data)
    if (!parsed.success) return { heads: [...heads], complete: false }
    for (const pull of parsed.data) heads.add(pull.head.sha)
    if (parsed.data.length < PAGE) return { heads: [...heads], complete: true }
  }
  return { heads: [...heads], complete: false }
}

/** One installation's repositories to sweep, each `owner/name`. The deployment names them
 *  (`runnerSweepTargets`, review-job.ts): Task 8 mints no installation-wide token, so the sweep
 *  cannot list them for itself. */
export type SweepTarget = { installationId: number; repositories: string[] }
export type SweepSkip = { repo: string; why: string }
export type SweepResult = { repositories: number; heads: number; closed: number; skipped: SweepSkip[] }

/** Every collaborator the sweep reaches through, so it is testable with no network and no SDK — the
 *  same shape as Task 13's `ReviewTaskDeps`. */
export type SweepDeps = {
  targets: () => SweepTarget[]
  /** Read only when a repository is named, so a deployment with no targets needs no identity. */
  identity: () => AppIdentity
  checkRunName: () => string
  installationToken: typeof installationToken
  makeOctokit: (token: string) => Octokit
  listOpenPullHeads: typeof listOpenPullHeads
  closeStaleCheckRuns: typeof closeStaleCheckRuns
  now: () => Date
  log: (message: string, fields: Record<string, unknown>) => void
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Error text from somebody else's code, made safe for a result and a log that trigger.dev keeps and
 *  shows: the rule Task 13 applies to check-run reasons (design §4.3). */
const safely = (e: unknown): string =>
  scanForSecrets(messageOf(e)).length > 0 ? 'its text is withheld because it matched a secret pattern' : messageOf(e)

/** Criss, 2026-09-14 (answer 14): closes what a review that died without throwing left
 *  `in_progress`, on the open pull requests of the repositories the deployment names, and nothing it
 *  cannot confirm. Every refusal is recorded and the rest is still swept; only a named repository
 *  with no App identity throws. */
export const sweepRun = async (deps: SweepDeps): Promise<SweepResult> => {
  const result: SweepResult = { repositories: 0, heads: 0, closed: 0, skipped: [] }
  const targets = deps.targets()
  // Nothing named: nothing swept and no credential read. Task 15's teardown leaves a deployed version
  // with no App identity, and its hourly tick must not fail for that.
  if (targets.every((t) => t.repositories.length === 0)) return result
  // Thrown, naming the variables and never a value (appIdentityFromEnv, Task 13). Nothing is closed.
  const identity = deps.identity()
  const name = deps.checkRunName()
  for (const target of targets) {
    for (const full of target.repositories) {
      const [owner, repo, extra] = full.split('/')
      if (owner === undefined || owner === '' || repo === undefined || repo === '' || extra !== undefined) {
        result.skipped.push({ repo: full, why: 'not an owner/name repository' })
        continue
      }
      let octokit: Octokit
      try {
        // Scoped to this one repository, by name (Global Constraints) — one token per repository.
        const minted = await deps.installationToken({
          identity, installationId: target.installationId, repositories: [repo],
        })
        octokit = deps.makeOctokit(minted.token)
      } catch (e) {
        result.skipped.push({ repo: full, why: `no token for this repository: ${safely(e)}` })
        continue
      }
      let listed: { heads: string[]; complete: boolean }
      try {
        listed = await deps.listOpenPullHeads({ octokit, owner, repo })
      } catch (e) {
        result.skipped.push({ repo: full, why: `open pull requests not listed: ${safely(e)}` })
        continue
      }
      result.repositories += 1
      if (!listed.complete) {
        result.skipped.push({ repo: full, why: 'open pull requests not fully listed; the heads that were listed were swept' })
      }
      for (const headSha of listed.heads) {
        result.heads += 1
        try {
          // No staleAfterMs, ever: Task 6's one-hour rule, the life of an installation token, is the
          // only evidence this sweep has that a run is abandoned.
          result.closed += await deps.closeStaleCheckRuns({ octokit, owner, repo, headSha, name, now: deps.now() })
        } catch (e) {
          result.skipped.push({ repo: `${full}@${headSha.slice(0, 12)}`, why: safely(e) })
        }
      }
    }
  }
  deps.log('stale check-run sweep finished', {
    repositories: result.repositories, heads: result.heads, closed: result.closed, skipped: result.skipped.length,
  })
  return result
}

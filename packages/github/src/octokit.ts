import { Octokit } from '@octokit/core'
import { z } from 'zod'

/** Current GitHub docs examples send this header. Pinning it deliberately (rather than letting the
 *  API default drift) means a future breaking version cannot arrive without a diff in this repo.
 *
 *  Here, in `github`, since 0.2.0 (spec 0.2.0 §3.1): every way in builds its client with
 *  `octokitFor`, so the CLI and an SDK host talk to the same API version the App's runner was proven
 *  against. `@review-agent/app` re-exports it, because its token request sends the same header. */
export const GITHUB_API_VERSION = '2026-03-10'

/** The authenticated client, built once per review: an installation token expires in an hour, and a
 *  person's token is theirs for the one review it was given for. @octokit/core 7.0.8's constructor
 *  turns only `userAgent` and `timeZone` into headers (dist-src/index.js), so the API-version pin is
 *  a before-request hook, which every `octokit.request` passes through.
 *
 *  `baseUrl` is GitHub Enterprise Server's API root (`https://<host>/api/v3`); left out, github.com.
 *  `fetch` is injectable for the tests and for nothing else. */
export const octokitFor = (a: { token: string; fetch?: typeof fetch; baseUrl?: string }): Octokit => {
  const octokit = new Octokit({
    auth: a.token,
    ...(a.baseUrl !== undefined && { baseUrl: a.baseUrl }),
    ...(a.fetch !== undefined && { request: { fetch: a.fetch } }),
  })
  octokit.hook.before('request', (options) => {
    options.headers['x-github-api-version'] = GITHUB_API_VERSION
  })
  return octokit
}

/** GitHub's own boolean for "may this person push here", read off the live endpoint at Step 27c:
 *  `user.permissions.push`, true for admin, maintain and write, false for triage, read and none. The
 *  coarse `permission` word (admin | write | read | none) is not read, so there is one field to
 *  agree on — the one a deployment's own permission checks should read too. A response without it
 *  is not an answer that grants anything. */
const PermissionSchema = z.object({ user: z.object({ permissions: z.object({ push: z.boolean() }) }) })

/** Whether a person may spend this deployment's money on a review (Criss, 2026-09-14, decision 3).
 *  The App asks it before a REQUESTED review; an SDK host may use it as its `authorize` gate (spec
 *  0.2.0 §4.2). A 404 is an answer — GitHub does not know them on this repository — so it is `false`.
 *  Anything else is not an answer about the person and is thrown, before the engine, where it costs
 *  nothing. Moved here from the App's runner in 0.2.0 (spec §3.1). */
export const pushAccessOf = async (a: {
  octokit: Octokit; owner: string; repo: string; username: string
}): Promise<boolean> => {
  let data: unknown
  try {
    data = (await a.octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
      owner: a.owner, repo: a.repo, username: a.username,
    })).data
  } catch (e) {
    if ((e as { status?: unknown }).status === 404) return false
    throw e
  }
  const parsed = PermissionSchema.safeParse(data)
  if (!parsed.success) return false
  return parsed.data.user.permissions.push
}

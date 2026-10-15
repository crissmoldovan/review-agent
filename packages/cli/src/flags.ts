import type { Effort, Tier } from '@review-agent/core'
import type { ReportWant } from '@review-agent/github'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

const TIERS: readonly Tier[] = ['basic', 'normal', 'thorough']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** As the CLI spells them (spec 0.2.0 §5.2): `status` is the word a person types for a commit status. */
const REPORTS: Readonly<Record<string, ReportWant>> = {
  auto: 'auto', 'check-run': 'check-run', status: 'commit-status', none: 'none',
}

/** github.com, whose API is `api.github.com`: what every flag and token lookup means by default. */
export const GITHUB_COM = 'github.com'

export type ReviewFlags = {
  repo?: string; pr?: string; tier?: string; model?: string; effort?: string
  check?: boolean; skipCheck?: boolean; brief?: string; budget?: string; post?: boolean; json?: boolean
  report?: string; reReview?: boolean; githubHost?: string; keepCheckout?: boolean; yes?: boolean
  multi?: boolean
}
export type ValidatedFlags = {
  owner: string; repo: string; pr: number
  tier?: Tier; model?: string; effort?: Effort; check?: boolean
  brief?: string; budgetUsd?: number; json: boolean
  post: boolean
  report: ReportWant
  /** Whether to buy the re-review pass: on with `--post` unless `--no-re-review`, and never without. */
  reReview: boolean
  host: string
  keepCheckout: boolean
  yes: boolean
  multi: boolean
}

/** `owner/name`, as `--repo` takes it for `review` and `doctor` alike. */
export const parseRepo = (s: string | undefined): { owner: string; repo: string } => {
  if (s === undefined) throw new UsageError('--repo is required, as owner/name')
  const parts = s.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new UsageError(`--repo must be owner/name, got ${JSON.stringify(s)}`)
  }
  return { owner: parts[0], repo: parts[1] }
}

/** A host name and nothing else: no scheme, no path, no credentials. It becomes the API's address and
 *  the `--hostname` handed to `gh`, so anything that is not a host is refused here rather than turned
 *  into a URL nobody meant. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/

export const parseGitHubHost = (h: string | undefined): string => {
  if (h === undefined) return GITHUB_COM
  const host = h.trim().toLowerCase()
  if (!HOST.test(host)) {
    throw new UsageError(
      `--github-host must be a host name, such as github.example.com — no https:// and no path — got ${JSON.stringify(h)}`,
    )
  }
  return host
}

/** Where the REST API is for a host (spec 0.2.0 §5.2): github.com's default, or GitHub Enterprise
 *  Server's `https://<host>/api/v3`. Undefined for github.com, so the client keeps its own default. */
export const apiBaseUrlFor = (host: string): string | undefined =>
  host === GITHUB_COM ? undefined : `https://${host}/api/v3`

export const parseFlags = (f: ReviewFlags): ValidatedFlags => {
  const { owner, repo } = parseRepo(f.repo)
  if (f.pr === undefined) throw new UsageError('--pr is required')
  const pr = Number(f.pr)
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new UsageError(`--pr must be a positive whole number, got ${JSON.stringify(f.pr)}`)
  }

  let tier: Tier | undefined
  if (f.tier !== undefined) {
    if (!(TIERS as readonly string[]).includes(f.tier)) {
      throw new UsageError(`--tier must be one of ${TIERS.join(', ')}, got ${JSON.stringify(f.tier)}`)
    }
    tier = f.tier as Tier
  }
  let effort: Effort | undefined
  if (f.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(f.effort)) {
      throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(f.effort)}`)
    }
    effort = f.effort as Effort
  }
  let budgetUsd: number | undefined
  if (f.budget !== undefined) {
    budgetUsd = Number(f.budget)
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new UsageError(`--budget must be a positive number of dollars, got ${JSON.stringify(f.budget)}`)
    }
  }
  if (f.check === true && f.skipCheck === true) {
    throw new UsageError('--check and --skip-check contradict each other')
  }
  const check = f.check === true ? true : f.skipCheck === true ? false : undefined

  const post = f.post === true
  let report: ReportWant = 'auto'
  if (f.report !== undefined) {
    const want = Object.hasOwn(REPORTS, f.report) ? REPORTS[f.report] : undefined
    if (want === undefined) {
      throw new UsageError(`--report must be one of ${Object.keys(REPORTS).join(', ')}, got ${JSON.stringify(f.report)}`)
    }
    // A flag that would do nothing is refused rather than ignored: somebody who typed it expects a
    // report on the commit, and a review that only prints writes nothing anywhere.
    if (!post) throw new UsageError('--report says how a posted review is reported on the commit: add --post, or leave it out')
    report = want
  }
  // The same, for `--re-review`: the earlier summary it reads is one this product posted, and a review
  // that posts nothing reads none (spec 0.2.0 §5.2). `--no-re-review` without --post is what happens
  // anyway, so it is accepted.
  if (f.reReview === true && !post) {
    throw new UsageError("--re-review reads the reviewer's earlier summary on the pull request, which only a posting review does: add --post, or leave it out")
  }

  return {
    owner, repo, pr,
    ...(tier !== undefined && { tier }),
    ...(f.model !== undefined && { model: f.model }),
    ...(effort !== undefined && { effort }),
    ...(check !== undefined && { check }),
    ...(f.brief !== undefined && { brief: f.brief }),
    ...(budgetUsd !== undefined && { budgetUsd }),
    json: f.json === true,
    post,
    report,
    reReview: post && f.reReview !== false,
    host: parseGitHubHost(f.githubHost),
    keepCheckout: f.keepCheckout === true,
    // Accepted without --post, unlike --report: a script that always passes it is not wrong.
    yes: f.yes === true,
    multi: f.multi === true,
  }
}

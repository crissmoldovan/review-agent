import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, modelCredentialFromEnv, SecretLeak,
  type ModelCredential, type ReportMode, type ReviewRecord,
} from '@review-agent/core'
import {
  duplicatesIn, noReporter, prepareReview, reporterFor, runReviewSession, tokenIdentityOf,
  type PublishedReview, type Reporter, type ReviewAsk, type ReviewVia, type RunReviewDeps,
  type RunReviewResult, type SessionReport, type SessionResult, type TokenIdentity,
} from '@review-agent/github'
import {
  EXIT_BAD_USAGE, EXIT_ENGINE_FAILURE, EXIT_OK, EXIT_POST_FAILED, EXIT_SECRET_LEAK,
} from './exit-codes'
import { apiBaseUrlFor, parseFlags, UsageError, type ReviewFlags } from './flags'
import { resolveGitHubToken, type GhCli, type GitHubTokenSource } from './github-token'

/** The pipeline's dependencies plus the ones only a terminal has. Derived from `RunReviewDeps`
 *  rather than listed again, so a dependency added to the pipeline reaches this command by failing
 *  to compile instead of by being forgotten. `note` is omitted because the CLI's answer to it is
 *  `stderr`, and a caller that could pass both would have two ways to say the same thing. */
export type ReviewCommandDeps = Omit<RunReviewDeps, 'note'> & {
  makeOctokit: (a: { token: string; baseUrl?: string }) => Octokit
  stdout: (s: string) => void
  stderr: (s: string) => void
  env: Record<string, string | undefined>
  /** The GitHub CLI: steps 3 and 4 of where the token comes from (spec 0.2.0 §5.3). */
  gh: GhCli
  /** A person is at a terminal to answer a question: stdin is a TTY. Without one nothing is asked, so
   *  CI is never stuck at a prompt, and `--yes` is implied (spec 0.2.0 §5.2). */
  interactive: boolean
  /** A `[y/N]` question on the terminal; anything but a yes is a no (confirm.ts). */
  confirm: (question: string, signal?: AbortSignal) => Promise<boolean>
}

/** What `--json` prints with `--post` (decision §14.8): the record, and what became of it on GitHub —
 *  so a script can tell "reviewed and posted" from "reviewed, not posted" without reading stderr. */
export type PostedJson = {
  record: ReviewRecord
  posted: { reviewId: number | null; summaryCommentId: number | null; summaryUrl: string | null; inlineComments: number } | null
  report: { kind: SessionReport['kind']; conclusion: SessionReport['conclusion']; url: string | null } | null
}

const STOPPED = 'the review was stopped before it finished; nothing was printed'

export const runReviewCommand = async (
  flags: ReviewFlags, deps: ReviewCommandDeps,
  /** `signal`: the first Ctrl-C (interrupt.ts). It stops the review and the Claude process with it,
   *  and a report already opened on the commit is finished as interrupted (spec 0.2.0 §5.4). */
  options: { signal?: AbortSignal } = {},
): Promise<number> => {
  // The GitHub token is never printed (spec 0.2.0 §5.3, §10), and this command prints error messages
  // other code wrote — an octokit error can quote the request it made. So once the token is known,
  // nothing reaches the terminal with it in. A token shorter than any GitHub issues is not hunted for:
  // replacing every "1" in the output would hide everything and protect nothing.
  let token = ''
  const scrub = (s: string): string => (token.length >= 8 ? s.split(token).join('[redacted]') : s)
  const out = (s: string): void => { deps.stdout(scrub(s)) }
  const err = (s: string): void => { deps.stderr(scrub(s)) }

  try {
    const f = parseFlags(flags)
    // Before the token check and before any GitHub call, so a misconfigured machine is told so before
    // anything is downloaded. Two rules, both core's (spec 0.2.0 §3.1): ANTHROPIC_BASE_URL refused
    // (Task 0, Criss 2026-09-14, decision 10), and exactly one model credential — both set is refused
    // since 0.2.0 (decision §14.4), so a review is always billed somewhere nameable. Neither is still
    // allowed here, and only here: the CLI runs as a person, on their machine, with their login.
    let credential: ModelCredential
    try {
      credential = modelCredentialFromEnv(deps.env, { allowLogin: true })
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e))
    }

    const found = await resolveGitHubToken({
      env: deps.env, host: f.host, gh: deps.gh, need: f.post ? 'post' : 'read', repo: `${f.owner}/${f.repo}`,
      interactive: deps.interactive, confirm: deps.confirm, stderr: err,
      ...(options.signal !== undefined && { signal: options.signal }),
    })
    token = found.token
    const baseUrl = apiBaseUrlFor(f.host)
    const octokit = deps.makeOctokit({ token: found.token, ...(baseUrl !== undefined && { baseUrl }) })

    // Posting only: who the token is, and so what it can report with — one GET /user, no write
    // (spec 0.2.0 §2.2, §5.4). A review that only prints asks GitHub nothing it does not need.
    let identity: TokenIdentity | null = null
    let reporter: Reporter = noReporter
    if (f.post) {
      identity = await identityOf(octokit, found.source, f.host)
      if (f.report === 'check-run' && identity.kind === 'user') {
        throw new UsageError(
          "--report check-run needs a token that can create check runs — a GitHub App's, or GitHub Actions' " +
          "GITHUB_TOKEN with checks: write. GitHub lets no person's token create one; use --report status, or auto.",
        )
      }
      reporter = await reporterFor({ octokit, want: f.report, identity })
    }

    const ask: ReviewAsk = {
      ...(f.tier !== undefined && { tier: f.tier }),
      ...(f.multi && { multi: true }),
      ...(f.model !== undefined && { model: f.model }),
      ...(f.effort !== undefined && { effort: f.effort }),
      ...(f.check !== undefined && { check: f.check }),
      ...(f.brief !== undefined && { brief: f.brief }),
      ...(f.budgetUsd !== undefined && { budgetUsd: f.budgetUsd }),
    }
    const { makeOctokit: _m, stdout: _o, stderr: _e, env: _v, gh: _g, interactive: _i, confirm: _c, ...pipeline } = deps
    const prepared = await prepareReview({
      octokit, owner: f.owner, repo: f.repo, number: f.pr,
      // The CLI is a deployment of one: it reads no configuration file of its own, so the built-in
      // table is the whole of it. What the reviewed repository adds comes from its base branch.
      deployment: defaultDeploymentConfig(),
      ask,
      deps: { fetchPullRequest: pipeline.fetchPullRequest, fetchRepoConfig: pipeline.fetchRepoConfig },
    })
    if (prepared.kind === 'failed') { err(prepared.reason); return EXIT_ENGINE_FAILURE }

    // Spec 0.2.0 §5.4: once, before anything is spent, say what will be written and as whom. Asked on a
    // terminal; in CI it is said and not asked, so the log shows it.
    if (f.post && identity !== null) {
      const plan = describePosting({
        identity, owner: f.owner, repo: f.repo, number: f.pr, mode: prepared.settings.report.mode,
        reporter: reporter.kind, fallsBack: f.report === 'auto', name: prepared.settings.report.checkRunName,
      })
      if (plan.writes && deps.interactive && !f.yes) {
        const yes = await deps.confirm(`${plan.sentence} Continue? [y/N]`, options.signal)
        if (!yes) {
          err(options.signal?.aborted === true
            ? 'stopped before the review started; nothing was reviewed or posted'
            : 'nothing was reviewed and nothing was posted')
          return EXIT_ENGINE_FAILURE
        }
      } else {
        err(plan.sentence)
      }
    }

    const via: ReviewVia = {
      kind: 'cli',
      login: identity?.kind === 'user' ? identity.login : null,
      // Wording only — what it reports with was decided from the token above (spec 0.2.0 §2.2).
      from: deps.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'command-line',
    }
    const session = await runReviewSession({
      prepared,
      post: f.post,
      reporter,
      via,
      // The summary comment this login posted is the one to edit (decision §14.7). No bot's replies are
      // ignored: the person posting may be the one replying `/dispute` (decision §14.6).
      ...(identity?.kind === 'user' && { selfLogin: identity.login }),
      reReview: f.reReview,
      // Passed explicitly, so the Claude process gets this credential and no other (spec 0.2.0 §3.2) —
      // the one the rule above chose, not whatever else the shell happens to hold.
      runtime: { credential },
      keepCheckout: f.keepCheckout,
      ...(options.signal !== undefined && { signal: options.signal }),
      deps: {
        // The pipeline's progress lines are stderr here, so --json stays one parseable document.
        runReviewDeps: { ...pipeline, note: err },
        log: (message, fields) => { err(typeof fields.error === 'string' ? `${message}: ${fields.error}` : message) },
      },
    })
    return finishWith(session, { json: f.json, post: f.post, out, err })
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return EXIT_BAD_USAGE }
    // Anything else — GitHub unreachable, a bug here — is a review that did not happen. Exit 1 says
    // so; a stack trace at the user says less.
    err(`the review did not complete: ${e instanceof Error ? e.message : String(e)}`)
    return EXIT_ENGINE_FAILURE
  }
}

/** Who the token is. A 401 is a missing thing — a token that is not one — so it is a 2, like no token
 *  at all (spec 0.2.0 §5.5); anything else is GitHub not answering, and a review that did not happen. */
const identityOf = async (octokit: Octokit, source: GitHubTokenSource, host: string): Promise<TokenIdentity> => {
  try {
    return await tokenIdentityOf(octokit)
  } catch (e) {
    if ((e as { status?: unknown }).status === 401) {
      const from = source === 'gh' ? `the GitHub CLI's login for ${host}` : source
      throw new UsageError(`GitHub refused the token from ${from} (401): it is wrong, expired or revoked`)
    }
    throw new Error(`could not ask GitHub who the token belongs to: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** "a, b and c". */
const listed = (parts: string[]): string =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/** The one sentence a person reads before a review is posted as them (spec 0.2.0 §5.4), and whether
 *  anything will be written at all. It follows the session's own rules: a `silent` repository writes
 *  nothing, and `check-only` with no check run to carry its annotations says its findings in the summary
 *  comment instead (decision §14.3). */
export const describePosting = (a: {
  identity: TokenIdentity
  owner: string; repo: string; number: number
  mode: ReportMode
  reporter: Reporter['kind']
  /** `--report auto`: a check run that falls back to a commit status when the token cannot create one. */
  fallsBack: boolean
  /** The check run's name, or the commit status's context. */
  name: string
}): { writes: boolean; sentence: string } => {
  const where = `${a.owner}/${a.repo}#${a.number}`
  if (a.mode === 'silent') {
    return { writes: false, sentence: `Nothing will be posted on ${where}: this repository's settings make the review silent, so it is only printed here.` }
  }
  const who = a.identity.kind === 'user' ? `@${a.identity.login}` : "this token's GitHub App installation"
  const checkRun = a.reporter === 'check-run'
  const mode: ReportMode = a.mode === 'check-only' && !checkRun ? 'summary-only' : a.mode
  const parts: string[] = []
  if (mode === 'inline+summary') parts.push('a review with inline comments', 'a summary comment')
  if (mode === 'summary-only') parts.push('a summary comment')
  if (checkRun) {
    parts.push(`a check run "${a.name}"${mode === 'check-only' ? ' with the findings as annotations' : ''}` +
      (a.fallsBack ? ' (a commit status, if the token cannot create one)' : ''))
  }
  if (a.reporter === 'commit-status') parts.push(`a commit status "${a.name}"`)
  return { writes: true, sentence: `This will post as ${who} on ${where}: ${listed(parts)}.` }
}

/** The exit code a session ends with, and what is printed for it. */
const finishWith = (s: SessionResult, o: {
  json: boolean; post: boolean; out: (s: string) => void; err: (s: string) => void
}): number => {
  const print = (review: RunReviewResult, published: PublishedReview | null, report: SessionReport | null): void => {
    if (o.json && o.post) {
      const envelope: PostedJson = {
        record: review.record,
        posted: published === null ? null : {
          reviewId: published.reviewId, summaryCommentId: published.summaryCommentId,
          summaryUrl: published.summaryUrl, inlineComments: published.counts.inline,
        },
        report: report === null ? null : { kind: report.kind, conclusion: report.conclusion, url: report.url },
      }
      o.out(JSON.stringify(envelope, null, 2) + '\n')
    } else if (o.json) {
      o.out(JSON.stringify(review.record, null, 2) + '\n')
    } else {
      o.out(render(review) + (o.post ? postedLines(published, report) : ''))
    }
  }
  const keptAt = (dir: string | null): void => { if (dir !== null) o.err(`the downloaded code was kept at ${dir}`) }
  // A report finished as interrupted says so on the commit (spec 0.2.0 §5.4); the person who pressed
  // Ctrl-C is told it was, so they know nothing is left pending.
  const stopped = (report: SessionReport | null): string =>
    report?.kind === 'commit-status' && report.conclusion !== null
      ? `${STOPPED}; the commit status says the review was interrupted`
      : STOPPED

  switch (s.kind) {
    case 'reviewed':
      print(s.review, s.published, s.report)
      keptAt(s.checkoutDir)
      // A review cut short by its ceiling still says what it found, and is still not finished.
      return s.review.result.failure === null ? EXIT_OK : EXIT_ENGINE_FAILURE
    case 'unfinished':
      if (s.stopped === 'cancelled') { o.err(stopped(s.report)); return EXIT_ENGINE_FAILURE }
      print(s.review, s.published, s.report)
      keptAt(s.checkoutDir)
      return EXIT_ENGINE_FAILURE
    case 'failed':
      // Order matters: a withheld review is not a failure to report in the usual words, whose reason
      // a reader would take for the review's content. SecretLeak's own message is names and
      // locations only (core, secrets.ts).
      if (s.stage === 'withheld') {
        o.err(`refusing to emit this review: ${s.cause instanceof SecretLeak ? s.cause.message : s.reason}`)
        return EXIT_SECRET_LEAK
      }
      if (s.stopped === 'cancelled') { o.err(stopped(s.report)); return EXIT_ENGINE_FAILURE }
      if (s.stage === 'publish' && s.review !== null) {
        // Spec 0.2.0 §5.5: reviewed and paid for, and GitHub would not take it. The review is printed
        // so it is not lost, and the exit code says it is not on the pull request.
        o.err(s.reason)
        print(s.review, null, s.report)
        keptAt(s.review.checkoutDir)
        return EXIT_POST_FAILED
      }
      o.err(s.reason)
      return EXIT_ENGINE_FAILURE
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** Where the review went, under the readable summary. */
const postedLines = (published: PublishedReview | null, report: SessionReport | null): string => {
  const lines: string[] = []
  if (published === null) {
    lines.push('NOT POSTED: the review is above, and nothing of it is on the pull request.')
  } else if (published.mode === 'silent') {
    lines.push("posted nothing: this repository's settings make the review silent")
  } else {
    const what = [
      ...(published.counts.inline > 0 ? [plural(published.counts.inline, 'inline comment')] : []),
      ...(published.summaryCommentId !== null ? ['a summary comment'] : []),
    ]
    // `check-only` with a check run writes no comment at all: its findings are the run's annotations.
    lines.push(`posted ${what.length === 0 ? 'no comment' : listed(what)}` +
      (published.summaryUrl === null ? '' : `: ${published.summaryUrl}`))
  }
  if (report !== null) {
    const kind = report.kind === 'check-run' ? 'a check run' : 'a commit status'
    lines.push(`reported with ${kind}: ${report.conclusion ?? 'it could not be completed'}` +
      (report.kind === 'check-run' && report.url !== null ? ` (${report.url})` : ''))
  }
  return ['', ...lines].join('\n') + '\n'
}

const render = (review: RunReviewResult): string => {
  const { pr, settings, result, check, record } = review
  const lines: string[] = [
    `${pr.owner}/${pr.repo}#${pr.number} at ${pr.headSha.slice(0, 7)} — tier ${settings.tier}, ` +
    `${settings.model}, effort ${settings.effort}`,
  ]
  if (result.output !== null) {
    lines.push('', result.output.summary, '',
               `intent: ${result.output.intent.verdict} — ${result.output.intent.note}`, '')
    // A multi-reviewer review's duplicates are said once, as posting says them (spec 0.2.0 §8.3, decision
    // 17): the finding the check pass kept is listed, with the other focuses that found it too. The
    // full list, duplicates included, stays on the record (`--json`). Measured 2026-10-15: the first
    // captured `--multi` review printed two of its findings twice before this.
    const findings = result.output.findings
    const duplicates = duplicatesIn(check === null ? null : { findings, verdicts: check.verdicts })
    const alsoFoundBy = new Map<number, Set<string>>()
    for (const v of check?.verdicts ?? []) {
      if (!duplicates.has(v.index) || typeof v.duplicateOf !== 'number') continue
      const lens = findings[v.index]?.lens
      if (lens === undefined) continue
      const lenses = alsoFoundBy.get(v.duplicateOf) ?? new Set<string>()
      lenses.add(lens)
      alsoFoundBy.set(v.duplicateOf, lenses)
    }
    findings.forEach((finding, i) => {
      if (duplicates.has(i)) return
      const verdict = check?.verdicts.find((v) => v.index === i)
      // At the check pass's severity, as posting says it (`selectForPosting`), so the terminal and
      // the pull request give one number; the reviewer's own is kept beside it. A refuted finding is
      // never posted, so it keeps the reviewer's. Measured 2026-10-15: the demo's pull request #14
      // printed 8/10 where the review it posted said 7/10.
      const severity = verdict === undefined || verdict.verdict === 'refuted' ? finding.severity : verdict.severity
      const also = [...(alsoFoundBy.get(i) ?? [])].filter((l) => l !== finding.lens)
      const notes = [
        ...(verdict === undefined ? [] : [`check: ${verdict.verdict}` +
          (severity === finding.severity ? '' : `, was ${finding.severity}/10`)]),
        ...(also.length === 0 ? [] : [`also found by ${also.join(', ')}`]),
      ]
      // The focus that found it, when it says something the category does not (`impact` found by the
      // impact reviewer needs no second word).
      const focus = finding.lens === undefined || finding.lens === finding.category ? '' : ` · ${finding.lens} reviewer`
      lines.push(`  [${severity}/10 ${finding.category}${focus}] ${finding.file}:${finding.line} ${finding.title}` +
                 (notes.length === 0 ? '' : ` [${notes.join(' · ')}]`))
    })
    if (duplicates.size > 0) {
      lines.push(`  (${duplicates.size} ${duplicates.size === 1 ? 'duplicate' : 'duplicates'} merged — found by more than one reviewer; all are in --json)`)
    }
    if (result.output.findings.length === 0) lines.push('  no findings')
    for (const i of result.output.inconclusive) {
      lines.push(`  [?] ${i.question} — would be settled by: ${i.whatWouldSettleIt}`)
    }
  }
  if (result.failure !== null) {
    // The CLI's own words when it has them: "Not logged in · Please run /login" tells a user what to do.
    const detail = result.failure.kind === 'cli-error' && result.failure.message ? ` — ${result.failure.message}` : ''
    lines.push('', `FAILED: ${result.failure.kind}${detail}`)
  }
  if (result.wrapUpFired) lines.push('', 'the soft budget fired: the review was told to write up what it had.')
  if (result.cutShort) lines.push('', 'CUT SHORT: the hard ceiling fired; this review is partial.')
  // The record's total, which is every pass this review bought — the re-review pass and every focus of
  // a multi-reviewer review included — and labelled, because it is the CLI's `total_cost_usd`: model
  // spend at per-token API prices, whichever credential paid (a subscription draws it from its
  // allowance instead).
  const recheckUsd = record.recheckUsage?.costUsd ?? 0
  lines.push('', `$${record.costUsd.toFixed(2)} model spend at per-token API prices · ${result.usage.turns} turns · ` +
                 `${Math.round(result.usage.durationMs / 1000)}s` +
                 (check === null ? '' : ` · check $${check.usage.costUsd.toFixed(2)}`) +
                 (recheckUsd > 0 ? ` · re-review $${recheckUsd.toFixed(2)}` : ''))
  return lines.join('\n') + '\n'
}

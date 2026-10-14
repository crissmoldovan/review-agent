import type { Octokit } from '@octokit/core'
import {
  defaultDeploymentConfig, gatewayBaseUrlRefusal, SecretLeak, type EngineResult, type ResolvedSettings,
} from '@review-agent/core'
import {
  removeCheckout, runReview, type CheckPassResult, type PullRequestContext, type ReviewAsk, type RunReviewDeps,
} from '@review-agent/github'
import { EXIT_BAD_USAGE, EXIT_ENGINE_FAILURE, EXIT_OK, EXIT_SECRET_LEAK } from './exit-codes'
import { parseFlags, UsageError, type ReviewFlags } from './flags'

/** The pipeline's dependencies plus the ones only a terminal has. Derived from `RunReviewDeps`
 *  rather than listed again, so a dependency added to the pipeline reaches this command by failing
 *  to compile instead of by being forgotten. `note` is omitted because the CLI's answer to it is
 *  `stderr`, and a caller that could pass both would have two ways to say the same thing. */
export type ReviewCommandDeps = Omit<RunReviewDeps, 'note'> & {
  makeOctokit: (token: string) => Octokit
  stdout: (s: string) => void
  stderr: (s: string) => void
  env: Record<string, string | undefined>
}

export const runReviewCommand = async (
  flags: ReviewFlags, deps: ReviewCommandDeps,
): Promise<number> => {
  try {
    const f = parseFlags(flags)
    // Task 0, Criss 2026-09-14 (decision 10): kept through this rewrite. Before the token check and
    // before any GitHub call.
    const gateway = gatewayBaseUrlRefusal(deps.env)
    if (gateway !== null) throw new UsageError(gateway)
    const token = deps.env.GITHUB_TOKEN ?? deps.env.GH_TOKEN
    if (token === undefined || token === '') {
      throw new UsageError(
        'GITHUB_TOKEN is not set. The CLI needs a token with Contents: Read and Pull requests: Read ' +
        'on the repository, and nothing more.',
      )
    }
    const ask: ReviewAsk = {
      ...(f.tier !== undefined && { tier: f.tier }),
      ...(f.model !== undefined && { model: f.model }),
      ...(f.effort !== undefined && { effort: f.effort }),
      ...(f.check !== undefined && { check: f.check }),
      ...(f.brief !== undefined && { brief: f.brief }),
      ...(f.budgetUsd !== undefined && { budgetUsd: f.budgetUsd }),
    }

    const { pr, settings, result, check, record, checkoutDir } = await runReview({
      octokit: deps.makeOctokit(token),
      owner: f.owner, repo: f.repo, number: f.pr,
      // The CLI is a deployment of one: it reads no configuration file of its own, so the built-in
      // table is the whole of it. What the reviewed repository adds comes from its base branch.
      deployment: defaultDeploymentConfig(),
      ask,
      // The pipeline's progress lines are stderr here, so --json stays one parseable document.
      deps: { ...deps, note: deps.stderr },
    })

    // The CLI publishes nothing, so it has finished with the downloaded code.
    await removeCheckout(checkoutDir)
    if (f.json) deps.stdout(JSON.stringify(record, null, 2) + '\n')
    else deps.stdout(render({ pr, settings, result, check }))

    return result.failure === null && result.output !== null ? EXIT_OK : EXIT_ENGINE_FAILURE
  } catch (e) {
    // Order matters: a SecretLeak is not a usage error and must never fall through to the generic
    // branch, which prints the message it is carrying.
    if (e instanceof SecretLeak) {
      deps.stderr(`refusing to emit this review: ${e.message}`)
      return EXIT_SECRET_LEAK
    }
    if (e instanceof UsageError) { deps.stderr(e.message); return EXIT_BAD_USAGE }
    // Anything else — a spawn that failed, a GitHub 404, a bug here — is a review that did not
    // happen. Exit 1 says so; a stack trace at the user says less.
    deps.stderr(`the review did not complete: ${e instanceof Error ? e.message : String(e)}`)
    return EXIT_ENGINE_FAILURE
  }
}

const render = (a: {
  pr: PullRequestContext; settings: ResolvedSettings; result: EngineResult; check: CheckPassResult | null
}): string => {
  const { pr, settings, result, check } = a
  const lines: string[] = [
    `${pr.owner}/${pr.repo}#${pr.number} at ${pr.headSha.slice(0, 7)} — tier ${settings.tier}, ` +
    `${settings.model}, effort ${settings.effort}`,
  ]
  if (result.output !== null) {
    lines.push('', result.output.summary, '',
               `intent: ${result.output.intent.verdict} — ${result.output.intent.note}`, '')
    result.output.findings.forEach((finding, i) => {
      const verdict = check?.verdicts.find((v) => v.index === i)
      const suffix = verdict === undefined ? '' : ` [check: ${verdict.verdict}]`
      lines.push(`  [${finding.severity}/10 ${finding.category}] ${finding.file}:${finding.line} ${finding.title}${suffix}`)
    })
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
  const costUsd = result.usage.costUsd + (check?.usage.costUsd ?? 0)
  lines.push('', `$${costUsd.toFixed(2)} · ${result.usage.turns} turns · ` +
                 `${Math.round(result.usage.durationMs / 1000)}s` +
                 (check === null ? '' : ` · check $${check.usage.costUsd.toFixed(2)}`))
  return lines.join('\n') + '\n'
}

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Octokit } from '@octokit/core'
import { MARKER_OPEN, decodeMarker, fetchPullRequest } from '@review-agent/github'
import { describe, expect, it } from 'vitest'
import { runReviewJob, runnerDeployment } from '../../src/tasks/review-job'
import { DEFAULT_DEADLINE_MS, MODEL_CREDENTIAL_VARS } from '../../src/tasks/review-run'

// The proving ground: a repository created for this test and nothing else. The first thing this
// product does that WRITES to GitHub does not write to a repository anyone works in.
// Criss's personal account, not an organisation's (decision 13). The owner is also who asks for the
// review below: a requested review is refused unless the requester can push (Task 13, decision 3).
// THE PROVING GROUND IS NOT EMPTY, and it is not ours alone. Found read-only on 2026-09-15, before
// this product had posted anything: a third-party review App is installed on this repository and
// reviewed PR #1 within two minutes of its creation — one issue comment, two reviews carrying one
// inline comment each, and a check run of its own concluding `failure`.
// Its inline comments even carry `Severity N/10`, the same convention this product uses.
// Every read-back below is therefore filtered on something only OUR review has, and none of them is
// a count of everything on the pull request: the summary comment on `MARKER_OPEN`, the inline
// comments on `pull_request_review_id`, and the check run on the id the job returned. That was true
// before this was known and is now deliberate — verified against a real second bot rather than
// assumed. Nothing here asserts the other App's presence: it is Criss's installation, not this
// plan's, and it may be gone tomorrow.
const OWNER = 'crissmoldovan'
const REPO = 'review-agent-proving-ground'
const NUMBER = 1
const SEEDED_FILE = 'src/retry.ts'

// Gate 1: no GitHub token, no suite. This token does the reading the test verifies with; the
// product does its writing with the App's own installation token, which it mints itself.
const token = process.env.GITHUB_TOKEN ?? ''
const describeIf = token === '' ? describe.skip : describe

describeIf('the App posts a review', () => {
  it('is pointed at the proving ground, at the pull request seeded with a defect', { timeout: 60_000 }, async () => {
    const pr = await fetchPullRequest({
      octokit: new Octokit({ auth: token }), owner: OWNER, repo: REPO, number: NUMBER,
    })
    expect(pr.changedFiles.map((f) => f.path)).toEqual([SEEDED_FILE])
    // THE SEEDED BACKOFF DEFECT WAS REPAIRED, by commit 487f857 on 2026-09-15, which is what run 3
    // was measuring. Verified against the live pull request the same day: the diff holds
    // `setTimeout(resolve, delayMs)` and NOT `setTimeout(resolve, 0)`, which is what the assertion
    // here used to say. It was left asserting the old shape and failed silently, because this file
    // is excluded from `pnpm test` (vitest.config.ts) and only the operator ever runs it.
    //
    // The computed delay is still asserted, because it is the line the pull request's prose claims a
    // schedule for and the one the other defects sit around. The backoff line is asserted in its
    // REPAIRED shape: this pull request is no longer a first-review fixture, it is a re-review one.
    expect(pr.diff).toContain('const delayMs = baseDelayMs * 2 ** attempt')
    expect(pr.diff).toContain('setTimeout(resolve, delayMs)')
    expect(pr.diff).not.toContain('setTimeout(resolve, 0)')
    // The body claims a backoff the code does not do: the reviewer has something to disagree with.
    // The plan predicted the words "backs off between attempts"; what the operator seeded claims a
    // schedule instead, and says it twice — here and again in the doc comment on `withRetry`.
    expect(pr.body).toContain('exponential backoff — 100ms, then 200ms, then 400ms')
    expect(pr.diff).toContain('200ms, then 400ms')
  })

  // Gate 2: the App's own credentials, which only the operator has. The private key is read from
  // the operator's own file inline on the command that runs this suite — it is never written here,
  // never committed and never printed. These names are deliberately NOT the deployment's
  // `REVIEW_AGENT_APP_*` pair (credentials.ts, Task 13): a developer who has a deployment's
  // variables in their shell must still opt in by name before this test can spend.
  const clientId = process.env.REVIEW_AGENT_E2E_APP_CLIENT_ID ?? ''
  const privateKeyPem = process.env.REVIEW_AGENT_E2E_APP_PRIVATE_KEY ?? ''
  const installationId = process.env.REVIEW_AGENT_E2E_INSTALLATION_ID ?? ''
  // The job asserts a model credential itself — EXACTLY one of these two, throwing when neither is
  // set and when both are (assertModelCredential, Task 13). The gate asks the same question, so a
  // shell holding both skips instead of running the paid case into that throw on its first call.
  const haveModel = MODEL_CREDENTIAL_VARS.filter((name) => (process.env[name] ?? '') !== '').length === 1
  const haveApp = clientId !== '' && privateKeyPem !== '' && installationId !== '' && haveModel

  // Gate 3: money. ONE basic review of a one-file pull request, paying for the disprove-it check
  // pass as well (the basic default since Task 0), on ANTHROPIC_API_KEY. Capped at $5.00 by the
  // request's budgetUsd of 1.6 below: a $4.00 review ceiling plus the check pass's own $1.00, at
  // per-token API prices. At the tier's own $2 target the two ceilings would be $6.25. It is the
  // first of the two reviews Criss approved (decision 14); the second is Step 16's hosted run.
  // Nothing here can be reached from `pnpm test`, and it is not rerun without asking Criss.
  const paid = process.env.REVIEW_AGENT_E2E_PAID === '1' && haveApp ? it : it.skip

  // The job bounds its run at DEFAULT_DEADLINE_MS, so one run plus a minute of GitHub reads is
  // what this test allows: the job's own deadline fires first and the test sees its error, instead
  // of vitest killing the process mid-review with nothing written down.
  paid('posts one summary comment, inline comments and a successful check run',
    { timeout: DEFAULT_DEADLINE_MS + 60_000 }, async () => {
    const reader = new Octokit({ auth: token })
    const pr = await fetchPullRequest({ octokit: reader, owner: OWNER, repo: REPO, number: NUMBER })
    const base = {
      identity: { clientId, privateKeyPem },
      installationId: Number(installationId),
    }
    const baselinePath = join(import.meta.dirname, 'first-post-baseline.json')

    const startedFirst = Date.now()
    const first = await runReviewJob({
      ...base,
      request: {
        repo: `${OWNER}/${REPO}`, pr: NUMBER, headSha: pr.headSha, tier: 'basic',
        // Decision 14's $5 cap, enforced rather than hoped for: a $1.60 target gives the review a
        // $4.00 ceiling and the check pass a $1.00 one (budgetFor, CHECK_BUDGET_FRACTION), per-token
        // API prices. A request may lower a budget, never raise it.
        budgetUsd: 1.6,
        // The account owner, who can push: a requested review is refused otherwise (decision 3),
        // and a made-up login would be refused before anything was spent.
        requestedBy: OWNER, requestId: `e2e-first-${startedFirst}`,
      },
    })
    const firstSeconds = Math.round((Date.now() - startedFirst) / 1000)

    // The result is a union, and its two absences are real cases, not shrugs: `skipped` means the
    // job decided this pull request was release-only, and a null check run means `silent` mode.
    // Both are stated as failures with a sentence rather than read through `?.`, so a wrong shape
    // fails legibly instead of asserting against undefined.
    if (first.kind !== 'reviewed') throw new Error(`expected a posted review; the job returned ${first.kind}: ${first.reason}`)
    const checkRun = first.checkRun
    if (checkRun === null) throw new Error('the runner deployment is not `silent`, so a check run was expected')

    // Read back as the operator, with the operator's token: what a person opening the pull request
    // would see, not what the posting code believes it did.
    const issueComments = await reader.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: OWNER, repo: REPO, issue_number: NUMBER, per_page: 100,
    })
    // That endpoint has no author filter, and the `<slug>[bot]` login convention is not in GitHub's
    // documentation: the bot's own comment is the one carrying the marker the product writes.
    const ours = issueComments.data.filter((c) => (c.body ?? '').includes(MARKER_OPEN))

    const reviewComments = await reader.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner: OWNER, repo: REPO, pull_number: NUMBER, per_page: 100,
    })
    // `pull_request_review_id` is how a comment is tied back to the review that made it — the same
    // field the product uses to fill in the marker's comment ids.
    const inline = reviewComments.data.filter((c) => c.pull_request_review_id === first.reviewId)
    const marker = decodeMarker(ours[0]?.body ?? '')
    const suggestionIds = inline.filter((c) => c.body.includes('```suggestion')).map((c) => c.id)

    // The name and status of the check run are not on the result — it carries `{ id, conclusion }` —
    // so they come from GitHub, on the sha the job says it posted on. `filter` defaults to `latest`,
    // and this read happens before the second run, so ours is the one listed.
    const checkRuns = await reader.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner: OWNER, repo: REPO, ref: first.headSha, per_page: 100,
    })
    const listed = checkRuns.data.check_runs.find((r) => r.id === checkRun.id)
    if (listed === undefined) throw new Error(`check run ${checkRun.id} is not listed on ${first.headSha}`)

    // Written before anything is asserted, so a failed assertion still leaves the run measured.
    // Step 17's read-back adds the hosted run to the same file.
    await writeFile(baselinePath, JSON.stringify({
      recordedAt: new Date().toISOString(),
      target: { repo: `${OWNER}/${REPO}`, pr: NUMBER, headSha: pr.headSha },
      checkRunName: first.record.settings.report.checkRunName,
      first: {
        reviewedHeadSha: first.headSha,
        reviewId: first.reviewId,
        summaryCommentId: first.summaryCommentId,
        summaryComments: ours.length,
        inlineComments: inline.length,
        suggestionCommentIds: suggestionIds,
        counts: first.counts,
        checkRun: {
          id: checkRun.id,
          conclusion: checkRun.conclusion,
          onGitHub: { name: listed.name, status: listed.status, conclusion: listed.conclusion },
        },
        tier: first.record.settings.tier,
        model: first.record.settings.model,
        effort: first.record.settings.effort,
        budget: first.record.settings.budget,
        costUsd: first.record.costUsd,
        usage: first.record.usage,
        findings: first.record.output?.findings.length ?? null,
        intent: first.record.output?.intent.verdict ?? null,
        failure: first.record.failure,
        wallClockSeconds: firstSeconds,
        markerRuns: marker?.runs.length ?? null,
      },
    }, null, 2) + '\n')

    // The job reviews and posts on the sha it resolved itself, not on the one it was handed. If
    // this differs, somebody pushed while the test was running and every number above is about a
    // different commit — which is a failure, not a detail.
    expect(first.headSha).toBe(pr.headSha)

    // The cap that applied, as the record states it: a $1.60 target and a $4.00 review ceiling,
    // with the check pass's own ceiling a quarter of that target times 2.5, $1.00 (decision 14).
    expect(first.record.settings.budget).toEqual({ targetUsd: 1.6, wrapUpAtUsd: 1.12, ceilingUsd: 4 })
    // Step 6, 2026-09-15: the plan's Interfaces block put `droppedRequestKeys` on `record.settings`.
    // It is on `record.request` (core/src/record.ts:25) — nothing was dropped from this request, so
    // `budgetUsd: 1.6` was honoured rather than silently ignored for being above the tier target.
    expect(first.record.request.droppedRequestKeys).toEqual([])

    // One summary comment, and the inline comments that go with it (design §5).
    expect(ours).toHaveLength(1)
    expect(first.summaryCommentId).not.toBeNull()
    expect(ours[0].id).toBe(first.summaryCommentId)
    // A null review id here would mean the product had nothing to say inline about a pull request
    // seeded with a defect. That is the finding of this task, not a shape to route around.
    expect(first.reviewId).not.toBeNull()
    expect(inline.length).toBeGreaterThan(0)
    for (const c of inline) expect(c.body).toMatch(/Severity \d{1,2}\/10/)
    // The same number seen from both sides: what the publisher counted, and what GitHub kept.
    // The rest of `counts` — summaryOnly, droppedInline, suppressed, notInCheckout — is recorded
    // in the baseline rather than asserted: those are measurements of one model run, and a paid
    // test must not go red over how many findings a review happened to make.
    expect(inline).toHaveLength(first.counts.inline)

    // The check run exists, it is completed, and with the gate off a finished review concludes
    // `success` (Criss, 2026-09-14, decision 5), under the name the deployment configures.
    expect(listed.status).toBe('completed')
    expect(listed.conclusion).toBe('success')
    expect(checkRun.conclusion).toBe('success')
    expect(listed.name).toBe(runnerDeployment().report.checkRunName)
    // The name on GitHub is the name the record says was used: one setting, one place.
    expect(first.record.settings.report.checkRunName).toBe(listed.name)

    // The comment ids were read back off the posted review and stored: that is what makes the next
    // review able to find its own threads without a database.
    expect(marker).not.toBeNull()
    expect(marker!.runs).toHaveLength(1)
    const postedIds = new Set(inline.map((c) => c.id))
    const stored = marker!.runs[0].findings.filter((f) => f.commentId !== null)
    expect(stored.length).toBeGreaterThan(0)
    for (const f of stored) expect(postedIds.has(f.commentId!)).toBe(true)
  })

  // Criss, 2026-09-14 (decision 12): the second approved review is ONE hosted run of the deployed
  // task, triggered by hand (Step 16). This reads its effect back off GitHub and adds it to the
  // baseline. Free: the operator's own token, reads only.
  //
  // WHAT THE HOSTED RUN DID IS NOT KNOWABLE FROM GITHUB, so it is an input here and not a guess.
  // The one approved hosted run — Production, version 20260915.2, 2026-09-15 — failed 6 s in,
  // inside the FIRST call `reviewOnce` makes (`installationToken` → `privateKeyOf`), on a
  // `REVIEW_AGENT_APP_PRIVATE_KEY` that would not decode. It never reached
  // GitHub, and a run that fails before its first GitHub call leaves exactly the pull request a run
  // that was never triggered leaves: only the run page tells those two apart. So the read-back is
  // TOLD which world it is checking, and asserts that one strictly. Both worlds are written out
  // below and exactly one of them runs:
  //
  //   `reviewed`             — the plan's Step 15 case: the summary comment edited in place, a
  //                            second run in the marker, a second check run concluding `success`.
  //                            NEVER YET RUN GREEN. It needs a hosted run that reaches GitHub,
  //                            which needs a second run Criss has not approved.
  //   `failed-before-github` — what the one approved run actually left: nothing. Green, 2026-09-15.
  //
  // Neither is the default, because a read-back that guesses which world it is in is worth nothing.
  const hostedRunId = process.env.REVIEW_AGENT_E2E_HOSTED_RUN ?? ''
  const hostedOutcome = process.env.REVIEW_AGENT_E2E_HOSTED_OUTCOME ?? ''
  const afterHostedReviewed = hostedRunId !== '' && hostedOutcome === 'reviewed' ? it : it.skip
  const afterHostedNoReach = hostedRunId !== '' && hostedOutcome === 'failed-before-github' ? it : it.skip

  // One read, two readers. Every filter here picks out something only THIS product's review has —
  // the marker in the comment body, the review id on the inline comments, the configured check-run
  // name — because another review App reviewed the same pull request and left comments and a check
  // run of its own (see the note at the top of this file).
  const readHostedEffect = async () => {
    const reader = new Octokit({ auth: token })
    const baselinePath = join(import.meta.dirname, 'first-post-baseline.json')
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as {
      first: {
        reviewedHeadSha: string; reviewId: number; summaryCommentId: number
        inlineComments: number; checkRun: { id: number }
      }
      hostedRuns?: Record<string, Record<string, unknown>>
    }
    const comments = await reader.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: OWNER, repo: REPO, issue_number: NUMBER, per_page: 100,
    })
    const ours = comments.data.filter((c) => (c.body ?? '').includes(MARKER_OPEN))
    const marker = decodeMarker(ours[0]?.body ?? '')
    const reviewComments = await reader.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner: OWNER, repo: REPO, pull_number: NUMBER, per_page: 100,
    })
    const inline = reviewComments.data.filter((c) => c.pull_request_review_id === baseline.first.reviewId)
    // `filter` defaults to `latest`: one check run per name per App, the newest — which is the
    // hosted run's if it made one, and still the first run's if it did not.
    const listed = await reader.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner: OWNER, repo: REPO, ref: baseline.first.reviewedHeadSha, per_page: 100,
    })
    const named = listed.data.check_runs.filter((r) => r.name === runnerDeployment().report.checkRunName)
    const hosted = named.filter((r) => r.id !== baseline.first.checkRun.id)

    // Written before anything is asserted, so a failed assertion still leaves the run measured.
    //
    // BY RUN ID, and this is the repair of a harness defect found by using it. It used to merge
    // into a single `hosted` key, so pointing the read-back at a newer run silently OVERWROTE the
    // previous one's provenance in place — measured on 2026-09-15, when reading run 3 back replaced
    // run 2's `runId`, `readBackAt` and `summaryUpdatedAt`, the source for run 2's column in the
    // measurement notes. `git checkout` put it back that day; a fourth run
    // would have had nowhere to go at all. One entry per run id, and everything already under that
    // id is carried across: `<run>.run` is the operator's hand-copied record of the run page —
    // status, billed duration, vendor cost, the `memory` span's bytes — numbers no GitHub read can
    // supply (Step 16, Step 17).
    await writeFile(baselinePath, JSON.stringify({
      ...JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, unknown>,
      latestHostedRun: hostedRunId,
      hostedRuns: {
        ...(baseline.hostedRuns ?? {}),
        [hostedRunId]: {
          ...(baseline.hostedRuns?.[hostedRunId] ?? {}),
          runId: hostedRunId,
          outcome: hostedOutcome,
          readBackAt: new Date().toISOString(),
          summaryComments: ours.length,
          summaryCommentId: ours[0]?.id ?? null,
          summaryUpdatedAt: ours[0]?.updated_at ?? null,
          summaryEdited: ours[0] === undefined ? null : ours[0].updated_at !== ours[0].created_at,
          inlineComments: inline.length,
          markerRuns: marker?.runs.length ?? null,
          firstRunOutcomes: marker?.runs[0]?.findings.map((f) => f.outcome) ?? null,
          // What the LAST run recorded about itself: the fields the 2026-09-15 anchor change added.
          // `anchor` is a hash and never source text, so writing it into a baseline that lives in
          // git is safe — and it is the one field a regression here would silently drop.
          lastRunFindings: marker?.runs.at(-1)?.findings.map(
            (f) => ({ id: f.id, line: f.line, category: f.category ?? null, anchor: f.anchor ?? null,
                      commentId: f.commentId, outcome: f.outcome })) ?? null,
          checkRuns: hosted.map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion })),
          latestCheckRunId: named[0]?.id ?? null,
        },
      },
    }, null, 2) + '\n')

    return { baseline, ours, marker, inline, hosted, named }
  }

  afterHostedReviewed('after the hosted run, the same summary comment was edited in place and carries every run',
    { timeout: 60_000 }, async () => {
    const { baseline, ours, marker, hosted } = await readHostedEffect()

    expect(ours).toHaveLength(1)
    expect(ours[0].id).toBe(baseline.first.summaryCommentId)      // edited in place, not added to
    // ONE MARKER RUN PER REVIEW THIS PRODUCT HAS POSTED HERE, and the count is a literal on purpose:
    // it is what makes a hosted run that did not reach GitHub go red instead of passing quietly.
    // Four as of 2026-09-15: `42dacae` twice (runs 1 and 2), `487f857` (run 3), `f33dfc4` (run 4).
    // A fifth review of this pull request must bump it, and that is the point — the number records
    // how many times this fixture has been written to, which is a fact about the fixture.
    expect(marker?.runs).toHaveLength(4)
    // The re-review appended rather than restarted: the newest run read a DIFFERENT head from the
    // first, which is the whole claim "a re-review of changed code" makes.
    expect(marker?.runs.at(-1)?.headSha).not.toBe(baseline.first.reviewedHeadSha)
    // Every earlier finding carries one of the four outcomes. WHICH one is still deliberately not
    // asserted, but the reason has changed and the old one is gone. It used to be that `findingId`
    // hashes the TITLE, so a finding was recognised only when two model runs wrote a byte-identical
    // one. Identity is now the ANCHOR — a hash of the source line the comment went on — which no
    // model run rewrites. What keeps this open is narrower: run 4 settled run 3, whose rows were
    // written before anchors existed and so fell back to the old matcher for every one of them.
    // Only a run settling a run that HAS anchors decides by the code, and that has not happened
    // yet. What happened goes into the baseline as `firstRunOutcomes` — a measurement, which is
    // what this file is for.
    for (const f of marker?.runs[0]?.findings ?? []) {
      expect(['open', 'fixed', 'disputed', 'deferred']).toContain(f.outcome)
    }
    // THE MARKER CARRIES ANCHORS, AND NEVER SOURCE TEXT. This is the live half of the 2026-09-15
    // identity change: every row the newest run wrote for a non-blank line hashes that line, and
    // the marker sits in a public comment, so what it must NOT carry is the line itself. A hash is
    // 12 hex characters; nothing in a source line looks like that by accident, and the length is
    // the assertion that would redden if anyone ever stored the text.
    const newest = marker?.runs.at(-1)?.findings ?? []
    expect(newest.length).toBeGreaterThan(0)
    for (const f of newest) {
      expect(f.anchor).toMatch(/^[0-9a-f]{12}$/)
      expect(f.category).toBeTypeOf('string')
    }
    expect(hosted).toHaveLength(1)
    expect(hosted[0].status).toBe('completed')
    expect(hosted[0].conclusion).toBe('success')                   // gate off (decision 5)
  })

  afterHostedNoReach('the hosted run failed before its first GitHub call and left the pull request untouched',
    { timeout: 60_000 }, async () => {
    const { baseline, ours, marker, inline, hosted, named } = await readHostedEffect()

    // The point of this case is that the re-review path did NOT happen. It is written as strictly
    // as the `reviewed` case, in the opposite direction, so that a hosted run which DID reach
    // GitHub makes it go red rather than quietly passing: each assertion below names the exact
    // thing a second posted review would have changed.
    expect(ours).toHaveLength(1)                                   // no second summary comment
    expect(ours[0].id).toBe(baseline.first.summaryCommentId)
    expect(ours[0].updated_at).toBe(ours[0].created_at)            // never edited, by GitHub's clock
    expect(marker?.runs).toHaveLength(1)                           // one run in the marker, not two
    // Still the value the FIRST run wrote for its own findings. Not a re-review verdict: no second
    // review looked at them, so `open` here means untouched and nothing more.
    for (const f of marker?.runs[0]?.findings ?? []) expect(f.outcome).toBe('open')
    expect(inline).toHaveLength(baseline.first.inlineComments)     // no new inline comment
    expect(hosted).toHaveLength(0)                                 // no new check run
    // And the newest check run under our name is still the first run's, which is the positive form
    // of the line above: the hosted run had no installation token to create one with.
    expect(named).toHaveLength(1)
    expect(named[0].id).toBe(baseline.first.checkRun.id)
  })
})

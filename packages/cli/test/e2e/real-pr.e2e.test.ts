import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Octokit } from '@octokit/core'
import { defaultDeploymentConfig, REVIEW_INSTRUCTIONS_VERSION, type ReviewRecord } from '@review-agent/core'
import { downloadArchive, fetchPullRequest, sanitiseCheckout } from '@review-agent/github'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const BIN = join(import.meta.dirname, '../../dist/index.js')

// The pull request under test is named by whoever runs the suite, never by this file:
//   REVIEW_AGENT_E2E_REPO              owner/name of a repository the token can read
//   REVIEW_AGENT_E2E_PR                the number of a pull request in it
//   REVIEW_AGENT_E2E_HEAD              optional: the head sha it must be at, so a push made while the
//                                      suite runs is a failure rather than a different measurement
//   REVIEW_AGENT_E2E_CREDENTIAL_FILE   optional: a credential file the head tree is known to carry
//                                      (a `.npmrc`, say), which the checkout must remove
const [OWNER = '', REPO = '', ...extra] = (process.env.REVIEW_AGENT_E2E_REPO ?? '').split('/')
const NUMBER = Number(process.env.REVIEW_AGENT_E2E_PR ?? '')
const PINNED_HEAD = process.env.REVIEW_AGENT_E2E_HEAD ?? ''
const CREDENTIAL_FILE = process.env.REVIEW_AGENT_E2E_CREDENTIAL_FILE ?? ''
const haveTarget = OWNER !== '' && REPO !== '' && extra.length === 0 && Number.isInteger(NUMBER) && NUMBER > 0

// Gate 1: no GitHub token or no named pull request, no suite. Gate 2 (below) is the one that guards
// the money.
const token = process.env.GITHUB_TOKEN ?? ''
const describeIf = token === '' || !haveTarget ? describe.skip : describe

describeIf('end to end, read-only', () => {
  it('fetches the real PR', { timeout: 60_000 }, async () => {
    const pr = await fetchPullRequest({
      octokit: new Octokit({ auth: token }), owner: OWNER, repo: REPO, number: NUMBER,
    })
    expect(pr.headSha).toMatch(/^[0-9a-f]{40}$/)
    if (PINNED_HEAD !== '') expect(pr.headSha).toBe(PINNED_HEAD)
    expect(pr.title.length).toBeGreaterThan(0)
    expect(pr.changedFiles.length).toBeGreaterThan(0)
    // A pull request whose every file is binary has no hunk to show, so this asks for at least one.
    expect(pr.diff).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m)
  })

  it('downloads the head archive with no .git, and removes its credential files', { timeout: 120_000 }, async () => {
    const pr = await fetchPullRequest({
      octokit: new Octokit({ auth: token }), owner: OWNER, repo: REPO, number: NUMBER,
    })
    const head = PINNED_HEAD === '' ? pr.headSha : PINNED_HEAD
    const dir = await mkdtemp(join(tmpdir(), 'ra-e2e-'))
    const { removed } = await downloadArchive({
      octokit: new Octokit({ auth: token }), owner: OWNER, repo: REPO, ref: head, destDir: dir,
    })
    // The pull request's own files are in the working copy (a file it deleted is not, by definition).
    const kept = pr.changedFiles.find((f) => f.status !== 'removed')
    if (kept !== undefined) expect(existsSync(join(dir, kept.path))).toBe(true)
    // A repository that installs private packages the standard way carries a `.npmrc`. Finding it
    // in `removed`, and not on disk, is the evidence that removal ran on a real repository rather
    // than only on fixtures (design §11.6; github/archive.ts says why these are removed, not judged).
    // Asserted only when the operator names such a file: most repositories carry none.
    if (CREDENTIAL_FILE !== '') {
      expect(removed).toContain(CREDENTIAL_FILE)
      expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(false)
    }
    // A second walk over what is left finds nothing to remove and no .git: the working copy the
    // model would see is clean.
    expect(await sanitiseCheckout(dir)).toEqual({ gitDirs: [], removed: [] })
  })

  it('refuses to post, and says which sub-project owns posting', { timeout: 30_000 }, async () => {
    const failed = await run('node', [BIN, 'review', '--repo', `${OWNER}/${REPO}`,
                                      '--pr', String(NUMBER), '--post']).catch((e: unknown) => e)
    expect(failed).toMatchObject({ code: 2 })
    expect(String((failed as { stderr: string }).stderr)).toContain('sub-project 2')
  })

  // Gate 2: the only test in this repository that can spend money. `pnpm test` cannot reach the file
  // (vitest.config.ts excludes *.e2e.test.ts) and `pnpm test:e2e` skips this unless somebody has
  // deliberately said so. Design §8: about a dollar, and two to five minutes.
  const paid = process.env.REVIEW_AGENT_E2E_PAID === '1' ? it : it.skip

  paid('reviews the real PR under the tier budget', { timeout: 900_000 }, async () => {
    const budgetUsd = defaultDeploymentConfig().tiers.basic.budgetUsd
    const started = Date.now()
    // A non-zero exit rejects, and the rejection still carries stdout. Take it either way: a review
    // that failed or went over budget is a result to record, so the record is parsed and the baseline
    // written BEFORE anything is asserted.
    const ran = await run(
      'node',
      [BIN, 'review', '--repo', `${OWNER}/${REPO}`, '--pr', String(NUMBER), '--tier', 'basic', '--json'],
      { maxBuffer: 32 * 1024 * 1024 },
    ).then((r) => ({ ...r, code: 0 }), (e: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1,
    }))
    const wallClockSeconds = Math.round((Date.now() - started) / 1000)
    const record = JSON.parse(ran.stdout) as ReviewRecord
    const output = record.output

    await writeFile(join(import.meta.dirname, 'baseline.json'), JSON.stringify({
      recordedAt: new Date().toISOString(),
      target: { repo: `${OWNER}/${REPO}`, pr: NUMBER, headSha: record.request.headSha },
      tier: record.settings.tier,
      model: record.settings.model,
      effort: record.settings.effort,
      engineVersion: record.engineVersion,
      instructionsVersion: record.instructions.version,
      skills: record.skills.map((s) => s.id),
      budgetUsd: record.settings.budget,
      costUsd: record.costUsd,
      usage: record.usage,
      wrapUpFired: record.wrapUpFired,
      cutShort: record.cutShort,
      failure: record.failure,
      exitCode: ran.code,
      findings: output?.findings.length ?? null,
      inconclusive: output?.inconclusive.length ?? null,
      intent: output?.intent.verdict ?? null,
      removedCredentialFiles: record.checkout.removedCredentialFiles,
      wallClockSeconds,
    }, null, 2) + '\n')

    expect(ran.code).toBe(0)
    expect(record.failure).toBeNull()
    expect(record.cutShort).toBe(false)
    expect(output).not.toBeNull()

    // The wire document already parsed inside the CLI — that is what `failure === null` means. What
    // this adds is that what came OUT is the domain shape: camelCase, nulls collapsed, severities in
    // range. A record carrying `end_line` would mean the parser was bypassed somewhere.
    expect(typeof output!.summary).toBe('string')
    expect(['matches', 'partial', 'diverges', 'unclear']).toContain(output!.intent.verdict)
    for (const finding of output!.findings) {
      expect(finding).toHaveProperty('endLine')
      expect(finding).not.toHaveProperty('end_line')
      expect(finding.severity).toBeGreaterThanOrEqual(1)
      expect(finding.severity).toBeLessThanOrEqual(10)
    }
    for (const item of output!.inconclusive) expect(typeof item.whatWouldSettleIt).toBe('string')

    // Design §3.1: every value that produced the review is on its own record.
    expect(record.settings.tier).toBe('basic')
    expect(record.settings.effort).toBe('low')
    expect(record.instructions.version).toBe(REVIEW_INSTRUCTIONS_VERSION)
    expect(record.settings.budget.targetUsd).toBe(budgetUsd)

    // The removal ran on the checkout the model actually reviewed, and the CLI said so.
    if (CREDENTIAL_FILE !== '') {
      expect(record.checkout.removedCredentialFiles).toContain(CREDENTIAL_FILE)
      expect(ran.stderr).toContain(CREDENTIAL_FILE)
    }
    // The review was of the head the suite expected, when it was told one.
    if (PINNED_HEAD !== '') expect(record.request.headSha).toBe(PINNED_HEAD)

    expect(record.costUsd).toBeGreaterThan(0)
    expect(record.costUsd).toBeLessThan(budgetUsd)
  })
})

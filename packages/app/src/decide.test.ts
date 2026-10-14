import { describe, expect, it } from 'vitest'
import { defaultDeploymentConfig } from '@review-agent/core'
import { MARKER_OPEN, RERUN_IDENTIFIER } from '@review-agent/github'
import { MULTI_REFUSED, decideDelivery, encodeRequestRefinement, isReleaseOnly, parseCommandFlags, skipAsReleaseOnly } from './decide'

const deployment = defaultDeploymentConfig()
/** A deployment that switched the multi-reviewer mode off (spec 0.2.0 §14.19). */
const noMulti = { ...defaultDeploymentConfig(), allowMulti: false }

const pullRequestPayload = (over: Record<string, unknown> = {}) => ({
  action: 'opened',
  installation: { id: 4242 },
  repository: { full_name: 'acme/widgets' },
  pull_request: {
    number: 25,
    draft: false,
    head: { sha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f' },
  },
  ...over,
})

describe('decideDelivery on a pull_request event', () => {
  it('reviews a pull request that just opened', () => {
    const got = decideDelivery({ delivery: { event: 'pull_request', payload: pullRequestPayload() }, deployment })

    expect(got).toEqual({
      kind: 'review',
      installationId: 4242,
      request: { repo: 'acme/widgets', pr: 25, headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f' },
    })
  })

  // Spec 0.2.0 §8.3 point 5, decision §14.19: the multi-reviewer mode is never automatic. Nothing on a
  // pull_request delivery can ask for it, whatever the deployment allows.
  it('never asks an automatic review for several reviewers', () => {
    for (const action of ['opened', 'ready_for_review']) {
      const got = decideDelivery({ delivery: { event: 'pull_request', payload: pullRequestPayload({ action, multi: true }) }, deployment })
      expect(got.kind === 'review' && 'multi' in got.request).toBe(false)
    }
  })
})

describe('decideDelivery on the other pull_request actions', () => {
  it('reviews a pull request the first time it leaves draft', () => {
    const delivery = { event: 'pull_request', payload: pullRequestPayload({ action: 'ready_for_review' }) }

    expect(decideDelivery({ delivery, deployment })).toMatchObject({ kind: 'review' })
  })

  it('never reviews a push', () => {
    const delivery = { event: 'pull_request', payload: pullRequestPayload({ action: 'synchronize' }) }

    // Design §5, "Not on every push". A re-review of a new head sha is asked for, not automatic.
    expect(decideDelivery({ delivery, deployment }))
      .toEqual({ kind: 'ignore', why: 'pull_request.synchronize is not a trigger (design §5)' })
  })

  it('ignores a draft that was just opened, and waits for it to be ready', () => {
    const payload = pullRequestPayload({ pull_request: { number: 25, draft: true, head: { sha: '4f8e2a1' } } })

    expect(decideDelivery({ delivery: { event: 'pull_request', payload }, deployment }))
      .toEqual({ kind: 'ignore', why: 'opened as a draft; the review waits for ready_for_review (design §5)' })
  })

  it('ignores the actions that are not triggers', () => {
    for (const action of ['closed', 'reopened', 'edited', 'labeled', 'converted_to_draft', 'assigned']) {
      expect(decideDelivery({ delivery: { event: 'pull_request', payload: pullRequestPayload({ action }) }, deployment }))
        .toMatchObject({ kind: 'ignore' })
    }
  })

  it('starts no automatic review at all when the deployment turned it off', () => {
    const off = { ...deployment, autoReview: 'off' as const }

    expect(decideDelivery({ delivery: { event: 'pull_request', payload: pullRequestPayload() }, deployment: off }))
      .toEqual({ kind: 'ignore', why: 'autoReview is off; opened starts no review' })
  })

  it('ignores a delivery with no installation, because the App cannot act without one', () => {
    const payload = pullRequestPayload()
    delete (payload as { installation?: unknown }).installation

    expect(decideDelivery({ delivery: { event: 'pull_request', payload }, deployment }))
      .toEqual({ kind: 'ignore', why: 'a pull_request delivery without the fields a review needs' })
  })
})

const commentPayload = (body: string, over: Record<string, unknown> = {}) => ({
  action: 'created',
  installation: { id: 4242 },
  repository: { full_name: 'acme/widgets' },
  issue: { number: 25, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/25' } },
  comment: { id: 903112, body, user: { login: 'crissmoldovan', type: 'User' } },
  ...over,
})

describe('decideDelivery on an issue_comment', () => {
  it('reviews when a pull request comment starts with the command', () => {
    const delivery = { event: 'issue_comment', payload: commentPayload('/review') }

    expect(decideDelivery({ delivery, deployment })).toEqual({
      kind: 'review',
      installationId: 4242,
      request: {
        repo: 'acme/widgets',
        pr: 25,
        headSha: 'unresolved',
        requestedBy: 'crissmoldovan',
        requestId: '903112',
      },
    })
  })

  it('uses the deployment command word, which a deployment may set to its own, e.g. /acme review', () => {
    const acme = { ...deployment, command: '/acme review' }
    const delivery = { event: 'issue_comment', payload: commentPayload('/acme review') }

    expect(decideDelivery({ delivery, deployment: acme })).toMatchObject({ kind: 'review' })
    expect(decideDelivery({ delivery, deployment })).toMatchObject({ kind: 'ignore' })
  })

  it('takes everything after the command as the brief, across lines', () => {
    const body = '/review the migration is the risky part\n\nthe rest is generated'
    const delivery = { event: 'issue_comment', payload: commentPayload(body) }
    const got = decideDelivery({ delivery, deployment })

    expect(got.kind === 'review' && got.request.brief)
      .toBe('the migration is the risky part\n\nthe rest is generated')
  })

  it('needs the command at the start, and needs it to be a whole word', () => {
    for (const body of ['please /review this', '/reviewer please look', 'review']) {
      expect(decideDelivery({ delivery: { event: 'issue_comment', payload: commentPayload(body) }, deployment }))
        .toMatchObject({ kind: 'ignore' })
    }
    // Leading whitespace and a capital are what a phone keyboard produces, not an attack.
    expect(decideDelivery({ delivery: { event: 'issue_comment', payload: commentPayload('  /Review') }, deployment }))
      .toMatchObject({ kind: 'review' })
  })
})

describe('the flags a comment may carry', () => {
  it('parses the same flags the CLI takes, with either spelling', () => {
    expect(parseCommandFlags('--tier normal --model claude-opus-5 --effort=high --budget 4.50'))
      .toEqual({ request: { tier: 'normal', model: 'claude-opus-5', effort: 'high', budgetUsd: 4.5 }, refused: [] })
  })

  it('reads --check and --skip-check as the two directions of one setting', () => {
    expect(parseCommandFlags('--check').request).toEqual({ check: true })
    expect(parseCommandFlags('--skip-check').request).toEqual({ check: false })
    // Contradicting yourself in a comment box is not worth refusing a review over; the later word
    // wins, the way a shell would read it.
    expect(parseCommandFlags('--check --skip-check').request).toEqual({ check: false })
  })

  it('does not guess at a value that is not allowed, and names the one it did not use', () => {
    // The trap (Criss, 2026-09-14, decision 4): a value this parser drops never reaches
    // resolveSettings, so it never lands in droppedRequestKeys. Unless it is named HERE, nobody is
    // ever told.
    const got = parseCommandFlags('--tier exhaustive --effort ludicrous --budget lots')
    expect(got.request).toEqual({})
    expect(got.refused).toHaveLength(3)
    expect(got.refused.join('\n')).toContain('`--tier exhaustive`')
    expect(got.refused.join('\n')).toContain('`--effort ludicrous`')
    expect(got.refused.join('\n')).toContain('`--budget lots`')
  })

  it('takes --multi, which asks for the multi-reviewer mode since 0.2.0 (spec 0.2.0 §8.3, §14.16)', () => {
    // Refused until the mode was built. The parser no longer decides whether it runs: the deployment's
    // switch (decideDelivery, the runner) and the requester's push access (the runner) do.
    const got = parseCommandFlags('--multi --check')
    expect(got.request).toEqual({ multi: true, check: true })
    expect(got.refused).toEqual([])
  })

  it('refuses with the github package’s own sentences and function, re-exported for the receiver', async () => {
    // Moved in 0.2.0 (spec §3.1) so the CLI and the SDK refuse exactly what this receiver refuses.
    const github = await import('@review-agent/github')
    const receiver = await import('./receiver')
    expect(receiver.refuseUnbuilt).toBe(github.refuseUnbuilt)
    expect(receiver.MULTI_REFUSED).toBe(github.MULTI_REFUSED)
    expect(receiver.THOROUGH_REFUSED).toBe(github.THOROUGH_REFUSED)
  })

  it('takes --tier thorough, which is one reviewer at high effort since 0.2.0 (spec §14.1), and combines it with --multi', () => {
    // It was refused with --multi while it was going to mean the fan-out. It now buys what it says,
    // and --multi says how many of it (§14.16).
    const got = parseCommandFlags('--tier thorough --multi')
    expect(got.request).toEqual({ tier: 'thorough', multi: true })
    expect(got.refused).toEqual([])
  })

  it('leaves the free text alone', () => {
    expect(parseCommandFlags('--tier normal look at the lock file').request).toEqual({ tier: 'normal' })
  })

  it('reaches the request, with the free text as the brief', () => {
    const body = '/review --tier normal --check the migration is the risky part'
    const got = decideDelivery({ delivery: { event: 'issue_comment', payload: commentPayload(body) }, deployment })

    expect(got.kind === 'review' && got.request).toMatchObject({
      tier: 'normal', check: true, brief: 'the migration is the risky part', requestId: '903112',
    })
    expect(got.kind === 'review' && got.refused).toBeUndefined()

    // A flag the parser has no case for is not consumed: it stays in the brief, word for word.
    // Contract 3 — nothing the parser will not use is dropped in silence — covers a word it does
    // not recognise as much as a value it refuses.
    const unknown = decideDelivery({
      delivery: { event: 'issue_comment', payload: commentPayload('/review --verbose look at the lock file') },
      deployment,
    })
    expect(unknown.kind === 'review' && unknown.request.brief).toBe('--verbose look at the lock file')
  })

  it('asks for several reviewers when a comment says --multi, and keeps the rest of the line as the brief', () => {
    const body = '/review --multi --tier thorough the migration is the risky part'
    const got = decideDelivery({ delivery: { event: 'issue_comment', payload: commentPayload(body) }, deployment })

    expect(got.kind === 'review' && got.request).toMatchObject({
      tier: 'thorough', multi: true, brief: 'the migration is the risky part', requestId: '903112',
    })
    expect(got.kind === 'review' && got.refused).toBeUndefined()
  })

  it('carries the refusals on the decision, so they can reach the summary', () => {
    // A deployment that switched the mode off (spec 0.2.0 §14.19): the review still runs, with one
    // reviewer, and the summary says why.
    const body = '/review --multi --tier thorough --effort ludicrous the migration is the risky part'
    const got = decideDelivery({ delivery: { event: 'issue_comment', payload: commentPayload(body) }, deployment: noMulti })

    expect(got.kind).toBe('review')
    expect(got.kind === 'review' && got.request.tier).toBe('thorough')
    expect(got.kind === 'review' && 'multi' in got.request).toBe(false)
    expect(got.kind === 'review' && got.request.brief).toBe('the migration is the risky part')
    expect(got.kind === 'review' && got.refused).toEqual([
      '`--effort ludicrous` — not a value this flag takes, so the deployment’s default was used.',
      '`--multi` — this deployment does not run several reviewers on one review, so one reviewer ran.',
    ])
  })
})

describe('a comment that must never start a review', () => {
  it('ignores a comment carrying the product own state marker', () => {
    // The product's summary comment documents the command word, so it CONTAINS "/review". Left
    // alone, the bot would answer itself for as long as the rate limit allowed.
    const body = `${MARKER_OPEN}eyJ2IjoxfQ== -->\n\n/review to run it again`
    const delivery = { event: 'issue_comment', payload: commentPayload(body) }

    expect(decideDelivery({ delivery, deployment }))
      .toEqual({ kind: 'ignore', why: 'a comment carrying this App own review marker' })
  })

  it('ignores its own summary comment, where the marker is the last line and the command the first', () => {
    // `summaryBody` (packages/github/src/body.ts) puts the marker LAST, so the case above — marker
    // first — is refused by the command-at-the-start rule before the marker is ever looked at, and
    // could not tell a working loop guard from a missing one. This body is the shape the product
    // actually writes, arranged so the marker is the ONLY thing between the delivery and a review:
    // remove the guard and the bot answers its own comment, which is the loop itself.
    const body = `/review to run it again\n\n${MARKER_OPEN}eyJ2IjoxfQ== -->`
    const delivery = { event: 'issue_comment', payload: commentPayload(body) }

    expect(decideDelivery({ delivery, deployment }))
      .toEqual({ kind: 'ignore', why: 'a comment carrying this App own review marker' })
  })

  it('ignores a comment whose author GitHub calls a Bot', () => {
    const payload = commentPayload('/review', {
      comment: { id: 903113, body: '/review', user: { login: 'review-agent[bot]', type: 'Bot' } },
    })

    expect(decideDelivery({ delivery: { event: 'issue_comment', payload }, deployment }))
      .toEqual({ kind: 'ignore', why: 'a comment written by a Bot account' })
  })

  it('still reviews when the author type is absent, because the marker is the guard that matters', () => {
    const payload = commentPayload('/review', { comment: { id: 903114, body: '/review' } })

    expect(decideDelivery({ delivery: { event: 'issue_comment', payload }, deployment }))
      .toMatchObject({ kind: 'review' })
  })

  it('ignores an edited or deleted comment, whatever it now says', () => {
    for (const action of ['edited', 'deleted']) {
      const delivery = { event: 'issue_comment', payload: commentPayload('/review', { action }) }
      expect(decideDelivery({ delivery, deployment })).toMatchObject({ kind: 'ignore' })
    }
  })

  it('ignores a comment on a plain issue', () => {
    const payload = commentPayload('/review', { issue: { number: 25 } })

    expect(decideDelivery({ delivery: { event: 'issue_comment', payload }, deployment }))
      .toEqual({ kind: 'ignore', why: 'a comment on a plain issue, not a pull request' })
  })
})

const checkRunPayload = (over: Record<string, unknown> = {}) => ({
  action: 'requested_action',
  requested_action: { identifier: RERUN_IDENTIFIER },
  installation: { id: 4242 },
  repository: { full_name: 'acme/widgets' },
  sender: { login: 'crissmoldovan' },
  check_run: {
    id: 55001,
    head_sha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
    external_id: null,
    pull_requests: [{ number: 25 }],
  },
  ...over,
})

describe('decideDelivery on the check run Re-run action', () => {
  it('repeats the review at the head the check run named', () => {
    const got = decideDelivery({ delivery: { event: 'check_run', payload: checkRunPayload() }, deployment })

    expect(got).toEqual({
      kind: 'review',
      installationId: 4242,
      request: {
        repo: 'acme/widgets',
        pr: 25,
        headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
        requestedBy: 'crissmoldovan',
        requestId: 'rerun:55001',
      },
    })
  })

  it('repeats the SETTINGS of the last request when the check run carried them', () => {
    const external_id = encodeRequestRefinement({
      repo: 'acme/widgets', pr: 25, headSha: 'older', tier: 'normal', check: true,
      brief: 'the migration',   // a person's free text: it must NOT ride along
    })
    const payload = checkRunPayload({
      check_run: { id: 55002, head_sha: 'c0ffee0', external_id, pull_requests: [{ number: 25 }] },
    })
    const got = decideDelivery({ delivery: { event: 'check_run', payload }, deployment })

    // The settings come back; the sha does not — a re-run reviews the head the button was on.
    expect(got.kind === 'review' && got.request).toMatchObject({
      tier: 'normal', check: true, headSha: 'c0ffee0',
    })
    // And the brief does not come back: it is not encoded, so it is not stored on the check run.
    expect(got.kind === 'review' && got.request.brief).toBeUndefined()
    expect(got.kind === 'review' && got.refused).toBeUndefined()
  })

  it('repeats a multi-reviewer review a check run carried, since a button press is a request (spec 0.2.0 §14.19)', () => {
    // `thorough` is one reviewer at high effort since 0.2.0 (spec §14.1), and `multi` runs several of
    // it: a Re-run repeats both, and the runner still checks the presser can push before it spends.
    const external_id = encodeRequestRefinement({
      repo: 'acme/widgets', pr: 25, headSha: 'older', tier: 'thorough', multi: true, check: true,
    })
    const payload = checkRunPayload({
      check_run: { id: 55005, head_sha: 'c0ffee0', external_id, pull_requests: [{ number: 25 }] },
    })
    const got = decideDelivery({ delivery: { event: 'check_run', payload }, deployment })

    expect(got.kind === 'review' && got.request).toMatchObject({ tier: 'thorough', multi: true, check: true })
    expect(got.kind === 'review' && got.refused).toBeUndefined()
  })

  it('repeats a thorough tier a check run carried, refuses the several reviewers this deployment switched off, and names it', () => {
    // Criss, 2026-09-14 (decision 4): external_id is a string that came back from GitHub, written when
    // the deployment may still have allowed the mode.
    const external_id = encodeRequestRefinement({
      repo: 'acme/widgets', pr: 25, headSha: 'older', tier: 'thorough', multi: true, check: true,
    })
    const payload = checkRunPayload({
      check_run: { id: 55005, head_sha: 'c0ffee0', external_id, pull_requests: [{ number: 25 }] },
    })
    const got = decideDelivery({ delivery: { event: 'check_run', payload }, deployment: noMulti })

    expect(got.kind === 'review' && got.request.tier).toBe('thorough')
    expect(got.kind === 'review' && got.request.multi).toBeUndefined()
    expect(got.kind === 'review' && got.request.check).toBe(true)
    expect(got.kind === 'review' && got.refused).toEqual([MULTI_REFUSED])
  })

  it('ignores a different action button, and a check_run event that is not a button press', () => {
    const other = checkRunPayload({ requested_action: { identifier: 'something-else' } })
    expect(decideDelivery({ delivery: { event: 'check_run', payload: other }, deployment }))
      .toEqual({ kind: 'ignore', why: 'check_run action "something-else" is not the re-run button' })

    const completed = checkRunPayload({ action: 'completed', requested_action: undefined })
    expect(decideDelivery({ delivery: { event: 'check_run', payload: completed }, deployment }))
      .toMatchObject({ kind: 'ignore' })
  })

  it('ignores a re-run that names no pull request, because there is nothing to review', () => {
    const payload = checkRunPayload({ check_run: { id: 55003, head_sha: 'c0ffee0', pull_requests: [] } })

    expect(decideDelivery({ delivery: { event: 'check_run', payload }, deployment }))
      .toEqual({ kind: 'ignore', why: 'the re-run button was pressed on a check run with no pull request' })
  })

  it('survives a check run that carries an external_id it did not write', () => {
    const payload = checkRunPayload({
      check_run: { id: 55004, head_sha: 'c0ffee0', external_id: 'not-ours', pull_requests: [{ number: 25 }] },
    })

    expect(decideDelivery({ delivery: { event: 'check_run', payload }, deployment })).toMatchObject({ kind: 'review' })
  })
})

describe('release-only pull requests', () => {
  it('recognises the paths a release touches and nothing else', () => {
    expect(isReleaseOnly(['package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'])).toBe(true)
    expect(isReleaseOnly(['packages/core/package.json', 'packages/github/package.json'])).toBe(true)
    expect(isReleaseOnly(['.changeset/lucky-pans-shake.md'])).toBe(true)
    for (const path of [
      'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb',
      'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
      'Pipfile.lock', 'CHANGES.md', 'HISTORY.txt', 'RELEASES', 'docs/CHANGELOG.md', 'VERSION',
    ]) {
      expect(isReleaseOnly([path]), path).toBe(true)
    }
  })

  it('is disarmed by a single file that is not one of those', () => {
    expect(isReleaseOnly(['package.json', 'pnpm-lock.yaml', 'src/index.ts'])).toBe(false)
    for (const path of ['src/index.ts', 'README.md', 'tsconfig.json', 'docs/design.md', '.changeset/config.json']) {
      expect(isReleaseOnly([path]), path).toBe(false)
    }
  })

  it('is not true of a pull request that changed nothing', () => {
    // Nothing to review is a different thing from a release, and it deserves a different reason.
    expect(isReleaseOnly([])).toBe(false)
  })

  it('skips the automatic review and never the requested one', () => {
    const paths = ['package.json', 'CHANGELOG.md']
    const automatic = { repo: 'acme/widgets', pr: 25, headSha: '4f8e2a1' }
    const asked = { ...automatic, requestId: '903112' }

    expect(skipAsReleaseOnly({ request: automatic, changedPaths: paths })).toBe(true)
    expect(skipAsReleaseOnly({ request: asked, changedPaths: paths })).toBe(false)
    expect(skipAsReleaseOnly({ request: automatic, changedPaths: [...paths, 'src/index.ts'] })).toBe(false)
  })
})

describe('deliveries this App does not act on', () => {
  it('names what it ignored and why', () => {
    for (const event of ['push', 'ping', 'installation', 'pull_request_review', 'workflow_run']) {
      expect(decideDelivery({ delivery: { event, payload: {} }, deployment }))
        .toEqual({ kind: 'ignore', why: `${event} is not an event this App acts on` })
    }
  })

  it('ignores pull_request_review_comment, which is not the command channel', () => {
    // Verified: a PR comment arrives as `issue_comment`. A review-thread comment is a different
    // event with a different permission, and the App is not subscribed to it for commands.
    expect(decideDelivery({ delivery: { event: 'pull_request_review_comment', payload: {} }, deployment }))
      .toMatchObject({ kind: 'ignore' })
  })

  it('ignores a payload that is not an object at all', () => {
    expect(decideDelivery({ delivery: { event: 'pull_request', payload: 'not json' }, deployment }))
      .toEqual({ kind: 'ignore', why: 'a pull_request delivery without the fields a review needs' })
  })
})

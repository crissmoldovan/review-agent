import { describe, expect, it, vi } from 'vitest'
import type { ReviewRequest } from '@review-agent/core'
import { HEAD_SHA_UNRESOLVED } from './decide'
import { MAX_DISPATCH_PAYLOAD_BYTES, REVIEW_TASK_ID, type TriggerPort, dispatchReview, idempotencyKeyFor, projectPayload, tagsFor } from './dispatch'

const automatic: ReviewRequest = {
  repo: 'acme/widgets', pr: 25, headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
}
const requested: ReviewRequest = { ...automatic, requestedBy: 'crissmoldovan', requestId: '903112' }
const port = (): TriggerPort => vi.fn(async () => ({ id: 'run_2n4kd8wq' }))
/** What `dispatchReview` actually handed trigger.dev on its nth call. The dispatch is the ONLY place
 *  the key and the tags reach the runner, so every claim about the lock is read from here rather
 *  than from `idempotencyKeyFor` and `tagsFor`, which a dispatch could perfectly well never call. */
const sentOn = (trigger: TriggerPort, nth = 0) => vi.mocked(trigger).mock.calls[nth][0]

describe('dispatchReview', () => {
  it('triggers the review task and hands back the run id', async () => {
    const trigger = port()

    const got = await dispatchReview({ request: automatic, installationId: 4242, trigger })

    expect(got.runId).toBe('run_2n4kd8wq')
    expect(sentOn(trigger)).toMatchObject({
      taskId: REVIEW_TASK_ID,
      payload: { request: automatic, installationId: 4242 },
      idempotencyKey: idempotencyKeyFor(automatic),
      tags: tagsFor(automatic),
    })
  })

  it('hands back the very key it locked the run with, so a caller can recognise that run again', async () => {
    // The returned key is what a re-run button and a second delivery have to compare against; a
    // dispatch that returned a key it had not sent would make every such comparison a lie.
    const trigger = port()

    const got = await dispatchReview({ request: automatic, installationId: 4242, trigger })

    expect(got.idempotencyKey).toBe(sentOn(trigger).idempotencyKey)
    expect(got.idempotencyKey).toBe('auto:acme/widgets#25@4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f')
  })

  it('locks an automatic review to its head sha, so a redelivered webhook cannot start a second run', async () => {
    const trigger = port()

    await dispatchReview({ request: automatic, installationId: 4242, trigger })
    await dispatchReview({ request: { ...automatic }, installationId: 4242, trigger })
    await dispatchReview({ request: { ...automatic, headSha: 'c0ffee0d3adb33f' }, installationId: 4242, trigger })

    // Same pull request, same head, delivered twice: one key, so trigger.dev runs it once.
    expect(sentOn(trigger, 1).idempotencyKey).toBe(sentOn(trigger, 0).idempotencyKey)
    expect(sentOn(trigger, 0).idempotencyKey).toContain(automatic.headSha)
    // A new commit is a new review, so the lock must let it through.
    expect(sentOn(trigger, 2).idempotencyKey).not.toBe(sentOn(trigger, 0).idempotencyKey)
  })

  it('gives each explicit request its own key, so a second `/review` is never swallowed', async () => {
    const trigger = port()

    await dispatchReview({ request: requested, installationId: 4242, trigger })
    await dispatchReview({ request: { ...requested, requestId: '903113' }, installationId: 4242, trigger })

    expect(sentOn(trigger, 0).idempotencyKey).toBe('req:acme/widgets#25:903112')
    expect(sentOn(trigger, 1).idempotencyKey).not.toBe(sentOn(trigger, 0).idempotencyKey)
    // And neither of them shares the automatic lock on that same head, which would silently reduce
    // "somebody asked again" to "this head was already reviewed".
    expect(sentOn(trigger, 0).idempotencyKey).not.toBe(idempotencyKeyFor(automatic))
  })

  it('files the run under its tags, including how the review was asked for', async () => {
    const trigger = port()

    await dispatchReview({ request: requested, installationId: 4242, trigger })

    expect(sentOn(trigger).tags).toEqual(tagsFor(requested))
    expect(sentOn(trigger).tags).toContain('pr:acme/widgets#25')
    expect(sentOn(trigger).tags).toContain('trigger:requested')
  })

  it('carries the comment doorway refusals through to the runner', async () => {
    // Criss, 2026-09-14 (decision 4): the dispatch is the only road from the receiver to the
    // summary, so a refusal dropped here is a refusal nobody ever hears about.
    const refused = ['`--multi` — the multi-reviewer fan-out is not built yet, so one reviewer ran.']
    const trigger = port()

    await dispatchReview({ request: requested, installationId: 4242, refused, trigger })

    expect(sentOn(trigger).payload.refused).toEqual(refused)
  })
})

describe('the idempotency key', () => {
  it('is the same for the same automatic review of the same head, so it runs once', () => {
    expect(idempotencyKeyFor(automatic)).toBe(idempotencyKeyFor({ ...automatic }))
  })

  it('is different for a different head, because that is a different review', () => {
    expect(idempotencyKeyFor({ ...automatic, headSha: 'c0ffee0' })).not.toBe(idempotencyKeyFor(automatic))
  })

  it('is different every time somebody asks, so asking twice always runs', () => {
    // Design §3 on requestId: "comment id, so asking twice always runs". Two comments, two runs,
    // even at the same head sha and even seconds apart.
    const first = idempotencyKeyFor({ ...automatic, requestId: '903112' })
    const second = idempotencyKeyFor({ ...automatic, requestId: '903113' })

    expect(first).not.toBe(second)
    expect(first).not.toBe(idempotencyKeyFor(automatic))
  })

  it('is the same for one request delivered twice, which is what a redelivery is', () => {
    expect(idempotencyKeyFor({ ...automatic, requestId: '903112' }))
      .toBe(idempotencyKeyFor({ ...automatic, requestId: '903112', headSha: 'anything-else' }))
  })

  it('refuses an automatic review whose head sha was never resolved', () => {
    // An automatic key IS the head sha. A sentinel in it would collapse every unresolved review of
    // that pull request into one run, which is the opposite of what the key is for.
    expect(() => idempotencyKeyFor({ ...automatic, headSha: HEAD_SHA_UNRESOLVED }))
      .toThrow(/automatic review needs a resolved head sha/)
  })

  it('refuses a requested review with no request id to key it on', () => {
    // The mirror of the guard above, on the branch that has the same hole. An explicit key IS the
    // request id: an empty one keys every `/review` on that pull request to `req:repo#pr:`, so the
    // second person to ask gets the first person's run and is told nothing. `isAutomatic` is
    // `requestId === undefined`, so an empty string is NOT automatic — it lands here, where the
    // head sha the automatic branch relies on is deliberately not part of the key.
    for (const requestId of ['', '   ']) {
      expect(() => idempotencyKeyFor({ ...automatic, requestId }))
        .toThrow(/requested review needs a request id/)
    }
  })

  it('still keys a requested review whose head sha is unresolved, because every comment has one', () => {
    // The trap in the fix above: the automatic guard refuses HEAD_SHA_UNRESOLVED, and copying it
    // wholesale into this branch would refuse every `/review` comment ever written — the comment
    // doorway has no head sha to give (decide.ts), and this key does not want one.
    expect(idempotencyKeyFor({ ...automatic, headSha: HEAD_SHA_UNRESOLVED, requestId: '903112' }))
      .toBe('req:acme/widgets#25:903112')
  })

  it('refuses a key longer than trigger.dev will accept, rather than earning a 400', () => {
    expect(() => idempotencyKeyFor({ ...automatic, requestId: 'x'.repeat(2100) }))
      .toThrow(/at most 2048 characters, this one is 2/)
  })
})

describe('what the runner is sent', () => {
  it('sends the request and the installation, and nothing else at the top level', () => {
    expect(Object.keys(projectPayload({ request: automatic, installationId: 4242 })))
      .toEqual(['request', 'installationId'])
  })

  it('copies the request field by field, so nothing rides along', () => {
    // A caller that built its request by spreading the delivery would otherwise forward the whole
    // 25 MB webhook body inside a field nobody reads.
    const smuggled = { ...automatic, delivery: { payload: 'x'.repeat(1000) }, token: 'ghs_secret' } as ReviewRequest

    const payload = projectPayload({ request: smuggled, installationId: 4242 })

    expect(Object.keys(payload.request).sort()).toEqual(['headSha', 'pr', 'repo'])
    expect(JSON.stringify(payload)).not.toContain('ghs_secret')
  })

  it('keeps every field a review request really has', () => {
    const full: ReviewRequest = {
      repo: 'acme/widgets', pr: 25, headSha: '4f8e2a1', tier: 'thorough', multi: true,
      model: 'claude-opus-5', effort: 'high', check: true, brief: 'the migration', budgetUsd: 6,
      requestedBy: 'crissmoldovan', requestId: '903112',
    }

    expect(projectPayload({ request: full, installationId: 4242 }).request).toEqual(full)
  })

  it('carries the comment doorway refusals, and only when there are some', () => {
    // Criss, 2026-09-14 (decision 4): what a comment asked for and did not get has to reach the
    // summary, and this payload is the only road from the receiver to the runner.
    const refused = ['`--multi` — the multi-reviewer fan-out is not built yet, so one reviewer ran.']
    expect(projectPayload({ request: automatic, installationId: 4242, refused }).refused).toEqual(refused)
    expect(Object.keys(projectPayload({ request: automatic, installationId: 4242, refused: [] })))
      .toEqual(['request', 'installationId'])
  })
})

describe('the size of what is sent', () => {
  it('refuses a payload far below the limit, because nothing legitimate is that big', () => {
    const huge: ReviewRequest = { ...automatic, brief: 'x'.repeat(MAX_DISPATCH_PAYLOAD_BYTES) }

    expect(() => projectPayload({ request: huge, installationId: 4242 }))
      .toThrow(/payload is .* bytes, over the 131072-byte budget/)
  })

  it('lets a long human brief through', () => {
    const long: ReviewRequest = { ...automatic, brief: 'x'.repeat(20000) }

    expect(() => projectPayload({ request: long, installationId: 4242 })).not.toThrow()
  })
})

describe('the tags a run is filed under', () => {
  it('files a run by repository, pull request, head and how it was asked for', () => {
    // Tags are the only queryable handle on a run (metadata is not queryable), so these are what
    // "show me every review of widgets#25" will have to work from.
    expect(tagsFor(automatic)).toEqual([
      'repo:acme/widgets', 'pr:acme/widgets#25', 'sha:4f8e2a1c9b7d', 'trigger:auto',
    ])
    expect(tagsFor({ ...automatic, requestId: '903112' })).toContain('trigger:requested')
  })

  it('never sends more than ten tags, nor one over 128 characters', () => {
    const silly = { ...automatic, repo: `acme/${'n'.repeat(200)}` }

    const tags = tagsFor(silly)
    expect(tags.length).toBeLessThanOrEqual(10)
    for (const tag of tags) expect(tag.length).toBeLessThanOrEqual(128)
  })
})

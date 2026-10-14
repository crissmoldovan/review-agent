import {
  buildReviewRecord, defaultDeploymentConfig, resolveSettings, scanForSecrets,
  type EngineResult, type ReviewRequest,
} from '@review-agent/core'
import { describe, expect, it } from 'vitest'
import { verifySignature } from '../verify'
import {
  RECORD_CALLBACK_TIMEOUT_MS, RECORD_SIGNATURE_HEADER, sendRecordCallback, signRecordBody,
  type RecordCallback, type RecordCallbackBody,
} from './record-callback'

const REQUEST: ReviewRequest = { repo: 'acme/widgets', pr: 16, headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f' }
const SETTINGS = resolveSettings({ deployment: defaultDeploymentConfig(), repo: null, request: REQUEST })
// The figures of a measured basic-tier run: $0.345 at per-token API prices.
const RESULT: EngineResult = {
  output: {
    summary: 'Adds a tag check to publish.yml.',
    intent: { verdict: 'matches', note: 'It does what the brief says.' },
    findings: [], inconclusive: [],
  },
  usage: {
    costUsd: 0.345, inputTokens: 18, outputTokens: 3333,
    cacheReadTokens: 121_660, cacheWriteTokens: 19_864, turns: 10, durationMs: 51_900,
  },
  cutShort: false, wrapUpFired: false, failure: null,
}
const BODY: RecordCallbackBody = {
  version: 1,
  result: {
    kind: 'reviewed', headSha: REQUEST.headSha,
    record: buildReviewRecord({
      request: REQUEST, settings: SETTINGS, result: RESULT, skills: [], check: null, recheck: null, removedFromCheckout: [],
      startedAt: new Date('2026-09-14T10:00:00.000Z'), finishedAt: new Date('2026-09-14T10:00:55.000Z'),
    }),
    reviewId: 77, summaryCommentId: 903,
    counts: { inline: 0, summaryOnly: 0, droppedInline: 0, suppressed: 0, notInCheckout: 0, retracted: 0, reinstated: 0, retractionsWithheld: 0 },
    verdict: '<!-- review-agent-verdict: {} -->',
    checkRun: { id: 4242, conclusion: 'success' },
    comments: [{ findingId: 'f-aaa', file: 'src/a.ts', line: 10, commentId: 5001 }],
  },
}

const SECRET = 'a-callback-secret-made-for-this-receiver'
const CALLBACK: RecordCallback = {
  url: 'https://ops.example.test/api/review-agent/record', secretEnv: 'REVIEW_AGENT_RECORD_SECRET',
}
const ENV = { REVIEW_AGENT_RECORD_SECRET: SECRET }

/** A receiver that records what it was sent and answers with a status. */
const receiver = (status = 202) => {
  const sent: { url: string; init: RequestInit }[] = []
  const fetch: typeof globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} })
    return new Response(null, { status })
  }
  return { fetch, sent }
}

describe('sendRecordCallback (Criss, answer 16)', () => {
  it('signs the exact bytes it sends, in the shape verifySignature already checks', async () => {
    const r = receiver()
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: r.fetch }))
      .toEqual({ sent: true, status: 202 })
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].url).toBe(CALLBACK.url)
    expect(r.sent[0].init.method).toBe('POST')
    const rawBody = Buffer.from(String(r.sent[0].init.body), 'utf8')
    const signature = new Headers(r.sent[0].init.headers).get(RECORD_SIGNATURE_HEADER)
    // The receiver's side, with the receiver's own function: one verifier for webhooks and records.
    expect(verifySignature({ rawBody, signature, secret: SECRET })).toEqual({ ok: true })
    expect(verifySignature({ rawBody, signature, secret: 'somebody-else' })).toEqual({ ok: false, why: 'mismatch' })
    expect(signRecordBody({ rawBody, secret: SECRET })).toBe(signature)
  })

  it('sends the finished review as JSON a receiver can parse back to what was sent', async () => {
    const r = receiver()
    await sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: r.fetch })
    expect(JSON.parse(String(r.sent[0].init.body))).toEqual(JSON.parse(JSON.stringify(BODY)))
    expect(new Headers(r.sent[0].init.headers).get('content-type')).toBe('application/json')
  })

  it('sends nothing, and makes no request, when the deployment named no callback', async () => {
    const r = receiver()
    expect(await sendRecordCallback({ callback: null, env: ENV, body: BODY, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'not-configured' })
    expect(r.sent).toHaveLength(0)
  })

  it('refuses an address that is not https, that carries a credential, or that is not an address', async () => {
    for (const url of ['http://ops.example.test/record', 'https://user:pass@ops.example.test/record', 'not a url']) {
      const r = receiver()
      expect(await sendRecordCallback({ callback: { ...CALLBACK, url }, env: ENV, body: BODY, fetch: r.fetch }))
        .toEqual({ sent: false, why: 'bad-url' })
      expect(r.sent).toHaveLength(0)
    }
  })

  it('refuses to sign with a model credential, an App identity variable, or a name that is not a variable', async () => {
    for (const secretEnv of [
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
      'REVIEW_AGENT_APP_PRIVATE_KEY', 'REVIEW_AGENT_APP_CLIENT_ID', 'lower-case-name',
    ]) {
      const r = receiver()
      const env = { ...ENV, [secretEnv]: SECRET }
      expect(await sendRecordCallback({ callback: { ...CALLBACK, secretEnv }, env, body: BODY, fetch: r.fetch }))
        .toEqual({ sent: false, why: 'bad-secret-name' })
      expect(r.sent).toHaveLength(0)
    }
  })

  it('refuses to send unsigned when the secret is missing', async () => {
    const r = receiver()
    expect(await sendRecordCallback({ callback: CALLBACK, env: {}, body: BODY, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'no-secret' })
    expect(r.sent).toHaveLength(0)
  })

  it('withholds a body that matches a secret pattern, rather than sending it', async () => {
    const r = receiver()
    const leaky: RecordCallbackBody = {
      ...BODY, result: { ...BODY.result, verdict: `<!-- ${'ghp_' + 'A'.repeat(36)} -->` },
    }
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: leaky, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'withheld' })
    expect(r.sent).toHaveLength(0)
  })

  it('withholds a token at the start of a line, which JSON-encoding hides from a serialised scan', async () => {
    // The case above puts a SPACE before the token, and `JSON.stringify` leaves a space alone — so it
    // passes against a scan of the serialised text and proves nothing about the gap. Every pattern in
    // packages/core/src/secrets.ts but `private-key` is anchored with `\b`, and `JSON.stringify` turns
    // a newline inside a string into the two characters `\` and `n`; `n` is a word character, so
    // `…\nghp_AAAA…` has no boundary before `g` and does not match. Scanning the string LEAVES sees
    // the value as the model wrote it, and catches it. Verified against the real patterns 2026-09-14.
    const r = receiver()
    // `RESULT.output` is `ReviewOutput | null`, so it is rewritten whole rather than spread.
    const onItsOwnLine: EngineResult = {
      ...RESULT,
      output: {
        summary: `the token is on its own line:\n${'ghp_' + 'A'.repeat(36)}`,
        intent: { verdict: 'matches', note: 'It does what the brief says.' },
        findings: [], inconclusive: [],
      },
    }
    const leaky: RecordCallbackBody = {
      ...BODY,
      result: {
        ...BODY.result,
        record: buildReviewRecord({
          request: REQUEST, settings: SETTINGS, result: onItsOwnLine,
          skills: [], check: null, recheck: null, removedFromCheckout: [],
          startedAt: new Date('2026-09-14T10:00:00.000Z'), finishedAt: new Date('2026-09-14T10:00:55.000Z'),
        }),
      },
    }
    // The gap this case exists for, stated as an assertion rather than as a comment.
    expect(scanForSecrets(JSON.stringify(leaky))).toEqual([])
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: leaky, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'withheld' })
    expect(r.sent).toHaveLength(0)
  })

  it('scans the assembled bytes too, so a secret the leaf walk cannot reach is still withheld', async () => {
    // Added 2026-09-14, not in the plan. Plan Step 4(c2) predicted — correctly — that deleting the
    // serialised `scanForSecrets(text)` line fails no case, because every string in today's body is a
    // leaf, and told the builder to keep the untested line and write that down. An unguarded line is
    // one a later reader deletes as dead, so this case names the one thing only the serialised scan
    // sees: the bytes, object KEYS included. `stringLeaves` walks `Object.values` and never visits a
    // key. No field of `RecordCallbackBody` carries a model-written key today, so the body is built
    // through `unknown` — it is the shape a future field could produce, and the guard is for that.
    const r = receiver()
    const keyed = {
      ...BODY,
      result: {
        ...BODY.result,
        record: { ...BODY.result.record, [`ghp_${'A'.repeat(36)}`]: 'a value nothing would scan twice' },
      },
    } as unknown as RecordCallbackBody
    // The gap, stated as an assertion: the token is in the bytes that would leave.
    expect(scanForSecrets(JSON.stringify(keyed))).not.toEqual([])
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: keyed, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'withheld' })
    expect(r.sent).toHaveLength(0)
  })

  it('says a receiver refused it, with the status, and sends once', async () => {
    const r = receiver(500)
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: r.fetch }))
      .toEqual({ sent: false, why: 'rejected', status: 500 })
    expect(r.sent).toHaveLength(1)
  })

  it('gives up at its timeout, and says so, rather than holding a finished review', async () => {
    const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init?.signal?.reason) }, { once: true })
    })
    expect(await sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: hanging, timeoutMs: 5 }))
      .toEqual({ sent: false, why: 'timeout' })
  })

  it('never rejects: a receiver that is down is an outcome, not an error', async () => {
    const down: typeof fetch = async () => { throw new TypeError('fetch failed') }
    await expect(sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: down }))
      .resolves.toEqual({ sent: false, why: 'unreachable' })
  })

  it('does not follow a redirect, so a signed record goes where it was configured to go', async () => {
    const r = receiver()
    await sendRecordCallback({ callback: CALLBACK, env: ENV, body: BODY, fetch: r.fetch })
    expect(r.sent[0].init.redirect).toBe('error')
  })

  it('waits ten seconds at most when no timeout is given', () => {
    expect(RECORD_CALLBACK_TIMEOUT_MS).toBe(10_000)
  })
})

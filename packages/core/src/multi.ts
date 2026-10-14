import type { EngineFailure, EngineInput, EngineResult, Usage } from './engine'
import type { Inconclusive, ReviewOutput } from './findings'
import { REVIEW_LENSES, reviewSystemPrompt, type Lens } from './prompt'

// The multi-reviewer mode (spec 0.2.0 §8.3; decisions §14.16-§14.19, all taken as (a)). Instead of one
// reviewer looking at everything, one reviewer per focus — the prompt's own `REVIEW_LENSES` — reads
// the same checkout under the same read-only rules, each told to look for one kind of problem. A tier
// still says how deep each one goes; this says how many perspectives.
//
// What lives here is the part every way in shares: running the focuses side by side, and combining
// what they said into one engine result. Running a focus is somebody else's function (`run`), so the
// review session can watch each one's spend from outside, and trigger.dev's runner can later run each
// focus as a child task of its own (§8.3 point 4, decision §14.18 — Stage 6) without this file changing.

/** One focused reviewer, as it ended. */
export type FocusRun = { lens: Lens; result: EngineResult }

/** What the review record keeps of each focus (spec 0.2.0 §8.3 point 6). */
export type FocusRecord = {
  lens: Lens
  /** This focus's own bill, at per-token API prices as the Claude Code CLI reported it. */
  usage: Usage
  /** It returned an answer in the findings schema — complete, or partial when `cutShort`. A focus that
   *  did not finish contributed nothing to the review. */
  finished: boolean
  /** Its ceiling, or another limit, stopped it before it was done. */
  cutShort: boolean
  failure: EngineFailure | null
  /** How many findings it reported, before the check pass or anything else judged them. */
  findings: number
}

/** How many focuses run at once when the caller does not say: all three. On a laptop, CI or a VPS
 *  they are three processes side by side (spec 0.2.0 §8.3 point 4). The App's runner says 1: one
 *  review peaks around 400 MiB and its machine has 1 GB. */
export const DEFAULT_FOCUS_CONCURRENCY = REVIEW_LENSES.length

const emptyUsage = (): Usage => ({
  costUsd: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0,
})

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Runs one engine pass per focus over `input` — the review's own input, the same checkout, flags,
 *  skills, runtime and abort signal — with only the system prompt changed to that focus's
 *  (`reviewSystemPrompt({ settings, lens })`), at most `concurrency` at a time.
 *
 *  **Each focus has the tier's soft budget and the tier's ceiling** (spec 0.2.0 §8.3 point 1):
 *  `input.settings.budget` is passed to every one unchanged, so the reviewers of one review may spend
 *  up to the number of focuses times the tier's ceiling between them. A focus stopped by its ceiling
 *  keeps whatever it had written — the engine already returns partial output with failure `budget` —
 *  and its sibling focuses are not stopped with it. The one trial (§8.3) is why: on one pull request
 *  all three reviewers were stopped by their ceilings and returned nothing, for $5.91 — and the
 *  spec's conclusion was that a stopped reviewer's work must count, and one failure must not sink
 *  the rest.
 *
 *  **A focus that fails does not fail the review** (point 2). One whose `run` throws — the spawn
 *  failed, the binary was not there — is recorded as `crashed` and named through `onFailure`, and the
 *  others go on. Only when EVERY focus threw does this throw, with the first error: then nothing ran
 *  at all, and the caller's reason should be the one a single reviewer would have given.
 *
 *  **The abort signal reaches every focus.** It is in each focus's input, so every running child is
 *  killed with it; no focus still queued is started once it has fired; and this throws the signal's
 *  reason, as one aborted reviewer does — unless every focus had already answered.
 *
 *  Results come back in `REVIEW_LENSES` order, however they finished, so a record is the same
 *  whichever focus was quickest. */
export const runFocusedReviews = async (a: {
  input: EngineInput
  /** Runs one focus: `runEngine`, or a wrapper that watches its spend. */
  run: (input: EngineInput) => Promise<EngineResult>
  concurrency: number
  /** A focus whose `run` threw, before the review goes on without it. */
  onFailure?: (lens: Lens, error: unknown) => void
}): Promise<FocusRun[]> => {
  const { input } = a
  if (!Number.isInteger(a.concurrency) || a.concurrency < 1) {
    throw new TypeError(`concurrency must be a whole number of at least 1, got ${String(a.concurrency)}`)
  }
  // A function, not the expression inline: `aborted` is a live getter, and TypeScript would narrow it
  // to `false` after the first test and call the second one impossible.
  const aborted = (): boolean => input.signal?.aborted === true
  const lenses = [...REVIEW_LENSES]
  const results = new Map<Lens, EngineResult>()
  const thrown: unknown[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      // Before taking a focus off the queue: a review stopped while one focus ran must not start the
      // next one and pay for it.
      if (aborted()) return
      const lens = lenses[next++]
      if (lens === undefined) return
      try {
        results.set(lens, await a.run({
          ...input,
          systemPrompt: reviewSystemPrompt({ settings: input.settings, lens }),
        }))
      } catch (e) {
        // The review is being stopped: nothing is recorded about this focus, and the throw below says
        // why the whole review ended.
        if (aborted()) return
        thrown.push(e)
        try { a.onFailure?.(lens, e) } catch { /* a progress line must not undo a review */ }
        results.set(lens, {
          output: null, usage: emptyUsage(), cutShort: false, wrapUpFired: false,
          failure: { kind: 'crashed', code: null, stderr: messageOf(e) },
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(a.concurrency, lenses.length) }, worker))

  // Stopped with a focus lost to the stop — killed, or never started — is a review that did not run.
  // Stopped after every focus had already answered is a finished one, which the caller publishes as
  // it would one reviewer that finished as the stop landed.
  if (aborted() && results.size < lenses.length) {
    const reason: unknown = input.signal?.reason
    throw reason instanceof Error ? reason : new Error('The operation was aborted')
  }
  if (thrown.length === lenses.length) throw thrown[0]
  return lenses.flatMap((lens) => {
    const result = results.get(lens)
    return result === undefined ? [] : [{ lens, result }]
  })
}

const sumUsage = (all: Usage[]): Usage => all.reduce((t, u) => ({
  costUsd: t.costUsd + u.costUsd,
  inputTokens: t.inputTokens + u.inputTokens,
  outputTokens: t.outputTokens + u.outputTokens,
  cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens,
  cacheWriteTokens: t.cacheWriteTokens + u.cacheWriteTokens,
  turns: t.turns + u.turns,
  durationMs: t.durationMs + u.durationMs,
}), emptyUsage())

/** The focuses' answers as ONE engine result, which everything after the engine — the paths, the
 *  secret scan, the check pass, publishing, the record — already knows how to read.
 *
 *  - `findings`: the union, each tagged with the `lens` it came from, in `REVIEW_LENSES` order.
 *    Nothing is merged here: deciding that two findings are one defect is the check pass's job
 *    (decision §14.17), and it reads them against the code.
 *  - `summary` and `intent`: the `intent` focus's, the one told to judge whether the change does what
 *    it says; when it gave no answer, the first focus that did — every focus is asked for both.
 *  - `inconclusive`: every focus's, each question once.
 *  - `usage`: the sum of the focuses' — so the record's `usage`, and with it `costUsd`, is what the
 *    reviewers cost together. Its `durationMs` is the sum too: process time, not the wall clock of
 *    focuses that ran side by side, which the record's `timings` carry.
 *  - `failure`: null when any focus answered, partially or not (point 2 — the review fails only when
 *    every focus produced nothing); otherwise the first focus's, in `REVIEW_LENSES` order. Each focus's
 *    own is on the record.
 *  - `cutShort`: any focus was stopped by a limit. */
export const combineFocusRuns = (runs: FocusRun[]): EngineResult => {
  const answered = runs.flatMap((r) => r.result.output === null ? [] : [{ lens: r.lens, output: r.result.output }])
  const lead = answered.find((r) => r.lens === 'intent') ?? answered[0]
  const seenQuestions = new Set<string>()
  const inconclusive: Inconclusive[] = answered.flatMap((r) => r.output.inconclusive).filter((i) => {
    if (seenQuestions.has(i.question)) return false
    seenQuestions.add(i.question)
    return true
  })
  const output: ReviewOutput | null = lead === undefined ? null : {
    summary: lead.output.summary,
    intent: { ...lead.output.intent },
    findings: answered.flatMap((r) => r.output.findings.map((f) => ({ ...f, lens: r.lens }))),
    inconclusive,
  }
  return {
    output,
    usage: sumUsage(runs.map((r) => r.result.usage)),
    cutShort: runs.some((r) => r.result.cutShort),
    wrapUpFired: runs.some((r) => r.result.wrapUpFired),
    failure: output !== null ? null : (runs[0]?.result.failure ?? { kind: 'refusal' }),
  }
}

/** The record's `focuses` (spec 0.2.0 §8.3 point 6). */
export const focusRecords = (runs: FocusRun[]): FocusRecord[] => runs.map((r) => ({
  lens: r.lens,
  usage: { ...r.result.usage },
  finished: r.result.output !== null,
  cutShort: r.result.cutShort,
  failure: r.result.failure,
  findings: r.result.output?.findings.length ?? 0,
}))

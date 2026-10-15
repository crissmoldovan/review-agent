import {
  REVIEW_LENSES, reviewSystemPrompt, type EngineInput, type Lens,
} from '@review-agent/core'
import {
  publishReview, type ReportHandle, type ReportKind, type Reporter, type RunReviewDeps,
} from '@review-agent/github'
import type { ReviewResult } from './result'

/** Where a review has got to (spec 0.2.0 §4.2, `onProgress`). In the order a posted review passes
 *  them: `preparing` (reading the pull request and its settings), `downloading`, `reviewing`,
 *  `checking`, `rechecking` (a re-review of a pull request reviewed before), `publishing`,
 *  `reporting` (finishing the check run or commit status), `done`. A review skips what it does not
 *  do: a printed one never publishes or reports, a first review never re-checks. */
export type ProgressStage =
  | 'preparing' | 'downloading' | 'reviewing' | 'checking' | 'rechecking' | 'publishing' | 'reporting' | 'done'

type About = {
  /** `'owner/name'`, so one handler can follow several reviews. */
  repo: string
  pr: number
}

/** The review has reached `stage`. `note` is absent, which is how these are told from a `NoteEvent`. */
export type StageEvent = About & { note?: undefined } & (
  | { stage: 'preparing' }
  | { stage: 'downloading' }
  /** Once per reviewer: on a multi-reviewer review, once per focus as it starts, with its `focus`;
   *  otherwise once, with `focus: null`. */
  | { stage: 'reviewing'; focus: Lens | null }
  /** `findings`: how many the disprove-it pass is checking. */
  | { stage: 'checking'; findings: number }
  /** `findings`: how many earlier findings the re-review pass is asked about. */
  | { stage: 'rechecking'; findings: number }
  | { stage: 'publishing' }
  | { stage: 'reporting'; report: ReportKind }
  /** The last event of every call that returns: the result's kind. Sent once the checkout is gone. */
  | { stage: 'done'; result: ReviewResult['kind'] }
)

/** A line of progress inside the stage the review last reached — the lines the CLI prints on stderr
 *  (credential files removed from the checkout, a focused reviewer that failed, a report that could
 *  not be completed). Not a new stage. `details` are the fields the line was logged with, `{}` when
 *  none; meant for the host's own logs. */
export type NoteEvent = About & { stage: ProgressStage; note: string; details: Record<string, unknown> }

export type ProgressEvent = StageEvent | NoteEvent

/** A stage event, before the review it is about is added. Distributed over the union, so each
 *  stage keeps its own fields. */
type StageOnly<E = StageEvent> = E extends StageEvent ? Omit<E, keyof About | 'note'> : never

export type Progress = {
  stage: (e: StageOnly) => void
  note: (line: string) => void
  log: (message: string, fields: Record<string, unknown>) => void
}

/** Sends events to the host's `onProgress`, which must never be able to fail a review: a progress
 *  bar that throws, or an async handler that rejects, is the host's bug and costs only the event. The
 *  rejection is caught here because nothing else would: an unhandled rejection can end the process,
 *  and with it every other review running in it. */
export const progressFor = (a: { repo: string; pr: number; onProgress: ((e: ProgressEvent) => void) | null }): Progress => {
  const about: About = { repo: a.repo, pr: a.pr }
  let current: ProgressStage = 'preparing'
  const send = (e: ProgressEvent): void => {
    if (a.onProgress === null) return
    try {
      const r = a.onProgress(e) as unknown
      if (typeof r === 'object' && r !== null && typeof (r as { then?: unknown }).then === 'function') {
        (r as PromiseLike<unknown>).then(undefined, () => { /* the event is lost, not the review */ })
      }
    } catch { /* the event is lost, not the review */ }
  }
  return {
    stage: (e) => {
      current = e.stage
      send({ ...about, ...e } as StageEvent)
    },
    note: (line) => { send({ ...about, stage: current, note: line, details: {} }) },
    log: (message, fields) => { send({ ...about, stage: current, note: message, details: { ...fields } }) },
  }
}

/** Which focus an engine run is, read off the one thing that differs between them: the system prompt
 *  `runFocusedReviews` gave it (`reviewSystemPrompt({ settings, lens })`, a pure function of the
 *  two). Null for a review by one reviewer, and for a prompt that matches none — a progress event
 *  that says less, rather than one that names the wrong focus. */
const focusOf = (input: EngineInput): Lens | null => {
  if (!input.settings.multi) return null
  return REVIEW_LENSES.find((lens) => reviewSystemPrompt({ settings: input.settings, lens }) === input.systemPrompt) ?? null
}

/** `runReview`'s collaborators, watched from outside: each says which stage it is starting, then does
 *  exactly what it did. Wrapping the deps is the session's own way of seeing in — it watches the
 *  engine's spend the same way — so no stage needs a change inside `@review-agent/github`.
 *
 *  `made` collects every checkout directory created, so `reviewPullRequest` can remove each one
 *  whatever path the review ended on (spec 0.2.0 §4.4). */
export const watchedDeps = (base: RunReviewDeps, progress: Progress, made: string[]): RunReviewDeps => ({
  ...base,
  makeCheckoutDir: async () => {
    const dir = await base.makeCheckoutDir()
    made.push(dir)
    return dir
  },
  downloadArchive: async (a) => {
    progress.stage({ stage: 'downloading' })
    return base.downloadArchive(a)
  },
  runEngine: async (input) => {
    progress.stage({ stage: 'reviewing', focus: focusOf(input) })
    return base.runEngine(input)
  },
  runCheckPass: async (x) => {
    // With nothing to check the pass returns at once, spawning nothing: no stage to report.
    if (x.findings.length > 0) progress.stage({ stage: 'checking', findings: x.findings.length })
    return base.runCheckPass(x)
  },
  runRecheckPass: async (x) => {
    progress.stage({ stage: 'rechecking', findings: x.previous.length })
    return base.runRecheckPass(x)
  },
})

/** `publishReview`, saying `publishing` first. The session's `publishReview` seam, given the real
 *  function: nothing about what is published changes. */
export const watchedPublish = (progress: Progress): typeof publishReview => async (a) => {
  progress.stage({ stage: 'publishing' })
  return publishReview(a)
}

/** A reporter whose handle says `reporting` as the session finishes it. Opening the report — before
 *  the model, `pending` or `in_progress` — is not a stage of its own: it is part of getting ready,
 *  and is over in one request. The handle's fields are read through, live: a commit status learns
 *  its `url` only when it is finished. */
export const watchedReporter = (reporter: Reporter, progress: Progress): Reporter => ({
  kind: reporter.kind,
  start: async (s) => {
    const handle = await reporter.start(s)
    if (handle === null) return null
    const watched: ReportHandle = {
      get kind() { return handle.kind },
      get id() { return handle.id },
      get url() { return handle.url },
      finish: async (f) => {
        progress.stage({ stage: 'reporting', report: handle.kind })
        return handle.finish(f)
      },
    }
    return watched
  },
})

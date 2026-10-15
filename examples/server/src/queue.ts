/** What a finished run tells the queue: whether to keep its key, so a redelivery of the same request
 *  is answered "already done" rather than paid for again. */
export type RunOutcome = { remember: boolean }

export type Enqueued =
  | { kind: 'queued'; waiting: number }
  /** The same key is waiting, running, or finished within `rememberMs`. */
  | { kind: 'duplicate'; state: 'waiting' | 'running' | 'done' }
  /** `limit` reviews are already waiting. Nothing was dropped to make room. */
  | { kind: 'full'; limit: number }
  /** `close()` was called: the process is stopping. */
  | { kind: 'closed' }

export type QueueOptions<J> = {
  /** How many runs at once. Each review is at least one Claude Code process of a few hundred MiB
   *  (spec 0.2.0 §9.2), so the default, 1, is the safe one for a small machine. */
  concurrency: number
  /** How many jobs may WAIT behind the running ones. Bounded because a webhook is answered before its
   *  review runs: an unbounded line on a busy day grows until the process dies and takes every
   *  accepted review with it, where a full line says 503 and GitHub shows the delivery as failed. */
  limit: number
  run: (job: J, signal: AbortSignal) => Promise<RunOutcome>
  /** A run that threw instead of returning — a bug, not an outcome. Its key is forgotten. */
  onCrash?: (job: J, error: unknown) => void
  /** How long a finished key is remembered. Default 24 hours. */
  rememberMs?: number
  /** At most this many finished keys are remembered; the oldest go first. Default 10,000. */
  rememberMax?: number
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** An in-process review queue: bounded, deduplicated by key, a fixed number of runs at once.
 *
 *  Why a queue at all: GitHub waits 10 seconds for a webhook's answer and a review takes minutes, so the
 *  delivery is answered when the review is queued and the review runs afterwards (spec 0.2.0 §7, §9.2).
 *
 *  The key is the receiver's idempotency key (`idempotencyKeyFor`, `@review-agent/app/receiver`): one
 *  automatic review per pull request and head commit, one review per `/review` comment, one per press of
 *  a check run's Re-run button. It is kept the way the App's trigger.dev key is kept: a review that
 *  finished keeps it, so a redelivered webhook runs nothing twice; a run that asks to be forgotten — it
 *  failed before spending anything — or that threw clears it, so asking again runs again.
 *
 *  Everything here lives in this process's memory and nowhere else: a restart loses what was waiting and
 *  what was remembered. That is the example's stated limit (README, "Limits"). */
export class ReviewQueue<J extends { key: string }> {
  readonly #o: Required<Omit<QueueOptions<J>, 'onCrash'>> & Pick<QueueOptions<J>, 'onCrash'>
  readonly #waiting: J[] = []
  readonly #running = new Map<string, AbortController>()
  readonly #done = new Map<string, number>() // key → when it stops being remembered; insertion-ordered
  readonly #idle: (() => void)[] = []
  #closed = false

  constructor(o: QueueOptions<J>) {
    if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new TypeError('concurrency must be a whole number of at least 1')
    if (!Number.isInteger(o.limit) || o.limit < 0) throw new TypeError('limit must be a whole number of at least 0')
    this.#o = { rememberMs: DAY_MS, rememberMax: 10_000, now: Date.now, ...o }
  }

  enqueue(job: J): Enqueued {
    if (this.#closed) return { kind: 'closed' }
    this.#forgetExpired()
    if (this.#running.has(job.key)) return { kind: 'duplicate', state: 'running' }
    if (this.#waiting.some((w) => w.key === job.key)) return { kind: 'duplicate', state: 'waiting' }
    if (this.#done.has(job.key)) return { kind: 'duplicate', state: 'done' }
    // Checked after the duplicates: a redelivery of a job already held is not a new one, and is answered
    // as such even when the line is full.
    if (this.#waiting.length >= this.#o.limit && this.#running.size >= this.#o.concurrency) {
      return { kind: 'full', limit: this.#o.limit }
    }
    this.#waiting.push(job)
    this.#pump()
    return { kind: 'queued', waiting: this.#waiting.length }
  }

  stats(): { waiting: number; running: number; remembered: number } {
    return { waiting: this.#waiting.length, running: this.#running.size, remembered: this.#done.size }
  }

  /** Stops taking jobs, and hands back the ones that were waiting — never started, so nothing was
   *  spent on them — for the caller to log. Running jobs go on until they finish or `abort()`. */
  close(): J[] {
    this.#closed = true
    return this.#waiting.splice(0)
  }

  /** Aborts every running job's signal. The SDK stops the review's Claude process with it, removes the
   *  checkout, and concludes the check run as cancelled. */
  abort(reason: string): void {
    for (const controller of this.#running.values()) controller.abort(new Error(reason))
  }

  /** Resolves when nothing is running. */
  idle(): Promise<void> {
    if (this.#running.size === 0) return Promise.resolve()
    return new Promise((resolve) => { this.#idle.push(resolve) })
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#o.concurrency && this.#waiting.length > 0) {
      const job = this.#waiting.shift() as J
      const controller = new AbortController()
      this.#running.set(job.key, controller)
      void this.#start(job, controller)
    }
  }

  async #start(job: J, controller: AbortController): Promise<void> {
    let remember = false
    try {
      remember = (await this.#o.run(job, controller.signal)).remember
    } catch (e) {
      this.#o.onCrash?.(job, e)
    } finally {
      this.#running.delete(job.key)
      if (remember) this.#remember(job.key)
      this.#pump()
      if (this.#running.size === 0) for (const resolve of this.#idle.splice(0)) resolve()
    }
  }

  #remember(key: string): void {
    this.#done.delete(key) // re-inserted at the end, as the newest
    this.#done.set(key, this.#o.now() + this.#o.rememberMs)
    while (this.#done.size > this.#o.rememberMax) {
      const oldest = this.#done.keys().next().value as string
      this.#done.delete(oldest)
    }
  }

  #forgetExpired(): void {
    const now = this.#o.now()
    // Oldest first, and every key is remembered for the same time, so the first one still in date
    // means every later one is too.
    for (const [key, until] of this.#done) {
      if (until > now) break
      this.#done.delete(key)
    }
  }
}

import { describe, expect, it } from 'vitest'
import { ReviewQueue, type RunOutcome } from './queue'

type Job = { key: string }

/** A run the test finishes by hand, so what is running at any moment is the test's to decide. */
const controlledRuns = () => {
  const started: string[] = []
  const signals = new Map<string, AbortSignal>()
  const finishers = new Map<string, (o: RunOutcome) => void>()
  const failers = new Map<string, (e: Error) => void>()
  let running = 0
  let mostAtOnce = 0
  const run = (job: Job, signal: AbortSignal): Promise<RunOutcome> => {
    started.push(job.key)
    signals.set(job.key, signal)
    running++
    mostAtOnce = Math.max(mostAtOnce, running)
    return new Promise<RunOutcome>((resolve, reject) => {
      finishers.set(job.key, (o) => { running--; resolve(o) })
      failers.set(job.key, (e) => { running--; reject(e) })
    })
  }
  return {
    run, started, signals,
    finish: async (key: string, o: RunOutcome = { remember: true }) => {
      finishers.get(key)?.(o)
      await new Promise((r) => setTimeout(r, 0)) // let the queue start the next one
    },
    fail: async (key: string) => {
      failers.get(key)?.(new Error('boom'))
      await new Promise((r) => setTimeout(r, 0))
    },
    mostAtOnce: () => mostAtOnce,
  }
}

describe('ReviewQueue concurrency', () => {
  it('runs one review at a time when asked for one, in the order they came', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' }); q.enqueue({ key: 'b' }); q.enqueue({ key: 'c' })
    expect(runs.started).toEqual(['a'])
    await runs.finish('a')
    expect(runs.started).toEqual(['a', 'b'])
    await runs.finish('b')
    await runs.finish('c')
    expect(runs.started).toEqual(['a', 'b', 'c'])
    expect(runs.mostAtOnce()).toBe(1)
  })

  it('runs up to its concurrency at once, and no more', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 2, limit: 10, run: runs.run })
    for (const key of ['a', 'b', 'c']) q.enqueue({ key })
    expect(runs.started).toEqual(['a', 'b'])
    expect(q.stats()).toMatchObject({ running: 2, waiting: 1 })
    await runs.finish('b')
    expect(runs.started).toEqual(['a', 'b', 'c'])
    expect(runs.mostAtOnce()).toBe(2)
  })
})

describe('ReviewQueue deduplication', () => {
  it('takes a key once while it is waiting or running: a redelivered webhook is not a second review', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' }); q.enqueue({ key: 'b' })
    expect(q.enqueue({ key: 'a' })).toEqual({ kind: 'duplicate', state: 'running' })
    expect(q.enqueue({ key: 'b' })).toEqual({ kind: 'duplicate', state: 'waiting' })
    expect(runs.started).toEqual(['a'])
  })

  it('remembers a finished key, so a redelivery after the review does not pay for it again', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' })
    await runs.finish('a', { remember: true })
    expect(q.enqueue({ key: 'a' })).toEqual({ kind: 'duplicate', state: 'done' })
    expect(runs.started).toEqual(['a'])
  })

  it('forgets a key whose run asked to be forgotten, so asking again runs again', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' })
    await runs.finish('a', { remember: false })
    expect(q.enqueue({ key: 'a' }).kind).toBe('queued')
    expect(runs.started).toEqual(['a', 'a'])
  })

  it('forgets the key of a run that threw, and says so once', async () => {
    const runs = controlledRuns()
    const crashed: string[] = []
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run, onCrash: (job) => crashed.push(job.key) })
    q.enqueue({ key: 'a' })
    await runs.fail('a')
    expect(crashed).toEqual(['a'])
    expect(q.enqueue({ key: 'a' }).kind).toBe('queued')
  })

  it('forgets a finished key once its time is up', async () => {
    const runs = controlledRuns()
    let now = 1_000
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run, rememberMs: 500, now: () => now })
    q.enqueue({ key: 'a' })
    await runs.finish('a')
    now += 499
    expect(q.enqueue({ key: 'a' }).kind).toBe('duplicate')
    now += 1
    expect(q.enqueue({ key: 'a' }).kind).toBe('queued')
  })

  it('remembers at most rememberMax keys, dropping the oldest', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run, rememberMax: 2 })
    for (const key of ['a', 'b', 'c']) {
      q.enqueue({ key })
      await runs.finish(key)
    }
    expect(q.stats().remembered).toBe(2)
    expect(q.enqueue({ key: 'a' }).kind).toBe('queued')
    expect(q.enqueue({ key: 'c' }).kind).toBe('duplicate')
  })
})

describe('ReviewQueue bound', () => {
  it('answers full past its limit, and drops nothing it already holds', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 2, run: runs.run })
    expect(q.enqueue({ key: 'a' })).toEqual({ kind: 'queued', waiting: 0 })
    expect(q.enqueue({ key: 'b' })).toEqual({ kind: 'queued', waiting: 1 })
    expect(q.enqueue({ key: 'c' })).toEqual({ kind: 'queued', waiting: 2 })
    expect(q.enqueue({ key: 'd' })).toEqual({ kind: 'full', limit: 2 })
    // A redelivery of something it holds is still recognised as one when it is full.
    expect(q.enqueue({ key: 'c' })).toEqual({ kind: 'duplicate', state: 'waiting' })
    await runs.finish('a'); await runs.finish('b'); await runs.finish('c')
    expect(runs.started).toEqual(['a', 'b', 'c'])
  })

  it('with a limit of 0, runs what it can start now and holds nothing back', () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 0, run: runs.run })
    expect(q.enqueue({ key: 'a' }).kind).toBe('queued')
    expect(q.enqueue({ key: 'b' }).kind).toBe('full')
  })
})

describe('ReviewQueue shutdown', () => {
  it('stops taking jobs on close, and hands back the ones that never started', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' }); q.enqueue({ key: 'b' })
    expect(q.close()).toEqual([{ key: 'b' }])
    expect(q.enqueue({ key: 'c' })).toEqual({ kind: 'closed' })
    await runs.finish('a')
    expect(runs.started).toEqual(['a'])
  })

  it('aborts the running review through its own signal, and is idle once it has returned', async () => {
    const runs = controlledRuns()
    const q = new ReviewQueue<Job>({ concurrency: 1, limit: 10, run: runs.run })
    q.enqueue({ key: 'a' })
    let idle = false
    void q.idle().then(() => { idle = true })
    q.abort('the server is stopping')
    expect(runs.signals.get('a')?.aborted).toBe(true)
    expect((runs.signals.get('a')?.reason as Error).message).toBe('the server is stopping')
    expect(idle).toBe(false)
    await runs.finish('a', { remember: false })
    expect(idle).toBe(true)
  })
})

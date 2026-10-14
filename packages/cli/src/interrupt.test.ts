import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { EXIT_INTERRUPTED } from './exit-codes'
import { cancelOnSignals } from './interrupt'

/** A process to signal, without signalling the one running these tests. */
const fakeProcess = () => {
  const emitter = new EventEmitter()
  const exits: number[] = []
  const said: string[] = []
  const interrupt = cancelOnSignals({
    on: (s, l) => emitter.on(s, l),
    off: (s, l) => emitter.off(s, l),
    exit: (code) => { exits.push(code) },
    stderr: (s) => { said.push(s) },
  })
  return { emitter, exits, said, interrupt }
}

// Spec 0.2.0 §9.3 P14.
describe('cancelOnSignals — Ctrl-C during a review', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('aborts the review on the first %s, and exits on nothing', (signal) => {
    const p = fakeProcess()
    p.emitter.emit(signal)
    expect(p.interrupt.signal.aborted).toBe(true)
    expect(p.exits).toEqual([])
    expect(p.said).toEqual(['stopping the review — press Ctrl-C again to exit at once'])
  })

  it('exits at once with 130 on the second, without waiting for the review to stop', () => {
    const p = fakeProcess()
    p.emitter.emit('SIGINT')
    p.emitter.emit('SIGTERM')
    expect(p.exits).toEqual([EXIT_INTERRUPTED])
    expect(EXIT_INTERRUPTED).toBe(130)
  })

  it('gives Ctrl-C back to Node once the review is over', () => {
    const p = fakeProcess()
    p.interrupt.dispose()
    expect(p.emitter.listenerCount('SIGINT')).toBe(0)
    expect(p.emitter.listenerCount('SIGTERM')).toBe(0)
  })
})

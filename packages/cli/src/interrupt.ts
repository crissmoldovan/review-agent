import { EXIT_INTERRUPTED } from './exit-codes'

const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/** Ctrl-C, for a command that is spending money (spec 0.2.0 §9.3 P14).
 *
 *  Node's default on SIGINT is to exit on the spot: the Claude process it started could keep running
 *  and keep billing, and the downloaded code stayed in the temp directory. So the first SIGINT or
 *  SIGTERM aborts the review instead — the abort reaches the Claude process through `spawn`'s
 *  `signal`, and the review's own clean-up runs. A second one exits at once, with 130 (128 + SIGINT, as
 *  a shell reports a Ctrl-C), for the person who does not want to wait for the clean-up.
 *
 *  Installed only around a review, and removed after it: anywhere else Ctrl-C keeps Node's meaning.
 *  The process is a parameter so the two-press rule can be tested without signalling the test runner. */
export const cancelOnSignals = (a: {
  on: (signal: NodeJS.Signals, listener: () => void) => unknown
  off: (signal: NodeJS.Signals, listener: () => void) => unknown
  exit: (code: number) => void
  stderr: (s: string) => void
}): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController()
  const onSignal = (): void => {
    if (controller.signal.aborted) {
      a.exit(EXIT_INTERRUPTED)
      return
    }
    a.stderr('stopping the review — press Ctrl-C again to exit at once')
    controller.abort(new Error('the review was interrupted'))
  }
  for (const s of SIGNALS) a.on(s, onSignal)
  return {
    signal: controller.signal,
    dispose: () => { for (const s of SIGNALS) a.off(s, onSignal) },
  }
}

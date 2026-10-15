import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

/** One yes-or-no question on the terminal, `[y/N]`: only `y` or `yes` is a yes.
 *
 *  Everything else is a no — Enter, any other word, the input closing (Ctrl-D), and an abort (the
 *  first Ctrl-C, interrupt.ts) — because the questions this CLI asks are "may I write to GitHub as
 *  you?" and "may I start a browser login?", and silence must never be taken for consent.
 *
 *  `terminal: false` leaves the terminal in its ordinary line mode, so Ctrl-C reaches this process as
 *  a SIGINT and goes through the same handler as during a review, rather than being swallowed by
 *  readline. The question is written to `output` — stderr in the CLI — so stdout stays the review. */
export const askYesNo = async (a: {
  input: Readable; output: Writable; question: string; signal?: AbortSignal
}): Promise<boolean> => {
  if (a.signal?.aborted === true) return false
  const rl = createInterface({ input: a.input, output: a.output, terminal: false })
  try {
    return await new Promise<boolean>((resolve) => {
      // A closed input never answers; without this the question would wait for ever.
      rl.once('close', () => { resolve(false) })
      rl.question(`${a.question} `, a.signal === undefined ? {} : { signal: a.signal })
        .then((answer) => { resolve(/^\s*y(es)?\s*$/i.test(answer)) }, () => { resolve(false) })
    })
  } finally {
    rl.close()
  }
}

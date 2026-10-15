import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { askYesNo } from './confirm'

const ask = (typed: string | null, signal?: AbortSignal) => {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (c: Buffer) => { shown += c.toString('utf8') })
  const answer = askYesNo({ input, output, question: 'Continue? [y/N]', ...(signal !== undefined && { signal }) })
  if (typed === null) input.end()
  else input.write(typed)
  return { answer, shown: () => shown }
}

describe('askYesNo — [y/N]', () => {
  it('shows the question and takes y or yes, in any case, as a yes', async () => {
    for (const typed of ['y\n', 'Y\n', 'yes\n', ' YES \n']) {
      const q = ask(typed)
      expect(await q.answer).toBe(true)
      expect(q.shown()).toContain('Continue? [y/N]')
    }
  })

  it('takes everything else as a no: Enter, another word, a closed input', async () => {
    for (const typed of ['\n', 'n\n', 'no\n', 'yep\n', 'sure\n', null]) {
      expect(await ask(typed).answer).toBe(false)
    }
  })

  it('takes an abort — the first Ctrl-C — as a no, whether it came before or during the question', async () => {
    const before = new AbortController()
    before.abort()
    expect(await askYesNo({ input: new PassThrough(), output: new PassThrough(), question: 'q', signal: before.signal })).toBe(false)

    const during = new AbortController()
    const pending = askYesNo({ input: new PassThrough(), output: new PassThrough(), question: 'q', signal: during.signal })
    during.abort()
    expect(await pending).toBe(false)
  })
})

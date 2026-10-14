import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codeOf } from './code'

/** `codeOf` is what lets `src/init-boundary.test.ts` search source text for `console` and
 *  `process` without failing every file whose comments discuss them. That makes it load-bearing:
 *  if it blanked one character too many, the lock would go quiet about a real leak and still look
 *  green. These are the cases where "too many" is a real risk. */

const dir = mkdtempSync(join(tmpdir(), 'review-agent-code-'))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
const scan = (source: string): string => {
  const file = join(dir, `sample-${n++}.ts`)
  writeFileSync(file, source)
  return codeOf(file)
}

describe('reading a file as code', () => {
  it('blanks a line comment and keeps the line it was on', () => {
    const got = scan('const a = 1 // process.stdout.write(secret)\nconst b = 2\n')

    expect(got).toContain('const a = 1')
    expect(got).not.toContain('process')
    expect(got.split('\n')).toHaveLength(3)
  })

  it('blanks a block comment across lines without moving any code below it', () => {
    const got = scan('/** console.log(pem)\n *  and more prose\n */\nconst a = 1\n')

    expect(got).not.toContain('console')
    expect(got.split('\n')[3]).toBe('const a = 1')
  })

  it('reads a `//` inside a string as part of the string, so what follows it is still code', () => {
    // The shape that matters: a URL and a real print on one line. Blanking from the first `//`
    // would lose the print and call the file clean.
    const got = scan("const u = 'https://example.com'; console.log(u)\n")

    expect(got).toContain('console.log(u)')
  })

  it('reads a regex literal as a literal, so a quote inside one cannot open a string', () => {
    // Straight out of `init-server.ts`. Before this case existed the scan entered a string at the
    // quote inside `/"/` and never left it, so every comment in the rest of the file survived —
    // and one of them says the word `process`, which failed the lock on a file that is clean.
    const got = scan(
      "const e = (s: string): string => s.replace(/\"/g, '&quot;').replace(/'/g, '&#39;')\n" +
      '// it would kill the process before the message is printed\n' +
      'const after = 1\n',
    )

    expect(got).toContain('.replace(')
    expect(got).toContain('const after = 1')
    expect(got).not.toContain('process')
  })

  it('reads a slash after a value as division, and still blanks the comment after it', () => {
    const got = scan('const half = total / 2 // console.log(half)\nconst b = 3\n')

    expect(got).toContain('const half = total / 2')
    expect(got).not.toContain('console')
    expect(got).toContain('const b = 3')
  })

  it('keeps the inside of a template literal, comment-shaped or not', () => {
    const got = scan('const page = `<!-- a comment in HTML -->${name}`\n')

    expect(got).toContain('<!-- a comment in HTML -->')
    expect(got).toContain('${name}')
  })

  it('does not end a string at an escaped quote, which would leave the scan one quote out of step', () => {
    const got = scan("const a = 'it\\'s fine' // console.log(a)\nconst b = 2\n")

    expect(got).toContain("'it\\'s fine'")
    expect(got).not.toContain('console')
    expect(got).toContain('const b = 2')
  })

  it('leaves a file with no comments at all exactly as it was', () => {
    const source = 'export const add = (a: number, b: number): number => a + b\n'

    expect(scan(source)).toBe(source)
  })
})

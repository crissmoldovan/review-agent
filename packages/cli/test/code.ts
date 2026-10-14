import { readFileSync } from 'node:fs'

/** A file's CODE: the same text with every comment blanked, and nothing else changed.
 *
 *  `src/init-boundary.test.ts` searches source text for `console` and `process`, and half the
 *  comments in this repository discuss exactly those — including the comment in `init-command.ts`
 *  that explains why a secret is never printed, and the one in `init-server.ts` about the timeout
 *  killing the process. A rule that read raw text would fail on the files whose comments promise
 *  the rule, which is the fastest way to have the rule deleted.
 *
 *  The invariant, and the reason this is a character scan rather than a regex: **code is never
 *  removed.** Only the inside of a comment is replaced with spaces. A quote opens a string whose
 *  contents pass through untouched, so `'https://example.com'` cannot swallow the rest of its line,
 *  and a regex literal is recognised as one, so `.replace(/"/g, '&quot;')` cannot open a string
 *  that runs to the end of the file. What the scan still cannot do is read the inside of a
 *  `${ ... }` in a template literal, where it keeps everything verbatim; the effect of every
 *  remaining mistake is a comment KEPT, never a statement dropped, so the worst it can produce is a
 *  false alarm on a file a human then reads. */
export const codeOf = (file: string): string => blankComments(readFileSync(file, 'utf8'))

type State = 'code' | 'line-comment' | 'block-comment' | 'regex' | "'" | '"' | '`'

/** What can stand immediately before a `/` that opens a regex literal. After a value — a name, a
 *  number, a closing bracket — a `/` is division instead, and treating one as the other is how a
 *  scanner ends up in a string state it can never leave. */
const BEFORE_A_REGEX = /[(,=:[!&|?{};+\-*%~^<>]$/
const KEYWORD_BEFORE_A_REGEX = /\b(return|typeof|case|in|of|new|delete|void|throw|do|else|yield|await)$/

const opensARegex = (codeSoFar: string): boolean => {
  const before = codeSoFar.trimEnd()
  return before === '' || BEFORE_A_REGEX.test(before) || KEYWORD_BEFORE_A_REGEX.test(before)
}

const blankComments = (source: string): string => {
  let out = ''
  let state: State = 'code'
  let inCharacterClass = false
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1] ?? ''
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; out += '  '; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block-comment'; out += '  '; i += 2; continue }
      if (c === '/' && opensARegex(out)) { state = 'regex'; inCharacterClass = false }
      else if (c === "'" || c === '"' || c === '`') state = c
      out += c
      i += 1
      continue
    }
    if (state === 'line-comment') {
      // The newline itself survives, so a line number in a failure still points at the real line.
      if (c === '\n') state = 'code'
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    // Inside a string, a template or a regex. An escape consumes the character after it, so `'\''`
    // and `/\//` do not end here, and everything is copied through: a violation cannot hide inside
    // a literal, it can only make the scan keep a comment it should have blanked.
    if (c === '\\') { out += c + next; i += 2; continue }
    if (state === 'regex') {
      if (c === '[') inCharacterClass = true
      else if (c === ']') inCharacterClass = false
      else if (c === '/' && !inCharacterClass) state = 'code'
    } else if (c === state) state = 'code'
    out += c
    i += 1
  }
  return out
}

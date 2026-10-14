import type { Finding, Inconclusive, IntentVerdict, Tier } from '@review-agent/core'
import { encodeMarker, type MarkerState } from './marker'

/** The info string on a suggested-change fence. **NOT VERIFIED against GitHub's documentation**
 *  (research, 2026-09-14): the docs describe suggestions only through UI steps and screenshots, and
 *  no fetched page prints the syntax. Task 15's one real posted review is what proves it.
 *
 *  It is a single exported constant precisely because it may be wrong: set it to `''` and every
 *  suggestion in the product degrades to a plain fenced code block — readable advice a person can
 *  copy, instead of a control that does not work. Exactly one test fails on that edit, by design:
 *  the value pin in `body.test.ts`, which Task 15 Step 13 B edits in the same commit. Batch 1's
 *  verification (2026-09-14) found the edit failing a second case as well, so the hatch did not
 *  work as described; that case now asserts the plain-advice block itself. */
export const SUGGESTION_FENCE = 'suggestion'

/** Ours, not GitHub's. The research found NO documented limit on a comment body or a suggestion —
 *  the commonly cited 65,536 is not in the docs — so this is a product rule, not an API fact.
 *  Design §5 wants a suggested change only "where the fix is small": twenty lines is the most a
 *  reader takes in without scrolling the comment itself. */
export const MAX_SUGGESTION_LINES = 20

export const fenced = (info: string, text: string): string => ['```' + info, text, '```'].join('\n')

/** Verified: applying a suggestion REPLACES the commented line range. Our inline comments are
 *  single-line — `anchorFindings` produces a `line` and no `start_line` — so a suggestion is only
 *  safe when the finding itself names one line, or when the model wrote a replacement with exactly
 *  as many lines as the range it named. Anything else would patch lines it was not written for. */
export const suggestionFits = (f: Finding): boolean => {
  if (f.suggestion === null || f.suggestion.trim() === '') return false
  const lines = f.suggestion.replace(/\n$/, '').split('\n')
  if (lines.length > MAX_SUGGESTION_LINES) return false
  // A backwards or absent endLine is treated as one line: a malformed range must not be used to
  // justify a multi-line replacement.
  const span = f.endLine === null ? 1 : f.endLine - f.line + 1
  return span <= 1 ? true : lines.length === span
}

/** Design §5: every inline comment carries **Severity N/10**. It is the first thing on the line
 *  because it is the only number a reader uses to decide whether to keep reading.
 *  `fence` defaults to `SUGGESTION_FENCE` and no caller passes it: it is a seam for the test that
 *  renders a body with the fence emptied, so the degrade path above is exercised rather than
 *  asserted in prose (batch 1's verification, 2026-09-14, asked for a test that bites). */
export const inlineBody = (f: Finding, fence: string = SUGGESTION_FENCE): string => {
  const parts = [`**Severity ${f.severity}/10** · ${f.category}`, '', `**${f.title}**`, '', f.explanation]
  // Backticked, because evidence is `path:line` and Markdown would otherwise eat an underscore in a
  // filename. An empty list prints no heading at all: a heading over nothing reads as a bug.
  if (f.evidence.length > 0) parts.push('', 'Evidence:', ...f.evidence.map((e) => `- \`${e}\``))
  const suggestion = f.suggestion === null ? '' : f.suggestion.replace(/\n$/, '')
  if (suggestion.trim() !== '') {
    parts.push('', suggestionFits(f)
      ? fenced(fence, suggestion)
      : `Suggested fix:\n${fenced('', suggestion)}`)
  }
  return parts.join('\n')
}

export type SummaryInput = {
  headSha: string
  tier: Tier
  model: string
  /** What this review cost: model spend at per-token API prices, as the Claude Code CLI reported it
   *  for this run (`Usage.costUsd`, plus the check pass when it ran). It is NOT a subscription
   *  allowance and NOT a price charged to anyone — a deployment running on a subscription token
   *  still gets an API-priced figure here, and the comment says so, because an unlabelled number in
   *  a public pull request will be read as a bill. */
  costUsd: number
  summary: string
  intent: { verdict: IntentVerdict; note: string }
  summaryOnly: Finding[]
  inconclusive: Inconclusive[]
  marker: MarkerState
  /** What the requester asked for and did not get, already phrased as sentences by whoever knew
   *  why: `ResolvedSettings.droppedRequestKeys` for a value the deployment does not allow, and the
   *  comment doorway's own refusals for `--tier thorough` and `--multi`, which it will not pass on
   *  until the fan-out is built (Criss, 2026-09-14, decision 4). The second kind is why this field
   *  exists rather than being read off the settings: a flag the comment parser drops never reaches
   *  `resolveSettings`, so it can never land in `droppedRequestKeys`, and a refusal nobody can see
   *  is indistinguishable from a bug. Empty on the ordinary path. */
  refused: string[]
}

/** Design §5: one summary comment naming the commit reviewed, the tier and model, the cost, and any
 *  finding that could not be placed inline. */
export const summaryBody = (a: SummaryInput): string => {
  const lines: string[] = [
    `### Review of \`${a.headSha.slice(0, 7)}\``,
    '',
    `Tier **${a.tier}** · model \`${a.model}\` · ` +
    `cost **$${a.costUsd.toFixed(2)}** (model spend at API token prices)`,
    '',
    a.summary,
    '',
    `**Intent:** ${a.intent.verdict} — ${a.intent.note}`,
  ]
  // Design §5: "any finding that could not be placed inline". GitHub will only take a comment on a
  // line that is in the diff, so a real finding in an untouched file has nowhere else to be said.
  if (a.summaryOnly.length > 0) {
    lines.push('', '#### Not placed inline', '')
    for (const f of a.summaryOnly) {
      lines.push(`- **${f.severity}/10** \`${f.file}:${f.line}\` — **${f.title}** — ${f.explanation}`)
    }
  }
  // Design §4.5: every measured review produced inconclusive items, and all of them needed running
  // code, the internet or a person. Printing them is what lets a person close one.
  if (a.inconclusive.length > 0) {
    lines.push('', '#### Could not be settled', '')
    for (const i of a.inconclusive) {
      lines.push(`- ${i.question} — would be settled by: ${i.whatWouldSettleIt}`)
    }
  }
  // Criss, 2026-09-14 (decision 4): what was asked for and not done is said out loud, in the place
  // the requester is already reading. The sentences arrive phrased, because the half that knows WHY
  // something was not honoured is the half that refused it — the resolver for a value a deployment
  // disallows, the comment doorway for `--tier thorough` and `--multi`.
  if (a.refused.length > 0) {
    lines.push('', '#### Not honoured', '')
    for (const r of a.refused) lines.push(`- ${r}`)
  }
  // Last, and on its own line: design §5 keeps the re-review state in the pull request itself
  // rather than in a database, and `decodeMarker` reads the LAST marker in a body — so an edit by a
  // person that quotes an older copy of this comment cannot win over the current state.
  lines.push('', encodeMarker(a.marker))
  return lines.join('\n') + '\n'
}

/** The review's own top-level text (Task 7b). It is deliberately NOT `summaryBody`. Design §5 keeps
 *  the re-review state in ONE comment, the summary, which is edited in place. A review is never
 *  edited once posted, so a marker here would be a second copy that goes stale on the next push.
 *  It takes no count of what is on the lines, and says none: when GitHub refuses the inline
 *  comments, Task 4 re-posts THIS SAME BODY with `comments: []`, so any count it carried would be
 *  wrong exactly when a reader most needs it to be right. The review points at the summary, which
 *  names every finding including the ones that could not be placed on a line. */
export const reviewBody = (a: { headSha: string }): string =>
  `### Review of \`${a.headSha.slice(0, 7)}\`\n\n` +
  'The summary comment on this pull request has the whole review, including anything that could ' +
  'not be placed on a line.\n'

/** Hidden in the retraction note, so a second review never appends a second one. It is the same
 *  trick the state marker uses: an HTML comment is invisible to a reader and unmistakable to us. */
export const RETRACTED_MARKER = '<!-- review-agent:retracted -->'

/** Longer than any path anybody keeps, short enough that a note stays a note. */
export const MAX_NOTE_PATH_CHARS = 120

/** A string THIS PRODUCT DID NOT WRITE, put inside a code span without letting it out again.
 *
 *  The only caller is the retraction note, whose `file` comes out of a marker — and a marker is read
 *  from a pull-request comment, which is to say from whoever could write one. Left raw, a `file` of
 *  "`\n\n# SHIP IT" closed the span and signed an H1 with this product's name. A repository may also
 *  hold a path with a backtick in it perfectly honestly, and this is the same answer to both.
 *
 *  Backticks are REMOVED, not escaped: escaping inside a code span does nothing, and a longer fence
 *  is only another way out. Newlines go with them, so a note stays one paragraph. */
export const inlineCode = (s: string): string => {
  const flat = s.replace(/[`\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat === '') return '`(no file)`'
  return `\`${flat.length > MAX_NOTE_PATH_CHARS ? `${flat.slice(0, MAX_NOTE_PATH_CHARS)}…` : flat}\``
}

/** What a review says on an inline comment for a finding the re-review pass judged resolved
 *  (Criss, 2026-09-15; rewritten 2026-09-16 when a model started actually looking).
 *
 *  What changed, and why the sentence is allowed to be stronger than it was: this note used to sit
 *  on top of an INFERENCE. Nothing had examined the defect — the row was called gone because the
 *  model stopped mentioning it, or because a hash of its source line was no longer in the file — so
 *  the note could honestly say only "no longer reported", and even that turned out to be false in
 *  the run that produced it (an edited line reads as a gone line, so a `// TODO` appended to one
 *  retracted a comment in the same review that re-posted the finding). Now a reviewer has read the
 *  code at a named commit and answered a question about it. The note says that, and no more.
 *
 *  Three things it still may not do:
 *
 *  - It may not say a person fixed anything. A model reading code cannot see who changed what, or
 *    whether the defect moved somewhere this pass did not look. `resolved` is one reviewer's answer
 *    at one commit, not a repair anybody signed.
 *  - It may not be undated. A comment outlives the commit it was written about — GitHub re-anchors
 *    it onto later heads — so the sha it looked at is part of the claim, not decoration.
 *  - It may not replace what the comment said. The note is APPENDED and the original text kept,
 *    because a reply, a `/dispute` or a whole conversation may be hanging off it. */
export const retractionNote = (a: { file: string; headSha: string }): string => [
  '---',
  RETRACTED_MARKER,
  `**No longer reported.** The reviewer read ${inlineCode(a.file)} at \`${a.headSha.slice(0, 7)}\``
  + ' and no longer finds this issue there. That is one reviewer\'s answer at one commit, and not'
  + ' proof that a person fixed it. The comment above is left as it was said.',
].join('\n')

/** Hidden in the reinstatement note, the twin of `RETRACTED_MARKER`. The LAST of the two in a body
 *  is what the comment currently claims — see `noteStanding` in post.ts — so the pair is a two-state
 *  ledger rather than a flag that can only be set once. */
export const REINSTATED_MARKER = '<!-- review-agent:reinstated -->'

/** What a review says on a comment it retracted before and should not have (Criss, 2026-09-16).
 *
 *  A retraction used to be permanent in public: the marker could push a wrong `fixed` back to `open`
 *  — that is the whole of design point 3 — and the comment went on saying the reviewer no longer
 *  found the issue, under a defect the product had just re-confirmed. The private ledger was
 *  repairable and the thing a person reads was not.
 *
 *  The same three rules the retraction note obeys apply here, for the same reasons: it names the sha
 *  it looked at, it claims nothing about who changed what, and it is APPENDED — the retraction above
 *  it stays exactly where it was, because a note that vanishes is a note nobody can check. */
export const reinstatementNote = (a: { file: string; headSha: string }): string => [
  '---',
  REINSTATED_MARKER,
  `**Reported again.** The note above was wrong. The reviewer read ${inlineCode(a.file)} at `
  + `\`${a.headSha.slice(0, 7)}\` and finds this issue there after all. Both notes are left standing:`
  + ' this is what the reviewer said at each commit, and the earlier answer is part of that record.',
].join('\n')

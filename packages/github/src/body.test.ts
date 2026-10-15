import { describe, expect, it } from 'vitest'
import type { Finding } from '@review-agent/core'
import { MAX_SUGGESTION_LINES, SUGGESTION_FENCE, fenced, inlineBody, suggestionFits, codeSpan } from './body'

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: '.github/workflows/publish.yml', line: 100, endLine: null,
  severity: 7, category: 'security',
  title: 'a tag on any branch publishes',
  explanation: 'A tag pushed from any branch publishes that branch.',
  evidence: [], suggestion: null, ...over,
})

describe('inlineBody', () => {
  it('opens with the severity out of ten, because that is what the reader scans for', () => {
    const body = inlineBody(finding())
    expect(body.startsWith('**Severity 7/10**')).toBe(true)
  })

  it('carries the title and the explanation', () => {
    const body = inlineBody(finding())
    expect(body).toContain('a tag on any branch publishes')
    expect(body).toContain('A tag pushed from any branch publishes that branch.')
  })

  it('names the category, so a security finding is not read as a nit', () => {
    expect(inlineBody(finding())).toContain('security')
  })

  it('lists the evidence the reviewer said it read', () => {
    const body = inlineBody(finding({ evidence: ['.github/workflows/publish.yml:92', 'README.md:14'] }))
    expect(body).toContain('`.github/workflows/publish.yml:92`')
    expect(body).toContain('`README.md:14`')
  })

  it('says nothing about evidence when there is none, rather than an empty heading', () => {
    expect(inlineBody(finding({ evidence: [] })).toLowerCase()).not.toContain('evidence')
  })

  // Spec 0.2.0 §8.3: on a multi-reviewer review, which focus found it — after the severity and the
  // category, and nowhere on a review by one reviewer.
  it('names the focus that found it on a multi-reviewer review, and only there', () => {
    expect(inlineBody(finding({ lens: 'security' })).split('\n')[0]).toBe('**Severity 7/10** · security · security focus')
    expect(inlineBody(finding({ category: 'correctness', lens: 'intent' })).split('\n')[0]).toBe('**Severity 7/10** · correctness · intent focus')
    expect(inlineBody(finding()).split('\n')[0]).toBe('**Severity 7/10** · security')
  })
})

describe('the suggested change', () => {
  it('is emitted as a fenced block whose info string is the one exported constant', () => {
    // The literal ```suggestion fence is NOT VERIFIED in GitHub's documentation (research,
    // 2026-09-14): no fetched page prints the syntax. Every emission goes through SUGGESTION_FENCE
    // so that disproving it is one edit, not a hunt.
    // Pinned to its value as well as used through it. The expectation below is built from the
    // constant, so on its own it follows a typo in the constant and still passes; this line is the
    // one that fails. A deliberate change (Task 15 Step 13 finding the fence does not render) edits
    // the constant and this line together.
    expect(SUGGESTION_FENCE).toBe('suggestion')
    const body = inlineBody(finding({ suggestion: '  permissions: { contents: read }' }))
    expect(body).toContain('```' + SUGGESTION_FENCE + '\n  permissions: { contents: read }\n```')
  })

  it('emits nothing suggestion-shaped when the finding carries no suggestion', () => {
    expect(inlineBody(finding({ suggestion: null }))).not.toContain('```')
  })

  it('emits nothing for a suggestion that is only whitespace', () => {
    expect(inlineBody(finding({ suggestion: '   \n  ' }))).not.toContain('```')
  })

  it('degrades to a plain fenced code block when the fence is proven wrong', () => {
    // The escape hatch, run rather than argued: `inlineBody` takes the fence as a parameter whose
    // default is the constant, so a test can render a real body with it emptied. Until batch 1's
    // verification (2026-09-14) this case only checked `fenced('', …)`, which says nothing about
    // whether `inlineBody` reaches the fence through the constant at all — a fence written straight
    // into `inlineBody` passed it. It does not pass this.
    const f = finding({ suggestion: '  permissions: { contents: read }' })
    expect(inlineBody(f, '')).toContain(fenced('', '  permissions: { contents: read }'))
    expect(inlineBody(f, '')).not.toContain('```suggestion')
    // And the default IS the constant, which is what makes emptying the constant the one edit that
    // degrades every suggestion in the product (Task 15 Step 13 B makes exactly that edit).
    expect(inlineBody(f)).toBe(inlineBody(f, SUGGESTION_FENCE))
  })
})

describe('suggestionFits', () => {
  it('accepts a suggestion on a single-line finding', () => {
    expect(suggestionFits(finding({ line: 100, endLine: null, suggestion: 'one line' }))).toBe(true)
    expect(suggestionFits(finding({ line: 100, endLine: 100, suggestion: 'one line' }))).toBe(true)
  })

  it('accepts a multi-line suggestion whose line count matches the range it names', () => {
    expect(suggestionFits(finding({ line: 100, endLine: 102, suggestion: 'a\nb\nc' }))).toBe(true)
  })

  it('refuses a multi-line suggestion that does not match its range', () => {
    // GitHub applies a suggestion by REPLACING the commented range (verified). A replacement
    // written for three lines, applied to a range of two, silently makes the wrong patch.
    expect(suggestionFits(finding({ line: 100, endLine: 101, suggestion: 'a\nb\nc' }))).toBe(false)
  })

  it('refuses a suggestion longer than a reader will read', () => {
    // Pinned to its value as well as used through it, the way SUGGESTION_FENCE is. The expectation
    // below is built from the constant, so on its own it follows any change to twenty and still
    // passes. Twenty lines is a product rule — design §5 wants a suggestion only "where the fix is
    // small" — and not an API limit, so moving it is a deliberate change that edits this line too.
    expect(MAX_SUGGESTION_LINES).toBe(20)
    const long = Array.from({ length: MAX_SUGGESTION_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(suggestionFits(finding({ endLine: null, suggestion: long }))).toBe(false)
  })

  it('shows a suggestion that does not fit as plain advice, never as a control', () => {
    const body = inlineBody(finding({ line: 100, endLine: 101, suggestion: 'a\nb\nc' }))
    // The exact block, rather than the `not.toContain('```' + SUGGESTION_FENCE)` this case used to
    // carry: with the fence emptied — the documented escape hatch — that negative reads as
    // `not.toContain('```')` and fails on the plain block it was never about, which made emptying
    // the fence break two cases instead of the one pin that is meant to fail (batch 1's
    // verification, 2026-09-14). This form bites either way: taking the control branch for a
    // suggestion that does not fit loses the `Suggested fix:` prefix that only this branch writes.
    expect(body).toContain(`Suggested fix:\n${fenced('', 'a\nb\nc')}`)
  })
})

import { PRODUCT_URL, automatedReviewLine, summaryBody, type ReviewVia } from './body'
import type { MarkerState } from './marker'

const marker: MarkerState = {
  version: 1,
  runs: [{
    headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
    at: '2026-09-14T10:00:00.000Z',
    findings: [{
      id: 'a1b2c3d4e5f6', file: '.github/workflows/publish.yml', line: 100, severity: 7,
      title: 'a tag on any branch publishes', commentId: 42, outcome: 'open',
    }],
  }],
}

const APP: ReviewVia = { kind: 'app' }

const summaryInput = (over: Partial<Parameters<typeof summaryBody>[0]> = {}) => ({
  headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f',
  via: APP,
  tier: 'normal' as const,
  model: 'claude-opus-4-6',
  costUsd: 1.0543,
  summary: 'The change refuses a tag that does not match package.json.',
  intent: { verdict: 'matches' as const, note: 'The description and the diff agree.' },
  summaryOnly: [] as Finding[],
  inconclusive: [] as { question: string; whatWouldSettleIt: string }[],
  marker,
  refused: [] as string[],
  checkoutGaps: { notWritten: [] as { path: string; code: string }[], caseCollisions: [] as string[][] },
  ...over,
})

describe('summaryBody', () => {
  it('names the commit it reviewed, so nobody reads it against the wrong head', () => {
    expect(summaryBody(summaryInput())).toContain('4f8e2a1')
  })

  it('names the tier and the model, which is what a reader needs to judge the depth', () => {
    const body = summaryBody(summaryInput())
    expect(body).toContain('normal')
    expect(body).toContain('claude-opus-4-6')
  })

  it('states what the run cost and says what kind of number that is', () => {
    // Criss's standing rule: a cost figure that does not say what it measures is worse than none.
    // This one is model spend at per-token API prices, not a subscription allowance and not a
    // price charged to anyone.
    const body = summaryBody(summaryInput())
    expect(body).toContain('$1.05 (model spend at per-token API prices)')
  })

  it('opens with the automated-review line, and says the tier, model and cost there and only there', () => {
    // Spec 0.2.0 §5.6, decision §14.9: every summary says it is automated, the App's included. The
    // line it used to print on its own (`Tier … · model … · cost …`) is folded in, not repeated.
    const body = summaryBody(summaryInput())
    expect(body.split('\n')[0]).toBe(
      `🤖 **Automated review** by [review-agent](${PRODUCT_URL}) · GitHub App · tier **normal** · ` +
      '`claude-opus-4-6` · $1.05 (model spend at per-token API prices)',
    )
    expect(body.split('\n')[2]).toBe('### Review of `4f8e2a1`')
    expect(body.match(/\$1\.05/g)).toHaveLength(1)
    expect(body).not.toContain('Tier **')
  })

  // Spec 0.2.0 §8.3 point 2: a multi-reviewer review says which focuses ran and how each ended, on
  // its own line under the automated-review line.
  it('names the focused reviewers of a multi-reviewer review, and how each ended, under the automated line', () => {
    const body = summaryBody(summaryInput({
      focuses: [
        { lens: 'intent', finished: true, cutShort: false },
        { lens: 'impact', finished: true, cutShort: true },
        { lens: 'security', finished: false, cutShort: true },
      ],
      duplicates: 'merged',
    }))
    const lines = body.split('\n')
    expect(lines[0]).toContain('**Automated review**')
    expect(lines[2]).toBe('Three focused reviewers: intent ✓ · impact ✓ (cut short) · security ✗ (did not finish)')
    expect(lines[4]).toBe('### Review of `4f8e2a1`')
  })

  it('says so when the focuses’ findings were not merged, because the check pass was off or said nothing', () => {
    const focuses = [{ lens: 'intent', finished: true, cutShort: false }, { lens: 'impact', finished: true, cutShort: false }]
    expect(summaryBody(summaryInput({ focuses, duplicates: 'check-off' }))).toContain(
      'Two focused reviewers: intent ✓ · impact ✓ · the check pass was off, so findings were not merged and the same problem may be listed twice',
    )
    expect(summaryBody(summaryInput({ focuses, duplicates: 'check-unanswered' }))).toContain(
      'the check pass returned no verdicts, so findings were not merged',
    )
    expect(summaryBody(summaryInput({ focuses, duplicates: 'merged' }))).not.toContain('not merged')
  })

  it('has no focus line on a review by one reviewer', () => {
    for (const body of [summaryBody(summaryInput()), summaryBody(summaryInput({ focuses: [] }))]) {
      expect(body).not.toContain('focused reviewer')
      expect(body.split('\n')[2]).toBe('### Review of `4f8e2a1`')
    }
  })

  it('gives the intent verdict and the note behind it', () => {
    const body = summaryBody(summaryInput())
    expect(body).toContain('matches')
    expect(body).toContain('The description and the diff agree.')
  })

  it('lists the findings that could not be placed inline, with severity and location', () => {
    const orphan = finding({
      severity: 8, file: 'src/release.ts', line: 30, title: 'the token is logged on failure',
    })
    const body = summaryBody(summaryInput({ summaryOnly: [orphan] }))
    expect(body).toContain('8/10')
    expect(body).toContain('`src/release.ts:30`')
    expect(body).toContain('the token is logged on failure')
  })

  it('prints no unplaceable section when every finding found a line', () => {
    expect(summaryBody(summaryInput({ summaryOnly: [] }))).not.toContain('Not placed inline')
  })

  it('lists what the review could not settle, and what would settle it', () => {
    const body = summaryBody(summaryInput({
      inconclusive: [{ question: 'Does the runner have the secret?', whatWouldSettleIt: 'the repo settings' }],
    }))
    expect(body).toContain('Does the runner have the secret?')
    expect(body).toContain('the repo settings')
  })

  it('prints no inconclusive section when there is nothing unsettled', () => {
    expect(summaryBody(summaryInput({ inconclusive: [] }))).not.toContain('Could not be settled')
  })

  it('says what the requester asked for and did not get', () => {
    // Criss, 2026-09-14 (decision 4). A refusal that appears nowhere is the same experience as a
    // product that ignored you. The sentences arrive already phrased — this only renders them.
    const body = summaryBody(summaryInput({
      refused: [
        '`--multi` — this deployment does not run several reviewers on one review, so one reviewer ran.',
        '`--budget` — the deployment does not allow a request to raise it.',
      ],
    }))
    expect(body).toContain('Not honoured')
    expect(body).toContain('this deployment does not run several reviewers on one review')
    expect(body).toContain('the deployment does not allow a request to raise it')
  })

  it('prints no refusal section when everything asked for was honoured', () => {
    expect(summaryBody(summaryInput({ refused: [] }))).not.toContain('Not honoured')
  })

  // Spec 0.2.0 §9.3 P10. A file the reviewer never saw is a file it said nothing about, and a reader who
  // is not told reads that silence as "fine".
  it('says which files were not in the copy the reviewer read, and why', () => {
    const body = summaryBody(summaryInput({
      checkoutGaps: {
        notWritten: [{ path: 'docs/CON', code: 'EINVAL' }],
        caseCollisions: [['README.md', 'Readme.md']],
      },
    }))
    expect(body).toContain('#### Not in the checkout')
    expect(body).toContain('- `docs/CON` could not be written (`EINVAL`)')
    expect(body).toContain('- `README.md`, `Readme.md` differ only by letter case or Unicode form')
    // Before the marker, which must stay last.
    expect(body.indexOf('Not in the checkout')).toBeLessThan(body.indexOf(MARKER_OPEN))
  })

  it('prints no such section when the checkout holds everything', () => {
    expect(summaryBody(summaryInput())).not.toContain('Not in the checkout')
  })

  it('stops at twenty lines and counts the rest', () => {
    const notWritten = Array.from({ length: 23 }, (_, i) => ({ path: `bin/link-${i}`, code: 'EPERM' }))
    const body = summaryBody(summaryInput({ checkoutGaps: { notWritten, caseCollisions: [['A', 'a']] } }))
    expect(body).toContain('`bin/link-19`')
    expect(body).not.toContain('`bin/link-20`')
    expect(body).toContain('- and 4 more, listed on the review record')
  })

  it('cannot be turned into markup by a file name, which the pull request chose', () => {
    // A name with a backtick and a newline in it: left raw, it would close the code span and start a
    // heading of its own under this product's name.
    const body = summaryBody(summaryInput({
      checkoutGaps: { notWritten: [{ path: 'a`\n\n# SHIP IT', code: 'EINVAL' }], caseCollisions: [] },
    }))
    expect(body).not.toContain('\n# SHIP IT')
    expect(body).toContain('`a # SHIP IT`')
  })
})

import { MARKER_OPEN, decodeMarker } from './marker'

describe('the hidden marker in the summary comment', () => {
  it('round-trips: what went into the body comes back out of it', () => {
    // This IS the re-review mechanism (design §5: state lives in the pull request, in a hidden
    // marker inside the bot's own summary comment, so the product needs no database). If this
    // breaks, every re-review starts from nothing and every earlier finding looks fixed.
    expect(decodeMarker(summaryBody(summaryInput()))).toEqual(marker)
  })

  it('carries the comment ids the last run created, so replies can be read back', () => {
    const back = decodeMarker(summaryBody(summaryInput()))
    expect(back?.runs[0].findings[0].commentId).toBe(42)
    expect(back?.runs[0].findings[0].outcome).toBe('open')
  })

  it('hides the marker in an HTML comment, so a reader never sees it', () => {
    const body = summaryBody(summaryInput())
    expect(body).toContain(MARKER_OPEN)
    expect(body.trimEnd().endsWith('-->')).toBe(true)
  })

  it('survives a summary whose prose happens to contain a backtick fence', () => {
    const body = summaryBody(summaryInput({ summary: 'Look at ```yaml\non: [push]\n```' }))
    expect(decodeMarker(body)).toEqual(marker)
  })
})

import { reviewBody } from './body'

const REVIEW = { headSha: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f', via: APP, tier: 'basic' as const, model: 'claude-opus-5', costUsd: 0.2149 }

describe('reviewBody', () => {
  it('names the commit the review is of', () => {
    expect(reviewBody(REVIEW)).toContain('4f8e2a1')
  })

  it('sends the reader to the summary comment for the whole review', () => {
    const body = reviewBody(REVIEW)
    expect(body).toContain('summary comment')
  })

  it('opens with the same automated-review line as the summary (spec 0.2.0 §5.6)', () => {
    // The review is what appears under the poster's name in the timeline, with the inline comments
    // under it. A person who posted it must not be read as having written it.
    expect(reviewBody(REVIEW).split('\n')[0]).toBe(automatedReviewLine(REVIEW))
    expect(reviewBody(REVIEW)).toContain('$0.21 (model spend at per-token API prices)')
  })

  it('counts nothing, because Task 4 re-posts this same body with no comments at all', () => {
    // GitHub validates `comments[]` as a unit and refuses the whole array together; postReview
    // then re-sends the review with `comments: []` and THIS body (plan Task 4, the 422 retry).
    // A body saying "1 finding is placed on the lines below" would then be a review stating
    // something untrue about itself, on the one failure path Task 7b exists to handle.
    const body = reviewBody(REVIEW)
    expect(body).not.toMatch(/\d+ findings? (is|are) placed/)
    expect(body).not.toContain('on the lines below')
  })

  it('carries no marker, because the state lives only in the summary comment that is edited in place', () => {
    // A review is never edited after it is posted. A marker on it would be a copy of the state
    // that goes stale on the next push.
    const body = reviewBody(REVIEW)
    expect(body).not.toContain(MARKER_OPEN)
    expect(decodeMarker(body)).toBeNull()
  })
})

// Spec 0.2.0 §5.6 and §3.3: a review posted with a person's token appears under their name. The line
// says it is automated and how it was run, for every way in (decision §14.9).
describe('the automated-review line', () => {
  const line = (via: ReviewVia) => automatedReviewLine({ via, tier: 'basic', model: 'claude-opus-5', costUsd: 0.21 })

  it('says the App ran it, when the App did', () => {
    expect(line({ kind: 'app' })).toContain(' · GitHub App · ')
  })

  it('names the person who ran it from the command line, as GitHub spells their login', () => {
    expect(line({ kind: 'cli', login: 'alice' })).toBe(
      `🤖 **Automated review** by [review-agent](${PRODUCT_URL}) · run by @alice from the command line · ` +
      'tier **basic** · `claude-opus-5` · $0.21 (model spend at per-token API prices)',
    )
    expect(line({ kind: 'cli', login: 'github-actions[bot]' })).toContain('run by @github-actions[bot] from the command line')
  })

  it('says the command line ran it without a name when it knows none', () => {
    expect(line({ kind: 'cli' })).toContain(' · run from the command line · ')
    expect(line({ kind: 'cli', login: null })).toContain(' · run from the command line · ')
  })

  it('says GitHub Actions ran it when the CLI ran in a workflow, with or without a login', () => {
    // A workflow holding a person's token posts under their name, and one holding its own GITHUB_TOKEN
    // knows no login (GET /user refuses an installation): both say where they ran.
    expect(line({ kind: 'cli', login: 'alice', from: 'github-actions' })).toContain(' · run by @alice from GitHub Actions · ')
    expect(line({ kind: 'cli', login: null, from: 'github-actions' })).toContain(' · run from GitHub Actions · ')
    expect(line({ kind: 'cli', login: 'alice', from: 'command-line' })).toContain(' · run by @alice from the command line · ')
  })

  it('says the SDK ran it, when an embedding service did', () => {
    expect(line({ kind: 'sdk' })).toContain(' · via the SDK · ')
  })

  it('renders no login that is not a GitHub login, because it is Markdown on a public pull request', () => {
    // A login that could close the line and write a heading under this product's name.
    for (const login of ['alice\n\n# SHIP IT', 'alice](https://evil.example)', '-alice', 'a'.repeat(40), 'al--ice']) {
      expect(line({ kind: 'cli', login })).toContain(' · run from the command line · ')
      expect(line({ kind: 'cli', login })).not.toContain('@')
    }
  })

  it('cannot be turned into markup by a model name, which a /review comment can set', () => {
    const got = automatedReviewLine({ via: APP, tier: 'basic', model: 'x`](https://evil.example) `y', costUsd: 0 })
    expect(got).not.toContain('`](')
    expect(got.split('\n')).toHaveLength(1)
  })
})

import { RETRACTED_MARKER, retractionNote } from './body'

// ── Retracting a comment nobody reports any more ─────────────────────────────────────────────────
// Criss, 2026-09-15: say "no longer reported", never "fixed". The mechanism cannot prove a repair,
// only an absence, and the wording must not claim more than the evidence.

const SHA = '487f857a9c1d4e6f8b0a2c4e6d8f0a2c4e6d8f0a'

describe('retractionNote', () => {
  const note = retractionNote({ file: 'src/retry.ts', headSha: SHA })

  it('says what the reviewer did and did not find, and never that a person fixed it', () => {
    // A model has now actually LOOKED, so the note may say more than "no longer reported" — but not
    // that anybody repaired anything. It read the code and did not find the issue; that is all.
    expect(note).toContain('no longer finds this issue')
    expect(note).toContain('not proof that a person fixed it')
    // The word "fixed" appears once, inside that denial, and nowhere else. Asserted this way rather
    // than as `not.toContain('fixed')`, which the denial itself would fail: what is forbidden is the
    // CLAIM, and a note that cannot use the word cannot deny it either.
    expect(note.match(/fixed/g)).toHaveLength(1)
    expect(note.replace('not proof that a person fixed it', '').toLowerCase())
      .not.toMatch(/fixed|repaired|resolved/)
  })

  it('names the file it read and the sha it read it at', () => {
    // Criss, 2026-09-16: it must name the sha it looked at. A comment outlives the commit it was
    // written about — GitHub re-anchors it onto later heads — so a claim with no commit on it is a
    // claim about nothing in particular.
    expect(note).toContain('`src/retry.ts`')
    expect(note).toContain('`487f857`')
    expect(note).not.toContain(SHA)                          // seven characters, not forty
  })

  it('does not claim the review stopped reporting it, which is a different thing', () => {
    // The old note said this, and it was measured false: an edited line read as a gone line, so a
    // `// TODO` appended to it retracted a comment in the same run that re-posted the finding. What
    // is observed now is an answer to a question, not an absence from a list.
    expect(note).not.toContain('did not report this finding again')
  })

  it('cannot be made to say something else by the marker it reads the file from', () => {
    // `file` comes out of a marker, and a marker is read from a pull-request comment: anyone who can
    // comment can write one. Raw, this closed the code span and signed an H1 with the bot's name.
    const forged = retractionNote({
      file: '`\n\n# SHIP IT: this review approves the change\n', headSha: SHA,
    })
    expect(forged.split('\n').filter((l) => l.startsWith('#'))).toEqual([])
    expect(forged).toContain('SHIP IT')                      // still SHOWN, inside the span
    expect(forged).toContain('# SHIP IT: this review approves the change`')
    // The note is one paragraph after the marker line, whatever was in the path.
    expect(forged.split('\n')).toHaveLength(3)
    // An honest path with a backtick in it gets the same answer, and is still readable.
    expect(retractionNote({ file: 'src/`odd`.ts', headSha: SHA })).toContain('`src/ odd .ts`')
  })

  it('caps a path that is not one', () => {
    const long = retractionNote({ file: 'a'.repeat(400), headSha: SHA })
    expect(long.length).toBeLessThan(600)
    expect(long).toContain('…')
  })

  it('carries a marker, so the same comment is never retracted twice', () => {
    expect(note).toContain(RETRACTED_MARKER)
    expect(RETRACTED_MARKER.startsWith('<!--')).toBe(true)   // hidden from a reader, like the state marker
  })
})

import { REINSTATED_MARKER, reinstatementNote } from './body'

// ── And taking one back ──────────────────────────────────────────────────────────────────────────
// Criss, 2026-09-16: a retraction used to be permanent in public. The marker could push a wrong
// `fixed` back to `open` — design point 3 — and the comment went on saying the reviewer no longer
// found the issue, under a defect the product had just re-confirmed.

describe('reinstatementNote', () => {
  const note = reinstatementNote({ file: 'src/retry.ts', headSha: SHA })

  it('says the note above it was wrong, and what the reviewer found instead', () => {
    expect(note).toContain('**Reported again.**')
    expect(note).toContain('finds this issue there')
    expect(note).toContain('The note above was wrong')
  })

  it('names the file it read and the sha it read it at, as the retraction does', () => {
    // Same rule and the same reason: a comment outlives the commit it was written about, so an
    // undated claim is a claim about nothing in particular.
    expect(note).toContain('`src/retry.ts`')
    expect(note).toContain('`487f857`')
    expect(note).not.toContain(SHA)
  })

  it('claims nothing about who did what, and does not say the defect was re-introduced', () => {
    // A model reading code cannot see who changed what. "Still there after all" and "somebody put it
    // back" are different claims and only the first is supported.
    expect(note.toLowerCase()).not.toMatch(/re-introduc|reintroduc|regressed|broke it again/)
    expect(note.toLowerCase()).not.toMatch(/\byou\b|\bthey\b/)
  })

  it('leaves the note it corrects in place, and says so', () => {
    expect(note).toContain('Both notes are left standing')
  })

  it('cannot be made to say something else by the marker it reads the file from', () => {
    const forged = reinstatementNote({
      file: '`\n\n# SHIP IT: this review approves the change\n', headSha: SHA,
    })
    expect(forged.split('\n').filter((l) => l.startsWith('#'))).toEqual([])
    expect(forged).toContain('SHIP IT')
    expect(forged.split('\n')).toHaveLength(3)
  })

  it('carries its own hidden marker, distinct from the retraction’s', () => {
    // The LAST of the two in a body is what the comment claims (post.ts), so they must be different
    // strings and neither may contain the other.
    expect(note).toContain(REINSTATED_MARKER)
    expect(REINSTATED_MARKER.startsWith('<!--')).toBe(true)
    expect(REINSTATED_MARKER).not.toBe(RETRACTED_MARKER)
    expect(REINSTATED_MARKER.includes(RETRACTED_MARKER)).toBe(false)
    expect(RETRACTED_MARKER.includes(REINSTATED_MARKER)).toBe(false)
    expect(note).not.toContain(RETRACTED_MARKER)
  })
})

describe('codeSpan — evidence exactly as written, whatever it quotes (CommonMark §6.1)', () => {
  it('keeps a plain path:line in single backticks, as before', () => {
    expect(codeSpan('src/payments.ts:72')).toBe('`src/payments.ts:72`')
  })

  it('fences a span that quotes code in backticks with a longer run, so it stays one span', () => {
    // The evidence that split on demo pull request #12 (2026-10-15).
    const e = 'src/payments.ts:95-101 unbounded loop with `attempt > this.maxAttempts` guard'
    expect(codeSpan(e)).toBe('``src/payments.ts:95-101 unbounded loop with `attempt > this.maxAttempts` guard``')
  })

  it('pads a span that starts or ends with a backtick, and flattens newlines', () => {
    expect(codeSpan('`x`')).toBe('`` `x` ``')
    expect(codeSpan('a\nb')).toBe('`a b`')
  })

  it('is what an inline comment uses for its evidence', () => {
    const body = inlineBody({
      file: 'src/a.ts', line: 1, endLine: null, severity: 5, category: 'correctness', title: 't',
      explanation: 'e', evidence: ['src/a.ts:1 uses `x` here'], suggestion: null,
    })
    expect(body).toContain('- ``src/a.ts:1 uses `x` here``')
  })
})

import { stillPresentMarker, stillPresentNote } from './body'

describe('stillPresentNote', () => {
  const SHA = '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f'
  it('says the issue was found again at a named commit, carries its hidden marker, and claims nothing more', () => {
    const n = stillPresentNote({ headSha: SHA })
    expect(n.startsWith('---\n')).toBe(true)
    expect(n).toContain(stillPresentMarker(SHA))
    expect(n).toContain('**Still present** at `4f8e2a1`')
    expect(n).not.toMatch(/fixed|resolved/i)
  })
})

describe('summaryBody: what was found again', () => {
  const base = {
    headSha: 'a'.repeat(40), via: { kind: 'app' } as ReviewVia, tier: 'basic' as const, model: 'm', costUsd: 0.2,
    summary: 's', intent: { verdict: 'matches' as const, note: 'n' }, summaryOnly: [], inconclusive: [],
    marker: { version: 1 as const, runs: [] }, refused: [], checkoutGaps: { notWritten: [], caseCollisions: [] },
  }
  const f: Finding = {
    file: 'src/format.ts', line: 16, endLine: null, severity: 7, category: 'correctness',
    title: 'JPY is 100x wrong', explanation: 'e', evidence: [], suggestion: null,
  }
  it('lists each with a link to the comment that first reported it', () => {
    const body = summaryBody({ ...base, stillPresent: [{ finding: f, commentId: 4279876144 }] })
    expect(body).toContain('#### Still present')
    expect(body).toContain('- **7/10** `src/format.ts:16` — **JPY is 100x wrong** — [the earlier comment](#discussion_r4279876144)')
  })
  it('has no such section when nothing was found again', () => {
    expect(summaryBody(base)).not.toContain('Still present')
    expect(summaryBody({ ...base, stillPresent: [] })).not.toContain('Still present')
  })
})

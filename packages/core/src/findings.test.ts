import { describe, expect, it } from 'vitest'
import { readFixture } from '../test/fixture'
import { ParseError, parseReviewOutput, reviewJsonSchema } from './findings'

const structuredOutput = (fixture: string): unknown =>
  (readFixture(`cli/${fixture}`) as { structured_output: unknown }).structured_output

describe('parseReviewOutput', () => {
  it('parses an Opus-low review in the shape the CLI emits', () => {
    const out = parseReviewOutput(structuredOutput('success-opus-low.json'))

    expect(out.intent.verdict).toBe('matches')
    expect(out.findings).toHaveLength(4)
    expect(out.inconclusive).toHaveLength(2)
    expect(out.findings[0]).toMatchObject({
      file: 'src/cache/lru.ts',
      line: 61,
      endLine: null,
      severity: 5,
      category: 'correctness',
    })
    expect(typeof out.findings[0].suggestion).toBe('string')
    expect(out.inconclusive[0].whatWouldSettleIt).toContain('Running')
  })

  // Design §4.5: a measured run failed because the model wrote `null` where the schema demanded a
  // string. `success-null-suggestion.json` is a review in which every one of the five findings has
  // `"suggestion": null` and none has an `end_line` key at all — the shape that run produced.
  it('accepts a null suggestion and a missing end_line', () => {
    const out = parseReviewOutput(structuredOutput('success-null-suggestion.json'))

    expect(out.findings).toHaveLength(5)
    expect(out.findings.map((f) => f.suggestion)).toEqual([null, null, null, null, null])
    expect(out.findings.map((f) => f.endLine)).toEqual([null, null, null, null, null])
  })

  it('keeps an end_line the model did supply', () => {
    const out = parseReviewOutput(structuredOutput('success-end-line.json'))

    expect(out.findings).toHaveLength(2)
    expect(out.findings[0]).toMatchObject({ line: 49, endLine: 54, suggestion: null })
    expect(out.findings[1]).toMatchObject({ line: 49, endLine: 57, suggestion: null })
  })
})

const valid = () => ({
  summary: 's',
  intent: { verdict: 'matches', note: 'n' },
  findings: [
    { file: 'a.ts', line: 1, severity: 5, category: 'correctness',
      title: 't', explanation: 'e', evidence: ['a.ts:1'] },
  ],
  inconclusive: [],
})

describe('parseReviewOutput rejections', () => {
  it('throws ParseError carrying the raw value', () => {
    const raw = { nonsense: true }
    expect(() => parseReviewOutput(raw)).toThrow(ParseError)
    try {
      parseReviewOutput(raw)
    } catch (e) {
      expect((e as ParseError).raw).toBe(raw)
      expect((e as ParseError).message).toContain('summary')
    }
  })

  it.each([0, 11, 5.5])('rejects severity %s', (severity) => {
    const raw = valid()
    raw.findings[0].severity = severity
    expect(() => parseReviewOutput(raw)).toThrow(ParseError)
  })

  it('rejects an unknown category', () => {
    const raw = valid()
    raw.findings[0].category = 'style'
    expect(() => parseReviewOutput(raw)).toThrow(ParseError)
  })

  it('ignores fields the model invented', () => {
    const raw = valid()
    ;(raw.findings[0] as Record<string, unknown>).confidence = 0.9
    expect(parseReviewOutput(raw).findings[0]).not.toHaveProperty('confidence')
  })
})

type JsonSchema = {
  properties: {
    findings: {
      maxItems?: number
      items: { properties: Record<string, unknown>; required: string[] }
    }
  }
}

describe('reviewJsonSchema', () => {
  // This is the schema handed to `claude -p --json-schema`. The only recorded schema failure in the
  // measurement set (test/fixtures/cli/failure-schema.json, subtype
  // "error_max_structured_output_retries") came from demanding a string where the model wanted to
  // write null. These two assertions are what stops that returning.
  it('lets the model write null for end_line and suggestion', () => {
    const finding = (reviewJsonSchema() as JsonSchema).properties.findings.items
    expect(finding.properties.end_line).toEqual({ type: ['integer', 'null'] })
    expect(finding.properties.suggestion).toEqual({ type: ['string', 'null'] })
  })

  it('lets the model omit end_line and suggestion entirely', () => {
    const finding = (reviewJsonSchema() as JsonSchema).properties.findings.items
    expect(finding.required).toEqual([
      'file', 'line', 'severity', 'category', 'title', 'explanation', 'evidence',
    ])
  })

  // `maxFindings` caps how many findings the MODEL may return. It is a different number from
  // `report.maxInline`, which caps how many inline comments GitHub gets: see Task 3.
  it('caps the findings array only when asked', () => {
    expect((reviewJsonSchema() as JsonSchema).properties.findings.maxItems).toBeUndefined()
    expect((reviewJsonSchema({ maxFindings: 50 }) as JsonSchema).properties.findings.maxItems)
      .toBe(50)
  })

  it('returns a fresh object each call', () => {
    const a = reviewJsonSchema()
    const b = reviewJsonSchema()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})

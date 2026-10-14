import { z } from 'zod'

export type Severity = number
export type Category = 'intent' | 'correctness' | 'impact' | 'security'
export type Finding = {
  file: string
  line: number
  endLine: number | null
  severity: Severity
  category: Category
  title: string
  explanation: string
  evidence: string[]
  suggestion: string | null
}
export type Inconclusive = { question: string; whatWouldSettleIt: string }
export type IntentVerdict = 'matches' | 'partial' | 'diverges' | 'unclear'
export type ReviewOutput = {
  summary: string
  intent: { verdict: IntentVerdict; note: string }
  findings: Finding[]
  inconclusive: Inconclusive[]
}

export class ParseError extends Error {
  readonly raw: unknown
  constructor(message: string, raw: unknown) {
    super(message)
    this.name = 'ParseError'
    this.raw = raw
  }
}

const CATEGORIES = ['intent', 'correctness', 'impact', 'security'] as const
const VERDICTS = ['matches', 'partial', 'diverges', 'unclear'] as const

const wireFinding = z.object({
  file: z.string().min(1),
  line: z.number().int().min(0),
  end_line: z.number().int().nullish(),
  severity: z.number().int().min(1).max(10),
  category: z.enum(CATEGORIES),
  title: z.string().min(1),
  explanation: z.string(),
  evidence: z.array(z.string()).default([]),
  suggestion: z.string().nullish(),
})

const wireOutput = z.object({
  summary: z.string(),
  intent: z.object({ verdict: z.enum(VERDICTS), note: z.string() }),
  findings: z.array(wireFinding).default([]),
  inconclusive: z
    .array(z.object({ question: z.string(), what_would_settle_it: z.string() }))
    .default([]),
})

export const parseReviewOutput = (raw: unknown): ReviewOutput => {
  const parsed = wireOutput.safeParse(raw)
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new ParseError(`review output did not match the findings schema — ${why}`, raw)
  }
  const d = parsed.data
  return {
    summary: d.summary,
    intent: d.intent,
    findings: d.findings.map((f) => ({
      file: f.file,
      line: f.line,
      endLine: f.end_line ?? null,
      severity: f.severity,
      category: f.category,
      title: f.title,
      explanation: f.explanation,
      evidence: f.evidence,
      suggestion: f.suggestion ?? null,
    })),
    inconclusive: d.inconclusive.map((i) => ({
      question: i.question,
      whatWouldSettleIt: i.what_would_settle_it,
    })),
  }
}

/** The schema handed to `claude -p --json-schema`. It is the schema that was measured on
 *  2026-09-12 (spike/review-schema.json), unchanged, plus an optional cap on the findings array.
 *  Deliberately no `additionalProperties: false` anywhere: the measured schema had none and
 *  produced valid output on every successful run, and the one schema failure in the set came from
 *  a schema that was too strict, not too loose. Unknown keys are dropped by `parseReviewOutput`
 *  instead, where dropping them costs nothing. */
export const reviewJsonSchema = (opts?: { maxFindings?: number }): object => ({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    intent: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: [...VERDICTS] },
        note: { type: 'string' },
      },
      required: ['verdict', 'note'],
    },
    findings: {
      type: 'array',
      ...(opts?.maxFindings === undefined ? {} : { maxItems: opts.maxFindings }),
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          end_line: { type: ['integer', 'null'] },
          severity: { type: 'integer', minimum: 1, maximum: 10 },
          category: { type: 'string', enum: [...CATEGORIES] },
          title: { type: 'string' },
          explanation: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          suggestion: { type: ['string', 'null'] },
        },
        required: [
          'file', 'line', 'severity', 'category', 'title', 'explanation', 'evidence',
        ],
      },
    },
    inconclusive: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          what_would_settle_it: { type: 'string' },
        },
        required: ['question', 'what_would_settle_it'],
      },
    },
  },
  required: ['summary', 'intent', 'findings', 'inconclusive'],
})

import { z } from 'zod'
import { budgetFor } from './budget'
import { parseUsage } from './cli-process'
import { runClaude, type EngineInput, type Usage } from './engine'
import type { Finding, Severity } from './findings'
import { checkPassSystemPrompt } from './prompt'

export type CheckVerdict = {
  index: number
  verdict: 'confirmed' | 'refuted' | 'uncertain'
  severity: Severity
  reason: string
  evidence: string[]
  /** On a multi-reviewer review only (spec 0.2.0 §8.3, decision §14.17): the index of an EARLIER
   *  finding in the same list that this one repeats, or null when it repeats none. A finding with a
   *  number here is not said — `duplicatesIn` in github's report.ts — and stays on the record.
   *  Absent on a review by one reviewer, whose check pass is never asked: its verdicts are
   *  what they were before 0.2.0, key for key. */
  duplicateOf?: number | null
}

// The verifier prompt is NOT defined here. Task 4b owns every prompt the product ships, versions
// them together and records the version on each review (design §4.7). Two copies of the measured
// text would put that version out of step with what actually ran — and this copy had already
// drifted: it dropped the spike's severity scale line and merged its last paragraph.

/** `duplicate_of` is in the schema only when the pass is asked to mark duplicates, so the schema a
 *  single-reviewer review sends on the command line is the measured one, unchanged. Optional even
 *  then: a verdict that leaves it out costs that finding nothing — it is simply not a duplicate. */
const checkJsonSchema = (markDuplicates: boolean): object => ({
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
          severity: { type: 'integer', minimum: 1, maximum: 10 },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          ...(markDuplicates && { duplicate_of: { type: ['integer', 'null'] } }),
        },
        required: ['index', 'verdict', 'severity', 'reason', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
})

const verdictsSchema = z.looseObject({
  verdicts: z.array(z.object({
    index: z.number().int(),
    verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
    severity: z.number().int().min(1).max(10),
    reason: z.string(),
    evidence: z.array(z.string()).default([]),
    // Anything that is not a whole number is no answer, not a broken document: one bad field must
    // not cost the other verdicts. Read only when the pass was asked (below).
    duplicate_of: z.unknown().optional(),
  })).default([]),
})

/** The check costs a quarter of the review's target: measured $0.07–0.63 against $0.88–1.67. */
const CHECK_BUDGET_FRACTION = 0.25

const emptyUsage = (): Usage => ({
  costUsd: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, durationMs: 0,
})

const checkPrompt = (prompt: string, findings: Finding[]): string =>
  `${prompt}\n\n## Findings to verify (index = position in this list, from 0)\n` +
  '```json\n' + JSON.stringify(findings, null, 2) + '\n```\n\nVerify each finding.\n'

/** A `duplicate_of` the rest of the product may act on: a whole number naming a finding EARLIER in
 *  the list than the one it is about. Later or equal would let two findings name each other, and
 *  then neither would be said; out of range would name nothing. Anything else is "not a duplicate",
 *  which is the answer that says more, never less. */
const earlierIndex = (raw: unknown, self: number): number | null =>
  typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < self ? raw : null

export const runCheckPass = async (a: {
  findings: Finding[]; input: EngineInput
  /** How many focused reviewers' findings are in `findings`, on a multi-reviewer review (spec 0.2.0
   *  §8.3) — counted as the focuses that reported at least one. Left out on a review by one reviewer,
   *  which is the pass as measured. Given, the pass is also asked to mark duplicates, and its budget
   *  is the usual one times this number (below). */
  focuses?: number
}): Promise<{ verdicts: CheckVerdict[]; usage: Usage }> => {
  if (a.findings.length === 0) return { verdicts: [], usage: emptyUsage() }

  const multi = a.focuses !== undefined
  // The usual quarter of the tier's target, times the number of focuses that reported anything (spec
  // 0.2.0 §8.3). The check pass's bill follows what it has to read against the code — the findings —
  // and each focus hands it about one reviewer's worth: the one multi-reviewer trial checked 7
  // findings from two focuses (spec 0.2.0 §8.3), where the most a single measured reviewer returned
  // was 5 (config.ts, `maxFindings`). One reviewer's check budget over three reviewers' findings would
  // stop at its ceiling, and a check pass that stops with nothing says nothing: every finding would
  // then be posted at the reviewer's own severity, the failure design §4.6 exists to prevent. A focus
  // that reported nothing adds nothing to read, so it adds no budget. The ceiling follows as ever:
  // `budgetFor` makes it 2.5x this target.
  const scale = a.focuses !== undefined && Number.isFinite(a.focuses) ? Math.max(1, Math.trunc(a.focuses)) : 1
  const budget = budgetFor({
    agents: 1,
    effort: a.input.settings.effort,
    check: false,
    budgetUsd: a.input.settings.budget.targetUsd * CHECK_BUDGET_FRACTION * scale,
  })

  const input: EngineInput = {
    ...a.input,
    prompt: checkPrompt(a.input.prompt, a.findings),
    systemPrompt: checkPassSystemPrompt({ markDuplicates: multi }),
    schema: checkJsonSchema(multi),
    settings: { ...a.input.settings, budget },
  }

  // runClaude, not a second spawn: the check reads the same PR-authored code, so it gets the same
  // lock-down, the same tool set, the same skills and the same runtime (`buildArgv`, and the review's
  // credential), by construction rather than by remembering to. It also inherits the budget sentence
  // (Task 7) — with this pass's own smaller target in it. This pass's guard is its own ceiling.
  const run = await runClaude(input)
  const envelope = (run.envelope ?? {}) as Record<string, unknown>
  const parsed = verdictsSchema.safeParse(envelope.structured_output ?? {})
  const raw = parsed.success ? parsed.data.verdicts : []

  // A model can index findings that do not exist, or index one twice. Both happened often enough
  // in measurement to be worth handling here rather than in whatever posts the result: an index
  // out of range would otherwise attach a verdict to the wrong finding, or to none.
  const seen = new Set<number>()
  const verdicts = raw.filter((v) => {
    if (v.index < 0 || v.index >= a.findings.length) return false
    if (seen.has(v.index)) return false
    seen.add(v.index)
    return true
  }).map(({ duplicate_of, ...v }): CheckVerdict =>
    // Only when asked: a single reviewer's verdicts keep their measured shape, and a `duplicate_of`
    // a model volunteers unasked suppresses nothing.
    multi ? { ...v, duplicateOf: earlierIndex(duplicate_of, v.index) } : v)

  return { verdicts, usage: parseUsage(run.envelope) }
}

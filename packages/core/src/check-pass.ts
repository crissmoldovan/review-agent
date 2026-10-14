import { z } from 'zod'
import { budgetFor } from './budget'
import { parseUsage, spawnClaude } from './cli-process'
import { buildArgv, type EngineInput, type Usage } from './engine'
import type { Finding, Severity } from './findings'
import { checkPassSystemPrompt } from './prompt'

export type CheckVerdict = {
  index: number
  verdict: 'confirmed' | 'refuted' | 'uncertain'
  severity: Severity
  reason: string
  evidence: string[]
}

// The verifier prompt is NOT defined here. Task 4b owns every prompt the product ships, versions
// them together and records the version on each review (design §4.7). Two copies of the measured
// text would put that version out of step with what actually ran — and this copy had already
// drifted: it dropped the spike's severity scale line and merged its last paragraph.

const checkJsonSchema = {
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
        },
        required: ['index', 'verdict', 'severity', 'reason', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
}

const verdictsSchema = z.looseObject({
  verdicts: z.array(z.object({
    index: z.number().int(),
    verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
    severity: z.number().int().min(1).max(10),
    reason: z.string(),
    evidence: z.array(z.string()).default([]),
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

export const runCheckPass = async (a: {
  findings: Finding[]; input: EngineInput
}): Promise<{ verdicts: CheckVerdict[]; usage: Usage }> => {
  if (a.findings.length === 0) return { verdicts: [], usage: emptyUsage() }

  const budget = budgetFor({
    agents: 1,
    effort: a.input.settings.effort,
    check: false,
    budgetUsd: a.input.settings.budget.targetUsd * CHECK_BUDGET_FRACTION,
  })

  const input: EngineInput = {
    ...a.input,
    prompt: checkPrompt(a.input.prompt, a.findings),
    systemPrompt: checkPassSystemPrompt(),
    schema: checkJsonSchema,
    settings: { ...a.input.settings, budget },
  }

  // buildArgv, not a second flag list: the check reads the same PR-authored code, so it gets the
  // same lock-down, the same tool set and the same skills, by construction rather than by
  // remembering to. It also inherits the budget sentence (Task 7) — with this pass's own smaller
  // target in it. This pass's guard is its own ceiling.
  const run = await spawnClaude({
    argv: buildArgv(input), prompt: input.prompt, cwd: input.checkoutDir, signal: input.signal,
  })
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
  })

  return { verdicts, usage: parseUsage(run.envelope) }
}

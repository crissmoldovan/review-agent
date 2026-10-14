import type { ResolvedSettings } from '../../src/config'
import type { EngineInput } from '../../src/engine'

export const settingsFixture = (over: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
  tier: 'basic',
  model: 'claude-opus-5',
  effort: 'low',
  check: false,
  multi: false,
  budget: { targetUsd: 2, wrapUpAtUsd: 1.4, ceilingUsd: 5 },
  report: {
    mode: 'inline+summary',
    maxInline: 15,
    maxFindings: 50,
    repeatNits: false,
    firstReviewLowBandCap: 3,
    checkRunName: 'review-agent',
    failAtOrAbove: null,
    gateRequiresConfirmed: false,
  },
  severity: { bands: { critical: 9, high: 7, medium: 4 }, postInlineAtOrAbove: 5 },
  skills: [],
  deploymentInstructions: null,
  instructions: null,
  brief: null,
  droppedRequestKeys: [],
  ...over,
})

export const inputFixture = (over: Partial<EngineInput> = {}): EngineInput => ({
  checkoutDir: '/tmp/checkout',
  prompt: 'Review this pull request.',
  systemPrompt: 'You are the Acme PR reviewer.',
  settings: settingsFixture(),
  schema: { type: 'object', properties: { summary: { type: 'string' } } },
  skillDirs: [],
  ...over,
})

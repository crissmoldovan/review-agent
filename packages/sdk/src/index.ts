// @review-agent/sdk — the review, as one call a host makes from its own code (spec 0.2.0 §4).
export { reviewPullRequest } from './review'
export type {
  AuthorizeRequest, CredentialOption, GitHubAccess, MultiOption, ReviewOptions, ReviewSettings,
} from './options'
export type {
  FailedResult, PostedSummary, RefusedResult, ReportResult, ReviewedResult, ReviewResult, UnfinishedResult,
} from './result'
export type { NoteEvent, ProgressEvent, ProgressStage, StageEvent } from './progress'

// The few names a host needs beside the call, so it need not depend on the packages underneath:
// the App's own gate for `authorize`, the settings and their defaults, a wrapper for a credential it
// holds, and the types its results are made of.
export {
  DEFAULT_SESSION_DEADLINE_MS, pushAccessOf,
  type CheckConclusion, type PostedComment, type PublishCounts, type ReportKind, type ReportWant,
  type SessionStage, type StoppedBy,
} from '@review-agent/github'
export {
  defaultDeploymentConfig, SecretValue,
  type DeploymentConfig, type Effort, type Finding, type Lens, type ReportMode, type ReviewRecord, type Tier,
  type Usage,
} from '@review-agent/core'

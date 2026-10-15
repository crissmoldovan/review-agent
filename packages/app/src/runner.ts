/** `@review-agent/app/runner`: the App's review, in process, for a deployment that hosts its runner
 *  somewhere other than trigger.dev (spec 0.2.0 §3.1, §7) — a queue worker, a container, a VPS. It is
 *  the code the deployed `review-agent-review` task runs: the App token for one repository, the
 *  release-only skip, the push-access gate for a requested review, and the review session every way
 *  in shares, reported with a check run.
 *
 *  It holds the App's identity — it mints installation tokens — so, like the package root, it is the
 *  runner's half and never the receiver's (`src/boundary.test.ts`). And it never loads
 *  `@trigger.dev/sdk`, at import or at run time: nothing reachable from here imports it, which
 *  `src/runner-boundary.test.ts` holds over the source and `test/publishing.test.ts` over the
 *  published bundle. */
export { runReviewJob, runnerDeployment, runnerRecordCallback } from './tasks/review-job'
export {
  DEFAULT_DEADLINE_MS, DoNotRetry, RetryThis,
  type ReviewTaskResult,
} from './tasks/review-run'
export type { AppIdentity } from './credentials'

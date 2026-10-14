# @review-agent/app

The GitHub App half of [review-agent](https://github.com/crissmoldovan/review-agent), an AI pull-request reviewer you run inside your own environment.

- **`@review-agent/app/receiver`** — what your webhook endpoint needs: `verifyDelivery`, `decideDelivery`,
  `dispatchReview` and `sdkTriggerPort`. It cannot reach the App's private key, so it is safe in an
  internet-facing process.
- **`@review-agent/app`** — the App's manifest, credentials and installation tokens, for the runner.

A complete receiver, and how to deploy the runner: [Deploying](https://github.com/crissmoldovan/review-agent/blob/main/docs/deploying.md).
Every export: [the library reference](https://github.com/crissmoldovan/review-agent/blob/main/docs/library.md).

Apache-2.0.

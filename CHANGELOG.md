# Changelog

All four packages — `@review-agent/core`, `@review-agent/github`, `@review-agent/app` and `@review-agent/cli` — are
released together, at the same version.

## 0.1.3

### Fixed

- **The downloaded code is deleted after every review.** Before, each review left a full copy of the reviewed
  repository in the system's temp directory, and nothing removed it — on a laptop, a CI runner or a long-running
  server, copies of every repository ever reviewed. Now the CLI deletes it once the review is printed, the App's
  runner once the review is published, and a review that fails deletes it at once.
- On Windows: a JavaScript entry point given as `REVIEW_AGENT_CLAUDE_BIN` is run with Node (Windows cannot start a
  script by its first line), no console window flashes up, and the CLI's build no longer needs a Unix shell.

### Security

- `0.1.0` and `0.1.1` of all four packages are **deprecated** on npm, pointing to `0.1.2`, and the Windows issue fixed
  in `0.1.2` is published as [GHSA-m34m-4c65-cqf6](https://github.com/crissmoldovan/review-agent/security/advisories/GHSA-m34m-4c65-cqf6).
- A [security policy](SECURITY.md): how to report a vulnerability privately, and what is in scope.

### Repository

- Continuous integration on every pull request: build, typecheck and every test on Linux (Node 22 and 24) and macOS;
  Windows runs too, reported but not yet required.
- The original v0 design record is published as [docs/design.md](docs/design.md), so the code's "design §N"
  references resolve. Comments no longer point at documents that are not in this repository.

## 0.1.2

### Security

- **Claude Code is now started by an absolute path that cannot be inside the code under review.** Before, the
  reviewer started it by the bare name `claude`, leaving the lookup to the operating system. **On Windows that lookup
  searches the working directory first** — and the working directory is the downloaded pull request — so a pull
  request that added a `claude.exe` at its root would have been run instead of Claude Code, **with the model
  credential in its environment**. On Linux and macOS the same happened only if `PATH` contained an empty or `.` entry.
  The GitHub App's runner was not affected: it sets `REVIEW_AGENT_CLAUDE_BIN` to an absolute path.

  Now the reviewer finds Claude Code itself: `REVIEW_AGENT_CLAUDE_BIN` if set (it must be absolute and outside the
  checkout, or the review is refused), otherwise the first `claude` — `claude.exe` on Windows — in an **absolute**
  `PATH` directory that is not inside the checkout. Empty and relative `PATH` entries are skipped.

  **If you ran `review-agent review` on Windows against a pull request you did not trust, rotate the Anthropic
  credential it used.**

- On Windows only `claude.exe` is run, as installed by Anthropic's installer or WinGet; an npm install's `.cmd` shim is
  not, because running it needs a shell that would not escape the reviewer's arguments.

## 0.1.1

### Re-reviews ask the model instead of guessing

`0.1.0` decided whether an earlier finding had been fixed by matching it against the new review by its wording —
which the model rewrites between runs, so live defects could be marked fixed. An unreleased second attempt matched by
the source line the finding pointed at, and missed a repair that wrapped a line instead of deleting it. Comparing two
snapshots cannot answer the question, so `0.1.1` asks.

- **A re-review pass.** On a later review of a pull request, a third Claude Code process is given the earlier
  findings and asked, for each, whether it is still present in the code as it stands: `still-present`, `resolved` or
  `cannot-tell`. It has its own budget (a quarter of the review's) and runs only when that fits under the review's
  ceiling. A first review never pays for it.
- **Answers are checked.** Each answer must name the file of the finding it answers, or it is discarded; of two
  answers to one finding, the more cautious stands.
- **"No longer reported."** The inline comment of a finding judged resolved is edited, appending a note that names
  the commit read and does not claim anyone fixed anything. If a later review finds the problem again, **"Reported
  again"** is appended below it. Comments are only ever appended to.
- **People outrank the model.** A `/dispute` or `/defer` reply applies to every thread of that finding, and a finding
  someone answered is not put to the model again.
- Review instructions are now version `1.1.1` (was `1.0.0`).
- Markers written by `0.1.0` are still read.

> The re-review pass is covered by unit tests and has not yet run against a live model.

### Runner

- **Up to three attempts per run.** trigger.dev now retries a crashed, evicted or stalled attempt. A run that dies
  after the model has spent can therefore be paid for up to three times. A failure that spent nothing still starts a
  fresh run, as before.
- **A retried attempt closes the check run its predecessor left `in_progress`**, by id, before opening its own.
- **Settings from the environment, not from source:** the record callback (`REVIEW_AGENT_RECORD_URL`,
  `REVIEW_AGENT_RECORD_SECRET_ENV`) and the hourly sweep's repositories (`REVIEW_AGENT_SWEEP_TARGETS`). Unset means
  what it meant before: no record is sent, no sweep runs. Malformed sweep targets fail the sweep visibly.

### The review record and its callback

Additive: the callback envelope stays `version: 1` and the record `recordVersion: 1`.

- `result.comments`: each inline comment this review posted, as `{ findingId, file, line, commentId }`, so a reply —
  which carries only the id of the comment it answers — can be matched to its finding.
- `result.counts` gains `retracted`, `reinstated` and `retractionsWithheld`.
- The record gains `recheckUsage`, `recheckJudgements` and `recheckSkipped`; `costUsd` now includes the re-review
  pass.

### Documentation

A new README and a full reference in `docs/`: the CLI, using it on pull requests, configuration, the GitHub App,
deploying, how it works, the security model and the library.

## 0.1.0 — 2026-09-15

First release.

- **The engine** (`core`): runs Claude Code headless and read-only over a checkout of the whole repository; findings
  with severity, category, evidence and suggestions; an intent verdict and inconclusive items; a check pass that
  tries to disprove each finding; tiers, soft budgets and hard ceilings; a secret scan of the output; the review
  record.
- **GitHub** (`github`): reads a pull request, downloads it as an archive with credential files removed, reads
  `.review-agent/review.md` from the base branch, places findings on diff lines, posts a summary comment, inline
  comments with suggestions, and a check run with an optional gate; keeps re-review state in a hidden marker.
- **The App** (`app`): the manifest, App credentials and per-repository installation tokens, the webhook receiver
  library (`@review-agent/app/receiver`), and the trigger.dev tasks — the review and an hourly sweep of abandoned
  check runs.
- **The CLI** (`cli`): `review-agent review` (read-only, prints the review) and `review-agent init` (registers the
  App through GitHub's manifest flow, keeping no secret).

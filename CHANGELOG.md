# Changelog

All five packages — `@review-agent/core`, `@review-agent/github`, `@review-agent/app`, `@review-agent/cli` and
`@review-agent/sdk` — are released together, at the same version (the SDK from 0.2.0).

## 0.2.1 — 2026-10-15

- **Installing the CLI no longer pulls in trigger.dev.** `@trigger.dev/sdk` — and the 18 advisories `npm audit`
  reported through it (17 moderate, 1 high, in its WebSocket and OpenTelemetry dependencies; still present in its
  latest release) — came with `@review-agent/cli` and `@review-agent/app`, though only a receiver using
  `sdkTriggerPort` needs it. It is now an **optional peer** of both: nothing installs it for you. A receiver that
  calls `sdkTriggerPort` installs it itself (`npm install @trigger.dev/sdk`), and gets a sentence naming that fix if
  it has not. The App's trigger.dev runner is unchanged.
- **The SDK has run for real**, installed from npm: a print-only review and a posted one on the demo repository.

## 0.2.0 — 2026-10-15

**Three ways in, one review.** The reviewer now runs the same review session whichever way it is asked: the **GitHub
App** (as before), the **CLI** — which can now **post as you**, using your GitHub CLI login — and a new **SDK**,
`@review-agent/sdk`, that you embed and pass your own keys to. Plus a **multi-reviewer mode** (`--multi`), a
`thorough` tier that works everywhere, **Windows** support tested in CI, and task-by-task [guides](docs/guides/README.md)
built from real captured reviews of a [public demo repository](https://github.com/crissmoldovan/review-agent-demo).
The design is in [docs/specs/0.2.0-ways-in.md](docs/specs/0.2.0-ways-in.md).

**Run for real before this release** (2026-10-15, on the demo repository, model spend at per-token API prices):
`basic`, `normal` and `thorough` reviews; a `--multi` review; posting as yourself with a commit status; and the
**re-review pass**, for the first time against a live model — a repair that wrapped the faulty line was judged
resolved and its comment marked "No longer reported". The real Claude Code runs on Linux, macOS and Windows in CI at $0.
**Not yet run for real:** the SDK (unit tests with a fake Claude only) and the App's new child task per reviewer on
trigger.dev.

**Upgrading**
- **An App deployment:** redeploy the runner; nothing to reconfigure. A new task, `review-agent-focus`, registers itself
  for multi-reviewer reviews. Check runs now link to the summary comment, and every summary opens with an
  automated-review line.
- **The CLI:** `--post` now posts (it was refused). With **both** `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
  set it now refuses (exit 2). Exit `4` is new: reviewed and paid for, but posting failed. On npm 12, install Claude Code
  with `npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code`.
- **The library:** `octokitFor`, `pushAccessOf`, `refuseUnbuilt` and the Re-run settings codec moved to
  `@review-agent/github`; the App's receiver still exports its names. The record and the callback envelope stay
  `version 1` (new fields only).

**Found by the real captures, and fixed before release:** a `--multi` review printed by the CLI listed duplicates the
check pass had already merged; and an inline comment's evidence broke into pieces when it quoted code in backticks.


### The engine: credentials, the Claude binary, platforms

- **The CLI refuses two model credentials.** With both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` set,
  `review-agent review` now exits `2`, as the App's runner always has, so a review is billed to an account you can
  name. With neither, it still uses `claude login`.
- **A credential can travel with a review.** `runReview` takes a `runtime` — a credential, a Claude binary, and
  variables to pass by name — carried into every model pass. A credential given this way is the only one the Claude
  process sees, and prints as `[redacted]` wherever it is logged or serialised. Core exports `ModelCredential`,
  `ClaudeRuntime`, `SecretValue` and `modelCredentialFromEnv`; the runner's credential check is now core's.
- **Claude Code installed by npm.** On Windows the reviewer finds the `claude.exe` npm installed beside its
  `claude.cmd` shim. On every OS, npm's placeholder for the binary — what an npm 12 install leaves when the package's
  install script did not run — is recognised and reported as *"Claude Code's native binary is not installed — npm
  skipped its install script"*, with the fix.
- **Long review instructions go through a file.** On Windows, or when they are longer than 16,000 characters, they
  are passed as `--append-system-prompt-file`: a private file outside the checkout, deleted after each pass.
- **The Claude process may see `CLAUDE_CONFIG_DIR` and `USE_BUILTIN_RIPGREP`**, so a relocated Claude Code login
  and Alpine work.
- **Finding paths are repository paths.** `src\a.ts`, `./src/a.ts` and an absolute path inside the checkout all
  become `src/a.ts` before anything reads them. The review instructions ask for that too: `REVIEW_INSTRUCTIONS_VERSION`
  is `1.2.0`.
- **Nothing goes missing from the checkout in silence.** Archive entries that could not be written, and paths that
  differ only by letter case or Unicode form, are listed on the review record (`checkout.notWritten`,
  `checkout.caseCollisions`; the record stays version 1) and in a *Not in the checkout* section of the summary.
- **The skill cache is the user's own.** It is created `0700` and only when a skill is configured, an entry another
  user owns is refused, and a run that loses a download race no longer fails on a read-only directory. The CLI's
  default moved to this OS's cache directory (`~/Library/Caches/review-agent/skills` on macOS); the runner's is now
  per user (`review-agent-skills-<uid>`).
- **"Inside the checkout" is decided correctly** for a skill on another Windows drive, a directory named `..x`, and a
  checkout reached through a symlink; a skill's short name is found on Windows paths too.
- **Ctrl-C stops a CLI review** and the Claude process with it, and deletes the downloaded code; a second Ctrl-C
  exits at once with `130`.

### One review session

- **`thorough` works everywhere.** It is one reviewer at `high` effort ($8 soft budget, $20 ceiling; measured $0.62–0.89 on the demo's small pull requests)
  in the App as in the CLI: a `/review --tier thorough` and a Re-run that carries it are honoured, where both used to
  be refused. Its preset says `agents: 1`, so its record no longer says `multi: true`. `--multi` is still refused and
  named in the summary until the multi-reviewer mode is built.
- **Every summary and review says it is automated.** Their first line is *"🤖 Automated review by review-agent ·
  GitHub App · tier basic · `claude-opus-5` · $0.21 (model spend at per-token API prices)"* — the tier, model and cost
  line folded in — with `run by @login from the command line` or `via the SDK` for the other ways in. The App's
  reviews carry it too.
- **The person who posted a review can dispute it.** Replies are ignored only from a bot login the caller names; the
  author of the reviewed comments is no longer taken to be the bot.
- **A summary comment the poster cannot edit no longer fails the review.** A 403 on the edit posts a new summary, as a
  404 already did, and the comment found first is the one the poster's own login wrote, when it is known.
- **`@review-agent/github` runs a whole review.** `prepareReview()` and `runReviewSession()` — the report, the
  previous marker, the deadline, the review, publishing and deleting the checkout — return `reviewed`, `unfinished` or
  `failed` with the stage, the spend and whether a retry is safe, and throw only on a programmer's error. The App's
  runner moves onto it in a later stage; it already shares its money rule and failure sentences (`mayRetry`,
  `failureSentence`, `saidSafely`, `postedCommentsOf`).
- **Reporting with a commit status.** `reporterFor()` reports with a check run when the token can create one and a
  commit status when it cannot, decided with one `GET /user`. A status is a soft gate; a review that did not run
  reports `success` saying it is not a verdict, one its runner stopped reports `error`, and a `check-only` review with
  no check run puts its findings in the summary.
- **Moved to `@review-agent/github`:** `octokitFor` (now with `baseUrl` for GitHub Enterprise Server),
  `GITHUB_API_VERSION`, `pushAccessOf`, `refuseUnbuilt` and `MULTI_REFUSED`, all still exported where they were; new
  `defaultRunReviewDeps()`, which the CLI and the runner both start from. The CLI now pins the GitHub API version
  too. `upsertSummaryComment`, `publishReview` and `createCheckRun` also hand back GitHub's link to what they wrote.
  `THOROUGH_REFUSED` is deprecated.

### The multi-reviewer mode

- **`/review --multi` runs three focused reviewers** — `intent`, `impact` and `security` — instead of one, with any
  tier: `--multi --tier normal` is three reviewers at `medium` effort. Each has the tier's soft budget and its own
  ceiling (so up to three times the tier's ceiling between them), keeps what it wrote if its ceiling stops it, and
  does not take the others down if it fails: the review is unfinished only when none of the three produced anything.
  Measured: $0.67–0.72 a review on the demo's small pull requests, check pass included, at per-token API prices.
- **One check pass over all their findings, which also merges duplicates.** It is asked which findings repeat an
  earlier one; a duplicate is not posted, like a refuted finding, and stays on the record. Its budget is a quarter of
  the tier's target for each reviewer that reported a finding. With the check pass off nothing is merged, and the
  summary says so. A review by one reviewer is never asked about duplicates: its check pass is word for word what it
  was, and `REVIEW_INSTRUCTIONS_VERSION` is `1.3.0` only because the product now ships that one new paragraph.
- **The summary names the reviewers and how each ended** — *"Three focused reviewers: intent ✓ · impact ✓ (cut short)
  · security ✗ (did not finish)"* — and each inline comment names the focus that found it.
- **The record keeps each reviewer:** `focuses: [{ lens, usage, finished, cutShort, failure, findings }]`, empty for
  one reviewer; `usage` and `costUsd` include all three; a finding carries its `lens` and a check verdict its
  `duplicateOf`. The record stays version 1.
- **Never automatic, and a deployment can switch it off.** Only a request runs it — a comment, or the Re-run button
  of a review that used it, which in the App means someone with push access. A tier's `agents` no longer turns it on
  (nothing reads it now), and an automatic review that carries `multi` is refused and named. New deployment setting
  `allowMulti` (default `true`): `false` refuses `--multi` under *Not honoured* and runs one reviewer. `MULTI_REFUSED`
  is now that sentence; `MULTI_REFUSED_AUTOMATIC` is new. `refuseUnbuilt` takes `{ allowMulti, automatic }`.
- **How many run at once:** `defaultRunReviewDeps({ concurrency })`, 3 by default. The App's runner runs them one at
  a time, because three Claude processes do not fit its 1 GB machine; a child task per reviewer comes later in 0.2.0
  (Stage 6, below, replaced the one-at-a-time runner).
  The CLI has no `--multi` flag yet.
- **A multi-reviewer re-review** fits its re-review pass under the three reviewers' ceilings together, not one.

### The CLI

- **`review-agent review --post` posts**, as whoever the GitHub token belongs to: the review with its inline comments,
  the summary comment, and a report on the commit. At a terminal it first says once what it will post and as whom —
  *"This will post as @alice on acme/widgets#16: a review with inline comments, a summary comment and a commit status
  "review-agent". Continue? [y/N]"* — and anything but `y` posts and spends nothing; `--yes` skips the question, and
  without a terminal nothing is asked. The automated-review line says *run by @alice from the command line*, or *from
  GitHub Actions* when `GITHUB_ACTIONS=true` (the wording only). The old `--post` refusal is gone.
- **`--report auto|check-run|status|none`** (default `auto`): a person's token reports with a commit status, an
  installation token — an App's, or a workflow's own `GITHUB_TOKEN` — with a check run, decided with one `GET /user`.
  A commit status is a soft gate, and the docs say so wherever they mention it. `--report check-run` with a person's
  token is refused before the pull request is read. Ctrl-C after a status was set `pending` sets it to `error` on the way out.
- **`--re-review`**, on with `--post`: the reviewer reads its earlier summary on the pull request and runs the re-review
  pass; `--no-re-review` skips the pass and still edits that summary. `runReviewSession` takes `reReview: false` for
  the same. Without `--post` nothing is read, as before.
- **`--multi`**, **`--github-host <host>`** (GitHub Enterprise Server, `https://<host>/api/v3`; not tested against one
  yet), **`--keep-checkout`** (keeps the downloaded code and prints where), **`--yes`**, and **`review-agent
  --version`**, whose version is built into the bundle.
- **The GitHub token** comes from `GITHUB_TOKEN`, then `GH_TOKEN` (each only when not empty), then `gh auth token
  --hostname <host>`; at a terminal with `gh` installed but logged out, it offers to run `gh auth login --web` for you.
  Without a terminal it exits `2` naming exactly what to set. `gh` is started by absolute path, never a bare name. The
  token is never printed — an error message quoting it prints `[redacted]` — and never reaches the Claude process.
- **Exit code `4`:** reviewed and paid for, but posting failed. The review is printed so it is not lost.
- **`--json` with `--post`** prints `{ "record", "posted": { reviewId, summaryCommentId, summaryUrl, inlineComments },
  "report": { kind, conclusion, url } }`; without `--post`, the bare record as before.
- **The readable summary's cost is the review's total** — every pass it bought, the re-review pass and every focus of a
  multi-reviewer review included — and is labelled as model spend at per-token API prices.
- **`review-agent doctor [--repo owner/name] [--github-host host]`** checks this machine for `review --post`, one line
  per check with `✓`, `✗` (and a fix) or `!`: Node, the Claude Code binary and its `--version`, the model credential by
  name and kind, `ANTHROPIC_BASE_URL`, the GitHub token's source and identity — a classic token's scope names — and,
  with `--repo`, read access, push access, scopes, and whether it would report with a check run or a commit status. It
  only reads, prints no credential's value, and exits `0` when ready, `2` when not.
- **Library:** core exports `resolveClaudeBinary`; `tokenIdentityOf` keeps a classic token's scope names
  (`scopes`); `ReviewVia`'s `cli` kind takes `from: 'command-line' | 'github-actions'`.

- **A `--multi` review prints each duplicate once**, naming the other reviewers that found it ("also found by
  security") and how many were merged; `--json` keeps them all. An inline comment's evidence renders as one code span
  whatever it quotes.

### The SDK: `@review-agent/sdk`

- **A new package, `@review-agent/sdk`: the review as one call.** `reviewPullRequest({ repo, pr, github, credential, post, … })`
  runs the same review session as the App and the CLI and returns `reviewed`, `unfinished`, `refused` or `failed` —
  never throwing an outcome, so "found nothing" and "did not run" stay different. It posts nothing unless `post: true`.
  [The SDK](docs/sdk.md).
- **Credentials per review.** `{ apiKey }`, `{ oauthToken }` or `'claude-login'`, or exactly one from the environment.
  The Claude process gets that credential and no other; it is never written to `process.env`, never logged, and a
  subscription token is passed straight through and kept nowhere. `ANTHROPIC_BASE_URL` refuses every review.
- **`authorize`**, a gate before anything is downloaded or spent — `authorize: pushAccessOf` with `requestedBy` is the
  App's own; **`report`** (`auto`, `check-run`, `commit-status`, `none`); **`settings`**, merged over the defaults key by
  key; **`onProgress`**, stage by stage; **`signal`** and **`deadlineMs`**; `multi: { concurrency }`.
- Concurrent reviews in one process share nothing but the skill cache, and every checkout is removed when its review
  ends. The SDK does not depend on `@review-agent/app`, so it never installs trigger.dev.

### The App on the review session

- **The App's runner runs the review session** (`prepareReview`, `runReviewSession` with a check-run reporter), so the
  App, the CLI and the SDK review identically. What stays the runner's own: the token for one repository, the
  release-only skip, the push-access gate (still a neutral *Review refused* check run, at $0), closing the check run a
  killed attempt left open, trigger.dev's attempts and the new run a free failure starts. Everything a deployment sees
  is unchanged — task ids, payload, variables, check-run name, titles and conclusions, the record callback
  (`version: 1`), idempotency keys and retries — with two additions: the check run now links the summary comment, and
  the runner reads the App's own login (`GET /app`, `<slug>[bot]` — the `[bot]` form is **UNVERIFIED** against
  GitHub, and a wrong one matches nothing), so it edits its own summary comment rather than one a person posted with
  the CLI, and skips its own replies.
- **Multi-reviewer reviews run each focus as a child task** — a new task, `review-agent-focus`, one run per focus, all
  three started together with `batchTriggerAndWait`, each on its own `small-2x` machine (decision §14.18 (a)). The
  review waits, checkpointed, then runs one check pass over their findings and posts one review. A focus mints its
  own token, downloads the commit the review is of, and resolves its settings itself from the deployment, the base
  commit's settings file and the request — its payload carries ids and what was asked, never settings. Each child is
  keyed on the review's run, its focus and the commit. A focus that fails before its reviewer starts is retried by
  trigger.dev; one whose reviewer ran is never run again; one that fails every attempt is named as not finished and
  the review goes on (§8.3 point 2). A focus whose answer matched a secret pattern hands back where, never what, and
  the review is withheld as one run in a single process would be. The runner no longer runs focuses one at a time
  (`RUNNER_FOCUS_CONCURRENCY` is gone).
- **`@review-agent/app/runner`**: `runReviewJob` — the review the task runs, in your own process, for a runner hosted
  elsewhere — published with `DoNotRetry`, `RetryThis`, `ReviewTaskResult`, `runnerDeployment`,
  `runnerRecordCallback` and `DEFAULT_DEADLINE_MS`. It never loads `@trigger.dev/sdk`. New `focusConcurrency` option:
  in process, a multi-reviewer review's focuses run side by side, 3 at a time unless you say fewer.
- **Library:** `RunReviewDeps.runFocuses` (a `FocusRunner` returning `FocusRunsOutcome`) runs a multi-reviewer
  review's focuses elsewhere, asked before anything is downloaded; `withRepositoryPaths` is exported for such a
  runner. `runReviewSession` takes `onReviewed`, which hears the review before anything is published.
  `checkRunReporter` takes `calls` (its create and complete functions). `gateOf` moved to `check-run`, exported.
  `@review-agent/app` exports `appBotLogin`.

### Upgrading an App deployment to 0.2.0

Redeploy the runner (`npx trigger.dev@4.5.16 deploy`). Nothing to reconfigure: the variables, the receiver, its
trigger key and the record callback are as they were. The new `review-agent-focus` task registers itself with the
deploy, and only the runner starts it. A deployment that edited `runnerDeployment()` re-applies that edit, as on
every upgrade.

### Examples

- **Run it on your own server.** `examples/server` is the receiver, an in-process queue and the SDK in one Node.js 22
  process, posting as your App with no trigger.dev: bounded, deduplicated on the receiver's idempotency key, one
  review at a time by default, the release-only rule and the push-access gate as in the App, a clean `SIGTERM`, and
  logs that never carry a secret. Its Dockerfile is Debian, non-root, with Claude Code 2.1.258 pinned and its binary
  checked at build time. [Run your own server](docs/guides/self-hosting.md).
- **Review pull requests in GitHub Actions.** `examples/github-actions/review.yml` runs the CLI on open, on ready for
  review and on `/review` from someone with push access, posting as `github-actions[bot]` with a `review-agent` check
  run. Pull requests from forks and Dependabot are skipped with a notice; it never uses `pull_request_target`.
  [Review with GitHub Actions](docs/guides/github-actions.md).
- Both are workspace members, so CI builds, type-checks and tests them with the packages, and a test fails if either
  drifts from the Claude Code version the App runner pins.
- **Re-run repeats the settings wherever a review came from.** The settings a check run carries for its Re-run button
  are now stamped by the shared review session, so the CLI's, the SDK's and the self-hosted server's check runs carry
  them as the App's always did (`encodeRequestRefinement` moved to `@review-agent/github`; the App still exports it).

### Continuous integration

- **Windows is required** on every pull request, beside Linux (Node 22 and 24) and macOS, and an **Alpine** job runs
  the suite on musl.
- **The real Claude Code, at $0, on every OS**: CI installs the version the App runner pins and runs the engine with no
  credential; it answers "Not logged in" without reaching a model, proving the binary is found and started with the
  reviewer's real flags.

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

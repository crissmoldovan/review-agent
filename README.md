# review-agent

**An AI pull-request reviewer you run inside your own environment** — your GitHub App, your runner, your Anthropic
credential. The code it reviews goes to your runner and to Anthropic, and nowhere else.

It reads the **whole repository** at the pull request's head commit, not just the diff, with read-only tools, and
reports what it finds:

- **findings** with a severity out of 10, a category (intent, correctness, impact, security), the evidence it read,
  and a suggested fix when the fix is small;
- a **second pass that tries to disprove each finding**, so refuted findings are never posted and the rest are posted
  at the checked severity;
- an **intent verdict** — does the change do what its description says — and the questions it **could not settle**
  from the code alone;
- on later reviews of the same pull request, which earlier findings are **no longer there**.

As a GitHub App it posts a summary comment, inline comments with `suggestion` blocks, and a check run that can gate
merges if you want it to. From the command line it prints the same review, or with `--post` posts it as you, with a
commit status.

```
/review --tier normal
The retry logic moved into the client. Check every caller still handles a 429.
```

## Status

**`0.2.0`, early.** Use it, and read its findings as a careful colleague's first pass, not as a verdict.

- **Built and working:** the review engine, the [CLI](docs/cli.md), and the [GitHub App](docs/deploying.md) mode —
  webhook receiver library plus [trigger.dev](https://trigger.dev) runner — which posts reviews, comments and check
  runs.
- **Proven on real code:** read-only reviews of real pull requests for cost and quality measurement, and reviews
  posted to a real pull request through the deployed runner.
- **New in 0.2.0, run for real once each** on the [demo repository](https://github.com/crissmoldovan/review-agent-demo)
  (2026-10-15): posting from the CLI as yourself (`review-agent review --post`, with a commit status), the
  [multi-reviewer mode](docs/configuration.md#the-multi-reviewer-mode) (`--multi`: three focused reviewers, one check
  pass that also merges duplicates), the `thorough` tier, and the [re-review pass](docs/pull-requests.md#re-reviews),
  which marked a repaired finding "No longer reported". One run each is a sample, not a track record.
- **Not yet run for real:** the [SDK](docs/sdk.md) (`reviewPullRequest()`, covered by unit tests with a fake Claude),
  and the App's new child task per reviewer on trigger.dev.
- **Not built yet:** a GitHub Action mode, and changing the runner's settings without editing one function.
- **The same model varies from run to run.** One review is a sample.

## Quick start: review a pull request from your terminal

You need Node.js 22+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed as `claude`, a GitHub
token that can read the repository, and an Anthropic credential (or a logged-in `claude`).

```sh
npm install --global @review-agent/cli

export GITHUB_TOKEN=…            # or GH_TOKEN, or a logged-in `gh`; Contents: Read and Pull requests: Read
export ANTHROPIC_API_KEY=…       # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or neither if `claude` is logged in

review-agent doctor              # checks all of the above
review-agent review --repo owner/name --pr 123
```

In PowerShell, set the variables with `$env:GITHUB_TOKEN = "…"` and `$env:ANTHROPIC_API_KEY = "…"`; the commands are
the same.

It prints the summary, every finding with its severity and the check pass's verdict, and what the review cost.
`--json` prints the full record instead.

**Post it.** Add `--post` and the review goes on the pull request — a summary comment, inline comments and a commit
status — **as whoever the token belongs to**, with a first line saying it is automated. At a terminal it asks before
posting; the token then also needs Pull requests: Write and Commit statuses: Write.

```sh
review-agent review --repo owner/name --pr 123 --post
```

A commit status is a soft gate: anyone with push access can set one with the same name. For a gate that holds, use the
GitHub App below. Every flag: [the CLI reference](docs/cli.md).

## Quick start: review every pull request with a GitHub App

1. **Register an App** with `npx @review-agent/cli init --name "Acme Reviewer" --url https://acme.example
   --webhook-url https://<your-receiver>/api/github/webhook --org acme`, then generate its private key and set a
   webhook secret. → [The GitHub App](docs/github-app.md)
2. **Deploy the runner** from this repository to your own trigger.dev project, with the App's client id and key and
   one Anthropic credential. → [Deploying](docs/deploying.md#5-deploy-the-runner)
3. **Write the receiver**: about thirty lines with `@review-agent/app/receiver` — verify the signature, decide,
   dispatch. A complete Next.js route is in the guide. → [The receiver](docs/deploying.md#3-write-the-receiver)
4. **Install the App** on a repository and open a pull request.

The receiver never holds the App's key or a model credential; the runner never faces the internet.

**Other ways to run it.** Without trigger.dev: the receiver, a queue and the SDK in one container on your own server —
[examples/server](examples/server/README.md), guide: [Run your own server](docs/guides/self-hosting.md). Without an App
or a server: a GitHub Actions workflow that runs the CLI — [examples/github-actions](examples/github-actions/README.md),
guide: [Review with GitHub Actions](docs/guides/github-actions.md).

## On a pull request

- **Automatically** when a pull request opens (not as a draft) or is marked ready for review. Not on every push.
- **On request:** comment `/review`, with optional flags on the first line and a note for the reviewer after them, or
  press **Re-run** on its check run. Only people with push access can ask, because a review costs money.
- **Answer a finding** by replying `/dispute` or `/defer` under its inline comment.
- It **never approves or requests changes**. A check run concludes `success`, or `failure` only if you arm the gate.

→ [Using it on pull requests](docs/pull-requests.md)

## Configuration

Three layers, each allowed to change different things:

- **The deployment** sets everything: the command word, model, tiers and budgets, severity bands, the inline
  threshold, the reporting mode (`inline+summary`, `summary-only`, `check-only`, `silent`), the check-run name, a
  merge gate, extra instructions and trusted skills.
- **The repository** can add guidance in `.review-agent/review.md`, read from the **base** branch, and make the
  review quieter or stricter — never louder, costlier or less safe.
- **The request** can pick the tier, model, effort and check pass, add a note, and lower the budget.

→ [Configuration](docs/configuration.md)

## Security, in brief

Read-only tools (Read, Grep, Glob) and no shell; the reviewed repository's Claude settings and hooks are not loaded;
the model's process sees only its credential; the code is downloaded as an archive with credential files removed;
output is scanned for secrets before posting; the App never gets write access to code, and each review's token is
scoped to one repository; a gateway (`ANTHROPIC_BASE_URL`) is refused. → [Security model](docs/security.md)

## What it costs

Model spend at **per-token API prices** (what an Anthropic API key is billed), **measured** with `claude-opus-5`:

| What | Cost | Time |
|---|---|---|
| a `basic` review of a real production pull request | $0.88–1.06 | 2–5 minutes |
| its check pass | $0.07–0.58 | 13 seconds to about 2 minutes |
| a `normal` review (`medium` effort), before the check pass | $1.57–1.67 | 4–7 minutes |
| a whole `basic` review, check pass included, of a one-file pull request | $0.16–0.29 | |
| the re-review pass on a later review | about $0.10 — **an estimate** made before it ran; measured once since (below) | |
| a whole `basic` or `normal` review, check pass included, of the [demo repository](https://github.com/crissmoldovan/review-agent-demo)'s small pull requests — **measured 2026-10-15**, per-token API prices | $0.20–0.44 `basic` (5 runs); $0.56–0.62 `normal` (2 runs) | the reviewer: 27–50 seconds `basic`, 75–89 seconds `normal` |
| a whole `thorough` review, check pass included, of a small demo pull request — **measured 2026-10-15**, per-token API prices, with the soft budget lowered to $4 (`--budget 4`) | $0.62–0.89 (2 runs) | the reviewer: 93–132 seconds |
| a whole `--multi` review at `basic` — three focused reviewers and one check pass — of a small demo pull request — **measured 2026-10-15**, per-token API prices, with each reviewer's budget lowered to $1 (`--budget 1`) | $0.67–0.72 (2 runs) | the three reviewers: 86–116 seconds added up |
| the re-review pass on a later review of a small demo pull request — **measured once, 2026-10-15**, per-token API prices | $0.16, inside a whole `basic` review of $0.49 | |

Every run on the demo repository, with its check pass and findings: [what the runs
cost](docs/guides/choosing-a-tier.md#what-the-runs-cost).

Cost follows how much the reviewer explores, not the size of the diff. Each pass has a hard ceiling: $5.00 for a
`basic` review and $1.25 for each extra pass. With a Claude subscription token the same amounts are drawn from the
subscription's allowance instead of billed. trigger.dev bills its compute separately, at its own prices.

## Documentation

| Page | For |
|---|---|
| [The CLI](docs/cli.md) | every command, flag, exit code and environment variable |
| [Using it on pull requests](docs/pull-requests.md) | the people whose pull requests are reviewed |
| [Configuration](docs/configuration.md) | every setting, the repository file, and what wins |
| [The GitHub App](docs/github-app.md) | registering, permissions, keys, installing |
| [Deploying](docs/deploying.md) | the receiver, the runner, the record callback, the sweep, troubleshooting |
| [How it works](docs/how-it-works.md) | one review step by step, the passes, the record |
| [Security model](docs/security.md) | what the reviewer can and cannot do, and why |
| [Guides](docs/guides/README.md) | which guide for which goal |
| [Your first review in five minutes](docs/guides/first-review.md) | a pull request reviewed and printed in your terminal — Windows, macOS, Linux |
| [Post a review as yourself](docs/guides/post-as-yourself.md) | `--post`: the review on the pull request under your name, re-reviews, and what your token can reach |
| [Run your own server](docs/guides/self-hosting.md) | every pull request reviewed by your App from one Docker container on your own server — no trigger.dev |
| [Review with GitHub Actions](docs/guides/github-actions.md) | every pull request reviewed by a workflow — no App, no server |
| [Review from another CI](docs/guides/other-ci.md) | Jenkins, CircleCI, Buildkite, GitLab CI — with a bot account's token or your App's |
| [The webhook on Vercel](docs/guides/vercel.md) | your App's receiver on Vercel, its runner on trigger.dev |
| [Choosing a tier](docs/guides/choosing-a-tier.md) | which tier when, the multi-reviewer mode and budgets, with worked examples |
| [Troubleshooting](docs/guides/troubleshooting.md) | every message you can act on, by symptom, whichever way in |
| [The SDK](docs/sdk.md) | embedding the reviewer in your own service or script: every option, result and example |
| [Library reference](docs/library.md) | the five packages and their exports |
| [Changelog](CHANGELOG.md) | what changed in each release |

## Packages

| Package | |
|---|---|
| [`@review-agent/sdk`](https://www.npmjs.com/package/@review-agent/sdk) | the review as one call from your own code |
| [`@review-agent/cli`](https://www.npmjs.com/package/@review-agent/cli) | the `review-agent` command |
| [`@review-agent/app`](https://www.npmjs.com/package/@review-agent/app) | the GitHub App: receiver library, credentials, manifest |
| [`@review-agent/github`](https://www.npmjs.com/package/@review-agent/github) | reading pull requests and posting reviews |
| [`@review-agent/core`](https://www.npmjs.com/package/@review-agent/core) | the review engine |

## Developing

```sh
pnpm install        # pnpm 11, Node.js 22+
pnpm -r build
pnpm typecheck
pnpm test           # unit tests; also builds and packs the packages to check what would be published
```

The end-to-end tests (`pnpm test:e2e`) call real GitHub and a real model, so they cost money: they are excluded from
`pnpm test` and do nothing unless `REVIEW_AGENT_E2E_PAID=1` and their credentials are set.

| Path | What |
|---|---|
| `packages/core` | the engine |
| `packages/github` | the GitHub adapter |
| `packages/app` | the App, the receiver, and the trigger.dev tasks (`src/tasks`, `trigger.config.ts`) |
| `packages/cli` | the command line |
| `examples/` | the server and the GitHub Actions workflow — built, type-checked and tested with the packages |
| `test/` | checks on what the published packages contain |

## Licence

[Apache-2.0](LICENSE).

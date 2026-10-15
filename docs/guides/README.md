# Guides

Each guide takes you from nothing to a working result, step by step: what you need, the exact commands — PowerShell
beside the POSIX shell where they differ — the output to expect, what to do when you see something else, and what it
costs. Output quoted in a guide comes from reviews of the public demo repository
[`crissmoldovan/review-agent-demo`](https://github.com/crissmoldovan/review-agent-demo), labelled with the version and
the date it was captured.

## I want to…

| I want to… | Guide | Use case |
|---|---|---|
| read a review of a pull request before I ask a colleague | [Your first review in five minutes](first-review.md) — Windows, macOS, Linux | UC-2 |
| put that review on the pull request, under my own name | [Post a review as yourself](post-as-yourself.md) | UC-3 |
| have every pull request reviewed by a GitHub Actions workflow — no App, no server | [Review with GitHub Actions](github-actions.md) | UC-4 |
| review pull requests from Jenkins, CircleCI, Buildkite, GitLab CI or another CI | [Review pull requests from another CI](other-ci.md) | UC-5 |
| call a review from my own service, or review a batch of pull requests from a script | [The SDK](../sdk.md) (reference, with examples) | UC-6, UC-9 |
| have every pull request reviewed by my own GitHub App, from one container on my own server | [Run your own server](self-hosting.md) | UC-7 |
| … by my own GitHub App, with the runner on trigger.dev | [Deploying the reviewer as a GitHub App](../deploying.md) (reference, step by step) | UC-1 |
| … with the webhook on Vercel | [The webhook on Vercel](vercel.md) | UC-8 |
| decide which tier to ask for, and when to use several reviewers | [Choosing a tier](choosing-a-tier.md) | — |
| find out why something went wrong | [Troubleshooting, by symptom](troubleshooting.md) | all |

Not sure which way in? The CLI runs **as you** and prints, or posts under your name with a commit status — a soft
gate. GitHub Actions and a GitHub App post as a bot, with a check run a branch rule can pin. The SDK is the same review
as a function call. All of them run one shared review session, so a review is the same review whichever way it was
asked for ([spec 0.2.0 §0](../specs/0.2.0-ways-in.md#0-what-changes-in-one-paragraph)).

## Reference

| Page | For |
|---|---|
| [The CLI](../cli.md) | every command, flag, exit code and environment variable |
| [Using it on pull requests](../pull-requests.md) | the people whose pull requests are reviewed: `/review`, `/dispute`, `/defer`, re-reviews |
| [Configuration](../configuration.md) | every setting, the repository file, tiers, budgets, and what wins |
| [The GitHub App](../github-app.md) | registering, permissions, keys, installing |
| [Deploying](../deploying.md) | the receiver, the runner, the record callback, the sweep |
| [The SDK](../sdk.md) | every option, result and example of `reviewPullRequest` |
| [How it works](../how-it-works.md) | one review step by step, the passes, the record |
| [Security model](../security.md) | what the reviewer can and cannot do, and why |
| [Library reference](../library.md) | the five packages and their exports |

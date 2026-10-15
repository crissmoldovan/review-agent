# Review every pull request with GitHub Actions

At the end of this guide, every pull request that opens in your repository is reviewed by a GitHub Actions workflow,
and anyone with push access can ask for another review by commenting `/review`. There is no GitHub App to register
and no server to run: the workflow installs Claude Code and the `review-agent` CLI and runs one review per pull
request, posting as `github-actions[bot]` (use case UC-4 in [the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

<!-- capture: a screenshot of a pull request in the demo repository after the workflow ran — the
"review-agent" check run in the checks list, the summary comment from github-actions[bot], and one inline
comment. Label it with the review-agent version and the date it was captured. -->
*(captured output will appear here)*

What it posts on each reviewed pull request:

- a **review** with an inline comment for each finding worth one;
- a **summary comment** that opens with a line saying it is an automated review by review-agent, run from GitHub
  Actions, with the tier, the model and what the review cost;
- a **check run** named `review-agent` on the reviewed commit — `success`, `failure` only through
  [the gate](../configuration.md#the-gate), or `neutral` for a review that did not run.

What each part means: [using it on pull requests](../pull-requests.md#what-it-posts).

## What you need

- [ ] A repository on GitHub with Actions enabled, and admin rights on it (to add a secret).
- [ ] An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com). Reviews are billed to it,
      at per-token API prices.
- [ ] Optional: the [GitHub CLI](https://cli.github.com), `gh`, for the commands below. Everything can be done on
      github.com instead.

The reviewer is never installed on your own machine: the workflow installs it on GitHub's runner, for each review.

## 1. Add the API key as a repository secret

On github.com: the repository's **Settings → Secrets and variables → Actions → New repository secret**. Name it
`ANTHROPIC_API_KEY` and paste the key as its value.

Or with `gh`, which asks for the value — so the key never appears on the command line or in your shell history. The
same command in a POSIX shell and in PowerShell:

```sh
gh secret set ANTHROPIC_API_KEY --repo acme/widgets
```

**If you see this instead**

| Symptom | Fix |
|---|---|
| `gh` answers `HTTP 403` | adding a repository secret needs admin rights on the repository (its owner's, for a personal account's repository) |
| no **Secrets and variables** entry under **Settings** | you are not an admin of the repository, or are looking at your account's settings rather than the repository's |

## 2. Add the workflow

Copy [`examples/github-actions/review.yml`](../../examples/github-actions/review.yml) into your repository as
`.github/workflows/review-agent.yml`. Every line of it is commented with why it is there; read it before you commit
it — it runs with your API key. From the root of a clone of your repository:

```sh
mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/crissmoldovan/review-agent/v0.2.0/examples/github-actions/review.yml \
  -o .github/workflows/review-agent.yml
```

```powershell
New-Item -ItemType Directory -Force .github/workflows | Out-Null
Invoke-WebRequest -Uri https://raw.githubusercontent.com/crissmoldovan/review-agent/v0.2.0/examples/github-actions/review.yml `
  -OutFile .github/workflows/review-agent.yml
```

The file pins two versions. Keep both pinned, and change them on purpose:

- `@anthropic-ai/claude-code@2.1.258` — the Claude Code the reviewer's flags were measured against;
- `@review-agent/cli@0.2.0` — the reviewer.

## 3. Open a pull request

Commit the file on a branch and open a pull request. The same commands in a POSIX shell and in PowerShell:

```sh
git switch --create add-review-agent
git add .github/workflows/review-agent.yml
git commit --message "ci: review pull requests with review-agent"
git push --set-upstream origin add-review-agent
gh pr create --fill
```

That pull request is reviewed by the workflow it adds: a `pull_request` run uses the workflow as it is in the pull
request. A `/review` comment is different — its run uses the workflow on the **default branch**, so `/review` works
once the file is merged.

## 4. Read the result

A review takes a few minutes. On the pull request:

1. The checks list shows two checks: **`review-agent runner`**, the job, and **`review-agent`**, the review's own
   check run, which ends with the review's conclusion.
2. The summary comment from `github-actions[bot]` says what was found and what it cost.
3. Inline comments sit on the lines they are about.

<!-- capture: the summary comment and one inline comment posted by github-actions[bot] on a demo
pull request at tier basic, exactly as GitHub shows them; and the check run's page. Version and date. -->
*(captured output will appear here)*

The job's log, under **Actions → review-agent → the run**, shows what the CLI did. Its last lines say what was posted
and how it was reported:

<!-- capture: the last lines of the "Review and post" step's log from the same run — the "posted …"
and "reported with a check run: …" lines and the cost line. Version and date. -->
*(captured output will appear here)*

**If you see this instead**

| Symptom | Cause, and the fix |
|---|---|
| The job was **skipped** with the notice *"comes from a fork"* | by design: a fork's pull request gets no secrets. See [forks](#pull-requests-from-forks) |
| The job was **skipped** with the notice *"Dependabot pull requests get no Actions secrets"* | by design: GitHub runs Dependabot's pull requests like a fork's. Comment `/review` to have one reviewed |
| **`The ANTHROPIC_API_KEY repository secret is not set`**, exit `2` | step 1: the secret is missing, or was added under another name, or to another repository |
| **`Install Claude Code and review-agent`** fails at `claude --version` with *"claude native binary not installed"* | npm skipped Claude Code's install script, so `claude` is its placeholder. The workflow sets up Node.js 22, whose npm runs it; check that step still says `node-version: 22` |
| The review ran, and the check is a **commit status** instead of a check run | the job's token could not create a check run: check the workflow's `permissions:` still has `checks: write` |
| Exit `4`, *"posting failed"* | the review ran and was paid for, and GitHub would not take it — usually `pull-requests: write` missing from `permissions:`. The review is printed in the job log, so it is not lost |
| Exit `1`, the check says **Review did not finish** | the model failed, ran out of budget, or the review hit its 30-minute deadline. The check concludes `neutral`, which blocks nothing. Comment `/review` to try again |
| Exit `3` | the review's output matched a secret pattern and was withheld; nothing was posted |
| Nothing at all happens when the pull request opens | the workflow is not in the pull request (step 2), Actions is disabled for the repository, or the pull request was opened as a **draft** — it is reviewed when marked ready |

## Asking for another review

Comment on the pull request — in the conversation, not on a line:

```
/review
```

The first line may name a tier: `/review --tier normal` or `/review --tier thorough`. Nothing else in the comment is
read by this workflow (the GitHub App also reads a brief and more flags: [asking for a review](../pull-requests.md#asking-for-a-review)).

Only someone with **push access** can ask: a review is paid for with the repository's key. The workflow checks in two
places. Before a runner even starts, the comment's author must be the repository's owner, a member of its
organisation or an outside collaborator (`author_association`) — anyone can comment on a public repository, and most
comments should cost nothing. Then the first step asks GitHub whether that person can push, because a member or a
collaborator may still be read-only here. Anyone else's `/review` ends with a notice and nothing spent.

While a review of a pull request is running, a second request waits for it rather than cancelling it: a cancelled
review has already been paid for. One request waits at most; a newer one takes its place before it has spent
anything.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork no secrets and a read-only token, so the review could not run, and could
not post. The workflow **skips fork pull requests with a notice** instead of failing or reporting something
misleading. It skips them on a `/review` comment too — that run does get the secrets, but this workflow is not where
a fork's code meets the repository's keys.

To review one, a maintainer runs the CLI on their own machine, where it posts as them
([post a review as yourself](../cli.md#posting---post)):

```sh
review-agent review --repo acme/widgets --pr 128 --post
```

**Never switch the trigger to `pull_request_target`** to get around this. It runs with the repository's secrets and a
write token even for a fork's pull request — the opening that lets a fork reach them — and GitHub blocks it by
default in public repositories from 2026-11-02
([spec 0.2.0 §10](../specs/0.2.0-ways-in.md#10-security-for-the-new-ways-in), citing
[GitHub's documentation](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).

## Requiring the check before a merge

The `review-agent` check run is created with the workflow's own token, so it belongs to **GitHub Actions** — and a
branch rule can require it **pinned to that source**, so nothing else can satisfy it. A commit status cannot be pinned
like that: anyone with push access could set one with the same name
([spec 0.2.0 §2.2](../specs/0.2.0-ways-in.md#22-what-each-github-identity-can-do)).

In the repository's **Settings → Rules → Rulesets** (or **Settings → Branches**), add a rule for the default branch
that requires the status check **`review-agent`** with **GitHub Actions** as its source. Require `review-agent`, not
`review-agent runner`: the job fails when a review could not run, and an outage should not block a merge.

What a required check asks of every pull request:

- A review that did not run concludes `neutral`, which passes. Only [the gate](../configuration.md#the-gate) — off
  unless a deployment arms it — can make it fail.
- **A pushed commit has no `review-agent` check until someone comments `/review`**: pushes are not reviewed, so
  each new head commit needs a request before it can merge. If you would rather review every push, add
  `synchronize` to the `pull_request` types — and pay for a review on every push.
- **A fork's pull request never gets the check** from this workflow, and a maintainer's own `review-agent review
  --post` reports with a commit status, which a check pinned to GitHub Actions does not accept. If you take pull
  requests from forks, give the rule a bypass for the people who merge them, or do not require the check.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices** | **measured** with `claude-opus-5`: $0.88–1.06 for a `basic` review of a real production pull request; $0.16–0.29 for a one-file pull request, check pass included; $1.57–1.67 for a `normal` review before its check pass. `thorough`: not measured. Hard ceilings: $5.00 `basic`, $7.50 `normal`, $20.00 `thorough` ([what it costs](../../README.md#what-it-costs)) |
| The runner | GitHub, at **GitHub's price** for your plan | free on GitHub-hosted runners for public repositories. A job lasts about as long as its review — 2–7 minutes measured for `basic` and `normal` — plus installing two npm packages, **not measured** |

Each summary comment says what its review cost. A single review is a sample, not a verdict: the same model can find
different things on two runs of the same pull request.

## Upgrading

Change `@review-agent/cli@0.2.0` in the workflow to the new version, read the [changelog](../../CHANGELOG.md), and open
a pull request — it is reviewed by the new version. Change `@anthropic-ai/claude-code@2.1.258` only when a release of
the reviewer says to.

## Next steps

- [Choose a tier](../configuration.md#tiers) for the reviews you ask for.
- [Use it on pull requests](../pull-requests.md): replying `/dispute` or `/defer` to a finding, and re-reviews.
- For reviews posted as your own App, with the hourly sweep and the record callback:
  [deploy the GitHub App](../deploying.md), or [run your own server](self-hosting.md).

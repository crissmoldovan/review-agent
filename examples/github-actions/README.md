# review-agent in GitHub Actions

[`review.yml`](review.yml) reviews each pull request in a GitHub Actions workflow: no GitHub App to register, no server
to run. It installs Claude Code and the `review-agent` CLI, and posts the review as `github-actions[bot]` — a review
with inline comments, a summary comment, and a check run named **`review-agent`** on the reviewed commit. It is a
workflow you copy rather than a published action (spec 0.2.0, decision §14.12), so every line of it is yours to read.

| When | What happens |
|---|---|
| a pull request opens, or a draft is marked ready for review | it is reviewed at the `basic` tier |
| someone with push access comments `/review` (or `/review --tier normal`, `--tier thorough`) | it is reviewed again, at that tier |
| new commits are pushed | nothing — comment `/review` when you want another look |
| the pull request comes from a fork, or from Dependabot | skipped, with a notice on the run saying why |

Every line of the workflow is commented with why it is there. The step-by-step guide, with what to expect and what to
do when it goes wrong: [Review every pull request with GitHub Actions](../../docs/guides/github-actions.md).

## Set it up in four steps

1. **Add the secret.** In the repository: **Settings → Secrets and variables → Actions → New repository secret**,
   named `ANTHROPIC_API_KEY`, holding an [Anthropic API key](https://console.anthropic.com). Or, with the GitHub CLI,
   which asks for the value rather than taking it on the command line:

   ```sh
   gh secret set ANTHROPIC_API_KEY --repo acme/widgets
   ```

2. **Copy the file** to `.github/workflows/review-agent.yml` in that repository.
3. **Open a pull request** — the one that adds the file will do: a `pull_request` run uses the workflow as it is in the
   pull request. A `/review` comment uses the workflow on the default branch, so it works once the file is merged.
4. **Read the result** on the pull request: the `review-agent` check, the summary comment and any inline comments.
   The run itself is under **Actions → review-agent**.

## Costs

- **The model**, at **per-token API prices**, billed to the API key. Measured with `claude-opus-5`: $0.88–1.06 for a
  `basic` review of a real production pull request, $0.16–0.29 for a one-file pull request with the check pass, and
  $1.57–1.67 for a `normal` review before its check pass. `thorough` is not measured yet. Each review has a hard
  ceiling: $5.00 at `basic`, $7.50 at `normal`, $20.00 at `thorough`
  ([what it costs](../../README.md#what-it-costs), [tiers](../../docs/configuration.md#tiers)). The summary comment
  and the job log say what each review cost.
- **The runner's time**, at GitHub's price for your plan — GitHub-hosted runners are free for public repositories. A
  job takes about as long as the review (2–7 minutes measured for `basic` and `normal`) plus installing two npm
  packages, which has not been measured.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork no secrets, so there is no API key to review with, and its token cannot
write to the pull request. The workflow therefore **skips fork pull requests with a notice** rather than failing or
posting something misleading — and skips them on a `/review` comment too, whose run does have the secrets, because
this workflow is not the place a fork's code meets the repository's keys. A maintainer can review one with the CLI:
`review-agent review --repo acme/widgets --pr 128 --post`.

Do not switch the trigger to `pull_request_target` to get around this: it runs with the repository's secrets and a
write token for fork pull requests, and GitHub blocks it by default in public repositories from 2026-11-02
([spec 0.2.0 §10](../../docs/specs/0.2.0-ways-in.md#10-security-for-the-new-ways-in)).

## Requiring the check

The `review-agent` check run is created with the workflow's own token, so it belongs to **GitHub Actions**, and a
branch rule can require it **pinned to that source** — unlike a commit status, which anyone with push access could
set ([spec 0.2.0 §2.2](../../docs/specs/0.2.0-ways-in.md#22-what-each-github-identity-can-do)). In the repository's
**Settings → Rules → Rulesets** (or **Settings → Branches**), add a rule for the default branch that requires the
status check **`review-agent`** with **GitHub Actions** as its source. Require `review-agent`, not the job: the job is
a separate check, **`review-agent runner`**, which fails when a review could not run.

Before you require it, know what it asks of every pull request:

- a review that did not run concludes `neutral`, which passes — only [the gate](../../docs/configuration.md#the-gate)
  can fail it;
- **a pushed commit has no `review-agent` check until someone comments `/review`**, because pushes are not reviewed;
- **a fork's pull request never gets one** from this workflow, so a rule that requires it blocks the pull request —
  and a maintainer's own `review-agent review --post` does not unblock it, because a person's token reports with a
  commit status, which a check pinned to GitHub Actions does not accept. If you take pull requests from forks, give
  the rule a bypass for the people who merge them, or do not require the check;
- a Dependabot pull request gets one only when someone comments `/review`.

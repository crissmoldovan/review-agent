# Configuration

Settings come from three places, and each is allowed to change different things:

| Layer | Who writes it | Where it lives | What it may change |
|---|---|---|---|
| **Deployment settings** | whoever runs and pays for the reviewer | a `DeploymentConfig` object (below) | everything |
| **The repository file** | the reviewed repository | `.review-agent/review.md`, read from the pull request's **base** branch | it can make the review **quieter or stricter**, never louder, costlier or less safe |
| **The request** | the person asking | `/review` flags in a comment, or CLI flags | tier, model, effort, check pass, a brief, and a **lower** budget |

The repository file is read from the **base** branch, never from the pull request itself, so a pull request cannot
change the rules it is judged by.

## Deployment settings

A deployment's settings are a `DeploymentConfig` (exported by `@review-agent/core`). `defaultDeploymentConfig()`
returns the built-in defaults below. Where each kind of deployment gets its settings:

| Mode | Where the settings come from | How to change them |
|---|---|---|
| CLI | always `defaultDeploymentConfig()` | per-run flags only — see [the CLI](cli.md) |
| App: the receiver | the object your receiver passes to `decideDelivery` | your receiver's code. **Only `command` and `autoReview` are read here** |
| App: the runner | `runnerDeployment()` in `packages/app/src/tasks/review-job.ts` | edit that function before you deploy the runner — see [deploying](deploying.md#4-optional-change-the-runners-settings) |
| In-process (`runReviewJob`) | the `deployment` you pass | your code |

In an App deployment the two halves are configured separately: the receiver decides **whether** a delivery is a
review (`command`, `autoReview`); the runner decides **how** it is reviewed and reported (everything else). Keep the
`command` in both the same if you change it, so the words in the summary match the word people type.

### Every setting

| Setting | Type | Default | What it does |
|---|---|---|---|
| `command` | string | `/review` | the word that asks for a review in a pull request comment. Matched at the start of the comment, case-insensitively, as a whole word: `/reviewer` is not `/review` |
| `autoReview` | `'open+ready'` \| `'off'` | `'open+ready'` | review automatically when a pull request opens (not as a draft) and when it is marked ready for review. `'off'`: only when asked |
| `model` | string | `claude-opus-5` | the model, unless a request names another |
| `effort` | `low` … `max` | `low` | the fallback effort; in practice each tier's own `effort` is used |
| `tiers` | `{ basic, normal, thorough }` | see [tiers](#tiers) | per tier: `agents`, `effort`, `check`, `budgetUsd` |
| `severity.bands` | `{ critical, high, medium }` | `{ critical: 9, high: 7, medium: 4 }` | where each band starts. Anything below `medium` is **low** |
| `severity.postInlineAtOrAbove` | 1–10 | `5` | the lowest severity that may become an inline comment. Lower findings go in the summary |
| `report.mode` | see [modes](#reporting-modes) | `inline+summary` | what is posted |
| `report.maxInline` | number | `15` | the most inline comments on one review; in `check-only` mode, the most annotations (never more than 50) |
| `report.maxFindings` | number | `50` | the most findings the model may return |
| `report.firstReviewLowBandCap` | number | `3` | the most **low**-band findings the first review of a pull request mentions at all |
| `report.repeatNits` | boolean | `false` | when `false`, later reviews of the same pull request mention no low-band findings |
| `report.checkRunName` | string | `review-agent` | the check run's name. A branch protection rule or ruleset requires a check **by this name**, so changing it un-requires the old one |
| `report.failAtOrAbove` | 1–10, or `null` | `null` (off) | the [gate](#the-gate): a finished review with a finding at or above this severity concludes `failure` |
| `report.gateRequiresConfirmed` | boolean | `false` | when `true`, only findings the check pass **confirmed** can trip the gate |
| `skills` | `SkillSource[]` | `[]` | trusted [skills](#skills) to load |
| `instructions` | string | none | extra review instructions, added after the built-in rules (they cannot replace them). Up to 10,000 characters are used |

### Tiers

A tier is a named preset. A request picks one; the default is `basic`.

| Tier | Effort | Check pass | Soft budget | Hard ceiling | Notes |
|---|---|---|---|---|---|
| `basic` | `low` | on | $2.00 | $5.00 | where every automatic review and a bare `/review` land |
| `normal` | `medium` | on | $3.00 | $7.50 | |
| `thorough` | `high` | on | $8.00 | $20.00 | **not usable from the App**: the multi-reviewer fan-out is not built. The CLI accepts it and runs one reviewer |

All figures are at **per-token API prices** — what an Anthropic API key would be billed. With a subscription token the
same amounts are drawn from the subscription's allowance instead.

### Budgets

- The **soft budget** is told to the model in its instructions. It is advisory.
- The **hard ceiling** is 2.5 × the soft budget, passed to Claude Code as `--max-budget-usd`. When it is reached the
  run stops; whatever the review produced is still reported, marked as cut short.
- The **check pass** and the **re-review pass** each get a quarter of the soft budget as their own target, and 2.5 ×
  that as their ceiling — $0.50 and $1.25 on `basic`. The re-review pass only runs if its ceiling still fits under
  the review's ceiling after what has been spent.
- A request may **lower** the budget (`--budget 1`), never raise it.

Measured costs are in the [README](../README.md#what-it-costs).

### Reporting modes

From loudest to quietest:

| Mode | Inline comments | Summary comment | Check run |
|---|---|---|---|
| `inline+summary` | yes | yes | yes, with counts |
| `summary-only` | — | yes | yes, with counts |
| `check-only` | — | — | yes, with each finding as an **annotation** |
| `silent` | — | — | no — the review is recorded and nothing is posted |

The re-review pass and the tracking of earlier findings only happen in the two modes that write the summary
comment, because that is where the reviewer keeps its memory of a pull request. A refused request (no push access)
still gets a check run, even in `silent`.

### The gate

Off by default: a reviewer that fails builds on the day it is installed gets uninstalled.

With `report.failAtOrAbove` set, a **finished** review concludes its check run `failure` when any finding — at the
**check pass's** severity, refuted findings never counted — is at or above the threshold. With
`report.gateRequiresConfirmed` also on, only findings the check pass confirmed count, so an `uncertain` one is
reported and cannot block. To make the gate block merges, require the check run (by `report.checkRunName`) in a
branch protection rule or ruleset.

Turning `gateRequiresConfirmed` on while a tier's check pass is off disarms the gate for that tier, since nothing is
ever confirmed; the check run's output says so.

### Skills

A skill is a folder of extra instructions and tools that Claude Code loads as a plugin (`--plugin-dir`). Skills come
**only from the deployment**: a skill planted in the reviewed repository is not loaded.

```ts
skills: [
  { kind: 'dir', path: '/opt/review-skills/security-pass' },                 // a local directory, absolute
  { kind: 'git', repo: 'acme/review-skills', ref: 'v1.2.0', path: 'perf' },   // a GitHub repo at a ref
]
```

- `dir`: an absolute path to an existing directory.
- `git`: downloaded once from `codeload.github.com` as an archive of `repo` at `ref`, optionally narrowed to `path`,
  and made read-only. Set `REVIEW_AGENT_SKILLS_TOKEN` to reach a private repository.
- Downloads are cached in `REVIEW_AGENT_SKILL_CACHE`, keyed by `repo@ref`, and **a cached entry is never
  refreshed** — so pin a tag or a commit, not a branch.
- The cache belongs to the user running the reviewer: it is created `0700`, refused if another user owns it, and an
  entry is used only if this user owns it. Without `REVIEW_AGENT_SKILL_CACHE`, the App's runner uses
  `review-agent-skills-<uid>` under the temp directory, and the CLI this OS's cache directory (see
  [the CLI's variables](cli.md#environment-variables)). Nothing is created when no skill is configured.
- No skill ships with the product; the built-in review instructions are part of the engine, not a skill.

A skill's id is its `path` (for `dir`) or `repo@ref` plus `#path` (for `git`); its short name is the last path segment
before `@` or `#`. The repository file can select among the deployment's skills by either.

## The repository file

A repository can tell the reviewer what matters to it by committing `.review-agent/review.md`. It is optional, read
from the pull request's **base** branch, and has an optional front-matter block followed by free text:

```markdown
---
postInlineAtOrAbove: 7
mode: summary-only
skills: [security-pass]
---
This service handles payments. Pay particular attention to:

- rounding of amounts (we always use integer pence);
- anything that changes how idempotency keys are built;
- error messages that could leak a card number.
```

| Key | Values | Effect |
|---|---|---|
| `postInlineAtOrAbove` | 1–10 | may **raise** the inline threshold; a value below the deployment's is ignored |
| `mode` | a [reporting mode](#reporting-modes) | may make the review **quieter**; a louder mode is ignored |
| `skills` | a name, or a list of names | **selects** among the deployment's skills; it can never add one. An empty list selects none |
| *the text after the front matter* | free text | added to the review instructions, after the deployment's own. Up to 10,000 characters are used |

Anything else in the front matter — `model`, `budgetUsd`, a gate — is ignored: those belong to whoever pays for the
run. An invalid value is ignored too, never an error, so a broken file costs a repository its preferences and not its
review. The front matter is a small `key: value` / `key: [a, b]` / list-of-`- item` format, not full YAML.

## The request

A person asks for a review in a pull request comment, with flags on the first line:

```
/review --tier normal --effort high
Please look hard at the migration: it runs on a table with 40M rows.
```

| Flag | Values | Effect |
|---|---|---|
| `--tier` | `basic` \| `normal` | the tier. `--tier thorough` is refused and named in the summary |
| `--effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | the effort |
| `--model` | any name | the model |
| `--budget` | dollars | a **lower** soft budget; a higher one is ignored and named in the summary |
| `--check` / `--skip-check` | — | turn the check pass on or off; if both appear, the last wins |
| `--multi` | — | refused and named in the summary: the fan-out is not built |

`--flag=value` works too. Every word on the first line that is not a flag, and every line after it, becomes the
**brief**: a note to the reviewer, fenced off as data in its prompt. An invalid value is not used, and the summary
says which one and why — a refusal is never silent. Full detail: [using it on pull requests](pull-requests.md).

## Order of precedence, in one place

| Setting | Decided by |
|---|---|
| tier, model, effort, check pass | the request, else the tier, else the deployment |
| budget | the tier, or a **lower** value from the request |
| reporting mode | the deployment, or a **quieter** mode from the repository file |
| inline threshold | the **higher** of the deployment's and the repository file's |
| skills | the deployment's list, narrowed by the repository file |
| instructions | the built-in rules, then the deployment's `instructions`, then the repository file's text |
| gate, severity bands, check-run name, caps | the deployment only |

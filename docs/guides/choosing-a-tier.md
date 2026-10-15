# Choosing a tier

At the end of this guide you will know which tier to ask for on a given pull request, when several reviewers are worth
their cost, how the budgets work, and what each choice has cost when it was measured. Every example uses the pull
requests of the public demo repository
[`crissmoldovan/review-agent-demo`](https://github.com/crissmoldovan/review-agent-demo), so you can run them yourself
([spec 0.2.0 §8](../specs/0.2.0-ways-in.md#8-tiers-what-they-are-and-when-to-use-which)).

## What a tier is

A tier says **how deep one reviewer goes**: the effort the model spends thinking before it answers, and how much it may
spend doing it. It is not a list of extra checks — every tier reads the same whole repository with the same rules, and
every tier runs the check pass that tries to disprove each finding.

| Tier | Effort | Check pass | Soft budget → hard ceiling | Check pass's own | Measured (per-token API prices, `claude-opus-5`) | Use it for |
|---|---|---|---|---|---|---|
| `basic` | `low` | on | $2.00 → $5.00 | $0.50 → $1.25 | $0.88–1.06 and 2–5 minutes on real production pull requests, plus $0.07–0.58 for the check pass; $0.16–0.29 for a whole review of a one-file pull request | **every pull request**. The default, and what automatic reviews use |
| `normal` | `medium` | on | $3.00 → $7.50 | $0.75 → $1.88 | $1.57–1.67 and 4–7 minutes, before the check pass | a change where a missed bug is expensive: money, authentication, permissions, data migrations, concurrency, a public API |
| `thorough` | `high` | on | $8.00 → $20.00 | $2.00 → $5.00 | **not measured** yet | the change you would ask your most senior engineer to read line by line: security-critical code, a large refactor, a release branch |

The figures are model spend at **per-token API prices** — what an Anthropic API key is billed — measured on real pull
requests ([what it costs](../../README.md#what-it-costs)). With a subscription token the same amounts are drawn from the
subscription's allowance instead. With the built-in settings the tiers mean the same in the App, the CLI, the SDK and
the GitHub Actions workflow; a deployment can change its own tier table ([configuration](../configuration.md#tiers)).

## Start with `basic`

Review every pull request at `basic`, and turn it up for the pull request that deserves it, by asking:

```text
/review --tier normal
```

in a pull request comment (an App deployment, your own server, or the GitHub Actions workflow), or
`--tier normal` on the command line. A note for the reviewer goes after the flags, or on the lines below them:

```text
/review --tier normal
The refund amount is now computed in minor units. Check every place that rounds.
```

## A higher tier is not "more findings"

It is more reading before answering. **Measured:** on one pull request the same model found five issues at `low`
effort and none at `medium` ([spec 0.2.0 §8.2](../specs/0.2.0-ways-in.md#82-guidance-the-docs-will-give-with-examples)).
One review is a sample: the same model can find different things on two runs of the same pull request.

So for an important change, **two `basic` reviews can tell you more than one `normal`**, and cost about the same: at
the measured figures, two `basic` reviews of a real pull request come to $1.76–2.12 before their check passes, and one
`normal` review to $1.57–1.67 before its own. Read what each found, and what the check pass said about it.

## Worked examples

The demo repository's pull requests, and the tier each calls for:

| Pull request | Tier | Why |
|---|---|---|
| [#1](https://github.com/crissmoldovan/review-agent-demo/pull/1) `feat/order-notes` — no known problem | `basic` | small, local, easy to check. "No findings" is an answer: a well-formed empty list is a review that worked |
| [#2](https://github.com/crissmoldovan/review-agent-demo/pull/2) `feat/currency-display` — a JPY formatting bug | `basic` | display code, local to one feature; [your first review](first-review.md) |
| [#3](https://github.com/crissmoldovan/review-agent-demo/pull/3) `fix/refund-rounding` — a rounding bug in money | `normal` | money: a subtle bug is costly, and worth more reading |
| [#4](https://github.com/crissmoldovan/review-agent-demo/pull/4) `feat/session-rotation` — a security flaw | `thorough`, or `--multi` | security-critical, and every caller of the session is affected |
| [#5](https://github.com/crissmoldovan/review-agent-demo/pull/5) `chore/bump-zod` — a version bump | none | nothing to review but a version. An App deployment and [your own server](self-hosting.md) skip it automatically, because every changed file is a release file. The CLI and the GitHub Actions workflow have no such rule — they review what they are pointed at — so do not ask |
| [#6](https://github.com/crissmoldovan/review-agent-demo/pull/6) `feat/retry-backoff` — an off-by-one, then a fix | `basic`, then a re-review after the fix | the second posted review asks whether the first one's findings are still there ([re-reviews](post-as-yourself.md#6-review-again-after-a-change)) |
| a 4,000-line generated client, with a small hand-written wrapper | `basic`, with a brief pointing at the hand-written part | effort spent on generated code is wasted |

For the last, the brief is a note to the reviewer — information that can point its attention, never a change to its
rules:

```sh
review-agent review --repo acme/widgets --pr 128 --brief "src/client/ is generated from openapi.yaml; review src/wrapper.ts and how it calls the client"
```

The commands below are the captured runs of the first four rows, the same in a POSIX shell and in PowerShell. Each
prints the review, as [your first review](first-review.md#7-read-the-output) explains.

### `basic`: pull request #2

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 2
```

<!-- capture: tier-basic-pr2-stdout — stdout of `review-agent review --repo crissmoldovan/review-agent-demo --pr 2` on macOS, full. The same run as first-review-pr2-stdout may be used. Version and date. -->
*(captured output will appear here)*

### `normal`: pull request #3

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 3 --tier normal
```

<!-- capture: tier-normal-pr3-stdout — stdout of `review-agent review --repo crissmoldovan/review-agent-demo --pr 3 --tier normal` on macOS, full. Version and date. -->
*(captured output will appear here)*

### `thorough`: pull request #4

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 4 --tier thorough
```

<!-- capture: tier-thorough-pr4-stdout — stdout of `review-agent review --repo crissmoldovan/review-agent-demo --pr 4 --tier thorough` on macOS, full. This is the first measured `thorough` review: keep its cost line. Version and date. -->
*(captured output will appear here)*

### Three focused reviewers: pull request #4

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 4 --multi
```

<!-- capture: tier-multi-pr4-output — stderr and stdout, in order, of `review-agent review --repo crissmoldovan/review-agent-demo --pr 4 --multi` (the default tier, basic) on macOS, full — stderr carries the "running 3 focused reviewers …" line and any reviewer that did not answer. The cost line is the three reviewers and the check pass together. Version and date. -->
*(captured output will appear here)*

<!-- capture: tier-measured-costs — after the four runs above: each one's cost line (total, check, seconds) in one list, with the review-agent and Claude Code versions and the date, to fill in "on the demo repository" figures in the tables of this guide. -->
*(captured output will appear here)*

**If you see this instead**

| Output | Cause, and the fix |
|---|---|
| `CUT SHORT: the hard ceiling fired; this review is partial.`, exit `1` | the review reached its tier's ceiling. What it found by then is printed above the line. A higher tier, or a brief that narrows the review |
| `--tier must be one of basic, normal, thorough, got "…"`, exit `2` | a tier that does not exist |
| `ignored, the deployment does not allow it: budgetUsd` | a `--budget` above the tier's; the review ran at the tier's budget ([budgets](#budgets)) |
| on a posted review, **Not honoured** — `` `--multi` — this deployment does not run several reviewers on one review, so one reviewer ran. `` | the deployment switched the multi-reviewer mode off |
| the GitHub Actions workflow warns `--tier takes basic, normal or thorough; reviewing at the default tier.` | the comment named another tier |

More: [troubleshooting](troubleshooting.md).

## Several reviewers: the multi-reviewer mode

**What it is.** Instead of one reviewer looking at everything, three run side by side, each told to look for one kind
of problem: **intent** (does the change do what it says, and correctly), **impact** (what else it breaks or silently
changes) and **security**. Their findings go through **one** check pass, which also marks a finding that repeats
another, so a problem two reviewers found is said once. The tier still says how deep each reviewer goes; `--multi` says
how many perspectives. They combine: `--multi --tier normal` is three focused reviewers, each at `medium` effort.

**When to use it.** A change that is both risky and wide — it touches several areas, or is the kind where one reviewer
tends to spend its whole budget on one sort of problem. Not by default: it costs several reviews.

**What it costs.** Each reviewer has the tier's whole soft budget and its own hard ceiling, so the three may spend up
to **three times the tier's ceiling** between them — $15 at `basic`, $22.50 at `normal`, $60 at `thorough` — plus one
check pass, whose budget is the usual quarter of the tier's soft budget for each reviewer that reported a finding (up to
$1.50, ceiling $3.75, at `basic`). Its cost on this release is **not measured**. The one trial before it — three focused
`claude-opus-5` reviewers and a check pass, at per-token API prices, on 2026-09-12 — went like this: on one pull
request two reviewers finished and found 7 findings (4 confirmed, 2 refuted) for $2.84, and $2.10 was lost on the
third; on another all three were stopped by the ceiling and returned nothing, $5.91
([spec 0.2.0 §8.3](../specs/0.2.0-ways-in.md#83-the-multi-reviewer-mode-new-in-020)). The mode is built so that a
reviewer stopped by its ceiling keeps what it wrote, and one that fails does not fail the review.

**How you will see it.** The posted summary has a line under the automated one —
`Three focused reviewers: intent ✓ · impact ✓ (cut short) · security ✗ (did not finish)` — and each inline comment
names the focus that found it. From the command line, stderr says how many run and their ceiling:
`running 3 focused reviewers (intent, impact, security), 3 at a time, each with this tier's budget: up to $5.00 apiece
at per-token API prices`.

**Who can ask.** Only a request runs it, never an automatic review. In the App and on your own server, only someone
with push access can ask, and a deployment can switch it off (`allowMulti: false`): then `--multi` is listed under
**Not honoured** and one reviewer runs ([configuration](../configuration.md#the-multi-reviewer-mode)). The GitHub
Actions workflow reads only `--tier` from a comment.

**Memory.** Each reviewer is a Claude Code process of its own, and one review was measured at roughly 300–400 MiB at
its peak ([spec 0.2.0 §9.2](../specs/0.2.0-ways-in.md#92-per-environment)). The CLI runs the three at once; the SDK
takes `multi: { concurrency: 1 }` to run them one at a time; the App's runner on trigger.dev runs each as a child task
on a machine of its own.

## Budgets

- The **soft budget** is told to the model in its instructions. It is advisory.
- The **hard ceiling** is 2.5 times the soft budget, passed to Claude Code as `--max-budget-usd`. When it is reached
  the run stops, and whatever the review produced is still reported, marked as **cut short**. From the command line a
  cut-short review prints `CUT SHORT: the hard ceiling fired; this review is partial.` and exits `1`.
- The **check pass** gets a quarter of the soft budget as its own target, and 2.5 times that as its ceiling. It costs
  nothing when there are no findings to check.
- The **re-review pass**, on a later posted review, gets the same, and runs only when its ceiling still fits under the
  review's ceiling after what has been spent.
- A request may **lower** the budget, never raise it:

  ```sh
  review-agent review --repo crissmoldovan/review-agent-demo --pr 3 --tier normal --budget 1.50
  ```

  gives a $1.50 soft budget and a $3.75 ceiling. A value above the tier's is ignored: the CLI says
  `ignored, the deployment does not allow it: budgetUsd` on stderr, and a posted summary lists it under
  **Not honoured**. A lower budget makes a cut-short review more likely, not a cheaper review of the same depth.

Every detail: [budgets](../configuration.md#budgets).

## Asking for it, every way in

| Way in | A tier | Several reviewers | A lower budget | A note |
|---|---|---|---|---|
| [The CLI](../cli.md#options) | `--tier normal` | `--multi` | `--budget 1.50` | `--brief "…"` |
| A comment, to an [App](../pull-requests.md#asking-for-a-review) or [your own server](self-hosting.md) | `/review --tier normal` | `/review --multi` | `/review --budget 1.50` | the words after the flags, and the lines below |
| A comment, to the [GitHub Actions workflow](github-actions.md#asking-for-another-review) | `/review --tier normal` | — | — | — |
| [The SDK](../sdk.md#options) | `tier: 'normal'` | `multi: true` | `budgetUsd: 1.5` | `brief: '…'` |

`--effort` (and the SDK's `effort`) overrides the tier's effort and keeps the tier's budget. An automatic review — a
pull request opening — is always `basic`, one reviewer.

## What it costs, in one place

| What | Who charges | How much |
|---|---|---|
| `basic` | Anthropic — **per-token API prices** | **measured**: $0.88–1.06 per review of a real production pull request, plus $0.07–0.58 for its check pass; $0.16–0.29 in all for a one-file pull request. Ceilings $5.00 and $1.25 |
| `normal` | the same | **measured**: $1.57–1.67 before the check pass. Ceilings $7.50 and $1.88 |
| `thorough` | the same | **not measured**. Ceilings $20.00 and $5.00 |
| `--multi` | the same | **not measured** on this release; up to three times the tier's ceiling, plus the check pass. One earlier trial: $2.84 and $5.91 |
| any of the above, on a subscription | the subscription — **its allowance** | the same amounts, drawn from the allowance rather than billed |

Each review prints, and each posted summary says, what it cost.

## Next steps

- [Your first review](first-review.md), at `basic`.
- [Post a review as yourself](post-as-yourself.md), and ask for re-reviews.
- [Configuration](../configuration.md#tiers): a deployment's own tier table, and the gate.

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
| `basic` | `low` | on | $2.00 → $5.00 | $0.50 → $1.25 | $0.88–1.06 and 2–5 minutes on real production pull requests, plus $0.07–0.58 for the check pass; $0.16–0.29 for a whole review of a one-file pull request. **Measured 2026-10-15 on the demo's small pull requests, per-token API prices:** $0.20–0.44 in all, check pass ($0.08–0.16) included — 5 runs | **every pull request**. The default, and what automatic reviews use |
| `normal` | `medium` | on | $3.00 → $7.50 | $0.75 → $1.88 | $1.57–1.67 and 4–7 minutes, before the check pass. **Measured 2026-10-15 on the demo's small pull requests, per-token API prices:** $0.56–0.62 in all, check pass ($0.26–0.29) included — 2 runs | a change where a missed bug is expensive: money, authentication, permissions, data migrations, concurrency, a public API |
| `thorough` | `high` | on | $8.00 → $20.00 | $2.00 → $5.00 | **Measured 2026-10-15 on the demo's small pull requests, per-token API prices:** $0.62–0.89 in all, check pass ($0.24–0.37) included — 2 runs, both with the soft budget lowered to $4.00 (`--budget 4`). Not yet measured on a production pull request | the change you would ask your most senior engineer to read line by line: security-critical code, a large refactor, a release branch |

The figures are model spend at **per-token API prices** — what an Anthropic API key is billed — measured on real pull
requests ([what it costs](../../README.md#what-it-costs)) and on the demo's
([what the runs cost](#what-the-runs-cost)). With a subscription token the same amounts are drawn from the
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
| [#7](https://github.com/crissmoldovan/review-agent-demo/pull/7) `feat/order-notes` — no known problem | `basic` | small, local, easy to check. "No findings" is an answer: a well-formed empty list is a review that worked |
| [#8](https://github.com/crissmoldovan/review-agent-demo/pull/8) `feat/currency-display` — a JPY formatting bug | `basic` | display code, local to one feature; [your first review](first-review.md) |
| [#9](https://github.com/crissmoldovan/review-agent-demo/pull/9) `fix/refund-rounding` — a rounding bug in money | `normal` | money: a subtle bug is costly, and worth more reading |
| [#10](https://github.com/crissmoldovan/review-agent-demo/pull/10) `feat/session-rotation` — a security flaw | `thorough`, or `--multi` | security-critical, and every caller of the session is affected |
| [#11](https://github.com/crissmoldovan/review-agent-demo/pull/11) `chore/bump-zod` — a version bump | none | nothing to review but a version. An App deployment and [your own server](self-hosting.md) skip it automatically, because every changed file is a release file. The CLI and the GitHub Actions workflow have no such rule — they review what they are pointed at — so do not ask |
| [#13](https://github.com/crissmoldovan/review-agent-demo/pull/13) `feat/retry-backoff` — an off-by-one, then a fix | `basic`, then a re-review after the fix | the second posted review asks whether the first one's findings are still there ([re-reviews](post-as-yourself.md#6-review-again-after-a-change)) |
| a 4,000-line generated client, with a small hand-written wrapper | `basic`, with a brief pointing at the hand-written part | effort spent on generated code is wasted |

For the last, the brief is a note to the reviewer — information that can point its attention, never a change to its
rules:

```sh
review-agent review --repo acme/widgets --pr 128 --brief "src/client/ is generated from openapi.yaml; review src/wrapper.ts and how it calls the client"
```

The commands below are the captured runs of #8, #9 and #10 — #10 twice, at `thorough` and with three reviewers — the
same in a POSIX shell and in PowerShell. Each prints the review, as [your first
review](first-review.md#7-read-the-output)
explains.

### `basic`: pull request #8

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 8
```

```text
crissmoldovan/review-agent-demo#8 at ff7bcec — tier basic, claude-opus-5, effort low

Adds `src/format.ts` with `formatMoney()` (en-US, sign before symbol) plus unit tests, and includes a `totalDisplay` string alongside the integer `total` in the single-order response. The integer `total` is preserved, and the comment correctly warns nothing should parse the display string back. Two gaps against the brief: `formatMoney` divides by 100 for all currencies, so JPY totals render 100x too small, and `serializeOrderSummary` (used by `GET /orders`) was not updated, so the console still needs its own formatter.

intent: partial — formatMoney and its tests exist as described, and serializeOrder gained totalDisplay. But the brief's "every order response" and "the console can drop its own formatter" are not met: GET /orders summaries (and refunds) still return raw integers only. formatMoney is also wrong for JPY, a currency the service accepts.

  [7/10 correctness] src/format.ts:16 formatMoney hardcodes 2 minor units, so JPY amounts are 100x too small [check: confirmed]
  [5/10 intent] src/http/serialize.ts:36 Brief says "every order response" carries totalDisplay, but the list response does not [check: confirmed]
  [3/10 intent] src/http/serialize.ts:46 Refund responses still carry an unformatted total [check: confirmed]
  [3/10 correctness] src/format.ts:15 Negative amounts between -0.005 and 0 would print "-" with a zero value [check: refuted]
  [?] Are JPY orders actually created in practice, or is JPY dead configuration? — would be settled by: Order-creation validation or fixtures showing whether JPY is reachable; `isCurrency` suggests it is, but no JPY order fixture was read.
  [?] Does the console actually read totalDisplay and drop its formatter in this PR's companion client change? — would be settled by: The console/client source, which is not in this checkout.

$0.25 model spend at per-token API prices · 7 turns · 38s · check $0.11
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*
Stderr was empty.

### `normal`: pull request #9

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 9 --tier normal
```

```text
crissmoldovan/review-agent-demo#9 at 2084466 — tier normal, claude-opus-5, effort medium

The PR replaces the exact largest-remainder `allocate()` split in `planRefund` with an independent per-line `Math.round(amount * remaining / outstanding)`, so finance can recompute a line's share from that line alone, and adds one test. The locality goal is met, but the claim that the shares always sum to the refund is wrong: independent rounding over- or under-shoots (three equal lines refunded 1000 give 333+333+333=999), breaking the documented `Refund.total === sum(lines)` invariant that the API exposes and that the refundable/remaining bookkeeping relies on. The resulting drift between recorded line amounts and refund totals makes two further states reachable: a line allocated more than it has left, and `outstanding === 0` yielding NaN shares and a provider refund recorded with no lines at all. The added test passes only because the single case it picks is one where the two roundings cancel.

intent: partial — The code does switch to per-line `round(amount * remaining / outstanding)`, which is the locally recomputable formula the brief describes, and it leaves the refundable check and the provider call untouched. But the brief's central correctness claim — that the rounding differences cancel so the lines always equal the refund — is false, and the added test only covers an input where they happen to cancel.

  [9/10 correctness] src/refunds.ts:61 Independently rounded shares do not sum to the refund total [check: confirmed]
  [7/10 correctness] src/refunds.ts:57 outstanding === 0 produces NaN shares and a refund with no lines, instead of an error [check: confirmed]
  [6/10 correctness] src/refunds.ts:61 A line can be allocated more than it has left to refund [check: confirmed]
  [4/10 correctness] src/refunds.ts:61 Loses the BigInt-exact multiplication that allocate() provided [check: confirmed]
  [5/10 intent] src/refunds.ts:58 Comment and docstring assert an invariant the code no longer holds [check: confirmed]
  [?] Is there a downstream consumer (ledger, export, reconciliation job) outside this repo that asserts sum(refund.lines) === refund.total? — would be settled by: Within the checkout, only src/http/serialize.ts:43 reads the lines; checking the consumers of that endpoint would show whether the broken invariant fails loudly or silently.
  [?] Would finance accept a cumulative-prefix formula (share_i = round(amount*prefix_i/outstanding) - round(amount*prefix_{i-1}/outstanding)), which ties out exactly but needs the preceding lines' remainders? — would be settled by: Clarification from the requester about whether "from that line alone" must exclude the running total of earlier lines.

$0.56 model spend at per-token API prices · 7 turns · 89s · check $0.26
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*
Stderr was empty.

### `thorough`: pull request #10

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 10 --tier thorough --budget 4
```

**The capture below was run with `--budget 4`**: half the tier's $8.00 soft budget, so a $10.00 ceiling, to keep the
paid captures for these guides under a $15 cap. Leave `--budget 4` out to give the review the tier's whole budget. The
model is told its soft budget, so with the full $8.00 it may read more, and cost more, than this run did.

```text
crissmoldovan/review-agent-demo#10 at 2c2fea0 — tier thorough, claude-opus-5, effort high

The PR replaces the single session secret with a keyring: tokens become `<key id>.<payload>.<signature>`, the key id is covered by the HMAC, `SESSION_KEYS` parses `id:secret` pairs with the current key first, and a bare `SESSION_SECRET` is adapted into a one-key ring named `default`. The structure is sound — the key id is bound into the signed data, ids are validated so they cannot contain `.`, and duplicate ids are rejected. Two things do not hold up: the previous-key verification branch skips the expiry check entirely, so pre-rotation tokens are accepted forever, and `POST /sessions/refresh` was never migrated off `config.sessionSecret`, so every refresh fails with 401 once `SESSION_KEYS` is in use. Both contradict the brief ("keep working until they expire", "existing callers did not need to change"), and neither is covered by the new tests.

intent: partial — The keyring, token format, SESSION_KEYS parsing and SESSION_SECRET fallback all land as described, and the three promised tests exist. But two brief claims are not borne out by the code: tokens signed with a previous key do not stop working when they expire (src/sessions.ts:59 skips the expiry check), and not all existing callers kept working — src/http/routes/sessions.ts:22 still passes the bare secret and now rejects every token under a real keyring. The title's "without logging anyone out" also does not cover the deploy itself: the format change invalidates all tokens issued before it.

  [9/10 security] src/sessions.ts:59 Tokens signed with a previous key are never checked for expiry [check: confirmed]
  [8/10 correctness] src/http/routes/sessions.ts:22 `POST /sessions/refresh` was not migrated to the keyring and rejects every token when SESSION_KEYS is set [check: confirmed]
  [4/10 security] src/sessions.ts:58 Previous-key signature compared with `!==` instead of `timingSafeEqual` [check: confirmed]
  [5/10 impact] src/sessions.ts:52 The token format change logs every operator out at deploy time [check: confirmed]
  [3/10 impact] src/config.ts:14 The deprecated `sessionSecret` field keeps a wrong-by-construction value reachable [check: confirmed]
  [?] Is there a deploy/rollout process that would need both SESSION_SECRET and SESSION_KEYS set during a transition, or any infrastructure config (compose, k8s manifests, CI env) that sets SESSION_SECRET and would need updating? — would be settled by: The repository contains no deployment manifests or CI workflow files setting these variables (only README.md documents them); checking the actual deployment configuration outside this repo would settle it.
  [?] Does `loadConfig` have tests asserting the old error text 'SESSION_SECRET must be at least 32 characters', which `longSecret` changed to 'SESSION_SECRET: every secret must be at least 32 characters'? — would be settled by: No test file references `loadConfig` (grepped test/), so nothing in-repo breaks; any external monitoring or runbook matching that string would need checking.

$0.62 model spend at per-token API prices · 10 turns · 93s · check $0.24
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*
Stderr was empty.

### Three focused reviewers: pull request #10

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 10 --multi --budget 1
```

**The capture below was run with `--budget 1`**, for the same $15 cap: each reviewer was told $1.00, with a $2.50
ceiling apiece — the figure on its stderr line. Leave `--budget 1` out to give each reviewer the tier's whole budget
($2.00, ceiling $5.00, at `basic`).

stderr:

```text
running 3 focused reviewers (intent, impact, security), 3 at a time, each with this tier's budget: up to $2.50 apiece at per-token API prices
```

stdout:

```text
crissmoldovan/review-agent-demo#10 at 2c2fea0 — tier basic, claude-opus-5, effort low

The PR adds a session keyring: tokens become `<key id>.<payload>.<signature>`, `SESSION_KEYS` supplies `id:secret` pairs with the current key first, and a bare `SESSION_SECRET` is mapped to a single key named `default`, so existing callers and deployments keep working. The structure, config parsing and backward compatibility all match the brief. However the verification path for previous keys skips the expiry check entirely, so tokens signed before a rotation never expire — the opposite of what the brief promises — and that path also drops the constant-time signature comparison used for the current key.

intent: partial — Keyring, token format, rotation support and SESSION_SECRET fallback are implemented as described. The brief's claim that previous-key tokens "keep working until they expire" is not met: they keep working indefinitely because the previous-key branch omits the exp check.

  [9/10 correctness · intent reviewer] src/sessions.ts:59 Tokens signed with a previous key are never checked for expiry [check: confirmed · also found by impact, security]
  [4/10 correctness · intent reviewer] src/sessions.ts:58 Previous-key signature compared with `!==` instead of timingSafeEqual [check: confirmed · also found by security]
  [3/10 correctness · intent reviewer] test/sessions.test.ts:44 No test that an expired previous-key token is rejected [check: confirmed]
  [8/10 impact] src/http/routes/sessions.ts:22 /sessions/refresh still verifies against the bare `sessionSecret`, so it rejects every token once `SESSION_KEYS` is used [check: confirmed]
  [6/10 impact] src/sessions.ts:51 Token format change logs out every existing session at deploy time [check: confirmed]
  (4 duplicates merged — found by more than one reviewer; all are in --json)
  [?] Is there a documented deploy procedure that tolerates invalidating all in-flight tokens at the format switch? — would be settled by: Deploy/runbook docs or a session-TTL drain step; the README change doesn't mention it.

$0.67 model spend at per-token API prices · 14 turns · 86s · check $0.18
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*
The cost line is the three reviewers and the check pass together; its seconds are the three reviewers' times added up,
not the wall clock.

**If you see this instead**

| Output | Cause, and the fix |
|---|---|
| `CUT SHORT: the hard ceiling fired; this review is partial.`, exit `1` | the review reached its tier's ceiling. What it found by then is printed above the line. A higher tier, or a brief that narrows the review |
| `--tier must be one of basic, normal, thorough, got "…"`, exit `2` | a tier that does not exist |
| `ignored, the deployment does not allow it: budgetUsd` | a `--budget` above the tier's; the review ran at the tier's budget ([budgets](#budgets)) |
| on a posted review, **Not honoured** — `` `--multi` — this deployment does not run several reviewers on one review, so one reviewer ran. `` | the deployment switched the multi-reviewer mode off |
| the GitHub Actions workflow warns `--tier takes basic, normal or thorough; reviewing at the default tier.` | the comment named another tier |

More: [troubleshooting](troubleshooting.md).

### What the runs cost

The runs above, the other runs of these guides, and the earlier runs of the same pull requests. Every figure is model
spend at **per-token API prices**, as each run's cost line or `--json` record gave it; each run
was paid with the machine's Claude login, so a subscription's allowance was drawn rather than an API key billed.

| Run | Tier and flags | Pull request | Total | Check pass | Reviewer's time | Findings |
|---|---|---|---|---|---|---|
| [`basic`](#basic-pull-request-8) | `basic` | #8 | $0.25 | $0.11 | 38 s | 4: 3 confirmed, 1 refuted |
| [`basic`, `--json`](first-review.md#8-the-same-review-as-json) | `basic` | #8 | $0.30 | $0.12 | 44 s | 3: 2 confirmed, 1 refuted |
| [`normal`](#normal-pull-request-9) | `normal` | #9 | $0.56 | $0.26 | 89 s | 5, all confirmed |
| [`thorough`](#thorough-pull-request-10) | `thorough --budget 4` | #10 | $0.62 | $0.24 | 93 s | 5, all confirmed |
| [three reviewers](#three-focused-reviewers-pull-request-10) | `--multi --budget 1`, at `basic` | #10 | $0.67 | $0.18 | 86 s, the three added up | 5 listed, all confirmed, after 4 duplicates merged |
| [first post](post-as-yourself.md#2-post-the-review) | `basic --post` | #13 | $0.33 | $0.11 | 43 s | 4, all confirmed |
| [re-review, after the fix](post-as-yourself.md#6-review-again-after-a-change) | `basic --post` | #13 | $0.49, of which the re-review pass $0.16 | $0.12 | 44 s | 3: 2 confirmed, 1 refuted |
| earlier run | `basic` | #2 | $0.44 | $0.16 | 50 s | 2, both confirmed |
| earlier run | `basic`, `--json` | #2 | $0.20 | $0.08 | 27 s | 3, all confirmed |
| earlier run | `normal` | #3 | $0.62 | $0.29 | 75 s | 5, all confirmed |
| earlier run | `thorough --budget 4` | #4 | $0.89 | $0.37 | 132 s | 7, all confirmed |
| earlier run | `--multi --budget 1`, at `basic` | #4 | $0.72 | $0.17 | 116 s, the three added up | 7 listed, all confirmed, after 2 duplicates merged |

*Measured 2026-10-15 · `claude-opus-5` · Claude Code 2.1.289 on macOS · review-agent 0.2.0 (release build from
`feat/0.2.0`) for the first seven rows. The **earlier runs** were made the same morning on an earlier build of the same
branch, against the same demo branches, which were pull requests #2–#4 before they were opened again as #8–#10.*

- **Total** is the whole review — every pass, the check pass included. **Reviewer's time** is the seconds on the cost
  line: the reviewer's own, without the check pass; for `--multi` it is the three reviewers' times added up, not the
  wall clock. End to end, as the capture script timed them, the four runs above took 60 s (`basic`), 153 s
  (`normal`), 141 s (`thorough`) and 66 s (`--multi`).
- **Findings** are what the reviewer listed, and the check pass's verdict on each.
- The `thorough` and `--multi` runs had their budgets lowered (above). Two runs of a tier are a sample, and these pull
  requests are small: a real production pull request has cost more ([the tiers](#what-a-tier-is)).

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
$1.50, ceiling $3.75, at `basic`). **Measured on this release**, 2026-10-15, on the demo's #10 at `basic` with each
reviewer's budget lowered to $1.00 (`--budget 1`): $0.67 and $0.72 in all, check pass included, at per-token API
prices — two runs, all three reviewers answering each time. The one trial before it — three focused
`claude-opus-5` reviewers and a check pass, at per-token API prices, on 2026-09-12 — went like this: on one pull
request two reviewers finished and found 7 findings (4 confirmed, 2 refuted) for $2.84, and $2.10 was lost on the
third; on another all three were stopped by the ceiling and returned nothing, $5.91
([spec 0.2.0 §8.3](../specs/0.2.0-ways-in.md#83-the-multi-reviewer-mode-new-in-020)). The mode is built so that a
reviewer stopped by its ceiling keeps what it wrote, and one that fails does not fail the review.

**How you will see it.** The posted summary has a line under the automated one —
`Three focused reviewers: intent ✓ · impact ✓ (cut short) · security ✗ (did not finish)` — and each inline comment
names the focus that found it. From the command line, stderr says how many run and their ceiling:
`running 3 focused reviewers (intent, impact, security), 3 at a time, each with this tier's budget: up to $5.00 apiece
at per-token API prices` — $2.50 in [the capture above](#three-focused-reviewers-pull-request-10), whose budget was
lowered to $1.00.

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
  review-agent review --repo crissmoldovan/review-agent-demo --pr 9 --tier normal --budget 1.50
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
| `basic` | Anthropic — **per-token API prices** | **measured**: $0.88–1.06 per review of a real production pull request, plus $0.07–0.58 for its check pass; $0.16–0.29 in all for a one-file pull request; $0.20–0.44 in all on the demo's small pull requests (2026-10-15). Ceilings $5.00 and $1.25 |
| `normal` | the same | **measured**: $1.57–1.67 before the check pass; $0.56–0.62 in all on the demo's small pull requests (2026-10-15). Ceilings $7.50 and $1.88 |
| `thorough` | the same | **measured** on the demo's small pull requests only (2026-10-15, with `--budget 4`): $0.62–0.89 in all. Ceilings $20.00 and $5.00 |
| `--multi` | the same | **measured** on the demo's small pull requests only (2026-10-15, at `basic` with `--budget 1`): $0.67–0.72 in all. Up to three times the tier's ceiling, plus the check pass. One earlier trial: $2.84 and $5.91 |
| the re-review pass, on a later posted review | the same | **measured once** (2026-10-15, demo #13, `basic`): $0.16. Ceiling $1.25 at `basic` |
| any of the above, on a subscription | the subscription — **its allowance** | the same amounts, drawn from the allowance rather than billed |

Each review prints, and each posted summary says, what it cost.

## Next steps

- [Your first review](first-review.md), at `basic`.
- [Post a review as yourself](post-as-yourself.md), and ask for re-reviews.
- [Configuration](../configuration.md#tiers): a deployment's own tier table, and the gate.

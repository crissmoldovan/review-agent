# review-agent — design, v0

> **This is the original v0 design record (written 2026-09-12, approved 2026-09-14), kept because the code cites it
> by section. It is not the current behaviour.** Where it differs, the reference pages in [docs/](.) and the
> [changelog](../CHANGELOG.md) are current. Known differences:
>
> - **Retries (§6).** A run now gets up to three attempts, so a run that dies after the model has spent can be paid
>   for more than once. §6 says one.
> - **Re-reviews (§5, "Re-review").** A later review no longer matches earlier findings against the new ones. A
>   separate pass asks the model whether each earlier finding is still present in the code. When a finding is judged
>   resolved, a note is appended to its inline comment. A `/dispute` or `/defer` reply outranks the model.
> - **`thorough` and `multi` (§3, §6).** The multi-reviewer fan-out is not built. The CLI runs `thorough` as one
>   reviewer at `high` effort. The App still refuses `thorough` and `multi` and names the refusal. A separate
>   multi-reviewer mode, not a tier, is planned for 0.2.0.
> - **The GitHub Action (§1, §2) is not built**, and there is no `action` package. The CLI prints a review and never
>   posts one.
> - **Skills (§4.7).** A skill source is a local directory or a GitHub repository at a ref, not a package or an
>   archive. No skill ships with the product. The built-in review instructions are versioned text inside the engine,
>   recorded on every review, not a skill.
> - **Deployment settings (§3, §3.1).** §3.1's table is not the full list: `report.maxFindings`,
>   `report.firstReviewLowBandCap` and the deployment's own `instructions` also exist. The App's runner takes its
>   settings from one function in its source, not from a configuration file. The record callback (§5) and the
>   sweep's repositories (§6) come from environment variables.
> - **Isolation (§4.3)** has one more rule: Claude Code is started by an absolute path that cannot be inside the
>   checkout.
> - **§11 item 5 is answered.** Claude Code runs in the runner's image, and a review of a one-file pull request
>   peaked at about 294 MiB on the 1 GB `small-2x` machine.

**Written:** 2026-09-12 · **Amended and approved:** 2026-09-14

## 0. What this is, and why it is its own repo

A PR reviewer that any organisation can deploy **inside its own environment**: their GitHub App, their
runner, their model credentials, their code never leaving their boundary.

It was first specified as one task inside a larger delivery pipeline built for a single organisation. It was taken
out and made a product with its own repository so that any organisation can deploy it inside its own environment,
and that pipeline became its first deployment. **What stays with a deployment, not in the product:** which
repositories are reviewed, any calibration data gathered from real reviews, and whatever acts on a finished review,
such as a merge gate, release notes or a step where a person decides.

**Ownership:** each deployment **registers its own GitHub App** from this repo's manifest, so each organisation's
App belongs to that organisation and not to an individual account. GitHub forced it: a private App *"can only be
installed on the account that owns the app"*.

**Licence:** open source, **Apache-2.0** — as permissive as MIT, plus an express patent grant and a notice
requirement, which matters for a tool companies deploy inside their own environment.

## 1. The three ways to deploy it

| Mode | What the adopter runs | Needs | Good for |
|---|---|---|---|
| **CLI** | `review-agent review --repo o/r --pr 9` on a laptop or in any CI | a model credential | trying it, one-off reviews, debugging the engine |
| **Action** | a workflow file that uses this repository's action | a repo secret | adopting it in one repo with no server and no App |
| **App + runner** | the App (registered from the manifest) + the webhook receiver + the trigger.dev tasks | hosting, a model credential | an organisation that wants every PR reviewed |

All three run the same engine and produce the same output. The Action mode inherits two limits from GitHub:
**a pull request from a fork gets no secrets**, so it cannot be reviewed this way, and because the workflow
file lives in the repo being reviewed, **a PR can edit its own reviewer**. The App mode has neither problem,
which is why it is the mode for an organisation that wants every pull request reviewed.

## 2. Packages

A pnpm monorepo, TypeScript, Node.

| Package | Contains | Knows about |
|---|---|---|
| `core` | the engine: checkout handling, the agent call, tiers, budgets, the findings format, the check pass, the secret scan, the review instructions | nothing about GitHub or hosting |
| `github` | fetch a PR and its source, post a review, the check run, re-review state | GitHub only |
| `cli` | `review-agent review`, `review-agent init` | core + github |
| `app` | the App manifest, `init` setup flow, the webhook receiver, the trigger.dev tasks | core + github |
| `action` | `action.yml` and a thin entrypoint that calls the CLI | cli |

The split lets the engine run and be measured without any App, and lets a deployment replace the hosting half
without touching the reviewing half. **Distribution:** the packages are **published publicly to npm** under
`@review-agent`, so a deployment's own webhook receiver can import the library.

## 3. A review request

One shape, whatever the doorway. It behaves like a command line because that is how it is invoked.

```ts
type ReviewRequest = {
  repo: string            // "owner/name"
  pr: number
  headSha: string
  tier: 'basic' | 'normal' | 'thorough'   // default from config
  multi: boolean          // several focused reviewers instead of one. default false
  model?: string          // e.g. "claude-opus-5"
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  check: boolean          // the disprove-it pass
  brief?: string          // extra context from the requester
  budgetUsd?: number      // soft target; the hard ceiling is derived. May lower, never raise
  requestedBy?: string    // login, when a person asked
  requestId?: string      // comment id, so asking twice always runs
}
```

**Tiers** are named presets, not separate code paths:

| Tier | Agents | Effort | Check | Soft budget | Measured (2026-09-12, Opus 5, per-token API prices) |
|---|---|---|---|---|---|
| `basic` | 1 | low | **on** | $2 | **$0.88–1.06** per review, 2–5 min, plus **$0.07–0.58** for the check (§4.6, §8) |
| `normal` | 1 | medium | on | $3 | $1.57–1.67 + check |
| `thorough` | coordinator + focused reviewers | high | on | set when built | not usable: the fan-out is not built |

The check is on in every tier, `basic` included — where every automatic review and bare `/review` lands —
because §4.6 is the cheapest correction the product has.

**Where settings come from**, later wins: built-in defaults → the deployment's configuration → the reviewed
repo's config file (§7, read from the **base** branch) → the request's own flags.

**What a request may not ask for:** `tier=thorough` and `multi` are **refused until the fan-out is built**
(§6), whichever doorway they come through — a comment, a Re-run, a payload triggered by hand. A refused flag
does **not** refuse the request: the review runs at the default tier with one reviewer, and the refusal is
**named in the summary**. It is carried explicitly, because a value the comment parser discards never reaches
`resolveSettings` and so never appears in `droppedRequestKeys`. `model` and `effort` stay open.

### 3.1 What a deployment configures

Everything about how a deployment reviews is configurable, including the severity levels and the mode of reporting.

| Setting | Default | What it does |
|---|---|---|
| `command` | `/review` | the word that invokes a review in a PR comment. A deployment may choose its own word |
| `severity.bands` | 9–10 critical · 7–8 high · 4–6 medium · 1–3 low | the names and the boundaries, both movable |
| `severity.postInlineAtOrAbove` | **5** | another reviewer posts at 7. No measured review reached 7, so 7 would have posted nothing on three real PRs (§8) |
| `report.mode` | `inline+summary` | or `summary-only`, `check-only`, or `silent` — which records the review and posts nothing |
| `report.maxInline` | 15 | inline comments; in `check-only` mode also the check run's annotations (§5) |
| `report.repeatNits` | `false` | low-severity findings are not re-posted on later reviews of the same PR |
| `report.checkRunName` | `review-agent` | the check run's name — an interface, because a ruleset requires a check by name. A deployment may set its own name |
| `report.failAtOrAbove` | **off** (`null`) | the gate: the check-adjusted severity at or above which a finished review concludes `failure` (§5). Deployment only |
| `report.gateRequiresConfirmed` | **off** | when on, only findings the check pass **confirmed** can fail the gate — `uncertain` no longer counts |
| `tiers` | §3's table | budgets, effort, model and check per tier |
| `model`, `effort` | Opus 5, low | per deployment; overridable per request |
| `skills` | none | trusted skill sources (§4.7) |
| `autoReview` | on open and first ready-for-review | or off, for request-only. Never on reopen (§5) |

Every value is recorded on the review's own record: two reviews are only comparable when the settings that
produced them are known.

## 4. The engine

### 4.1 What the reviewer sees

A working copy of the repository at the PR's head commit, **downloaded as an archive, not cloned**
(`GET /repos/{o}/{r}/tarball/{ref}`, contents:read) — an archive has no `.git`, so no remote URL and no token
can be left in it — plus the PR's title and description, the diff against the merge base, and the requester's
brief. Whole-repo reading is the point: the reviewer should try to understand how the change affects the rest of
the code, not only read the diff.

### 4.2 How the model is run

The **Claude Code CLI, headless**, one process per review:

```
claude -p --restricted --strict-mcp-config
        --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob"
        --model <model> --effort <effort> --max-budget-usd <ceiling>
        --no-session-persistence --exclude-dynamic-system-prompt-sections
        --output-format json --json-schema <findings schema>
        --append-system-prompt <review instructions>
        --plugin-dir <each trusted skill source>      # §4.7
```

**Not `--safe-mode`**: it disables every customisation, skills included, which would rule out §4.7.
`--restricted` does the protecting — it ignores user, project and local settings files.

**Why the CLI and not the Agent SDK:** `--restricted` confines the file tools to the working directory, and the
SDK has no equivalent; the CLI accepts either an API key or a subscription token — the only two kinds allowed
(§4.3) — while the SDK's documentation tells third parties to use API keys; and it is what was measured (§8).
The trade-off is that the deployment carries the CLI binary, and output is parsed from JSON.

### 4.3 Isolation — the rules, not the hopes

The reviewed code is written by whoever opened the PR. It is data, never instruction.

| Rule | Why |
|---|---|
| `--restricted`, so the reviewed repo's `.claude/settings.json` never loads | those settings can define **hooks**, which are commands. The Agent SDK loads them by default |
| no Bash, no write tools, no network tools | the review needs to read, nothing else |
| the process environment holds **only** the model credential | a model that can read files could otherwise read its own environment |
| the credential is an Anthropic API key **or** a subscription token, nothing else: `ANTHROPIC_AUTH_TOKEN` is not in the child's allowlist, and a set `ANTHROPIC_BASE_URL` **refuses the run** — in `core`, before anything is spawned, so the CLI, the Action and the runner all refuse | a gateway would carry the reviewed code somewhere other than Anthropic, and "the code never leaves their boundary" (§0) would be untrue in a way the adopter could not see |
| the review instructions come from this package, and the reviewed repo's config from the **base** branch | otherwise a PR edits the instructions that judge it |
| every finding's path is checked against the checkout before it is used | no model-written string addresses a resource |
| the output is scanned for secrets before posting | a review posts publicly |
| no model string is interpolated into a shell command or a URL path | a model-written string is data; interpolated, it would become a command or choose what is fetched |

### 4.4 Budgets — soft first, and partial results are kept

Measured 2026-09-12: four of six runs under a hard ceiling **returned nothing at all**, $9.54 as run — $8.01 at
per-token API prices — between them. A ceiling that kills a run is the wrong instrument.

1. **Soft target per tier**, **advisory**: the instructions ask the run to stop exploring and write up.
2. **Hard ceiling** at 2.5× the target, a runaway backstop. For `basic`: $2 target, $5 ceiling, until
   calibration data from real reviews says otherwise. The check pass is a second process with **its own** ceiling,
   2.5× a quarter of the target — $1.25 on `basic` — so a `basic` review with its check can reach $6.25 at
   per-token API prices.
3. **If the ceiling fires, whatever was produced is still posted**, marked as cut short.
4. Every run records cost, tokens, cached tokens, turns, duration and `wrapUpFired`, always `false`.

**The 70% wrap-up does not exist** (measured during development: five runs, $1.26 at per-token API prices): on
CLI 2.1.258 no hook event carries a spend, so it is known only once a run is over, and the ceiling is the only
brake. A +12,478-line pull request ran to **$4.94 against its $5 ceiling** at per-token API prices (2026-09-13).

### 4.5 Findings

```ts
type Finding = {
  file: string; line: number; endLine?: number
  severity: number          // 1–10. 9–10 critical · 7–8 high · 4–6 medium · 1–3 low
  category: 'intent' | 'correctness' | 'impact' | 'security'
  title: string; explanation: string
  evidence: string[]        // path:line the reviewer actually read
  suggestion?: string       // only when the fix is small and local
}
```

The review also returns a summary, an **intent verdict** — does the change do what its description says — and
an **inconclusive** list: what it could not settle, and what would settle it. Every measured review produced
inconclusive items, all needing running code, the internet, or a person; that list is what a future escalation
step would act on (§10). The output format accepts empty optional values: a run failed in measurement because
the model wrote `null` where the schema demanded a string.

### 4.6 The check pass

A second run that tries to **disprove** each finding, reading the code itself, and returns confirmed /
refuted / uncertain with its own severity. Measured: **$0.07–0.58** at per-token API prices (§8), 13–138 seconds;
on one set it rejected 2 of 7 findings. Cheap enough to leave on wherever findings are posted, so **it is on in
every tier** (§3).

**What a verdict does:** a **refuted** finding is never posted — it stays on the record — and a **confirmed**
or **uncertain** one is posted at the **check's** severity. That decides the inline threshold, the inline cap
and the low-band cap, so the check can only make a review say less. The first trial measured the reviewer
rating a guess 5 and a disclosed fact 7 while the check proposed 3 for both. `selectForPosting` takes the
verdicts with the findings they judged, matched by finding id.

**The gate reads the same adjusted set:** what can fail a check run is what survived the pass, at the check's
severities, refuted findings not counted. `report.gateRequiresConfirmed` (§3.1), off by default, narrows it to
confirmed findings. One rule decides what is said and what can fail the gate, so the gate can never fail a pull
request over a finding the reader was never shown.

### 4.7 The review instructions are a versioned skill — and skills plug in

The prompt is a file in this repo, versioned, and every review records which version it ran — tuning it is the
main quality lever. A deployment may add its own instructions (§7); it cannot replace the safety rules.

**External skills are supported, measured 2026-09-12.** A skill folder supplied by the deployment, lock-down on:
**loaded and ran**. A skill planted in the reviewed repository, lock-down on: **refused** ("Unknown command"). The
same planted skill with lock-down off: **offered to the model**, which declined only because the skill's own text
said so — judgement, not a control. So: **skills come from the deployment, never from the code being reviewed.** A
deployment lists trusted sources — a local directory, a git repo at a pinned ref, a package, an archive — mounted
read-only; the reviewed repo may *choose* among them, never add one; each run records the skills and versions it
used.

**In the box:** **one review skill built in**, used when nothing else is configured, plus **named external
skills a deployment can switch on**, and its own sources on top. Nothing is compulsory but §4.3's rules.

## 5. What it does on GitHub

**Triggers.** A review when a PR **opens**, or first leaves draft. Not on every push, and **not when it
reopens**: a review when a PR opens, then on request. After that, on request: a PR comment with the command
word (`/review` by default; a deployment may choose its own) carrying §3's flags, or the check run's "Re-run"
button, which repeats the last request. Release-only PRs — only version, changelog, `package.json` and lock
files — get no automatic review, so a JavaScript dependency bump gets none either; a comment still reviews any
of them.

**A request costs money, so the requester is checked first.** Inside the task, after the installation token is
minted and **before the archive download or the engine**, one API call reads GitHub's `user.permissions.push`
for the requester. Without push access the request is **refused, visibly**: a `neutral` check run on the head
commit names who asked and says nothing was spent, even in `silent` mode. It posts no comment, so nobody can
make the bot write to a PR just by commenting. The automatic path is untouched: any PR that opens is reviewed.

**Posting:**

- one **summary comment** naming the commit reviewed, the tier and model, the cost, and any finding that could
  not be placed inline;
- **inline comments** on changed lines only — GitHub requires the line to be in the diff — each carrying
  **Severity N/10**, with **suggested changes** as a ```` ```suggestion ```` block where the fix is small;
- a **check run**, concluded by the table below; in `check-only` mode, and only there, it **lists the findings
  as annotations** — capped at `report.maxInline`, at the check's severity, refuted ones dropped — and
  everywhere else it carries counts;
- in **every** mode, the hidden JSON verdict and, when the hard ceiling cut the run short, a line saying so: in
  the check run's output wherever one is posted, and in `silent`, which posts none, on the run's result and
  record;
- findings below the posting threshold are summarised, not commented.

**The check run's conclusion:**

| Outcome | Conclusion |
|---|---|
| a finished review with no findings | `success` |
| findings, all below the gate, or the gate off | `success` |
| findings, all filtered out — refuted by the check pass, or unplaceable | `success` |
| findings at or above `report.failAtOrAbove`, when the deployment has set it | `failure` |
| an error, a refused request (the push-access check above), or an abandoned run | `neutral` |

A finished review with nothing at the gate says `success`: `neutral` silently passes branch protection, so a
product that concluded it everywhere could never arm a gate. An abandoned run is `neutral`, whatever abandoned
it. A refused `thorough` or `multi` flag (§3) is not a refused request: that review runs and is concluded above.

**Re-review.** State lives in the PR, in a hidden marker inside the bot's own summary comment, so the product
needs no database. A re-review reads the marker and the replies in its own threads, marks each earlier finding
**fixed**, **still open**, **disputed** or **deferred**, and updates the summary in place.

**The finished record.** The product stores nothing. When a deployment names a callback, the finished
`ReviewRecord` is POSTed there once, after the review is published — signed with HMAC-SHA256 over the raw body
under a deployment secret, in GitHub's own `sha256=` shape, so the receiver checks it with the same
`verifySignature` it uses for webhooks. A callback that fails or times out is logged, and never fails, retries
or re-runs the review.

**Permissions of the App:** `checks: write`, `pull_requests: write`, `contents: read`, `metadata: read`,
`issues: read` — the last because GitHub delivers PR comments as `issue_comment`. Never `contents: write`: a
reviewer must never be able to change the code it reviews.

**Registration** is the manifest flow: `review-agent init` posts a manifest, GitHub asks the adopter to
confirm, and returns the App id, private key, webhook secret and client secret. **`init` keeps the App id and
discards all three secrets** — a credential never written cannot leak. It prints the instruction instead:
generate your own private key and webhook secret in the App's settings, put them into the deployment, then
**delete the registration-time private key and the client secret** so no unused credential is left behind. The
flow must complete within an hour.

## 6. The runner

**trigger.dev**, one task per review, machine `small-2x`, the CLI binary installed through a build extension.
Fan-out for the thorough tier uses `batchTriggerAndWait`; a waiting parent is checkpointed and not billed. A
deployment that prefers other hosting replaces this package only.

**`maxDuration` is required** — trigger.dev 4.5.16 refuses a config without it, minimum 5 seconds — and is set
high, as a backstop, because a `maxDuration` kill runs no lifecycle hook and cannot close the check run. The
task's **own wall-clock deadline is the primary stop**: it aborts the model and concludes the check run itself.

**trigger.dev retries nothing**: the project allows `maxAttempts: 1`, so no crash, SIGTERM, eviction or stall
after spend is paid for twice. A failure that spent nothing — a GitHub error before the engine, a crash with no
output at $0 — starts a new run on purpose, at most twice; a failed run clears its idempotency key, so the same
request can run again. **An hourly sweep** in the same project closes, as `neutral`, any check run of the
reviewer still `in_progress` an hour after it started on an open pull request of the repositories the
deployment names, and closes nothing it cannot confirm. It and the review task are the only holders of the App's
private key.

## 7. Configuration in the reviewed repo

`.review-agent/review.md` — what to care about in this repo, read **from the base branch**, optional; a
deployment default applies when it is absent. It follows a convention other reviewers also use: a file of review
guidance in a dot-directory at the repository root. A repo may raise its posting threshold, pick a quieter
reporting mode, and select among the skills its deployment allows. It may never lower a safety rule, add a skill
source, change the budgets or touch the gate — those belong to whoever pays for the run.

## 8. Cost, measured

Sixteen review runs on three merged pull requests of a production web application, 2026-09-12, read-only,
nothing posted. Every figure is **per-token API prices** — what an API key would have been billed; the runs drew
on a Claude subscription allowance and cost nothing extra.

| Configuration | Cost | Time | Findings |
|---|---|---|---|
| Sonnet 5, low | $0.10 | 37s | 2 |
| Sonnet 5, medium | $0.38–0.40 | 2m21s–2m41s | 2 |
| **Opus 5, low (tier `basic`)** | **$0.88–1.06** | 2m18s–4m40s | 4–5 |
| Opus 5, medium | $1.57–1.67 | 4m09s–6m41s | 0–5 |
| check pass | $0.07–0.58 (the upper end from a check measured 2026-09-13) | 13s–2m18s | — |
| 3 focused Opus reviewers + check, on one of the three PRs | $2.84 from the two that finished; $2.10 lost on the third | ~9 min | 7 findings → 4 confirmed, 2 refuted, 1 unsupported |
| the same on another of the three | $5.91, all three cut off by the ceiling | ~5½ min | nothing returned |

Two lessons: **the same model varies** — Opus found five findings at low effort on a PR where it found none at
medium — so one review is a sample, not a verdict; and **cost follows how much the agent explores**, not the
size of the diff. At 10–30 reviews a month on `basic`: roughly **$9–32 a month at per-token API prices**,
estimated from the measured per-review figures, plus **$0.07–0.58** per review for the check pass, measured, at
per-token API prices — or nothing beyond a subscription's allowance, if paid that way.

## 9. What v0 does not do

Running tests or any code · a browser · a hosted multi-tenant service · billing · Marketplace listing · its own
dashboard · a database · reviewing anything but pull requests · escalation between tiers · reading an issue
tracker for intent.

## 10. Written down for later

- **Escalation with a person in the middle** (2026-09-12): when a review is inconclusive on something that
  matters, ask a developer whether to escalate to a deeper tier.
- **Tests and sandboxes** as an optional deeper tier; **a hosted service**, if it should stop being self-deployed.
- **The gate** (draft-flip): turning a pull request back into a draft when its review fails, as a stand-in for a
  required check on a GitHub plan that cannot enforce one. Whether it is a product feature or a separate task
  that reads the concluded check run is not decided (§12).

## 11. To verify during the build

Items keep their original numbers, so a reference to one still resolves.

1. How the wrap-up instruction reaches a running review. **Answered, by spending a little to find out:** it
   cannot reach a running review on CLI 2.1.258 (§4.4).
2. Whether a suggestion posted by an App shows a working "Commit suggestion" button. *Still to verify.*
3. Which permission lets an App resolve its own review threads — REST has no endpoint; GraphQL has
   `resolveReviewThread`, and the permission is undocumented. *Still to verify.*
4. What GitHub returns for an inline comment on a line outside the diff. *Still to verify.*
5. That the CLI binary runs in the trigger.dev image, and its memory needs — settled before the task that
   depends on it is built, with the memory figure measured on a hosted run. *Still to verify.*
6. That an archive download contains no credentials. **Answered:** it can contain them, so credential-shaped files
   are **removed** before the model starts and named on the record — four rounds of "read it and decide if it is
   safe" were each broken by an independent reviewer.

## 12. Decided, and still open

**Decided 2026-09-12:** its own repository (§0) · each deployment registers its own App (§0) · all three
deployment modes in v0 (§1) · engine and CLI separate from the App (§2) · open source (§0) · a configurable
command word, severity bands, threshold and reporting mode (§3.1) · external skills from the deployment only, one
built in (§4.7).

**Decided 2026-09-14, the day this became the spec:**

- Apache-2.0 (§0) · published to npm under `@review-agent` (§2) · the check pass on for `basic` (§3, §4.6) ·
  `thorough` and `multi` refused from any request and named (§3) · two credential kinds, a gateway refused
  (§4.3) · `basic` stays $2 target / $5 ceiling (§4.4) · the gate reads the check-adjusted set, with
  `report.gateRequiresConfirmed` off by default (§3.1, §4.6) · no review on reopen; release-only includes
  `package.json` and lock files (§5) · push access checked before money is spent, refused visibly (§5) ·
  annotations in `check-only` only, the verdict and cut-short line in every mode (§5) · the conclusion table
  (§5) · `init` discards GitHub's secrets (§5) · `maxDuration` as a backstop (§6).
- One attempt per run; a failure that spent nothing starts a new run on purpose (§6).
- The App's private key is held only by the runner's tasks; the stale check-run sweep is a product task beside
  the review task (§6).
- The product stores nothing: after a review it sends the finished record to a signed callback (§5).
- Where a draft-flip gate runs — a product feature, or a separate task reading the concluded check run — is
  deferred, deliberately (§10).

**Still open:**

1. **Which external skills the box names by default** — a security pass, a test-coverage pass, or none. Decided
   during the build, from real reviews rather than from guessing.

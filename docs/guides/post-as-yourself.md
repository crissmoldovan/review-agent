# Post a review as yourself

At the end of this guide a review is on a pull request, **posted under your own GitHub name** from your terminal: a
review with inline comments on the lines it is about, a summary comment that opens with a line saying it is an
automated review you ran from the command line, and a commit status named `review-agent` on the reviewed commit. You
will also know how to answer a finding, how to have the pull request reviewed again after a change, and what your
GitHub token can reach (use case UC-3 in [the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

![Demo pull request #13 after the first post. A review by crissmoldovan, marked Owner and Author, opens with the automated-review line — run by @crissmoldovan from the command line, tier basic, claude-opus-5, $0.33 at per-token API prices — and "Review of f616c5d". Under it, one inline comment on src/payments.ts line 99: Severity 7/10, correctness, "Retry loop runs maxAttempts + 1 attempts", with its explanation, its evidence and a suggested change from > to >=.](images/pr13-review-inline.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* The review and
its one inline comment, posted under the name of the account that ran it. The summary comment and the commit status are
in [what appears on the pull request](#3-what-appears-on-the-pull-request).

**Use a pull request in a repository you can push to.** The examples use demo pull request #13,
`feat/retry-backoff` — an off-by-one in a retry loop, then a commit that fixes it — and only the demo repository's
owner can post there. Put your own `owner/name` and pull request number in their place.

## What you need

- [ ] Everything from [your first review](first-review.md): Node.js 22 or newer, Claude Code, review-agent, a model
      credential, and a GitHub login or token.
- [ ] **Push access** to the repository — the *Write* role or above. Setting a commit status needs it. Without it you
      can still post the review and the summary with `--report none` (step 4), where GitHub lets you comment.
- [ ] **A token that may post.** A `gh` login can. A classic token needs the `repo` scope (`public_repo` for a public
      repository). A fine-grained token needs **Contents: Read**, **Pull requests: Read and write** and **Commit
      statuses: Read and write** on the repository.

Every command in this guide is the same in a POSIX shell and in PowerShell.

## 1. Check you can post there

```sh
review-agent doctor --repo crissmoldovan/review-agent-demo
```

With `--repo`, doctor also checks the repository: whether the token can read it, whether you have push access, whether
a classic token's scopes can post there, and how the review will be reported. It only reads.

**An example layout** — the lines are the ones the code prints (`packages/cli/src/doctor-command.ts`); the login,
repository, path and versions are invented:

```text
✓ Node.js 22.12.0
✓ Claude Code: /usr/local/bin/claude
✓ Claude Code version: 2.1.258 (Claude Code)
✓ ANTHROPIC_BASE_URL is not set
✓ model credential: ANTHROPIC_API_KEY — an Anthropic API key, billed at per-token API prices
✓ GitHub token: from the GitHub CLI's login for github.com (gh auth token)
✓ GitHub identity: @alice — scopes: gist, read:org, repo — a classic token or a gh login reaches every repository @alice can, within its scopes
✓ acme/widgets: readable (private)
✓ @alice has push access to acme/widgets, which a commit status needs
! report: a commit status "review-agent" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App

Ready for `review-agent review --post`.
```

The real output, run by the demo repository's owner with a `gh` login, and Claude Code's own login rather than a
key:

```text
✓ Node.js 26.7.0
✓ Claude Code: /opt/homebrew/bin/claude
✓ Claude Code version: 2.1.289 (Claude Code)
✓ ANTHROPIC_BASE_URL is not set
! model credential: none set, so Claude Code's own login (`claude login`) will be used — doctor cannot tell whether it is logged in without starting a session; a review that is not says "Not logged in"
✓ GitHub token: from the GitHub CLI's login for github.com (gh auth token)
✓ GitHub identity: @crissmoldovan — scopes: admin:org, gist, read:packages, repo, workflow — a classic token or a gh login reaches every repository @crissmoldovan can, within its scopes
✓ crissmoldovan/review-agent-demo: readable (public)
✓ @crissmoldovan has push access to crissmoldovan/review-agent-demo, which a commit status needs
! report: a commit status "review-agent" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App

Ready for `review-agent review --post`.
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · exit code
`0`. doctor makes no model call, so nothing was spent.*

**If you see this instead**

| Line | Fix |
|---|---|
| `✗ @… has no push access to …, and a commit status needs it` | ask for the Write role, or post without a status: add `--report none` in step 2 |
| `✗ this token's scopes (…) cannot post to …` | give the token the `repo` scope (`public_repo` is enough for a public repository), or use another token |
| `✗ …: not found, or this token cannot read it` | check the name; a fine-grained token must include this repository |
| `! GitHub does not list what this token may do: …` | a fine-grained token: doctor cannot see its permissions without writing. Check it has the three in [what you need](#what-you-need) |

## 2. Post the review

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 13 --post
```

The reviewer reads the pull request and the repository's settings file, then asks — once, before it downloads
anything or spends anything — what it is about to post and as whom. With a person's token and the default settings
the question reads — with your login, repository and number in it — as it did for the demo repository's owner, on
stderr; the `y` at its end is the answer typed:

```text
This will post as @crissmoldovan on crissmoldovan/review-agent-demo#13: a review with inline comments, a summary comment and a commit status "review-agent". Continue? [y/N] y
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) on macOS.*

Type `y` and Enter. Anything else — Enter alone, Ctrl-D, Ctrl-C — posts nothing, spends nothing, and exits `1` with
`nothing was reviewed and nothing was posted`.

The sentence follows the repository's own [`.review-agent/review.md`](../configuration.md#the-repository-file), read
from the base branch: `summary-only` leaves out the inline comments; in `silent` mode nothing is asked, because
nothing will be written — it says `Nothing will be posted on …: this repository's settings make the review silent, so
it is only printed here.`

Then, in order: the commit status is set to `pending` (*"The review is running."*), the review runs, the review and
the summary are posted, and the status is set to its outcome. stderr says `review published` once it is on the pull
request. stdout is the review, as in [your first review](first-review.md#7-read-the-output), and two more lines: what
was posted, with the summary comment's link, and how it was reported. The whole run at the pull request's first
commit, stdout and stderr in the order the terminal showed them:

```text
This will post as @crissmoldovan on crissmoldovan/review-agent-demo#13: a review with inline comments, a summary comment and a commit status "review-agent". Continue? [y/N] y
review published
crissmoldovan/review-agent-demo#13 at f616c5d — tier basic, claude-opus-5, effort low

The PR replaces the fixed 250 ms retry delay in PaymentsClient with exponential backoff plus full jitter, capped at a new maxDelayMs (default 5 s), and honours a numeric Retry-After header by threading retryAfterMs through PaymentProviderError. It renames retryDelayMs to baseDelayMs (nothing in the repo set it, confirmed at src/config.ts:12 and src/main.ts:8) and adds an injectable random() for deterministic tests, with two new tests covering jitter and Retry-After. The backoff and Retry-After behaviour match the brief, but the rewritten loop guard uses `attempt > maxAttempts`, so a fully failing call makes four requests instead of the three the brief promises; no test covers the exhaustion path. Minor additional gaps: the new delay options are unvalidated and `Retry-After: 0` results in an immediate retry.

intent: partial — Exponential backoff with full jitter, the maxDelayMs cap, Retry-After parsing and the retryDelayMs -> baseDelayMs rename all land as described, and the rename is safe (src/config.ts:12 and src/main.ts:8 never set it). But the brief's "maxAttempts stays 3" is not true of the code: the new loop bound (src/payments.ts:99) allows a 4th attempt at the default setting.

  [8/10 correctness] src/payments.ts:99 Retry loop runs maxAttempts + 1 attempts [check: confirmed]
  [4/10 correctness] src/payments.ts:74 baseDelayMs and maxDelayMs are not validated [check: confirmed]
  [2/10 correctness] src/payments.ts:111 Full jitter can yield a 0 ms wait [check: confirmed]
  [2/10 correctness] src/payments.ts:145 Retry-After: 0 is honoured as a zero wait [check: confirmed]

$0.33 model spend at per-token API prices · 6 turns · 43s · check $0.11

posted 1 inline comment and a summary comment: https://github.com/crissmoldovan/review-agent-demo/pull/13#issuecomment-6185209666
reported with a commit status: success
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*

It found four things and posted one inline comment: only the first reached severity 5, the bar for a line of its
own ([inline comments](#inline-comments)). The other three went in the summary comment.

`--yes` posts without asking, for a script. Without a terminal nothing is ever asked: the same sentence, without the
question, is written to stderr, so a log shows what was done.

**If you see this instead**

| Output | Cause, and the fix |
|---|---|
| `GitHub refused the token from … (401): it is wrong, expired or revoked`, exit `2` | posting asks GitHub who the token belongs to, and GitHub refused it: a new token, or `gh auth login` again |
| `the review could not be reported on the commit: …`, exit `1` | GitHub would not take the `pending` status — for example, without push access. Nothing was downloaded or spent. Add `--report none`, or ask for the Write role |
| `--report check-run needs a token that can create check runs — …`, exit `2` | GitHub lets only Apps create check runs. Leave `--report` out, or say `--report status` |
| `the review ran and could not be posted: …`, exit `4` | the review ran and was paid for, and GitHub would not take it. See [when posting fails](#7-when-posting-fails-exit-4) |
| `posted nothing: this repository's settings make the review silent` | the repository's settings file says `mode: silent`. The review is printed, not posted |

**A pull request you opened yourself.** GitHub's own interface lets an author leave comments, but not approve, on their
own pull request; the reviewer posts a review of the "Commented" kind and never approves. GitHub's API accepts that
review from the pull request's own author: demo #13 was opened by the account that posted the review above (tested
2026-10-15, spike S4,
[spec 0.2.0 §12.2](../specs/0.2.0-ways-in.md#122-spikes--each-settles-an-unverified-fact-before-code-depends-on-it)).

## 3. What appears on the pull request

### The summary comment

One per pull request, edited in place each time the pull request is reviewed again. Its first line says it is
automated, how it was run, the tier, the model and the cost — the cost labelled, because an unlabelled number on a
pull request reads as a bill. **An example** of the line's shape (`packages/github/src/body.ts`), with an invented
login and cost:

> 🤖 **Automated review** by [review-agent](https://github.com/crissmoldovan/review-agent) · run by @alice from the
> command line · tier **basic** · `claude-opus-5` · $0.21 (model spend at per-token API prices)

It appears under your name, and this line is what tells a reader you did not write it. Under it: **Review of** the
commit, the reviewer's summary, the **Intent** verdict, and — when there are any — **Not placed inline** (findings
under the bar for an inline comment, and any that could not go on a changed line: on a first review at most three
below 4/10, on a later one none), **Could not be settled**, **Not in the checkout** (files the reviewer could not
read) and **Not honoured** (anything asked for and not done). It ends with a hidden marker: the reviewer's memory of
this pull request. Do not edit it.

![The summary comment of the first post on demo pull request #13, by crissmoldovan. It opens with the automated-review line — run by @crissmoldovan from the command line, tier basic, claude-opus-5, $0.33 at per-token API prices — then "Review of f616c5d", the reviewer's summary, "Intent: partial" with its note, and "Not placed inline" listing three findings: 3/10 src/payments.ts:74 baseDelayMs and maxDelayMs are not validated; 2/10 src/payments.ts:145 Retry-After: 0 is honoured as a zero wait; 1/10 src/payments.ts:111 Full jitter can yield a 0 ms wait.](images/pr13-summary-comment.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* The severities
are the check pass's, so they differ from the ones 0.2.0 printed in the terminal (4, 2 and 2); from 0.2.2 the
terminal prints the check pass's too.

Its Markdown source, read from GitHub's API — **after** the re-review in [step 6](#6-review-again-after-a-change) had
edited the comment in place, so this is the second review's text, at `1aaece2`, which [the screenshot
there](#6-review-again-after-a-change) shows rendered. The hidden marker line at its end is removed:

```markdown
🤖 **Automated review** by [review-agent](https://github.com/crissmoldovan/review-agent) · run by @crissmoldovan from the command line · tier **basic** · `claude-opus-5` · $0.49 (model spend at per-token API prices)

### Review of `1aaece2`

The PR replaces the fixed 250 ms retry pause in `PaymentsClient.post` with full-jitter exponential backoff capped at `maxDelayMs` (5 s default), and honours a numeric-seconds `Retry-After` header (also capped). `retryDelayMs` is renamed `baseDelayMs`; I confirmed nothing else in the repo sets it (`src/config.ts:12` only passes `baseUrl`/`apiKey`, `src/main.ts:8`). Behaviour matches the brief: retry count, non-retryable short-circuit and idempotency key reuse are preserved, and the new tests cover backoff, Retry-After capping and giving up after `maxAttempts`. Remaining issues are small: an unreachable condition in the retry loop and missing validation/floor on the delay options.

**Intent:** matches — Exponential full-jitter backoff, Retry-After in seconds, the maxDelayMs cap, unchanged maxAttempts=3 and the rename are all present as described, and the rename breaks no caller.

#### Could not be settled

- Does the provider ever send Retry-After as an HTTP-date rather than seconds? — would be settled by: Provider API documentation; the code comment at src/payments.ts:146 asserts seconds-only but nothing in the repo verifies it, and a date form would be silently ignored (falling back to backoff, which is a safe degradation).
- Is capping Retry-After at 5 s acceptable to the provider's rate limiter? — would be settled by: The provider's rate-limit policy: a 429 asking for 60 s but retried after 5 s may keep the client in the limit, which the brief accepts deliberately but was not measured here.
```

*Read 2026-10-15 from `GET /repos/crissmoldovan/review-agent-demo/issues/comments/6185209666`.*

### Inline comments

On changed lines only, for findings at severity 5 or more, worst first, at most 15. They arrive together as one review
of the **Commented** kind, whose text opens with the same automated line — the reviewer never approves and never
requests changes. Each comment opens with **Severity N/10** and the category, then the title, the explanation, the
evidence it read, and, when the fix is small, a `suggestion` block you can apply from GitHub. When no finding qualifies
there is no review, only the summary comment. A review that did not complete — one its spending ceiling cut short
included — places nothing on a line: its summary says **This review did not complete** and why, and lists what it had
found by then.

![The one inline comment of the first post, on src/payments.ts line 99 of demo pull request #13: "Severity 7/10 · correctness", the title "Retry loop runs maxAttempts + 1 attempts", the explanation, an Evidence list of three file-and-line quotes, and a Suggested change replacing attempt > this.maxAttempts with attempt >= this.maxAttempts.](images/pr13-review-inline.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* 0.2.0
printed this finding at 8/10 in the terminal, the reviewer's own severity; the comment says 7/10, the check pass's. From
0.2.2 the terminal says `[7/10 …] … [check: confirmed, was 8/10]`.

### The commit status

Named `review-agent`, on the reviewed commit, linking to the summary comment:

| When | State | Description |
|---|---|---|
| while the review runs | `pending` | *The review is running.* |
| a finished review | `success` | *No findings*, or *4 findings, worst 7/10* — and *cut short by its budget ceiling* when it was |
| a review that did not run or did not finish | `success` | *Not a verdict: the review did not finish — …*, with the reason |
| stopped with Ctrl-C | `error` | *The review was interrupted before it finished. Run it again for a result.* |

From the command line a finished review is always `success`: the [gate](../configuration.md#the-gate) that can make it
`failure` is a deployment setting, and the CLI reads no configuration of its own. A review that did not run reports
`success` too, saying it is **not a verdict**, so an outage never blocks a merge.

![The commits of demo pull request #13, both committed by "review-agent demo": f616c5d "feat(payments): exponential backoff with jitter, and honour Retry-After" and 1aaece2 "fix(payments): stop after maxAttempts, not one attempt later", each with a green check and 1 / 1 — the review-agent commit status.](images/pr13-commits-status.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* Taken after the
re-review in step 6, so both commits carry a status. The description is not in this view; read from GitHub's API (`GET
/repos/crissmoldovan/review-agent-demo/commits/{sha}/statuses`, 2026-10-15), each commit went `pending` *The review is
running.*, then `success` — *4 findings, worst 7/10* on `f616c5d` and *No findings* on `1aaece2`.

**A commit status is a soft gate.** A branch rule can require a status named `review-agent`, but it cannot pin it to
this reviewer: anyone with push access can set a status with the same name. Do not make it the only thing between a
pull request and your default branch. For a gate that holds, run the reviewer from the
[GitHub App](../deploying.md) or [GitHub Actions](github-actions.md), whose check runs a branch rule can pin to their
source ([spec 0.2.0 §2.2](../specs/0.2.0-ways-in.md#22-what-each-github-identity-can-do)).

## 4. Choose how it reports: `--report`

| `--report` | What it does | Needs |
|---|---|---|
| `auto` (the default) | a commit status for a person's token; a check run for an App's or a GitHub Actions workflow's token. Decided with one `GET /user` | push access, for a status |
| `status` | always a commit status | push access |
| `check-run` | always a check run — refused for a person's token before anything is read or spent | an App's or Actions' token |
| `none` | the review and the summary, and nothing on the commit | no push access |

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 13 --post --report none
```

## 5. Answer a finding: `/dispute` and `/defer`

Reply **under an inline comment**, with the word first on the reply's first line:

| Reply | Meaning |
|---|---|
| `/dispute` | the finding is wrong |
| `/defer` | the finding is right, but it will not be fixed in this pull request |

Anything after the word is free text for the people reading. Your own replies count: since 0.2.0 the reviewer ignores
replies only from an App's bot account, never from the person who posted the review. The answer is read at the next
re-review, recorded against that finding in the reviewer's memory of the pull request, and the model is not asked about
that finding again — a person's word outranks the model's. The comment itself is not changed.
More: [answering a finding](../pull-requests.md#answering-a-finding).

## 6. Review again after a change

Push the fix, then run the same command:

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 13 --post
```

With `--post` the reviewer reads its earlier summary comment on the pull request — the one your login posted, when
there is one — and does three things beyond a first review:

1. it reviews the code as it is now;
2. it asks a re-review pass, about each earlier finding nobody answered with `/dispute` or `/defer`, whether that
   problem is still in the code: `still-present`, `resolved` or `cannot-tell`;
3. it **edits** its earlier inline comment for each finding judged `resolved`, appending a note that begins
   **"No longer reported."** and names the commit it read. The note says this is one reviewer's answer at one commit,
   not proof that a person fixed it; the original text is left as it was. If a later review finds the problem again,
   it appends **"Reported again."** under that note.

The summary comment is edited in place rather than a second one posted. `--no-re-review` skips the re-review pass and
still edits that summary. Run by somebody else with their own token, the review cannot edit your comments: it posts a
summary of its own, carrying the earlier reviews' memory forward.

> **Status:** the capture below is the re-review pass's first run against a live model (2026-10-15). One run is one
> sample: treat "No longer reported" as one reviewer's answer at one commit.

The second run, after the fix commit `1aaece2` was pushed, stdout and stderr in the order the terminal showed them:

```text
This will post as @crissmoldovan on crissmoldovan/review-agent-demo#13: a review with inline comments, a summary comment and a commit status "review-agent". Continue? [y/N] y
review published
crissmoldovan/review-agent-demo#13 at 1aaece2 — tier basic, claude-opus-5, effort low

The PR replaces the fixed 250 ms retry pause in `PaymentsClient.post` with full-jitter exponential backoff capped at `maxDelayMs` (5 s default), and honours a numeric-seconds `Retry-After` header (also capped). `retryDelayMs` is renamed `baseDelayMs`; I confirmed nothing else in the repo sets it (`src/config.ts:12` only passes `baseUrl`/`apiKey`, `src/main.ts:8`). Behaviour matches the brief: retry count, non-retryable short-circuit and idempotency key reuse are preserved, and the new tests cover backoff, Retry-After capping and giving up after `maxAttempts`. Remaining issues are small: an unreachable condition in the retry loop and missing validation/floor on the delay options.

intent: matches — Exponential full-jitter backoff, Retry-After in seconds, the maxDelayMs cap, unchanged maxAttempts=3 and the rename are all present as described, and the rename breaks no caller.

  [3/10 correctness] src/payments.ts:100 Unreachable `attempt > this.maxAttempts` check [check: confirmed]
  [4/10 correctness] src/payments.ts:73 baseDelayMs and maxDelayMs are not validated [check: confirmed]
  [3/10 correctness] src/payments.ts:115 Full jitter has no floor, so a retry can fire with zero delay [check: refuted]
  [?] Does the provider ever send Retry-After as an HTTP-date rather than seconds? — would be settled by: Provider API documentation; the code comment at src/payments.ts:146 asserts seconds-only but nothing in the repo verifies it, and a date form would be silently ignored (falling back to backoff, which is a safe degradation).
  [?] Is capping Retry-After at 5 s acceptable to the provider's rate limiter? — would be settled by: The provider's rate-limit policy: a 429 asking for 60 s but retried after 5 s may keep the client in the limit, which the brief accepts deliberately but was not measured here.

$0.49 model spend at per-token API prices · 6 turns · 44s · check $0.12 · re-review $0.16

posted a summary comment: https://github.com/crissmoldovan/review-agent-demo/pull/13#issuecomment-6185209666
reported with a commit status: success
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · paid with
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.*
`re-review $0.16` is the re-review pass, inside the $0.49.

This time the intent verdict is `matches`, and the review posted only the summary comment. None of the three findings it
printed was said on the pull request — a refuted one never is, and a later review mentions no finding below 4/10 at the
check pass's severity (`report.repeatNits`, off by default: [every setting](../configuration.md#every-setting)) — so the
commit status reads *No findings*. The re-review pass judged the first review's inline comment resolved, and edited it:

![The first review's inline comment on demo pull request #13 after the second run. GitHub marks the thread Outdated, and the comment, now showing "edited", keeps its original text — Severity 7/10, correctness, "Retry loop runs maxAttempts + 1 attempts", the evidence and the suggested change — with a note appended under a rule: "No longer reported. The reviewer read src/payments.ts at 1aaece2 and no longer finds this issue there. That is one reviewer's answer at one commit, and not proof that a person fixed it. The comment above is left as it was said."](images/pr13-no-longer-reported.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* GitHub's own
**Outdated** badge is there because the fix commit changed the line.

The summary comment, edited in place rather than posted again — it now reviews `1aaece2`, at $0.49:

![The summary comment on demo pull request #13 after the second run, marked edited. The automated-review line now says $0.49 at per-token API prices, then "Review of 1aaece2", the new summary, "Intent: matches" with its note, and "Could not be settled" with two questions: whether the provider ever sends Retry-After as an HTTP-date, and whether capping Retry-After at 5 s is acceptable to the provider's rate limiter.](images/pr13-summary-after-rereview.png)

*Screenshot 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · demo pull request #13.* Its Markdown
source is under [the summary comment](#the-summary-comment).

## 7. When posting fails: exit 4

Exit `4` means the review **ran and was paid for**, and GitHub would not take it — a token without Pull requests:
Write, for example, or a GitHub outage. stderr says `the review ran and could not be posted:`
with GitHub's own message; the review is printed on stdout anyway, followed by:

```text
NOT POSTED: the review is above, and nothing of it is on the pull request.
```

so it is not lost. Running it again pays for the model again: fix what GitHub objected to first. With `--json`, the
[envelope](../cli.md#--json-with---post) says the same thing as `"posted": null`.

## 8. What your token can reach

- A `gh` login, like a classic token with the `repo` scope, reaches **every repository your account can**. The
  reviewer uses it for the one repository named on the command line, and nothing else.
- It is never printed, logged or written to disk. If an error message from GitHub quotes it, the CLI prints
  `[redacted]` in its place.
- It is never given to the Claude process: that process's environment is an allow-list that names no GitHub variable
  ([security](../security.md#what-the-model-can-do)). Nor can its Read tool open a file outside the downloaded code —
  such as a token `gh` stored in your home directory: asked to, Claude Code's tool refuses (`… is outside` its
  working directory; tested 2026-10-15, spike S1). And whatever it reads, everything the
  model writes is scanned before it is printed or posted, and a match on a GitHub token's pattern withholds the whole
  review (exit `3`).
- To narrow what a review can reach, use a fine-grained token limited to the one repository, with the three
  permissions in [what you need](#what-you-need), set as `GITHUB_TOKEN` for that terminal. `review-agent doctor`
  says where the token came from and, for a classic token or a `gh` login, its scope names.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices**; or a subscription — **its allowance** | the same review as printing it: **measured** with `claude-opus-5`, $0.88–1.06 for a `basic` review of a real production pull request plus $0.07–0.58 for its check pass; $0.16–0.29 for a whole `basic` review of a one-file pull request ([what it costs](../../README.md#what-it-costs)); $0.33 for the first post on demo #13, check pass included (measured 2026-10-15) |
| The re-review pass, on a later review | the same | **measured once**, 2026-10-15: $0.16, on demo #13, inside that review's $0.49 (the estimate before it ran was about $0.10). Its own ceiling is $1.25 at `basic`, and it runs only when that fits under what is left of the review's $5.00 ceiling |
| Posting | — | GitHub does not charge for comments and statuses |

The summary comment says what each review cost, as model spend at per-token API prices.

## Next steps

- [Choose a tier](choosing-a-tier.md) for the change in front of you.
- [Using it on pull requests](../pull-requests.md): what everything on the pull request means, for the people whose
  pull requests are reviewed.
- For reviews that are not under one person's name — every pull request reviewed by a bot, with a check run a branch
  rule can pin: [GitHub Actions](github-actions.md), [another CI](other-ci.md), or [a GitHub App](../deploying.md).
- [Troubleshooting](troubleshooting.md), by symptom.

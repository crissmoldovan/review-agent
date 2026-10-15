# Post a review as yourself

At the end of this guide a review is on a pull request, **posted under your own GitHub name** from your terminal: a
review with inline comments on the lines it is about, a summary comment that opens with a line saying it is an
automated review you ran from the command line, and a commit status named `review-agent` on the reviewed commit. You
will also know how to answer a finding, how to have the pull request reviewed again after a change, and what your
GitHub token can reach (use case UC-3 in [the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

<!-- capture: post-yourself-pr6-screenshot — a screenshot of demo pull request #6 (feat/retry-backoff) after the first `review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post`, run by the demo repository's owner at the pull request's first commit: the conversation showing the summary comment with its automated line, the review with one inline comment, and the `review-agent` commit status in the checks box. Version and date. -->
*(captured output will appear here)*

**Use a pull request in a repository you can push to.** The examples use demo pull request #6,
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

<!-- capture: post-yourself-doctor-repo-stdout — stdout of `review-agent doctor --repo crissmoldovan/review-agent-demo` run by the demo repository's owner with a `gh` login, on macOS, full. Version and date. -->
*(captured output will appear here)*

**If you see this instead**

| Line | Fix |
|---|---|
| `✗ @… has no push access to …, and a commit status needs it` | ask for the Write role, or post without a status: add `--report none` in step 2 |
| `✗ this token's scopes (…) cannot post to …` | give the token the `repo` scope (`public_repo` is enough for a public repository), or use another token |
| `✗ …: not found, or this token cannot read it` | check the name; a fine-grained token must include this repository |
| `! GitHub does not list what this token may do: …` | a fine-grained token: doctor cannot see its permissions without writing. Check it has the three in [what you need](#what-you-need) |

## 2. Post the review

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post
```

The reviewer reads the pull request and the repository's settings file, then asks — once, before it downloads
anything or spends anything — what it is about to post and as whom. With a person's token and the default settings
the question reads (your login, repository and number in it):

```text
This will post as @alice on crissmoldovan/review-agent-demo#6: a review with inline comments, a summary comment and a commit status "review-agent". Continue? [y/N]
```

Type `y` and Enter. Anything else — Enter alone, Ctrl-D, Ctrl-C — posts nothing, spends nothing, and exits `1` with
`nothing was reviewed and nothing was posted`.

The sentence follows the repository's own [`.review-agent/review.md`](../configuration.md#the-repository-file), read
from the base branch: `summary-only` leaves out the inline comments; in `silent` mode nothing is asked, because
nothing will be written — it says `Nothing will be posted on …: this repository's settings make the review silent, so
it is only printed here.`

Then, in order: the commit status is set to `pending` (*"The review is running."*), the review runs, the review and
the summary are posted, and the status is set to its outcome. stdout is the review, as in
[your first review](first-review.md#7-read-the-output), and two more lines. **An example layout** — the shape is the
code's (`packages/cli/src/review-command.ts`), the numbers and link invented:

```text
posted 2 inline comments and a summary comment: https://github.com/crissmoldovan/review-agent-demo/pull/6#issuecomment-…
reported with a commit status: success
```

<!-- capture: post-yourself-pr6-confirm — the question exactly as the terminal shows it (stderr) for `review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post`, run by the demo repository's owner at the pull request's first commit, before answering y. -->
*(captured output will appear here)*

<!-- capture: post-yourself-pr6-first-stdout — stdout and stderr of the same run after answering y, full, in the order the terminal shows them. Version and date. -->
*(captured output will appear here)*

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
own pull request; the reviewer posts a review of the "Commented" kind and never approves. Whether GitHub's API accepts
that review from the pull request's own author has **not yet been verified** by this project (spike S4,
[spec 0.2.0 §12.2](../specs/0.2.0-ways-in.md#122-spikes--each-settles-an-unverified-fact-before-code-depends-on-it)).
If GitHub refuses it, you get exit `4` and the review printed.

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
that could not go on a changed line), **Could not be settled**, **Not in the checkout** (files the reviewer could not
read) and **Not honoured** (anything asked for and not done). It ends with a hidden marker: the reviewer's memory of
this pull request. Do not edit it.

<!-- capture: post-yourself-pr6-summary-comment — the summary comment from the first post on PR #6, as GitHub renders it (a screenshot), and its Markdown source copied from the comment's edit box with the hidden marker line removed. Version and date. -->
*(captured output will appear here)*

### Inline comments

On changed lines only, for findings at severity 5 or more, worst first, at most 15. They arrive together as one review
of the **Commented** kind, whose text opens with the same automated line — the reviewer never approves and never
requests changes. Each comment opens with **Severity N/10** and the category, then the title, the explanation, the
evidence it read, and, when the fix is small, a `suggestion` block you can apply from GitHub. When no finding qualifies
there is no review, only the summary comment. A review that did not complete — one its spending ceiling cut short
included — places nothing on a line: its summary says **This review did not complete** and why, and lists what it had
found by then.

<!-- capture: post-yourself-pr6-inline-comment — one inline comment from the first post on PR #6, as GitHub renders it (a screenshot). -->
*(captured output will appear here)*

### The commit status

Named `review-agent`, on the reviewed commit, linking to the summary comment:

| When | State | Description |
|---|---|---|
| while the review runs | `pending` | *The review is running.* |
| a finished review | `success` | *No findings*, or *2 findings, worst 7/10* — and *cut short by its budget ceiling* when it was |
| a review that did not run or did not finish | `success` | *Not a verdict: the review did not finish — …*, with the reason |
| stopped with Ctrl-C | `error` | *The review was interrupted before it finished. Run it again for a result.* |

From the command line a finished review is always `success`: the [gate](../configuration.md#the-gate) that can make it
`failure` is a deployment setting, and the CLI reads no configuration of its own. A review that did not run reports
`success` too, saying it is **not a verdict**, so an outage never blocks a merge.

<!-- capture: post-yourself-pr6-status — a screenshot of the checks box on PR #6 after the first post, with the `review-agent` commit status and its description visible. -->
*(captured output will appear here)*

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
review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post --report none
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
review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post
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

> **Status:** the re-review pass is covered by unit tests only and has not yet been run against a live model
> ([README](../../README.md#status)). The capture below records one run of it.

<!-- capture: post-yourself-pr6-rereview-stdout — stdout and stderr of the second `review-agent review --repo crissmoldovan/review-agent-demo --pr 6 --post`, run by the demo repository's owner after the fix commit is on the branch (the first post having been made before it), answering y. Full; note the cost line's `re-review $…` part if present. Version and date. -->
*(captured output will appear here)*

<!-- capture: post-yourself-pr6-no-longer-reported — a screenshot of the first review's inline comment on PR #6 after that second run, showing the appended "No longer reported." note — or, if the re-review pass judged the finding otherwise, the comment as it stands and the second summary comment, so the guide can say what happened. -->
*(captured output will appear here)*

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
  ([security](../security.md#what-the-model-can-do)). Whether the process's Read tool can open a file outside the
  downloaded code — such as a token `gh` stored in a file in your home directory — has **not yet been tested** (spike
  S1, [spec 0.2.0 §10](../specs/0.2.0-ways-in.md#10-security-for-the-new-ways-in)). Whatever it reads, everything the
  model writes is scanned before it is printed or posted, and a match on a GitHub token's pattern withholds the whole
  review (exit `3`).
- To narrow what a review can reach, use a fine-grained token limited to the one repository, with the three
  permissions in [what you need](#what-you-need), set as `GITHUB_TOKEN` for that terminal. `review-agent doctor`
  says where the token came from and, for a classic token or a `gh` login, its scope names.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices**; or a subscription — **its allowance** | the same review as printing it: **measured** with `claude-opus-5`, $0.88–1.06 for a `basic` review of a real production pull request plus $0.07–0.58 for its check pass; $0.16–0.29 for a whole `basic` review of a one-file pull request ([what it costs](../../README.md#what-it-costs)) |
| The re-review pass, on a later review | the same | about $0.10 — **an estimate, not yet measured**. Its own ceiling is $1.25 at `basic`, and it runs only when that fits under what is left of the review's $5.00 ceiling |
| Posting | — | GitHub does not charge for comments and statuses |

The summary comment says what each review cost, as model spend at per-token API prices.

## Next steps

- [Choose a tier](choosing-a-tier.md) for the change in front of you.
- [Using it on pull requests](../pull-requests.md): what everything on the pull request means, for the people whose
  pull requests are reviewed.
- For reviews that are not under one person's name — every pull request reviewed by a bot, with a check run a branch
  rule can pin: [GitHub Actions](github-actions.md), [another CI](other-ci.md), or [a GitHub App](../deploying.md).
- [Troubleshooting](troubleshooting.md), by symptom.

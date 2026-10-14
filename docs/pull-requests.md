# Using it on pull requests

This page is for the people whose pull requests are reviewed: when the reviewer runs, how to ask it for a review,
what it posts, and how to answer it. It describes an [App deployment](deploying.md) with the default
[settings](configuration.md); a deployment may change the command word, the reporting mode and the thresholds.

## When it reviews

| Event | Review? |
|---|---|
| A pull request is **opened** | yes, automatically |
| A pull request is opened **as a draft** | no — it waits |
| A draft is **marked ready for review** | yes, automatically |
| New commits are **pushed** | **no** — ask for one when you want it |
| A pull request is **reopened** | no — ask for one |
| A comment starting with **`/review`** | yes, on request |
| The **Re-run** button on the reviewer's check run | yes, on request |

A deployment can switch the automatic reviews off (`autoReview: 'off'`), leaving only requests.

**Release-only pull requests** get no automatic review: one whose every changed file is a lock file
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, …), a version file
(`package.json`, `VERSION`, `version.txt`), a changelog (`CHANGELOG`, `CHANGES`, `HISTORY`, `RELEASES`,
`RELEASE-NOTES`, with or without `.md`/`.txt`/`.rst`) or a `.changeset/*.md` entry. That includes a dependency bump
touching only `package.json` and a lock file. A comment still reviews any of them.

If GitHub delivers the same triggering event for the same commit more than once, one automatic review runs, not
several.

## Asking for a review

Write a comment on the pull request — in the conversation, not on a line — that **starts with** the command word:

```
/review
```

Settings go on the **first line**; everything else is a note to the reviewer:

```
/review --tier normal --effort high
The retry logic moved into the client. Check every caller still handles a 429.
```

| Flag | Values | What it does |
|---|---|---|
| `--tier` | `basic`, `normal` | a bigger preset: more effort and a larger budget. See [tiers](configuration.md#tiers) |
| `--effort` | `low`, `medium`, `high`, `xhigh`, `max` | how hard the model thinks |
| `--model` | a model name | which model reviews |
| `--budget` | dollars | a **lower** budget for this review |
| `--check` / `--skip-check` | — | run or skip the [check pass](how-it-works.md#the-check-pass) |

`--flag=value` also works. A flag the deployment does not allow, or a value a flag does not take, is **not silently
dropped**: the review runs at the deployment's setting, and the summary lists what was not honoured and why under
**Not honoured**. `--tier thorough` and `--multi` are always listed there for now, because the multi-reviewer mode
they ask for is not built.

The note — the words on the first line that are not flags, and every following line — is passed to the reviewer as
information. It can point attention somewhere; it cannot change the reviewer's rules.

Every comment is its own request, so asking twice reviews twice. Editing a comment does not start a review.
The command works on drafts.

### Who may ask

A review costs money, so **only people with push access to the repository** can request one. For anyone else, no
review runs and nothing is spent; the reviewer posts a `neutral` check run titled **Review refused** that names who
asked. It does not comment, so commenting cannot make it write on a pull request.

Automatic reviews have no such check: every pull request that opens is reviewed.

### The Re-run button

The reviewer's check run carries its own **Re-run** button ("Review this commit again"). Pressing it reviews the
same commit again with the same settings as the review it is attached to (the note is not repeated). It needs push
access like a comment does.

GitHub's own re-run option for checks is **not** acted on — use the reviewer's button, or the comment.

## What it posts

With the default `inline+summary` mode, one review produces three things.

### 1. A summary comment

**One per pull request, edited in place** each time the pull request is reviewed again, so the conversation is not
filled with copies. It says:

- which commit was reviewed, the tier, the model and what the review cost (model spend at per-token API prices);
- the reviewer's summary of the change, and its **intent** verdict — whether the change does what its description
  says (`matches`, `partial`, `diverges` or `unclear`);
- **Not placed inline**: findings that could not go on a line, with their severity, file and line;
- **Could not be settled**: questions the reviewer could not answer from the code alone, and what would answer them;
- **Not honoured**: anything a request asked for that was not done.

It also carries a hidden marker: the reviewer's memory of earlier reviews of this pull request. Don't edit it.

### 2. Inline comments

On changed lines only — GitHub accepts comments only on lines in the diff. Each reads:

```
Severity 7/10 · correctness

Off-by-one in the retry loop

<explanation>

Evidence:
- src/client.ts:88
```

and, when the fix is small, a `suggestion` block you can apply from GitHub's interface (up to 20 lines, and only
when it replaces exactly the lines commented on; otherwise the fix is shown as plain code).

The inline comments arrive as one **review** with the state "Commented". The reviewer **never approves and never
requests changes**.

Which findings become inline comments:

- findings at severity **5 or more** (`severity.postInlineAtOrAbove`) on a changed line, worst first, at most **15**;
- the rest go in the summary;
- **low** findings (below 4) are capped: at most **3** are mentioned on the first review, and none on later reviews;
- findings the [check pass](how-it-works.md#the-check-pass) **refuted** are not said at all, and the others are
  shown at the check pass's severity.

### 3. A check run

Named `review-agent` by default, on the reviewed commit:

| Outcome | Conclusion |
|---|---|
| a finished review, with or without findings, and the gate off | `success` |
| a finished review with a finding at or above the [gate](configuration.md#the-gate) | `failure` |
| a review that failed, was refused, or was abandoned | `neutral` |

Its title says what happened: **No findings**, **3 findings, worst 7/10**, **Review did not finish**, **Review
refused** or **Review timed out**. A check run left running for an hour is closed as **Review timed out** by the next
review of that commit, and by the hourly sweep if the deployment runs it.

`neutral` passes branch protection, so a failed review never blocks a merge; only the gate can.

In the quieter [modes](configuration.md#reporting-modes) some of this is left out: `summary-only` posts no inline
comments, `check-only` posts only the check run (with findings as annotations), and `silent` posts nothing.

## Answering a finding

Reply **under an inline comment** with one of:

| Reply | Meaning |
|---|---|
| `/dispute` | the finding is wrong |
| `/defer` | the finding is right, but it will not be fixed in this pull request |

The reply's **first line** must start with the word; anything after it is free text for the people reading. The last
`/dispute` or `/defer` on a thread wins, and later chatter does not undo it.

What an answer does: it is recorded against that finding in the reviewer's memory of the pull request, and a later
review **does not ask the model about it again** — a person's word outranks the model's. It is also carried on the
[review record](how-it-works.md#the-review-record), so a deployment can collect it. It does not change the comment,
and anyone who can reply can answer.

## Re-reviews

When a pull request that has been reviewed is reviewed again (by `/review` or **Re-run**), the reviewer:

1. reviews the current code as usual;
2. asks the model, about each earlier finding nobody answered: is that problem still in the code as it stands now?
   (`still-present`, `resolved` or `cannot-tell`);
3. edits the inline comment of each finding judged **resolved**, appending **"No longer reported."** with the commit
   it read. The original text is left as it was, and the note does not claim that a person fixed anything;
4. if a later review finds the problem again, appends **"Reported again."** under that note.

A comment is only ever appended to, never deleted, and only the reviewer's own comments on this pull request are
edited. `cannot-tell`, or no answer, leaves a finding as it was.

This pass costs extra — a quarter of the review's budget at most — and runs only when it fits under the review's
ceiling. A first review never pays for it.

> **Status:** the re-review pass is new in `0.1.1` and is covered by unit tests only; it has not yet been run against
> a live model. Treat "No longer reported" as one reviewer's answer at one commit.

## What the reviewer will not do

- Approve or block a pull request on its own judgement, except through the [gate](configuration.md#the-gate) the
  deployment chooses to arm.
- Write to your code: it can read the repository and nothing more.
- Review every push. Ask for a review when you want one.
- Act on comments from bots, or on its own comments.

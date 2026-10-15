# The command line: `review-agent`

The CLI reviews one pull request on your own machine. By default it **prints** what it found and writes nothing
anywhere. With `--post` it posts the review to the pull request **as whoever the GitHub token belongs to** — you, if it
is your token — and reports the outcome on the commit.

| Command | What it does |
|---|---|
| [`review-agent review`](#review-agent-review) | reviews one pull request; prints it, or with `--post` posts it |
| [`review-agent doctor`](#review-agent-doctor) | checks this machine: Node, Claude Code, the model credential, the GitHub token and what it can do |
| [`review-agent init`](#review-agent-init) | registers a GitHub App for a deployment, through GitHub's manifest flow |
| `review-agent --version` | prints the version |

Step by step: [your first review](guides/first-review.md), [post a review as yourself](guides/post-as-yourself.md),
[from another CI](guides/other-ci.md). When something goes wrong: [troubleshooting](guides/troubleshooting.md).

## Install

The same in a POSIX shell and in PowerShell:

```sh
npm install --global @review-agent/cli     # puts `review-agent` on your PATH
# or, without installing:
npx @review-agent/cli review --repo owner/name --pr 9
```

Node.js **22 or newer** is required. `review-agent doctor` checks everything below in one go.

## `review-agent review`

```sh
review-agent review --repo <owner/name> --pr <number> [options]
```

### What it needs

1. **The Claude Code CLI**, as `claude` in a directory on your `PATH` (`claude.exe` on Windows), or wherever
   `REVIEW_AGENT_CLAUDE_BIN` points. The reviewer runs it headless. The hosted runner pins Claude Code `2.1.258`; the
   CLI uses whichever it finds, and a version that does not accept the
   [flags the engine passes](how-it-works.md#how-the-model-is-run) fails the review.
   - It is looked up **only in absolute `PATH` directories, and never inside the downloaded code** — see
     [security](security.md#what-the-model-can-do).
   - Install it with Anthropic's installer: `curl -fsSL https://claude.ai/install.sh | bash` on macOS and Linux;
     `irm https://claude.ai/install.ps1 | iex` in PowerShell, or `winget install Anthropic.ClaudeCode`, on Windows.
     They put `claude` (`claude.exe`) on `PATH`. An npm install on Windows puts only `.cmd` scripts on `PATH`, which
     the reviewer never runs; it finds the `claude.exe` npm installed beside them instead
     (`node_modules\@anthropic-ai\claude-code\bin\claude.exe`). Windows support is not yet tested; WSL2 works as
     Linux.
   - npm 12 does not run a dependency's install script unless you allow it, and Claude Code's npm package needs
     its script to put the real binary in place — without it, `claude` is a small placeholder. The reviewer
     recognises the placeholder and stops with *"Claude Code's native binary is not installed — npm skipped its
     install script"*, naming the file and the fix: reinstall with the package's install script allowed, or use
     Anthropic's installer. The command that works on npm 10, 11 and 12 alike (tested 2026-10-15):

     ```sh
     npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
     ```
2. **A model credential**, at most one of:
   - `ANTHROPIC_API_KEY` — an Anthropic API key, billed at per-token API prices;
   - `CLAUDE_CODE_OAUTH_TOKEN` — a subscription token from `claude setup-token`, drawn from that
     subscription's allowance;
   - neither — then `claude` uses its own login (`claude login`), if it has one.

   **Both** set is refused with exit code `2`, so a review is always billed to an account you can name. Whichever
   one is used, the `claude` process gets that one and no other.

   `ANTHROPIC_BASE_URL` must be **unset**: the reviewer refuses to run while it is set, because it sends the
   reviewed code to Anthropic and nowhere else. See [security](security.md).
3. **A GitHub token** — see [where it comes from](#where-the-github-token-comes-from). To read: **Contents: Read** and
   **Pull requests: Read**. To post as well: **Pull requests: Read and write** and **Commit statuses: Read and
   write**. A fine-grained personal access token limited to the one repository is enough.

### Options

| Flag | Value | Default | What it does |
|---|---|---|---|
| `--repo` | `owner/name` | — **required** | the repository |
| `--pr` | a positive whole number | — **required** | the pull request number |
| `--tier` | `basic` \| `normal` \| `thorough` | `basic` | the preset: effort, budget and whether the check pass runs. See [tiers](configuration.md#tiers) |
| `--multi` | — | off | three focused reviewers — intent, impact, security — instead of one, with any tier. See [the multi-reviewer mode](configuration.md#the-multi-reviewer-mode) |
| `--model` | a model name | `claude-opus-5` | passed to Claude Code as `--model`, unchecked |
| `--effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | the tier's | how hard the model thinks |
| `--check` | — | the tier's (on in every tier) | run the [check pass](how-it-works.md#the-check-pass) |
| `--skip-check` | — | — | skip the check pass. Giving both `--check` and `--skip-check` is an error |
| `--brief` | text | — | a note for the reviewer, such as what to focus on. It is fenced off as data in the prompt: it can steer attention, never change the rules |
| `--budget` | dollars, a positive number | the tier's | **lower** the soft budget. A value above the tier's is ignored, with a note on stderr |
| `--post` | — | off | post the review, its inline comments and the summary, as the token's identity, and report on the commit. See [posting](#posting---post) |
| `--report` | `auto` \| `check-run` \| `status` \| `none` | `auto` | with `--post`: how the outcome is reported on the commit. `auto` is a check run when the token can create one and a commit status when it cannot |
| `--re-review` / `--no-re-review` | — | on with `--post` | with `--post`: read this reviewer's earlier summary on the pull request and run the [re-review pass](how-it-works.md#the-re-review-pass) over what it found before |
| `--yes` | — | off | post without asking first. Without a terminal nothing is ever asked, so it is always on in CI |
| `--github-host` | a host name | `github.com` | GitHub Enterprise Server: the API is `https://<host>/api/v3`, and `gh` is asked for that host's login |
| `--keep-checkout` | — | off | keep the downloaded code after the review, and print where it is. It is yours to delete |
| `--json` | — | off | print the review record as JSON instead of the readable summary; with `--post`, an [envelope](#--json-with---post) around it |

`--report` and `--re-review` without `--post` are refused (exit `2`): they would do nothing. `--yes` and
`--no-re-review` without `--post` are accepted and change nothing.

Notes:

- `--tier thorough` is one reviewer at `high` effort with an $8 soft budget ($20 ceiling), here and in the App. Its
  cost was $0.62–0.89 (measured 2026-10-15 on the demo's small pull requests, at per-token API prices; [the measured runs](guides/choosing-a-tier.md)). `--multi` runs three
  reviewers, each with the tier's budget and its own ceiling — up to three times the tier's ceiling between them; it
  cost $0.67–0.72 on the same pull requests.
- The CLI uses the [built-in defaults](configuration.md#deployment-settings) and reads no configuration file of its
  own. It **does** read the reviewed repository's [`.review-agent/review.md`](configuration.md#the-repository-file)
  from the pull request's **base** branch, as the App does — so a repository can make the review quieter
  (`summary-only`, `silent`), and a posted review follows it.

### Where the GitHub token comes from

In this order, the first that gives one:

1. `GITHUB_TOKEN`, if it is set and not empty;
2. `GH_TOKEN`, if it is set and not empty;
3. **`gh auth token --hostname <host>`** — the [GitHub CLI](https://cli.github.com)'s own login, if `gh` is installed
   and logged in to that host;
4. otherwise, **at a terminal**, it offers to run `gh auth login --web --hostname <host>` for you: it opens a browser,
   you approve there, and the review goes on with that login. **Without a terminal** (CI) it stops with exit code `2`,
   saying exactly what to set.

`gh` is started by its absolute path in a `PATH` directory, never by a bare name that could find a `gh` in the
current directory.

The token is **never printed, logged, written to disk, or given to the `claude` process**: the process's environment is
an allow-list that names no GitHub variable. If an error message from GitHub quotes the token, the CLI prints
`[redacted]` in its place. A person's token reaches every repository that person can; the CLI uses it only for the one
repository named on the command line. `review-agent doctor` says where the token came from and what it can reach.

```sh
export GITHUB_TOKEN=…            # or: gh auth login --web
```

```powershell
$env:GITHUB_TOKEN = "…"          # or: gh auth login --web
```

### Posting: `--post`

```sh
review-agent review --repo acme/api --pr 128 --post
```

It posts what the App posts — [a summary comment, inline comments, and a report on the
commit](pull-requests.md#what-it-posts) — **as the token's identity**. With your own token, under your own name. Every
review and summary starts with a line saying it is automated and how it was run, so nobody takes it for your own
words:

> 🤖 **Automated review** by [review-agent](https://github.com/crissmoldovan/review-agent) · run by @alice from the
> command line · tier **basic** · `claude-opus-5` · $0.21 (model spend at per-token API prices)

In a GitHub Actions workflow (`GITHUB_ACTIONS=true`) it says *from GitHub Actions* instead. That variable changes the
words and nothing else.

**It asks first.** At a terminal, before anything is spent, it says once what it will post and as whom, and waits:

```
This will post as @alice on acme/api#128: a review with inline comments, a summary comment and a commit status "review-agent". Continue? [y/N]
```

Only `y` or `yes` goes on; anything else — Enter, Ctrl-D, Ctrl-C — posts nothing, spends nothing, and exits `1`.
`--yes` skips the question. Without a terminal there is no question: the same sentence is written to stderr, so a CI
log shows what was done.

**How it reports on the commit** (`--report auto`) is decided from the token with one call to GitHub (`GET /user`),
never from a guess about the environment:

- a person's token — classic, fine-grained, or `gh`'s — cannot create a check run (GitHub lets only Apps create them),
  so it reports with a **commit status** named `review-agent`. Setting a status needs **push access** to the repository;
- an installation token — a GitHub App's, or a GitHub Actions workflow's own `GITHUB_TOKEN` — reports with a **check
  run**, and falls back to a commit status if the token is refused one (a workflow without `checks: write`).

`--report status` and `--report check-run` choose for you; `check-run` with a person's token is refused before the
pull request is read or anything is spent (exit `2`). `--report none` posts the review and reports nothing on the commit, which also needs no
push access.

> **A commit status is a soft gate.** A branch rule can require a status named `review-agent`, but it cannot pin it
> to this reviewer: anyone with push access can set a status with the same name. Do not make a commit status the only
> thing standing between a pull request and your default branch. For a gate that holds, run the reviewer from the
> [GitHub App](github-app.md) or GitHub Actions, whose check runs a branch rule can pin to that App.

A review that did not run reports `success` with a description saying it is **not a verdict**, so an outage never
blocks a merge; a finished review reports `success`, or `failure` only through [the gate](configuration.md#the-gate).

**Re-reviews.** With `--post`, the reviewer reads its earlier summary on the pull request and asks the
[re-review pass](how-it-works.md#the-re-review-pass) whether what it found before is still there — a little more
model spend, only when there is an earlier review. `--no-re-review` skips the pass; the earlier summary is still edited
rather than a second one posted. The summary edited is the one this login posted, when there is one.

**GitHub Enterprise Server.** `--github-host github.example.com` talks to `https://github.example.com/api/v3` and asks
`gh` for that host's login. It has not been tested against a GitHub Enterprise Server in this release.

### What it prints

Progress notes go to **stderr**, so `--json` output on **stdout** is always one parseable document.

Without `--json`, stdout reads like this:

```
owner/name#9 at 1a2b3c4 — tier basic, claude-opus-5, effort low

<the reviewer's summary>

intent: matches — <note>

  [7/10 correctness] src/a.ts:42 Off-by-one in the retry loop [check: confirmed]
  [3/10 impact] src/b.ts:10 Log line repeats the token length [check: refuted]
  [?] Does the caller retry as well? — would be settled by: running the integration test

$1.05 model spend at per-token API prices · 21 turns · 183s · check $0.11
```

Each finding shows its severity out of 10, its category, where it is, its title and, when the check pass ran, its
verdict. `[?]` lines are what the reviewer could not settle on its own. A run that did not finish prints `FAILED:`
with the reason; a run cut off by its budget ceiling prints `CUT SHORT:` and still prints what it found. The cost is
the review's total — every pass it bought — as the Claude Code CLI reports it: model spend at per-token API prices,
which a subscription token draws from its allowance instead.

With `--post`, two lines follow:

```
posted 1 inline comment and a summary comment: https://github.com/owner/name/pull/9#issuecomment-…
reported with a commit status: success
```

With `--json`, stdout is the [review record](how-it-works.md#the-review-record).

Files of the repository that could not be written to the downloaded copy, and paths that differ only by letter
case, are named on stderr as the review starts, and listed on the record.

### `--json` with `--post`

With `--post`, `--json` prints the record inside an envelope that says what became of it on GitHub:

```json
{
  "record": { "recordVersion": 1, "…": "the review record" },
  "posted": {
    "reviewId": 900,
    "summaryCommentId": 8100,
    "summaryUrl": "https://github.com/owner/name/pull/9#issuecomment-8100",
    "inlineComments": 1
  },
  "report": { "kind": "commit-status", "conclusion": "success", "url": "https://github.com/owner/name/pull/9#issuecomment-8100" }
}
```

`posted` is `null` when nothing was posted (exit `4`, below); `report` is `null` with `--report none`. `reviewId` is
`null` when no review with inline comments was needed, `inlineComments` counts the comments GitHub placed, and
`conclusion` is a check run's word — `success`, `failure` or `neutral` — for a commit status too. Without `--post`,
`--json` prints the bare record, as before.

### Stopping a review

**Ctrl-C** (or `SIGTERM`) stops the review: the `claude` process is stopped with it, the downloaded code is deleted,
and the command exits `1` saying the review was stopped. If it had already set a commit status to `pending`, it sets it
to `error` on the way out — *"The review was interrupted before it finished"* — so the status does not block a merge;
the next run replaces it. A second Ctrl-C exits at once with `130`, without waiting for that clean-up.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | reviewed — and, with `--post`, posted |
| `1` | the review did not finish: the model failed, ran out of budget, returned unreadable output, GitHub could not be read, it was stopped with Ctrl-C, or you answered no to posting |
| `2` | bad usage, or something missing: a missing or invalid flag, `ANTHROPIC_BASE_URL` set, both model credentials set, no GitHub token, a token GitHub refuses when `--post` asks who it is, `--report check-run` with a person's token |
| `3` | the review's output matched a secret pattern, so it was withheld rather than printed or posted |
| `4` | reviewed and paid for, but posting failed. The review is printed (with `--json`, in the envelope with `posted: null`) so it is not lost |
| `130` | a second Ctrl-C, which exits without waiting for the review to stop |

`review-agent` with no arguments prints help and exits `2`; `review-agent --help` and `review-agent --version` exit `0`.

### Environment variables

| Variable | Needed | What it is |
|---|---|---|
| `GITHUB_TOKEN`, or `GH_TOKEN` | unless `gh` is logged in | the GitHub token; see [where it comes from](#where-the-github-token-comes-from). Empty counts as unset |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | unless `claude` is logged in | the model credential. **One** of them: both set refuses the run (exit `2`) |
| `ANTHROPIC_BASE_URL` | must be unset | a set value refuses the run |
| `GITHUB_ACTIONS` | no | set to `true` by GitHub Actions; makes the automated line say *from GitHub Actions*. Nothing else reads it |
| `CLAUDE_CONFIG_DIR` | no | where Claude Code keeps its login and settings, if you moved them; passed on to `claude` |
| `USE_BUILTIN_RIPGREP` | no | Claude Code's own switch for using the system's `ripgrep` (Alpine); passed on to `claude` |
| `REVIEW_AGENT_CLAUDE_BIN` | no | the **absolute** path to the Claude Code binary, outside the reviewed code; a relative path is refused, and so is npm's placeholder. Default: the first `claude` (`claude.exe` on Windows, or the one npm installed beside a `claude.cmd`) in an absolute `PATH` directory |
| `REVIEW_AGENT_SKILL_CACHE` | no | where [skills](configuration.md#skills) are cached. Default: `~/Library/Caches/review-agent/skills` on macOS, `%LOCALAPPDATA%\review-agent\skills` on Windows, `$XDG_CACHE_HOME/review-agent/skills` or `~/.cache/review-agent/skills` elsewhere. **Must be an absolute path**; created (`0700`) only when a skill is configured |
| `REVIEW_AGENT_SKILLS_TOKEN` | no | a GitHub token for downloading private `git` skill sources |

The `claude` process sees only `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `CLAUDE_CONFIG_DIR`, `USE_BUILTIN_RIPGREP`
and the one model credential in use — nothing else from your environment, your GitHub token included. On Windows,
Node also adds the system variables Windows needs, none of them secret. See [security](security.md).

### Examples

```sh
# The default: basic tier, check pass on, readable output, nothing posted.
review-agent review --repo acme/api --pr 128

# Spend more thought on a risky change, and say what matters.
review-agent review --repo acme/api --pr 128 --tier normal --effort high \
  --brief "this changes how sessions expire; check every caller"

# Machine-readable, without the check pass.
review-agent review --repo acme/api --pr 128 --skip-check --json > review.json

# Post it as yourself, with a commit status; asks before posting.
review-agent review --repo acme/api --pr 128 --post

# Three focused reviewers, posted without asking, no status on the commit.
review-agent review --repo acme/api --pr 128 --multi --post --yes --report none
```

The same in PowerShell, where a line continues with a backtick and output is redirected the same way:

```powershell
review-agent review --repo acme/api --pr 128

review-agent review --repo acme/api --pr 128 --tier normal --effort high `
  --brief "this changes how sessions expire; check every caller"

review-agent review --repo acme/api --pr 128 --skip-check --json > review.json

review-agent review --repo acme/api --pr 128 --post

review-agent review --repo acme/api --pr 128 --multi --post --yes --report none
```

## `review-agent doctor`

```sh
review-agent doctor [--repo <owner/name>] [--github-host <host>]
```

The same in PowerShell. It checks that this machine has what `review-agent review --post` needs, one line per check:
`✓` fine, `✗` missing — with a `fix:` line under it — and `!` worth knowing, which blocks nothing.

- **Node.js** 22 or newer;
- **Claude Code**: which binary a review would run, found by the same rule a review uses, or why there is none
  (not found, or npm's placeholder); and that it answers `--version` within 10 seconds — run with no credential;
- **the model credential**, by name and kind — never its value: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or
  neither (`claude login`, which doctor cannot check without starting a session: `!`). Both set is `✗`, and so is
  `ANTHROPIC_BASE_URL`;
- **the GitHub token**: where it came from — the variable, or `gh` — never its value; who GitHub says it is
  (`GET /user`), and for a classic token or a `gh` login its scope **names**, which say what it can reach;
- with `--repo`: whether the repository is readable, whether the token's user has **push access** (a commit status
  needs it), whether a classic token's scopes can post there, and **how the review would report** — a commit status
  (with the soft-gate warning) or a check run.

It only reads: no check run, no status, no comment and no model call, so it costs nothing. What cannot be learned
without writing — whether a fine-grained token may set a status, or what an installation token was granted — is said
as `!`. It exits `0` when nothing is `✗`, and `2` otherwise.

**An example layout** — produced by running doctor against test fakes (`packages/cli/src/doctor-command.test.ts`),
not captured from a real machine; the login, path and versions are invented:

<!-- doctor-example:start -->
```text
✓ Node.js 22.12.0
✓ Claude Code: /usr/local/bin/claude
✓ Claude Code version: 2.1.300 (Claude Code)
✓ ANTHROPIC_BASE_URL is not set
✓ model credential: ANTHROPIC_API_KEY — an Anthropic API key, billed at per-token API prices
✓ GitHub token: from GITHUB_TOKEN
✓ GitHub identity: @alice — scopes: repo, read:org — a classic token or a gh login reaches every repository @alice can, within its scopes
✓ acme/widgets: readable (private)
✓ @alice has push access to acme/widgets, which a commit status needs
! report: a commit status "review-agent" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App

Ready for `review-agent review --post`.
```
<!-- doctor-example:end -->

## `review-agent init`

Registers a **GitHub App** for an [App deployment](deploying.md), using GitHub's
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

```sh
review-agent init --name "Acme Reviewer" --url https://acme.example \
  --webhook-url https://acme.example/api/github/webhook [--org acme] [--webhook-inactive]
```

```powershell
review-agent init --name "Acme Reviewer" --url https://acme.example `
  --webhook-url https://acme.example/api/github/webhook [--org acme] [--webhook-inactive]
```

| Flag | Required | What it is |
|---|---|---|
| `--name` | yes | the App's name, as GitHub will show it on pull requests |
| `--url` | yes | the App's homepage; GitHub requires one |
| `--webhook-url` | yes | where GitHub will deliver events: your [receiver](deploying.md#3-write-the-receiver) |
| `--org` | no | register the App under this organisation instead of your own account |
| `--webhook-inactive` | no | register with deliveries switched off, for an App you drive in process |

What happens:

1. It starts a small web server on `127.0.0.1`, on a free port, and prints its address:
   `Open this page and press the button: http://127.0.0.1:<port>`. **Open that address yourself**; the command
   does not launch a browser.
2. The page shows the manifest and one button. Pressing it sends you to GitHub, which asks you to confirm the App.
3. GitHub redirects back to the local server with a one-time code, and the command exchanges it for the new App.
   The whole flow must finish within **one hour**.
4. It prints the App id, slug and **client id**, and the permissions GitHub stored. It refuses an App whose stored
   permissions are not exactly the [ones the reviewer needs](github-app.md#permissions-and-events).

**It writes no file and prints no secret.** GitHub returns a private key, a client secret and a webhook secret with
the registration; `init` discards all three. Instead it tells you what to do next — generate your own private key,
delete the registration-time key and the client secret, set a webhook secret, install the App. Those steps are in
[the GitHub App guide](github-app.md#after-registering).

The App is always registered as **private**: only the account that owns it can install it.

Exit codes: `0` registered, `1` the registration did not finish (including the one-hour timeout), `2` bad usage.

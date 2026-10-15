# Your first review in five minutes

At the end of this guide you will have reviewed a real pull request from your own terminal — on Windows, macOS or
Linux — and read what the reviewer found: a summary of the change, whether it does what it says, each finding with its
severity and the check pass's verdict, the questions it could not settle, and what the review cost. **Nothing is
posted anywhere.** The review is printed, and only you see it (use case UC-2 in
[the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

The five minutes are the review and reading it; installing what it needs takes as long as your downloads do.

The pull request is #8 of the public demo repository
[`crissmoldovan/review-agent-demo`](https://github.com/crissmoldovan/review-agent-demo), a small orders API whose pull
requests carry known problems. #8, `feat/currency-display`, has a bug in how it formats Japanese yen (JPY). Whether
the review finds it is what you are about to see: one review is a sample, not a verdict.

This is what `review-agent review --repo crissmoldovan/review-agent-demo --pr 8` printed — the whole of stdout (stderr
was empty):

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
the machine's Claude login (a subscription's allowance); the dollar figures are model spend at per-token API prices.* The
severities are the reviewer's own: 0.2.0 printed those. From 0.2.2 a line shows the check pass's, the one a posted
review uses, with the reviewer's beside it when they differ.

## What you need

- [ ] **A computer Claude Code runs on:** macOS 13 or newer; Ubuntu 20.04+, Debian 10+ or Alpine 3.19+; or Windows 10
      1809+ / Windows Server 2019+ — x64 or ARM64 in every case
      ([Claude Code's requirements](https://code.claude.com/docs/en/setup)). On **Windows**, review-agent 0.2.0 is
      **experimental**; the recommended way is **WSL2**, where you follow the Linux steps
      ([spec 0.2.0 §9.1](../specs/0.2.0-ways-in.md#91-support-levels-for-020)). On Alpine it is best effort.
- [ ] **A GitHub account.** The demo repository is public, so any account can read it — but the reviewer reads
      GitHub with a token, even for a public repository.
- [ ] **A way to pay for the model**, one of:
  - an **Anthropic API key**, from [console.anthropic.com](https://console.anthropic.com) — billed at per-token API
    prices;
  - a **Claude subscription** (Pro, Max, Team or Enterprise) — Claude Code's own login, or a token from
    `claude setup-token` — drawn from the subscription's allowance. The free claude.ai plan does not include Claude
    Code ([Claude Code's setup](https://code.claude.com/docs/en/setup#authenticate)).
- [ ] **Permission to install software**: Node.js, Claude Code, the GitHub CLI and review-agent.

| What | macOS | Linux | Windows (PowerShell) |
|---|---|---|---|
| Node.js 22 or newer | step 1 | step 1 | step 1 |
| Claude Code | `curl` installer, or Homebrew | `curl` installer | PowerShell installer, or WinGet |
| GitHub CLI (optional — a token works too) | `brew install gh` | [its Linux instructions](https://github.com/cli/cli#installation) | `winget install --id GitHub.cli` |

Every command below is the same in a POSIX shell (macOS, Linux, WSL) and in PowerShell unless the guide shows both.

## 1. Install Node.js 22 or newer

Check what you have:

```sh
node --version
```

It should print `v22` or higher, such as `v22.12.0`. If it does not, install Node.js:

- **macOS**: the installer from [nodejs.org](https://nodejs.org/en/download), or `brew install node`.
- **Linux**: [nodejs.org/en/download](https://nodejs.org/en/download) gives the commands for your distribution. A
  distribution's own `nodejs` package is often older than 22: check `node --version` afterwards.
- **Windows**: the installer from [nodejs.org](https://nodejs.org/en/download), or in PowerShell:

  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

Open a new terminal afterwards, so it finds the new `node`.

**If you see this instead**

| Symptom | Fix |
|---|---|
| `node: command not found`, or `'node' is not recognized` | the terminal was opened before the install: open a new one. If it persists, the installer did not put Node.js on `PATH`; run it again |
| `v20.…` or lower | an older Node.js comes first on `PATH`. review-agent needs 22 or newer: `review-agent doctor` says `✗ Node.js …: review-agent needs 22 or newer` |

## 2. Install Claude Code

The reviewer runs Claude Code, headless and read-only, to do the review. Install it with Anthropic's installer.

macOS, Linux and WSL:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Windows, in PowerShell — either of:

```powershell
irm https://claude.ai/install.ps1 | iex
winget install Anthropic.ClaudeCode
```

On macOS, `brew install --cask claude-code` works too. Or, on any of the three, with npm — the command that works on
npm 10, 11 and 12 alike (tested 2026-10-15):

```sh
npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
```

npm 12 does not run a dependency's install script unless you allow it, and Claude Code's npm package needs its script
to put the real binary in place; `--allow-scripts` allows it for that one package.

Open a new terminal, and check:

```sh
claude --version
```

It prints a version followed by `(Claude Code)`, such as `2.1.258 (Claude Code)`. The App's runner pins `2.1.258`, the
version the reviewer's flags were measured against; the CLI runs whichever Claude Code it finds.

**Then choose how the model is paid for.** Exactly one of these — the reviewer refuses to run with two:

- **Claude Code's own login** (a subscription, or a Console account): run `claude` once, follow its prompts to log in
  in your browser, then leave it. Set no variable.
- **An API key**, for this terminal only. Typed at a prompt rather than on the command line, so it stays out of your
  shell's history:

  ```sh
  read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
  ```

  ```powershell
  $env:ANTHROPIC_API_KEY = Read-Host -MaskInput "Anthropic API key"
  ```

  (`-MaskInput` needs PowerShell 7. In Windows PowerShell 5.1 leave it out: the key shows as you type it, and still
  stays out of your history.)
- **A subscription token** from `claude setup-token`: the same, with `CLAUDE_CODE_OAUTH_TOKEN` in place of
  `ANTHROPIC_API_KEY`. A subscription token is for your own use — your laptop, your own CI — never shared
  ([spec 0.2.0 §2.3](../specs/0.2.0-ways-in.md#23-model-credentials)).

Leave `ANTHROPIC_BASE_URL` unset: the reviewer refuses to run while it is set, because the reviewed code goes to
Anthropic and nowhere else.

**If you see this instead**

| Symptom | Fix |
|---|---|
| `claude: command not found`, or `'claude' is not recognized` | open a new terminal. If it persists, the installer's directory is not on `PATH`: Anthropic's [installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install) says how to add it |
| `claude --version` prints `Error: claude native binary not installed.` | npm skipped Claude Code's install script, so `claude` is a small placeholder. Install again with the npm command above, `--allow-scripts` included, or use Anthropic's installer |

## 3. Install review-agent

```sh
npm install --global @review-agent/cli
review-agent --version
```

It prints the version, and this guide is written for:

```text
0.2.0
```

Without installing, `npx @review-agent/cli` followed by the same arguments runs it too.

**If you see this instead**

| Symptom | Fix |
|---|---|
| `review-agent.ps1 cannot be loaded because running scripts is disabled on this system` (PowerShell) | PowerShell's execution policy blocks the script npm put on `PATH`. Run `review-agent.cmd` instead, or allow local scripts for your account: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `npm error code EACCES` | npm's global directory belongs to another user — as when Node.js was installed system-wide. Use `npx @review-agent/cli` instead, or install Node.js with a version manager ([nodejs.org](https://nodejs.org/en/download) lists them). Do not use `sudo` |
| `npm warn EBADENGINE` naming `node: '>=22'` | your Node.js is older than 22: step 1 |

## 4. Sign in to GitHub

The reviewer needs a GitHub token that can read the pull request. It looks, in order, at `GITHUB_TOKEN`, at `GH_TOKEN`,
and at the [GitHub CLI](https://cli.github.com)'s own login ([where the token comes from](../cli.md#where-the-github-token-comes-from)).

**With the GitHub CLI** (recommended). Install it — `brew install gh` on macOS, `winget install --id GitHub.cli` on
Windows, [its instructions](https://github.com/cli/cli#installation) on Linux — open a new terminal, and log in:

```sh
gh auth login
```

Choose GitHub.com and to log in with a web browser; copy the one-time code it prints, and approve in the browser.
`gh auth status` then says you are logged in to github.com. review-agent asks `gh` for its token each time
(`gh auth token --hostname github.com`); it never prints, logs or stores it, and never gives it to the Claude process.

If you skip this step and `gh` is installed, `review-agent review` offers, at a terminal, to run
`gh auth login --web --hostname github.com` for you.

**Or with a token.** On github.com: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
Generate new token**. For the demo repository, **Public repositories** access is enough to read. Then, for this
terminal:

```sh
read -rs GITHUB_TOKEN && export GITHUB_TOKEN
```

```powershell
$env:GITHUB_TOKEN = Read-Host -MaskInput "GitHub token"
```

**What the token can reach.** A `gh` login — like a classic token with the `repo` scope — reaches every repository
your account can. The reviewer uses it for the one repository named on the command line, and nothing else. To narrow
it, use a fine-grained token limited to the repositories you review.

## 5. Check the machine

```sh
review-agent doctor
```

It checks what a review needs and prints one line per check: `✓` fine, `✗` missing — with a `fix:` line under it —
and `!` worth knowing, which blocks nothing. It only reads: no model call, no comment, nothing spent.

**An example layout**, with a `gh` login and an API key — the lines are the ones the code prints
(`packages/cli/src/doctor-command.ts`); the login, path and versions are invented:

```text
✓ Node.js 22.12.0
✓ Claude Code: /usr/local/bin/claude
✓ Claude Code version: 2.1.258 (Claude Code)
✓ ANTHROPIC_BASE_URL is not set
✓ model credential: ANTHROPIC_API_KEY — an Anthropic API key, billed at per-token API prices
✓ GitHub token: from the GitHub CLI's login for github.com (gh auth token)
✓ GitHub identity: @alice — scopes: gist, read:org, repo — a classic token or a gh login reaches every repository @alice can, within its scopes
! no --repo given: what this token can do on a repository was not checked (review-agent doctor --repo owner/name)
! report: a commit status "review-agent" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App

Ready for `review-agent review --post`.
```

With Claude Code's own login instead of a key, the credential line is a `!`: doctor cannot tell whether Claude Code is
logged in without starting a session. The two `!` lines at the end are about posting, which this guide does not do.
Leave out `--repo` for now: its checks are whether you could post on that repository, and only its owner can post on
the demo repository.

The real output, from the machine these guides were captured on — a `gh` login, and Claude Code's own login rather
than a key:

```text
✓ Node.js 26.7.0
✓ Claude Code: /opt/homebrew/bin/claude
✓ Claude Code version: 2.1.289 (Claude Code)
✓ ANTHROPIC_BASE_URL is not set
! model credential: none set, so Claude Code's own login (`claude login`) will be used — doctor cannot tell whether it is logged in without starting a session; a review that is not says "Not logged in"
✓ GitHub token: from the GitHub CLI's login for github.com (gh auth token)
✓ GitHub identity: @crissmoldovan — scopes: admin:org, gist, read:packages, repo, workflow — a classic token or a gh login reaches every repository @crissmoldovan can, within its scopes
! no --repo given: what this token can do on a repository was not checked (review-agent doctor --repo owner/name)
! report: a commit status "review-agent" — a soft gate: a branch rule cannot pin it to this reviewer, so anyone with push access could set one with the same name. For a gate that holds, run it from GitHub Actions or the App

Ready for `review-agent review --post`.
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · exit code
`0`. doctor makes no model call, so nothing was spent.*

*Not captured yet on Windows: no Windows machine with a Claude login was available for these captures. Windows is
covered by CI instead — the `claude smoke, $0 (windows-latest)` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) installs the real Claude Code and runs it through the
reviewer with no credential, at $0 ([CHANGELOG](../../CHANGELOG.md)). doctor prints the same checks on Windows; its
`Claude Code:` line names the `claude.exe` it found, and some `fix:` lines give the PowerShell form.*

**If you see this instead**

| Line | Fix |
|---|---|
| `✗ Claude Code was not found: …` | step 2; or set `REVIEW_AGENT_CLAUDE_BIN` to the absolute path of the binary |
| `✗ Claude Code's native binary is not installed — npm skipped its install script. …` | npm left its placeholder: reinstall with `--allow-scripts`, as in step 2, or use Anthropic's installer |
| `✗ Claude Code did not answer --version: …` | run the path it names with `--version` yourself to see why; reinstall if it fails there too |
| `✗ ANTHROPIC_BASE_URL is set: …` | unset it: `unset ANTHROPIC_BASE_URL`, or `Remove-Item Env:ANTHROPIC_BASE_URL` in PowerShell |
| `✗ model credential: ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are both set, …` | unset one of them — or both, to use Claude Code's own login |
| `✗ GitHub token: none found` | step 4. The `fix:` line says what was missing: no variable, and `gh` not installed or not logged in |
| `✗ GitHub refused the token from … (401): it is wrong, expired or revoked` | make a new token, or `gh auth login` again |

`doctor` exits `0` when nothing is `✗` and `2` otherwise. More: [troubleshooting](troubleshooting.md).

## 6. Review demo pull request #8

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 8
```

The reviewer reads the pull request, downloads the repository at its head commit — as an archive, with
credential-shaped files removed — and runs Claude Code over it with read-only tools (Read, Grep and Glob: no shell).
A second pass then tries to disprove each finding. It may print a note on stderr while it works, such as a file it
removed from the download; otherwise nothing appears until it finishes. A `basic` review of a real pull request took
2–5 minutes when measured; this one, of the demo's small pull request, took 60 seconds end to end (2026-10-15).

Nothing is written to GitHub, and the downloaded code is deleted when the review ends. **Ctrl-C** stops the review and
the Claude process with it; a second Ctrl-C exits at once.

It prints the review shown at [the top of this guide](#your-first-review-in-five-minutes).

**If you see this instead**

| Output | Cause, and the fix |
|---|---|
| `FAILED: cli-error — Not logged in · Please run /login`, exit `1` | no credential variable is set and Claude Code is not logged in. Step 2. Nothing was spent |
| `no GitHub token: …`, exit `2` | step 4. Without a terminal it never offers to log you in, and says exactly what to set |
| `2 model credentials are set (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN); …`, exit `2` | unset one of them |
| `ANTHROPIC_BASE_URL is set: …`, exit `2` | unset it |
| `the pull request could not be read: …`, exit `1` | the repository or the number is wrong, or the token cannot read it. GitHub's own message follows — `Not Found`, or `Bad credentials` for a token that is not one |
| `the review did not complete: Claude Code was not found: …`, exit `1` | step 2; `review-agent doctor` finds this before a review starts |
| `FAILED: crashed`, exit `1` | the Claude process ended without an answer — for example a Claude Code too old to accept the [flags the reviewer passes](../how-it-works.md#how-the-model-is-run). Check `claude --version`, and update it |
| `CUT SHORT: the hard ceiling fired; this review is partial.`, exit `1` | the review reached its spending ceiling ($5.00 at `basic`). What it found before then is printed above the line |
| `FAILED: budget`, `FAILED: schema` or `FAILED: refusal`, exit `1` | the model ran and produced nothing usable: stopped by its ceiling, an answer in the wrong shape, or prose instead of a review. Running it again pays again |

## 7. Read the output

What a review prints has a fixed shape. **An example layout** — the shape is the code's
(`packages/cli/src/review-command.ts`); the words, numbers and paths are invented:

```text
owner/name#9 at 1a2b3c4 — tier basic, claude-opus-5, effort low

<the reviewer's summary>

intent: matches — <note>

  [7/10 correctness] src/a.ts:42 Off-by-one in the retry loop [check: confirmed, was 8/10]
  [3/10 impact] src/b.ts:10 Log line repeats the token length [check: refuted]
  [?] Does the caller retry as well? — would be settled by: running the integration test

$1.05 model spend at per-token API prices · 21 turns · 183s · check $0.11
```

Line by line:

1. **What was reviewed**: the repository and pull request, the commit (first seven characters), the tier, the model
   and its effort.
2. **The summary**: the reviewer's account of the change.
3. **The intent verdict**: does the change do what its description says — `matches`, `partial`, `diverges` or
   `unclear` — with a note.
4. **Each finding**: severity out of 10 and category (`intent`, `correctness`, `impact`, `security`), the file and
   line, the title, and the **check pass's verdict**. The check pass reads the code again and tries to disprove each
   finding: `confirmed`, `uncertain`, or `refuted`. A refuted finding would never be posted. The severity printed is
   the one a posted review uses — the check pass's — and `was 8/10` gives the reviewer's own when the check pass
   changed it. (0.2.0 and 0.2.1 printed the reviewer's own, as in the capture at the top of this guide.) `no
   findings` is a review that found nothing — which is an answer, not a failure.
5. **`[?]` lines**: questions the reviewer could not settle from the code alone, and what would settle them.
6. **The cost line**: the review's whole model spend, every pass included, **at per-token API prices** as Claude Code
   reports it; the reviewer's turns and seconds; and what the check pass cost of that total.

The exit code is `0` for a finished review, whatever it found. Every exit code: [the CLI reference](../cli.md#exit-codes).

## 8. The same review as JSON

`--json` prints the whole [review record](../how-it-works.md#the-review-record) — the request, the settings, the
model's full output, every check verdict, each pass's usage and the total cost — as one JSON document on stdout.
Progress notes stay on stderr, so stdout always parses.

**This runs the review again, and pays for it again** — and, one review being a sample, it may not find the same things.

```sh
review-agent review --repo crissmoldovan/review-agent-demo --pr 8 --json > review.json
jq '.costUsd' review.json
jq -r '.output.findings[] | "\(.severity)/10 \(.file):\(.line) \(.title)"' review.json
jq -r '.checkVerdicts[]? | "#\(.index) \(.verdict) at \(.severity)/10"' review.json
```

(`jq` is a separate install.) In PowerShell, read it straight into an object. The first line makes PowerShell read
the CLI's output as UTF-8, which it otherwise does not on Windows:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$review = review-agent review --repo crissmoldovan/review-agent-demo --pr 8 --json | Out-String | ConvertFrom-Json
$review.costUsd
$review.output.findings | ForEach-Object { "$($_.severity)/10 $($_.file):$($_.line) $($_.title)" }
$review.checkVerdicts | ForEach-Object { "#$($_.index) $($_.verdict) at $($_.severity)/10" }
```

The fields you will read most:

| Field | What it holds |
|---|---|
| `costUsd` | the total model spend, at per-token API prices |
| `output.summary`, `output.intent` | the summary, and `{ verdict, note }` |
| `output.findings[]` | `file`, `line`, `endLine`, `severity`, `category`, `title`, `explanation`, `evidence`, `suggestion` — the reviewer's own list |
| `checkVerdicts[]` | per finding (`index` into `output.findings`): `verdict`, the check pass's `severity`, its `reason` and `evidence`; `null` when the check pass did not run |
| `failure`, `cutShort` | why the review did not finish, or `null`; whether its ceiling stopped it |
| `checkout.removedCredentialFiles` | what was deleted from the download before the model started |

`output` is `null` when the model produced nothing usable.

The three `jq` commands, run on the `--json` record of a second review of #8:

```text
$ jq '.costUsd' review.json
0.2988815
$ jq -r '.output.findings[] | "\(.severity)/10 \(.file):\(.line) \(.title)"' review.json
7/10 src/format.ts:16 formatMoney assumes 2 minor units, so JPY is formatted wrong
5/10 src/http/serialize.ts:36 `GET /orders` summaries have no `totalDisplay`, so the console cannot drop its formatter
3/10 src/format.ts:17 Float division loses precision for very large amounts
$ jq -r '.checkVerdicts[]? | "#\(.index) \(.verdict) at \(.severity)/10"' review.json
#0 confirmed at 6/10
#1 confirmed at 4/10
#2 refuted at 1/10
```

*Captured 2026-10-15 · review-agent 0.2.0 (release build from `feat/0.2.0`) · Claude Code 2.1.289 on macOS · read with
jq 1.7.1 · paid with the machine's Claude login (a subscription's allowance); `costUsd` is model spend at per-token API
prices. Not captured on Windows, so the PowerShell lines' output is not shown.*

This second run found three things where the first, at the top of this guide, found four — one review is a sample. The
severities in `output.findings` are the reviewer's own; the check pass gave its own, and refuted the third finding (`#2
refuted at 1/10`), which a posted review would therefore leave out.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model, with an API key | Anthropic — **per-token API prices** | **measured** with `claude-opus-5`: $0.88–1.06 for a `basic` review of a real production pull request, plus $0.07–0.58 for its check pass; $0.16–0.29 for a whole `basic` review of a one-file pull request, check pass included ([what it costs](../../README.md#what-it-costs)); $0.25 and $0.30 for the two whole reviews of demo #8 above (measured 2026-10-15). Hard ceilings at `basic`: $5.00 for the review and $1.25 for its check pass. Each `--json` run in step 8 is another review |
| The model, with a subscription | your subscription — **its allowance** | the same amounts, drawn from the subscription's allowance rather than billed per token |
| GitHub | — | reading a pull request through GitHub's API is not charged; it counts against your account's API rate limit |

The figure on the cost line is model spend at per-token API prices whichever credential paid, because that is the
figure Claude Code reports.

## Next steps

- [Post a review as yourself](post-as-yourself.md): the same review, on the pull request, under your name.
- [Choose a tier](choosing-a-tier.md): when `basic` is enough, when to ask for `normal` or `thorough`, and the
  multi-reviewer mode.
- [The CLI reference](../cli.md): every flag, exit code and environment variable.
- [Troubleshooting](troubleshooting.md), by symptom.

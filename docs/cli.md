# The command line: `review-agent`

The CLI is the quickest way to try the reviewer. It reviews one pull request on your own machine and prints
what it found. **It never posts anything to GitHub** — posting is what the [App and runner](deploying.md) do.

It has two commands:

| Command | What it does |
|---|---|
| [`review-agent review`](#review-agent-review) | reviews one pull request and prints the result |
| [`review-agent init`](#review-agent-init) | registers a GitHub App for a deployment, through GitHub's manifest flow |

## Install

```sh
npm install --global @review-agent/cli     # puts `review-agent` on your PATH
# or, without installing:
npx @review-agent/cli review --repo owner/name --pr 9
```

Node.js **22 or newer** is required.

## `review-agent review`

```sh
review-agent review --repo <owner/name> --pr <number> [options]
```

### What it needs

1. **The Claude Code CLI**, as `claude` on your `PATH`, or wherever `REVIEW_AGENT_CLAUDE_BIN` points. The
   reviewer runs it headless. The hosted runner pins Claude Code `2.1.258`; the CLI uses whichever `claude` it
   finds, and a version that does not accept the [flags the engine passes](how-it-works.md#how-the-model-is-run)
   fails the review.
2. **A model credential**, one of:
   - `ANTHROPIC_API_KEY` — an Anthropic API key, billed at per-token API prices;
   - `CLAUDE_CODE_OAUTH_TOKEN` — a subscription token from `claude setup-token`, drawn from that
     subscription's allowance;
   - neither — then `claude` uses its own login (`claude login`), if it has one.

   `ANTHROPIC_BASE_URL` must be **unset**: the reviewer refuses to run while it is set, because it sends the
   reviewed code to Anthropic and nowhere else. See [security](security.md).
3. **A GitHub token** in `GITHUB_TOKEN` (or `GH_TOKEN`, used only when `GITHUB_TOKEN` is not set at all) that can
   read the repository: **Contents: Read** and **Pull requests: Read**, nothing more. A fine-grained personal
   access token limited to the one repository is enough.

### Options

| Flag | Value | Default | What it does |
|---|---|---|---|
| `--repo` | `owner/name` | — **required** | the repository |
| `--pr` | a positive whole number | — **required** | the pull request number |
| `--tier` | `basic` \| `normal` \| `thorough` | `basic` | the preset: effort, budget and whether the check pass runs. See [tiers](configuration.md#tiers) |
| `--model` | a model name | `claude-opus-5` | passed to Claude Code as `--model`, unchecked |
| `--effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | the tier's | how hard the model thinks |
| `--check` | — | the tier's (on in every tier) | run the [check pass](how-it-works.md#the-check-pass) |
| `--skip-check` | — | — | skip the check pass. Giving both `--check` and `--skip-check` is an error |
| `--brief` | text | — | a note for the reviewer, such as what to focus on. It is fenced off as data in the prompt: it can steer attention, never change the rules |
| `--budget` | dollars, a positive number | the tier's | **lower** the soft budget. A value above the tier's is ignored, with a note on stderr |
| `--json` | — | off | print the full review record as JSON instead of the readable summary |
| `--post` | — | — | **not available**: always refused with exit code 2. Use the App to post |

Notes:

- `--tier thorough` is accepted by the CLI, but the multi-reviewer fan-out it is named for is **not built**: it runs
  one reviewer at `high` effort with an $8 soft budget ($20 ceiling). The App does not honour it: a request for
  `thorough` there runs at the default tier, and the summary says so.
- The CLI uses the [built-in defaults](configuration.md#deployment-settings) and reads no configuration file of its
  own. It **does** read the reviewed repository's [`.review-agent/review.md`](configuration.md#the-repository-file)
  from the pull request's **base** branch, as the App does.
- A CLI review is always a first review: it reads no earlier review, so the [re-review
  pass](pull-requests.md#re-reviews) never runs here.

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
$0.94 · 21 turns · 183s · check $0.11
```

Each finding shows its severity out of 10, its category, where it is, its title and, when the check pass ran, its
verdict. `[?]` lines are what the reviewer could not settle on its own. A run that did not finish prints `FAILED:`
with the reason; a run cut off by its budget ceiling prints `CUT SHORT:` and still prints what it found.

With `--json`, stdout is the [review record](how-it-works.md#the-review-record).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | the review finished |
| `1` | the review did not finish: the model failed, ran out of budget, returned unreadable output, or an error was thrown |
| `2` | bad usage: a missing or invalid flag, `--post`, `ANTHROPIC_BASE_URL` set, or no GitHub token |
| `3` | the review's output matched a secret pattern, so it was withheld rather than printed |

`review-agent` with no arguments prints help and exits `2`; `review-agent --help` exits `0`. There is no
`--version` flag in this release: `npm ls -g @review-agent/cli` tells you which version is installed.

### Environment variables

| Variable | Needed | What it is |
|---|---|---|
| `GITHUB_TOKEN`, or `GH_TOKEN` | yes | read access to the repository |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | unless `claude` is logged in | the model credential |
| `ANTHROPIC_BASE_URL` | must be unset | a set value refuses the run |
| `REVIEW_AGENT_CLAUDE_BIN` | no | path to the `claude` binary; default `claude` from `PATH` |
| `REVIEW_AGENT_SKILL_CACHE` | no | where [skills](configuration.md#skills) are cached; default `~/.cache/review-agent/skills`. **Must be an absolute path** — the directory is created on every review |
| `REVIEW_AGENT_SKILLS_TOKEN` | no | a GitHub token for downloading private `git` skill sources |

The `claude` process sees only `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and the two model credentials — nothing
else from your environment, your GitHub token included. See [security](security.md).

### Examples

```sh
# The default: basic tier, check pass on, readable output.
review-agent review --repo acme/api --pr 128

# Spend more thought on a risky change, and say what matters.
review-agent review --repo acme/api --pr 128 --tier normal --effort high \
  --brief "this changes how sessions expire; check every caller"

# Machine-readable, without the check pass.
review-agent review --repo acme/api --pr 128 --skip-check --json > review.json

# Cap the soft budget at $1 (the ceiling becomes $2.50).
review-agent review --repo acme/api --pr 128 --budget 1
```

## `review-agent init`

Registers a **GitHub App** for an [App deployment](deploying.md), using GitHub's
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

```sh
review-agent init --name "Acme Reviewer" --url https://acme.example \
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

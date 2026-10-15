# Troubleshooting, by symptom

Find what you see, and read across: what it means, and what to do. Every message here is quoted as the code prints
it; `…` marks the part that changes — a name, a number, GitHub's own words. Messages are grouped by where you meet
them: [installing](#installing-and-starting), [Claude Code](#claude-code), [the model
credential](#the-model-credential), [the GitHub token](#the-github-token), [flags](#flags), [posting](#posting),
[a review that did not finish](#a-review-that-did-not-finish), [on the pull request](#on-the-pull-request),
[App deployments and your own server](#app-deployments-and-your-own-server), [GitHub Actions](#github-actions) and
[the SDK](#the-sdk).

`review-agent doctor` finds most of the first four groups before a review starts, at no cost:

```sh
review-agent doctor --repo owner/name
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | reviewed — and, with `--post`, posted |
| `1` | the review did not finish: the model failed, ran out of budget or returned nothing usable, GitHub could not be read, the report could not be opened, it was stopped, or you answered no to posting |
| `2` | bad usage, or something missing: a flag, a token, a credential — or `ANTHROPIC_BASE_URL` set, or a token GitHub refuses when `--post` asks who it is |
| `3` | the review's output matched a secret pattern, so it was withheld rather than printed or posted |
| `4` | reviewed and paid for, but posting failed. The review is printed so it is not lost |
| `130` | a second Ctrl-C, which exits without waiting for the review to stop |

`review-agent doctor` exits `0` when nothing is `✗` and `2` otherwise. Every code: [the CLI](../cli.md#exit-codes).

## Installing and starting

| You see | Cause | Fix |
|---|---|---|
| `review-agent: command not found`, or `'review-agent' is not recognized` | npm's global `bin` directory is not on `PATH`, or the terminal predates the install | open a new terminal; `npm prefix --global` shows where npm installs, and its `bin` (on Windows, the directory itself) must be on `PATH`. Or run `npx @review-agent/cli` |
| `review-agent.ps1 cannot be loaded because running scripts is disabled on this system` | PowerShell's execution policy blocks the script npm put on `PATH` | run `review-agent.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `npm error code EACCES` on a global install | npm's global directory belongs to another user | `npx @review-agent/cli`, or Node.js from a version manager; in CI, `export NPM_CONFIG_PREFIX="$PWD/.review-agent"` and put its `bin` on `PATH` ([other CI](other-ci.md#2-the-job-in-any-shell)). Not `sudo` |
| `npm warn EBADENGINE` naming `node: '>=22'` | Node.js older than 22 | install Node.js 22 or newer |
| doctor: `✗ Node.js …: review-agent needs 22 or newer` | the same | the same |
| `error: unknown command '…'` | a command that does not exist; the CLI has `review`, `doctor` and `init` | `review-agent --help` |

## Claude Code

In a review, the messages below that say Claude Code was not found, is npm's placeholder, or name
`REVIEW_AGENT_CLAUDE_BIN` follow `the review did not complete:` (exit `1`); in doctor, a `✗`.

| You see | Cause | Fix |
|---|---|---|
| `` Claude Code was not found: no executable `claude` in an absolute PATH directory. Install Claude Code, or set REVIEW_AGENT_CLAUDE_BIN to its absolute path `` (macOS, Linux) | no `claude` in a `PATH` directory written as an absolute path. Relative and empty `PATH` entries are skipped on purpose: they would mean the downloaded code's directory | install Claude Code ([your first review](first-review.md#2-install-claude-code)), open a new terminal, or set `REVIEW_AGENT_CLAUDE_BIN` |
| `Claude Code was not found: no claude.exe in an absolute PATH directory, nor in the npm package beside a claude.cmd. …` (Windows) | the same, on Windows. The reviewer runs `claude.exe`, never a `.cmd` or `.ps1` script | `irm https://claude.ai/install.ps1 \| iex`, or `winget install Anthropic.ClaudeCode`, or set `REVIEW_AGENT_CLAUDE_BIN` to the absolute path of `claude.exe` |
| `Claude Code's native binary is not installed — npm skipped its install script. … is the placeholder npm leaves in its place. …` | npm installed Claude Code without running its install script — npm 12's default — so `claude` is a ~500-byte placeholder | `npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code` (npm 10, 11 and 12), or Anthropic's installer |
| `claude --version` prints `Error: claude native binary not installed.` | the same placeholder, run directly | the same |
| `REVIEW_AGENT_CLAUDE_BIN must be an absolute path to the Claude Code binary; a relative one could resolve inside the code under review` | the variable holds a relative path | give the full path |
| `REVIEW_AGENT_CLAUDE_BIN points inside the checkout of the code under review; refusing to run it` | the path is inside the directory the pull request's code is downloaded to | point it at a Claude Code outside it |
| doctor: `✗ Claude Code did not answer --version: it did not answer within 10 seconds` | the binary hangs, or is not Claude Code | run it with `--version` yourself; reinstall |
| doctor: `✗ Claude Code did not answer --version: it failed (…)` | it exited with an error, or could not start — the code in brackets says which | the same |
| `FAILED: cli-error — Not logged in · Please run /login`, exit `1` | no credential variable is set, and Claude Code on this machine is not logged in. Nothing was spent | run `claude` and log in, or set `ANTHROPIC_API_KEY` |
| `FAILED: cli-error — …`, exit `1` | Claude Code reported an error before the model answered; its own words follow the dash | act on its words: a credential, an API error, a network problem |
| `FAILED: crashed`, exit `1` | the Claude process ended without an answer: killed — out of memory, a signal — or a Claude Code too old for the [flags the reviewer passes](../how-it-works.md#how-the-model-is-run) | `claude --version`; the App's runner pins `2.1.258`. On a small machine, give it more memory or run fewer reviews at once |

## The model credential

| You see | Cause | Fix |
|---|---|---|
| `ANTHROPIC_BASE_URL is set: this reviewer sends the reviewed code only to Anthropic, with an Anthropic API key or a subscription token, and refuses to run pointed anywhere else. Unset it.` | a gateway or proxy address is set. Every way in refuses it, the SDK included, even with a credential passed explicitly | `unset ANTHROPIC_BASE_URL`; in PowerShell `Remove-Item Env:ANTHROPIC_BASE_URL`; in a deployment, remove the variable |
| `` 2 model credentials are set (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN); set exactly one, so that what a review costs is billed somewhere a person can name, or neither, to use this machine's `claude login`. `` | both are set, so nobody could say which account paid | unset one. The CLI also accepts neither, and uses Claude Code's own login |
| `` no model credential: set exactly one of ANTHROPIC_API_KEY (an Anthropic API key) or CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, a Claude subscription). No review can run without one. `` | an App runner, your own server or the SDK found none. Only the CLI may fall back to a `claude login` | set one — an API key, for anything that reviews other people's pull requests |
| doctor: `` ! model credential: none set, so Claude Code's own login (`claude login`) will be used — … `` | not a problem in itself: doctor cannot tell whether Claude Code is logged in without starting a session | if a review then says `Not logged in`, log in |
| `CLAUDE_CODE_OAUTH_TOKEN is set` (your own server) | the server takes an API key only | remove it from the environment file ([self-hosting](self-hosting.md#4-start-it-on-the-server)) |

## The GitHub token

| You see | Cause | Fix |
|---|---|---|
| `` no GitHub token: GITHUB_TOKEN and GH_TOKEN are not set, and the GitHub CLI (gh) is not installed. Set GITHUB_TOKEN (or GH_TOKEN) to a token with … , or log in with `gh auth login --web --hostname …`. ``, exit `2` | no token anywhere the CLI looks. Empty variables count as unset | set `GITHUB_TOKEN`, or install `gh` and `gh auth login` ([where the token comes from](../cli.md#where-the-github-token-comes-from)) |
| `no GitHub token: … and the GitHub CLI is not logged in to …. …`, exit `2` | `gh` is installed but not logged in to that host, and there is no terminal to offer a login on (CI) | `gh auth login`, or set `GITHUB_TOKEN` |
| `` no GitHub token: … and `gh auth token` failed: it did not answer within 15 seconds. … `` | `gh` hung | check `gh auth status`; or set `GITHUB_TOKEN` |
| `` No GitHub token: … Run `gh auth login --web --hostname …` now? It opens your browser, and you approve there. [y/N] `` | at a terminal, with `gh` installed and logged out, the CLI offers to log you in | `y` opens the browser; then `logged in: using the GitHub CLI's login for …` and the review goes on |
| `` `gh auth login --web --hostname …` did not finish (exit …); no GitHub token: … `` | the login was cancelled or failed | run `gh auth login` yourself |
| `GitHub refused the token from … (401): it is wrong, expired or revoked`, exit `2` | with `--post`, GitHub would not say who the token is | a new token, or `gh auth login` again |
| `the pull request could not be read: …`, exit `1` | the repository or number is wrong, the token cannot read it, or GitHub did not answer. GitHub's own message follows — `Not Found`, `Bad credentials` | check `--repo` and `--pr`; `review-agent doctor --repo owner/name` |
| `the review did not complete: could not ask GitHub who the token belongs to: …`, exit `1` | with `--post`, GitHub did not answer the one `GET /user` | the network, or `--github-host` |
| doctor: `✗ …: not found, or this token cannot read it` | a wrong name, or a token without access to it | check the name; a fine-grained token must include the repository |
| doctor: `✗ @… has no push access to …, and a commit status needs it` | your account cannot push there | ask for the Write role, or post with `--report none` |
| doctor: `✗ this token's scopes (…) cannot post to …` | a classic token without `repo` (or `public_repo`, for a public repository) | give it the scope, or use another token |
| doctor: `! GitHub does not list what this token may do: …` | a fine-grained token: its permissions cannot be read without writing | check it has Contents: Read, Pull requests: Read and write, Commit statuses: Read and write |
| doctor: `! an installation token's permissions are not listed by GitHub: …` | an App's or GitHub Actions' token | a workflow needs `pull-requests: write`, and `checks: write` for a check run |
| an error with `[redacted]` in it | GitHub's message quoted the token, and the CLI took it out | nothing to do: the token was never printed |

## Flags

Each is exit `2`, before anything is read or spent.

| You see | Fix |
|---|---|
| `--repo is required, as owner/name` · `--repo must be owner/name, got "…"` | `--repo acme/widgets` |
| `--pr is required` · `--pr must be a positive whole number, got "…"` | `--pr 128` |
| `--tier must be one of basic, normal, thorough, got "…"` | [choosing a tier](choosing-a-tier.md) |
| `--effort must be one of low, medium, high, xhigh, max, got "…"` | one of those |
| `--budget must be a positive number of dollars, got "…"` | `--budget 1.50`. It can only lower the tier's budget |
| `--check and --skip-check contradict each other` | one of them |
| `--report must be one of auto, check-run, status, none, got "…"` | one of those |
| `--report says how a posted review is reported on the commit: add --post, or leave it out` | `--report` does something only with `--post` |
| `--re-review reads the reviewer's earlier summary on the pull request, which only a posting review does: add --post, or leave it out` | the same, for `--re-review` |
| `--github-host must be a host name, such as github.example.com — no https:// and no path — got "…"` | the host alone |
| `error: unknown option '…'` · `error: option '…' argument missing` | `review-agent review --help` lists every flag |
| `ignored, the deployment does not allow it: budgetUsd` (not an error) | a `--budget` above the tier's is ignored; the review runs at the tier's budget |

## Posting

| You see | Cause | Fix |
|---|---|---|
| `This will post as @… on …: … Continue? [y/N]` | `--post` at a terminal asks once, before anything is spent | `y` to post; `--yes` to skip the question |
| `nothing was reviewed and nothing was posted`, exit `1` | you answered anything but `y` or `yes` | run it again and answer `y` |
| `stopped before the review started; nothing was reviewed or posted`, exit `1` | Ctrl-C at the question | — |
| `--report check-run needs a token that can create check runs — a GitHub App's, or GitHub Actions' GITHUB_TOKEN with checks: write. GitHub lets no person's token create one; use --report status, or auto.`, exit `2` | GitHub lets only Apps create check runs | `--report auto` or `status` |
| `the review could not be reported on the commit: …`, exit `1` | GitHub refused to open the report — the `pending` status or the `in_progress` check run — for example for lack of push access, or of `checks: write`. Nothing was downloaded or spent | `--report none`; or the Write role; or the permission |
| `this token cannot create a check run; reporting with a commit status instead` | an installation token was refused a check run — a workflow without `checks: write` — so the review reports with a status | add `checks: write` to the workflow's `permissions:` |
| `the review ran and could not be posted: …`, exit `4`, and `NOT POSTED: the review is above, and nothing of it is on the pull request.` | the review was paid for, and GitHub would not take it — for example, a token without Pull requests: Write. With `--json`, `"posted": null` | fix the permission before running it again: a second run pays again |
| `the check run could not be completed: …` · `the commit status could not be completed: …`, and `reported with …: it could not be completed` | the review was posted, and closing its report failed | a status left `pending` is replaced by the next review's status on that commit. A check run left `in_progress` is closed as **Review timed out** by the next review of the commit once it is an hour old, or by an App deployment's hourly sweep |
| `the previous review’s marker could not be read; no re-review pass will run: …` | the earlier summary comment could not be read, so the earlier findings were not re-checked | the review is still posted; ask again later for the re-review |
| `Nothing will be posted on …: this repository's settings make the review silent, so it is only printed here.` · `posted nothing: this repository's settings make the review silent` | the repository's `.review-agent/review.md` says `mode: silent` | by design: a repository may make reviews quieter ([the repository file](../configuration.md#the-repository-file)) |
| a review on your own pull request is refused, exit `4` | whether GitHub's API accepts a review from the pull request's own author is **UNVERIFIED** (spike S4) | the review is printed; ask a colleague to post it, or post with an App or a bot |

## A review that did not finish

| You see | Cause | Fix |
|---|---|---|
| `CUT SHORT: the hard ceiling fired; this review is partial.`, exit `1` | the review reached its hard ceiling — $5.00 at `basic`. What it found by then is printed above, and a posted one is listed in a summary that says it did not complete | a smaller change, a brief that narrows it, or a higher tier ([budgets](choosing-a-tier.md#budgets)) |
| `FAILED: budget`, exit `1` | the ceiling stopped it before it wrote anything | the same |
| `FAILED: schema`, exit `1` | its answer did not match the findings format | run it again — which pays again |
| `FAILED: refusal`, exit `1` | the model answered in prose instead of a review | the same |
| `the review passed its 1800s deadline and was stopped`, exit `1` | the review's own 30-minute deadline | a smaller change, or a lower tier. The SDK's `deadlineMs` sets another |
| `stopping the review — press Ctrl-C again to exit at once` | the first Ctrl-C: the Claude process is stopped and the downloaded code deleted | wait for it; a second Ctrl-C exits `130` at once |
| `the review was stopped before it finished; nothing was printed` (`; the commit status says the review was interrupted`) | the stop finished cleaning up; a `pending` status was set to `error` | run it again when you want a review |
| `refusing to emit this review: review output withheld: … possible secret(s) — …`, exit `3` | something the model wrote matched a secret pattern — a GitHub or Anthropic token, an npm token, an AWS key, a Slack token, a private key header. The message names the pattern and where, never the text | look at that place in the pull request: a real secret in the code is worth knowing about. Nothing was posted |
| `the review did not complete: …`, exit `1` | anything else that stopped the review — a download that failed, a skill that would not load. The cause follows | act on it; a failure before the model started cost nothing |
| `running 3 focused reviewers (intent, impact, security), 3 at a time, …` | not an error: `--multi` | — |
| `the … reviewer returned no answer (…); the review goes on without it` · `the … reviewer could not run, and the review goes on without it: …` | one focus of a `--multi` review failed; the others are posted | the summary names it `✗ (did not finish)`. Only when none of the three answer is the review unfinished |
| `removed … credential files from the checkout before the review: …` (`file`, for one) | not an error: `.env`, keys and the like are deleted from the download before the model starts | — |
| `… archive entries could not be written to the checkout, so the review cannot read them: …` · `… sets of paths differ only by letter case or Unicode form; …` | files this OS cannot write — `CON` on Windows, a symlink without Developer Mode — or names that collide on a case-insensitive disk. They are listed on the record and in the summary under **Not in the checkout** | the reviewer did not read those files; on Windows, WSL2 avoids most of this |
| `the downloaded code was kept at …` | not an error: `--keep-checkout` | it is yours to delete |

## On the pull request

### The check run's title

| Title | Conclusion | Meaning |
|---|---|---|
| **No findings** | `success` | a finished review that found nothing — an answer, not a failure |
| **3 findings, worst 7/10** | `success`, or `failure` only through [the gate](../configuration.md#the-gate) | a finished review |
| **Review did not finish** | `neutral` | the review stopped; its summary says why. `neutral` passes branch protection, so it blocks nothing. **Re-run** tries again |
| **Review refused** | `neutral` | someone without push access asked for a review: *No review of `…` was run: @… asked for a review and does not have push access to …. Nothing was reviewed and nothing was spent.* |
| **Review timed out** | `neutral` | the run was killed before it could report; once its check run was an hour old, the next review of the commit, or an App deployment's hourly sweep, closed it |
| left **in progress** | — | the run was killed and nothing has closed it yet. Once it is an hour old, the next review of that commit — or an App deployment's hourly sweep — closes it as **Review timed out** |

### The commit status's description

From the CLI with a person's token, or the SDK with one, the report is a commit status named `review-agent`:

| State | Description | Meaning |
|---|---|---|
| `pending` | *The review is running.* | — |
| `success` | *No findings* · *2 findings, worst 7/10* (and *; cut short by its budget ceiling*) | a finished review. `failure` only through a gate the deployment armed |
| `success` | *Not a verdict: the review did not finish — …* | the review did not run or did not finish; a green tick that is **not** a clean review, so an outage never blocks a merge |
| `error` | *The review was interrupted before it finished. Run it again for a result.* | stopped with Ctrl-C, or by an SDK host's signal |

A commit status is a **soft gate**: anyone with push access can set one with the same name. Do not rely on it alone.

### In the summary comment

| You see | Meaning |
|---|---|
| **This review did not complete:** … Nothing was placed on a line. | the review stopped — its ceiling, an answer in the wrong shape, a crash — and says why. Anything it had found is listed under it |
| **Not honoured** — `` `--multi` — this deployment does not run several reviewers on one review, so one reviewer ran. `` | the deployment set `allowMulti: false` |
| **Not honoured** — `` `budgetUsd` — this deployment does not let a request set it, so its own value was used. `` | a `--budget` above the tier's |
| **Not honoured** — `` `--tier …` — not a value this flag takes, so the deployment’s default was used. `` | a comment named a value the flag does not take; the same for `--effort` and `--budget` |
| **Not in the checkout** | files the reviewer could not read, listed so their silence is not read as "fine" |
| `Three focused reviewers: intent ✓ · impact ✓ (cut short) · security ✗ (did not finish)` | a `--multi` review, and how each reviewer ended. *…the check pass was off, so findings were not merged and the same problem may be listed twice* says the duplicates were not merged |

### Notes appended to inline comments

| You see | Meaning |
|---|---|
| **No longer reported.** The reviewer read `…` at `…` and no longer finds this issue there. … | a later review's re-review pass judged the finding `resolved` at that commit. It is one reviewer's answer at one commit — **not** proof that a person fixed it. The original comment is left as it was |
| **Reported again.** The note above was wrong. … | a still later review found the problem again. Both notes stay, as the record of what was said at each commit |

### Nothing happened

| You did | Why nothing happened |
|---|---|
| pushed new commits | pushes are not reviewed. Comment `/review` ([when it reviews](../pull-requests.md#when-it-reviews)) |
| opened a draft | a draft is reviewed when it is marked ready for review |
| reopened a pull request | not a trigger. Comment `/review` |
| commented `/review` on a line, or edited a comment | only a new comment in the conversation, starting with `/review`, asks |
| opened a pull request that only bumps versions and lock files | an App deployment skips release-only pull requests automatically. Comment `/review` to have it reviewed anyway |
| commented `/review` without push access | an App posts a `neutral` **Review refused** check run; the GitHub Actions workflow ends with a notice. Nothing is spent |

## App deployments and your own server

Each guide has its own table: [deploying](../deploying.md#when-something-goes-wrong),
[your own server](self-hosting.md#when-something-goes-wrong), [the webhook on Vercel](vercel.md#when-something-goes-wrong).
The messages they share:

| You see | Cause, and the fix |
|---|---|
| deliveries answered `401` | the receiver's webhook secret and the App's differ; or, on Vercel, Deployment Protection answered |
| deliveries answered `204`, and no review | the event is not a trigger. The `why` that `decideDelivery` returns says which — log it in your receiver (your own server logs it as `delivery ignored`): `opened as a draft; …`, `a comment on a plain issue, not a pull request`, `a pull request comment that does not start with the command`, `a comment written by a Bot account` |
| deliveries answered `500` | the receiver could not start the run: on trigger.dev, `TRIGGER_SECRET_KEY` must be the Production environment's, allowed to trigger `review-agent-review` |
| `the App identity is not set: REVIEW_AGENT_APP_CLIENT_ID and REVIEW_AGENT_APP_PRIVATE_KEY. …` | set both in the runner's environment |
| `REVIEW_AGENT_APP_PRIVATE_KEY is set but is not a PEM private key: no "BEGIN … PRIVATE KEY" header. Paste the whole .pem file, header and footer included.` | the value is not the `.pem` |
| `the App private key is not a usable PEM private key` | the `.pem` is damaged, or not a private key: generate a new one on the App's page |
| `GitHub refused an installation token for installation …: HTTP 401 …` | the client id and the key belong to different Apps, or the key was deleted on GitHub. Another status, followed by GitHub's message: for example, the App is not installed on that repository |
| `REVIEW_AGENT_SWEEP_TARGETS is not JSON: expected [{"installationId":123,"repositories":["owner/name"]}]` | the sweep's variable is malformed; the sweep fails visibly rather than sweeping nothing |
| a `review-agent-focus` run fails: `the pull request moved on to … after its review started on …; this focus reviews only the commit its review is of, so it reviewed nothing` | someone pushed while a `--multi` review's focuses were queued; the review it belonged to was of the earlier commit |

## GitHub Actions

The workflow's own messages, from [`examples/github-actions/review.yml`](../../examples/github-actions/review.yml);
the full table is in [the guide](github-actions.md#4-read-the-result).

| You see | Cause, and the fix |
|---|---|
| notice: `#… comes from a fork, and this workflow does not review forks (no secrets reach a fork's run). …` | by design. A maintainer can review it with the CLI: [post as yourself](post-as-yourself.md) |
| notice: `Dependabot pull requests get no Actions secrets. Comment /review to have one reviewed.` | by design |
| notice: `@… asked for a review and does not have push access to …; nothing was spent.` | only people with push access can ask |
| warning: `--tier takes basic, normal or thorough; reviewing at the default tier.` | the comment named another tier |
| error: `The ANTHROPIC_API_KEY repository secret is not set (Settings → Secrets and variables → Actions).`, exit `2` | add the secret |

## The SDK

`reviewPullRequest` returns its outcomes — `reviewed`, `unfinished`, `refused`, `failed` — and throws only for a
programmer's error, before anything is fetched or spent ([the SDK](../sdk.md#what-throws)):

| Thrown | Fix |
|---|---|
| `TypeError: … is not an option of reviewPullRequest` | a misspelt option — `credentials` for `credential` would otherwise bill the environment's credential |
| `TypeError: settings.… is not a setting` | a misspelt setting |
| `TypeError: credential must be exactly one of { apiKey }, { oauthToken } or 'claude-login'` | one of the three |
| `TypeError: authorize needs requestedBy: the login whose request it decides` | pass `requestedBy` with `authorize` |
| `TypeError: authorize must answer true or false, and answered …` | a gate that returns nothing is not a yes |
| `Error: no model credential: …` · `Error: 2 model credentials are set (…); …` · `Error: ANTHROPIC_BASE_URL is set: …` | as [above](#the-model-credential) |

| Returned | Meaning |
|---|---|
| `{ kind: 'refused', reason: "authorize did not allow @…'s request; nothing was downloaded or spent" }` | your gate said no |
| `{ kind: 'failed', stage: 'before-model', reason: 'the review could not be authorized: …' }` | your gate threw; nothing spent, and `retryable` is true |
| `{ kind: 'failed', stage: 'before-model', reason: 'GitHub would not say whose token this is: …' }` | with `post: true`, the `GET /user` failed |
| `{ kind: 'failed', stage: 'publish', … }` | reviewed and paid for, and GitHub would not take it; `record` and `findings` carry the review |
| `{ kind: 'unfinished', … }` | the model ran and produced nothing usable, or was stopped; `reason` says which, `spentUsd` what it cost |

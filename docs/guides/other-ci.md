# Review pull requests from another CI

At the end of this guide a job in your own CI — Jenkins, CircleCI, Buildkite, GitLab CI building a GitHub repository,
or any CI that can run a Linux shell — reviews a GitHub pull request and posts the review on it: a review with inline
comments, a summary comment, and a report on the commit. It posts as a **bot account**, reporting with a commit status,
or as **your own GitHub App**, reporting with a check run a branch rule can pin (use case UC-5 in
[the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

It is the same review as everywhere else: the CLI, run in a job, with `--post`. Nothing here is a plugin; every
snippet is the CI's own configuration around the same three commands.

<!-- capture: other-ci-pr-screenshot — a screenshot of a demo pull request reviewed by the bot-account run below (other-ci-bot-token-log): the summary comment from the bot account, an inline comment if any, and the `review-agent` commit status. Version and date. -->
*(captured output will appear here)*

## What you need

- [ ] **A CI job that runs Linux with Node.js 22 or newer** — a container image such as `node:22-bookworm-slim` is
      enough: the CLI, Claude Code and its native binary are all it needs. Claude Code runs headless as root there
      (spike S7, [spec 0.2.0 §12.2](../specs/0.2.0-ways-in.md#122-spikes--each-settles-an-unverified-fact-before-code-depends-on-it)).
      macOS agents work too, with the model credential in the environment — CI has no keychain login. Windows agents
      are experimental in 0.2.0, and the snippets below are POSIX shell.
- [ ] **An Anthropic API key**, kept as a secret in your CI. A team's CI reviews other people's pull requests, so it
      takes an API key, billed at per-token API prices; a subscription token is for one person's own use
      ([spec 0.2.0 §2.3](../specs/0.2.0-ways-in.md#23-model-credentials)).
- [ ] **A GitHub identity to post as** — step 1.
- [ ] **The pull request's number in the job.** Each CI names it differently; the snippets in step 3 show where.

## 1. Choose who posts

| | A bot account's token | An App installation token |
|---|---|---|
| Who the comments are from | the bot account, `@review-bot` | your App, `<app-slug>[bot]` |
| Reports with | a **commit status** — a soft gate: a branch rule cannot pin it to this reviewer | a **check run** — a branch rule can require it **pinned to your App** |
| What the CI holds | a long-lived token that reaches what the bot account can, within the token's limits | the App's **private key**, which can mint a token for every repository the App is installed on. Each review's token is minted for one repository and dies within the hour |
| Setting up | a GitHub account and one token | an App registration, its key, and installing it |
| The automated line on the summary | *run by @review-bot from the command line* | *run from the command line* |

A check run is the only report a branch rule can pin to its source
([spec 0.2.0 §2.2](../specs/0.2.0-ways-in.md#22-what-each-github-identity-can-do)). If the review is to gate merges,
use an App.

### 1a. A bot account's token

1. Create a GitHub account for automation — a "machine user" — and give it the **Write** role on the repositories to
   review (a commit status needs push access).
2. Signed in as that account: **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**. Resource owner: the organisation that owns the repositories. Repository access: **Only select
   repositories**. Permissions: **Contents: Read**, **Pull requests: Read and write**, **Commit statuses: Read and
   write**. Give it an expiry, and note when to rotate it. An organisation may need to approve a fine-grained token
   before it works.
3. Keep the token as a secret in your CI, available to the review job as `GITHUB_TOKEN`.

A classic token with the `repo` scope works too, and reaches every repository the bot account can.

### 1b. An App installation token

1. **Register an App** with [`review-agent init`](../github-app.md#registering-it-with-review-agent-init). With no
   receiver of your own, register it with deliveries off; `--webhook-url` is still required, so give the address one
   would have:

   ```sh
   npx @review-agent/cli@0.2.0 init --name "Acme Reviewer" --url https://example.com \
     --webhook-url https://example.com/api/github/webhook --org acme --webhook-inactive
   ```

   ```powershell
   npx @review-agent/cli@0.2.0 init --name "Acme Reviewer" --url https://example.com `
     --webhook-url https://example.com/api/github/webhook --org acme --webhook-inactive
   ```

2. Do [what follows registering](../github-app.md#after-registering): generate a private key, delete the
   registration-time key and client secret, note the **client id**, and install the App on the repositories to review
   — only those.
3. Note the [installation id](../github-app.md#the-installation-id).
4. Keep three values in your CI, for the review job only: `REVIEW_AGENT_APP_CLIENT_ID` (the client id; not a secret),
   `REVIEW_AGENT_APP_PRIVATE_KEY` (the whole `.pem`, a secret) and `REVIEW_AGENT_INSTALLATION_ID`.

Each job then mints a token for the one repository it reviews. This script does it with the same functions the App's
runner uses, from `@review-agent/app`, and hands the token to the reviewer without printing it. Save it as
`review-with-app.mjs` in the job's working directory:

```js
// review-with-app.mjs — mint an installation token for one repository, then review and post with it.
// Reads REPO (owner/name), PR, REVIEW_AGENT_INSTALLATION_ID, REVIEW_AGENT_APP_CLIENT_ID and
// REVIEW_AGENT_APP_PRIVATE_KEY; ANTHROPIC_API_KEY is passed through to the reviewer.
import { spawnSync } from 'node:child_process'
import { appIdentityFromEnv, installationToken } from '@review-agent/app'

const { REPO = '', PR = '', REVIEW_AGENT_INSTALLATION_ID = '' } = process.env
const [, name] = REPO.split('/')
// Scoped to this one repository, and dead within the hour: one per review, never kept.
const { token } = await installationToken({
  identity: appIdentityFromEnv(process.env),
  installationId: Number(REVIEW_AGENT_INSTALLATION_ID),
  repositories: [name],
})
// The App's key stays here: the reviewer gets the token, not the key.
const { REVIEW_AGENT_APP_PRIVATE_KEY: _key, ...env } = process.env
const run = (args) =>
  spawnSync('review-agent', args, { stdio: 'inherit', env: { ...env, GITHUB_TOKEN: token } }).status ?? 1
const checked = run(['doctor', '--repo', REPO])
process.exit(checked !== 0 ? checked : run(['review', '--repo', REPO, '--pr', PR, '--post', '--yes']))
```

It needs `@review-agent/app` installed beside it — `npm install --no-save @review-agent/app@0.2.0` in that directory,
which also brings the trigger.dev SDK the package depends on. Any other way of minting an installation token works the
same: pass it to the reviewer as `GITHUB_TOKEN`, scoped to the one repository.

With an installation token, `--report auto` reports with a **check run**. It decides that from one `GET /user`, which
GitHub is expected to answer `403` for an installation token — **UNVERIFIED** by this project so far; a token
misjudged that way falls back to a commit status when its check run is refused ([the SDK's
reporting](../sdk.md#reporting-on-the-commit)). The capture `other-ci-app-token-log` below settles it.

## 2. The job, in any shell

Whatever the CI, the job does the same thing:

```sh
set -eu
# Installed under the job's own directory, so it works whichever user the job runs as.
export NPM_CONFIG_PREFIX="$PWD/.review-agent"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code \
  @anthropic-ai/claude-code@2.1.258 @review-agent/cli@0.2.0

review-agent doctor --repo "$REPO"                              # exit 2, before anything is spent, if something is missing
review-agent review --repo "$REPO" --pr "$PR" --post --yes
```

with `REPO` (`owner/name`), `PR`, `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` in its environment. **With an App**, the job
has the App's three values instead of `GITHUB_TOKEN`, runs `npm install --no-save @review-agent/app@0.2.0`, and runs
`node review-with-app.mjs` in place of the last two lines: the script runs both, with the token it minted.

- **Both versions pinned.** Claude Code at `2.1.258`, the version the reviewer's flags were measured against and the
  App's runner pins; the reviewer at the version you tested. `--allow-scripts` lets Claude Code's install script put
  the real binary in place — npm 12 needs it, npm 10 and 11 accept it.
- **`review-agent doctor`** checks the binary is the real one and answers, that exactly one model credential is set,
  who the token is, and whether it can post on the repository — reading only, at no cost.
- **No checkout.** The job does not need the repository's files: the reviewer downloads the pull request's code
  itself, as an archive with credential-shaped files removed, and never runs it.
- **`--yes`** is implied without a terminal; it is there so the line says what it does. Without a terminal the CLI
  writes on stderr what it is about to post, and as whom — *"This will post as @review-bot on acme/widgets#128: a review
  with inline comments, a summary comment and a commit status "review-agent"."* — so the log shows it.

<!-- capture: other-ci-bot-token-log — stdout and stderr, in order, of the two commands above run without a terminal (stdin from /dev/null) in a node:22-bookworm-slim container, against crissmoldovan/review-agent-demo pull request #7 (feat/order-notes, the clean one), with a bot account's fine-grained token as GITHUB_TOKEN. Replace the bot's login with @review-bot. Version and date. -->
*(captured output will appear here)*

<!-- capture: other-ci-app-token-log — the same, with `node review-with-app.mjs` in place of the two commands and an App installation for the demo repository: it shows whether `GET /user` sent the review to a check run (the "reported with a check run: …" line). Version and date. -->
*(captured output will appear here)*

### The exit code

| Code | Meaning | What the job might do |
|---|---|---|
| `0` | reviewed and posted | pass |
| `1` | the review did not finish — the model failed or ran out of budget, GitHub could not be read, or it was stopped | your choice: the report on the commit already says it is not a verdict, so an outage need not fail the build |
| `2` | something is missing: a credential, a token, a flag — or GitHub refused the token | fail: the job is misconfigured |
| `3` | the review's output matched a secret pattern and was withheld; nothing was posted | fail, and read the log: it names the pattern and where, never the text |
| `4` | reviewed and paid for, and posting failed. The review is in the log | fail, and fix what GitHub objected to before running it again — a second run pays again |

Every code: [the CLI reference](../cli.md#exit-codes).

**If you see this instead**

| Symptom | Cause, and the fix |
|---|---|
| npm fails with `EACCES` on its cache directory | the job's user has no home directory it can write — as when a container runs as a user its image does not know. Add `export npm_config_cache="$PWD/.npm-cache"`, or run the container as root (tested, spike S7). Claude Code keeps its settings under the home directory too, so give the job one it can write |
| `✗ Claude Code's native binary is not installed — npm skipped its install script. …` | the install line lost `--allow-scripts=@anthropic-ai/claude-code`, or the CI's npm is configured to ignore scripts |
| `✗ @review-bot has no push access to …, and a commit status needs it` | give the bot account the Write role on the repository |
| `✗ GitHub token: none found` | `GITHUB_TOKEN` did not reach the job: the secret's name, or a rule that keeps it from this branch. With an App, run `node review-with-app.mjs` rather than the two commands |
| `the App identity is not set: REVIEW_AGENT_APP_CLIENT_ID and REVIEW_AGENT_APP_PRIVATE_KEY. …` | the App's values did not reach the job |
| `REVIEW_AGENT_APP_PRIVATE_KEY is set but is not a PEM private key: …` | the secret holds something other than the whole `.pem`: paste it again, header and footer included |
| `GitHub refused an installation token for installation …: HTTP 401 …` | the client id and the key are not the same App's, or the key was deleted on GitHub. Another status, with GitHub's message after it: for example, the App is not installed on that repository, or the installation id is wrong |
| `reported with a commit status` where you expected a check run | the token is a person's or a bot's, not an installation's; or an installation token was refused a check run, and the review said `this token cannot create a check run; reporting with a commit status instead` |
| `the review could not be reported on the commit: …`, exit `1` | GitHub refused the report before the review started; nothing was spent. A bot without push access, or an App installation without Checks: write |

More, by symptom: [troubleshooting](troubleshooting.md).

## 3. Where each CI puts the pieces

These snippets show where the pull request's number and the secrets come from in each CI, with a bot account's token.
For an App, swap the last two commands for `node review-with-app.mjs`, as above. **They are not run by this project's
CI**; the variables they read are each CI's own, as its documentation describes them (checked 2026-10-15).

### Jenkins (multibranch pipeline)

`CHANGE_ID` is the pull request's number in a multibranch pipeline's pull request build. The two secrets are Jenkins
credentials of the *Secret text* kind:

```groovy
pipeline {
  agent { docker { image 'node:22-bookworm-slim' } }
  options { skipDefaultCheckout() }           // the reviewer downloads the code itself
  environment {
    REPO              = 'acme/widgets'
    ANTHROPIC_API_KEY = credentials('anthropic-api-key')
    GITHUB_TOKEN      = credentials('review-bot-github-token')
  }
  stages {
    stage('review-agent') {
      when { changeRequest() }
      steps {
        sh '''
          set -eu
          export NPM_CONFIG_PREFIX="$PWD/.review-agent" PATH="$PWD/.review-agent/bin:$PATH"
          npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code \
            @anthropic-ai/claude-code@2.1.258 @review-agent/cli@0.2.0
          review-agent doctor --repo "$REPO"
          review-agent review --repo "$REPO" --pr "$CHANGE_ID" --post --yes
        '''
      }
    }
  }
}
```

### CircleCI

`CIRCLE_PULL_REQUEST` is the pull request's URL, so its number is the last part. It is empty for a build of a branch
with no open pull request. The secrets come from a context — here one named `review-agent`:

```yaml
version: 2.1
jobs:
  review:
    docker:
      - image: node:22-bookworm-slim
    steps:
      # No `checkout`: the reviewer downloads the pull request's code itself.
      - run:
          name: review-agent
          command: |
            set -eu
            if [ -z "${CIRCLE_PULL_REQUEST:-}" ]; then echo "not a pull request build"; exit 0; fi
            export REPO="$CIRCLE_PROJECT_USERNAME/$CIRCLE_PROJECT_REPONAME" PR="${CIRCLE_PULL_REQUEST##*/}"
            export NPM_CONFIG_PREFIX="$PWD/.review-agent" PATH="$PWD/.review-agent/bin:$PATH"
            npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code \
              @anthropic-ai/claude-code@2.1.258 @review-agent/cli@0.2.0
            review-agent doctor --repo "$REPO"
            review-agent review --repo "$REPO" --pr "$PR" --post --yes
workflows:
  review:
    jobs:
      - review:
          context: review-agent
```

### Buildkite

`BUILDKITE_PULL_REQUEST` is the pull request's number, or `false` when the build is not for one. The agent needs
Node.js 22 or newer, and the two secrets in its environment — from an environment hook or your secrets store:

Buildkite substitutes `$` variables in a `pipeline.yml` when the pipeline is uploaded; `$$` leaves a `$` for the
agent's shell to read when the step runs, which is what this command needs:

```yaml
steps:
  - label: "review-agent"
    command: |
      set -eu
      if [ "$$BUILDKITE_PULL_REQUEST" = "false" ]; then echo "not a pull request build"; exit 0; fi
      export REPO="acme/widgets" PR="$$BUILDKITE_PULL_REQUEST"
      export NPM_CONFIG_PREFIX="$$PWD/.review-agent" PATH="$$PWD/.review-agent/bin:$$PATH"
      npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code \
        @anthropic-ai/claude-code@2.1.258 @review-agent/cli@0.2.0
      review-agent doctor --repo "$$REPO"
      review-agent review --repo "$$REPO" --pr "$$PR" --post --yes
```

### GitLab CI, building a GitHub repository

GitLab runs pipelines for a GitHub repository's pull requests when the project is connected to it as an external
repository (GitLab Premium or Ultimate). `CI_EXTERNAL_PULL_REQUEST_IID` is the pull request's number. GitLab ignores
pull requests from forks. `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are masked CI/CD variables — note that a *protected*
variable reaches only protected branches, and an external pull request's pipeline runs on its source branch:

```yaml
review-agent:
  image: node:22-bookworm-slim
  rules:
    - if: $CI_PIPELINE_SOURCE == "external_pull_request_event"
  variables:
    GIT_STRATEGY: none                       # the reviewer downloads the code itself
    REPO: acme/widgets
  script:
    - |
      set -eu
      export NPM_CONFIG_PREFIX="$PWD/.review-agent" PATH="$PWD/.review-agent/bin:$PATH"
      npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code \
        @anthropic-ai/claude-code@2.1.258 @review-agent/cli@0.2.0
      review-agent doctor --repo "$REPO"
      review-agent review --repo "$REPO" --pr "$CI_EXTERNAL_PULL_REQUEST_IID" --post --yes
```

### When to run it

Every snippet above reviews on every pull request build — and most CIs build on every push. A review costs money and
takes minutes, and the reviewer is built to review a pull request once and be asked again when someone wants
([when it reviews](../pull-requests.md#when-it-reviews)). Run the job when a pull request opens, or by hand, rather
than on every push, if your CI lets you; and let only one review of a pull request run at a time, so a second does not
pay for the same commit.

## 4. Secrets

- **Only this job gets them.** The API key and the GitHub token (or the App's key) are secrets of the review job, not
  of every job in the pipeline.
- **Never on a command line, never echoed.** The reviewer reads them from the environment only. Do not run the step
  with `set -x`, which prints each command. The CLI never prints the GitHub token — an error message quoting it
  prints `[redacted]` — and doctor names credentials, never their values.
- **The model never sees them.** The Claude process gets the model credential and an allow-list of variables that names
  no GitHub variable ([security](../security.md#what-the-model-can-do)).
- **Rotate** the bot's token on a schedule, and remove the App's key from the CI if you stop using it — deleting a
  secret from a CI does not revoke it on GitHub.
- **`ANTHROPIC_BASE_URL` must not be set** in the job: the reviewer refuses to run pointed anywhere but Anthropic.

## 5. Pull requests from forks

A fork's pull request is written by someone outside your organisation, and in most CI services the pipeline definition
for a pull request build is read from the pull request's own branch. A job that hands a fork's build your API key and a
token that can post hands them to whoever opened it. So:

- **Keep the secrets from fork builds.** Most CI services withhold secrets from them unless you turn that on; leave it
  off. GitLab's pipelines for external pull requests ignore forks altogether.
- **Review a fork's pull request by hand.** A maintainer runs the CLI on their own machine, where it posts as them:
  [post a review as yourself](post-as-yourself.md).

The reviewer itself never runs the code it reviews; the risk is the CI job around it.

## 6. Asking for another review

A check run posted with an App token carries a **Re-run** button. Pressing it sends a webhook to the App, which only an
[App deployment](../deploying.md) with a receiver acts on; an App registered with `--webhook-inactive` receives
nothing. From another CI, ask for a review the way your CI runs jobs: re-run the job, or trigger it by hand.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices** | **measured** with `claude-opus-5`: $0.88–1.06 for a `basic` review of a real production pull request, plus $0.07–0.58 for its check pass; $0.16–0.29 for a whole `basic` review of a one-file pull request. Hard ceilings: $5.00 `basic`, $7.50 `normal`, $20.00 `thorough`, each with its check pass's own ([what it costs](../../README.md#what-it-costs)) |
| The job | your CI vendor, at **its price** | a job lasts about as long as its review — 2–7 minutes measured for `basic` and `normal` — plus installing two npm packages, **not measured** |

## Next steps

- [Choose a tier](choosing-a-tier.md): `--tier normal` in the review command for a change that deserves it.
- [Using it on pull requests](../pull-requests.md): `/dispute`, `/defer`, and re-reviews — a later `--post` reads the
  earlier summary and asks whether earlier findings are still there.
- For reviews that start themselves when a pull request opens, with a check run, the hourly sweep and the record
  callback: [a GitHub App](../deploying.md), or [GitHub Actions](github-actions.md).
- [Troubleshooting](troubleshooting.md), by symptom.

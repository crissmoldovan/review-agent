# The SDK: `@review-agent/sdk`

The SDK runs the reviewer from your own Node.js code: one call reviews one pull request and **returns** what
happened, so your service or script can do something with it. It is for:

- **a product or platform team** that wants to call a review from its own service and act on the result — gate a
  deploy, file a ticket, post somewhere else, or post on the pull request itself;
- **an engineer reviewing a batch** — every open pull request in a repository, or one pull request at several tiers —
  from a script, usually posting nothing and keeping the records.

It is the same review the [GitHub App](deploying.md) and [the CLI](cli.md) run: the same session, the same rules for
what is said, the same check pass. **By default it posts nothing**; `post: true` posts the review, its inline comments
and its summary, and reports on the commit.

## Install

```sh
npm install @review-agent/sdk
```

- **Node.js 22 or newer.**
- **Claude Code**, as `claude` in an absolute `PATH` directory, or wherever `REVIEW_AGENT_CLAUDE_BIN` or the `claude`
  option points. Installing it, per operating system, and the npm 12 placeholder it can leave behind:
  [the CLI's requirements](cli.md#what-it-needs) apply unchanged. Linux and macOS; Windows support is not yet tested,
  and WSL2 works as Linux.

The SDK depends on `@review-agent/core`, `@review-agent/github` and `@octokit/core`. It does **not** depend on
`@review-agent/app`, so embedding the reviewer never installs trigger.dev.

## The one call

```ts
import { reviewPullRequest } from '@review-agent/sdk'

const result = await reviewPullRequest({
  repo: 'acme/widgets',
  pr: 128,
  github: { token: process.env.GITHUB_TOKEN! },           // or { octokit }
  credential: { apiKey: process.env.ANTHROPIC_API_KEY! },  // or { oauthToken } or 'claude-login'
  post: true,                                              // default false: review and return, post nothing
})

if (result.kind === 'reviewed') {
  console.log(result.record.costUsd, result.findings.length, result.report?.conclusion)
}
```

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `repo` | `'owner/name'` | required | the repository |
| `pr` | number | required | the pull request's number |
| `github` | `{ token, baseUrl? }` or `{ octokit }` | required | how to reach GitHub. A `token` is used for this review and nothing else, with the API version every way in is pinned to. `baseUrl` is a GitHub Enterprise Server's API root, `https://<host>/api/v3`. `{ octokit }` is a client you already have |
| `credential` | `{ apiKey }`, `{ oauthToken }` or `'claude-login'` | from the environment | the [model credential](#credentials). Left out: exactly one of `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from this process's environment, and never `claude login`. A value may be a string or a `SecretValue` |
| `post` | boolean | `false` | post the review, its inline comments and its summary, and report on the commit |
| `report` | `'auto'`, `'check-run'`, `'commit-status'`, `'none'` | `'auto'` | how to [report on the commit](#reporting-on-the-commit) when posting. Read only when posting |
| `tier` | `'basic'`, `'normal'`, `'thorough'` | the settings' | how deep the review goes ([tiers](configuration.md#tiers)) |
| `effort` | `'low'` … `'max'` | the tier's | the model's effort |
| `model` | string | the settings' (`claude-opus-5`) | the model's name |
| `check` | boolean | the tier's (on) | run the disprove-it pass (`true`) or skip it (`false`) |
| `brief` | string | none | extra context for the reviewer — data, never instruction |
| `budgetUsd` | number | the tier's | lower this review's soft budget, in US dollars at per-token API prices; it can never be raised |
| `multi` | `true`, or `{ concurrency }` | off | the [multi-reviewer mode](configuration.md#the-multi-reviewer-mode): one focused reviewer each for intent, impact and security. `true` runs all three at once; `{ concurrency: 1 }` one at a time — each is a Claude process of its own |
| `settings` | `ReviewSettings` | the built-in defaults | the [deployment settings](configuration.md#every-setting), any of them left out — see [settings](#settings) |
| `requestedBy` | string | none | whose request this is: the login `authorize` is asked about, recorded as `record.request.requestedBy` |
| `authorize` | `(who) => boolean \| Promise<boolean>` | none | a gate asked after the pull request is read and before anything is downloaded, written or spent — e.g. `pushAccessOf`. Needs `requestedBy` |
| `claude` | `{ bin? }` | `REVIEW_AGENT_CLAUDE_BIN`, else `claude` on `PATH` | which Claude Code to run: an absolute path, never inside the checkout |
| `workDir` | absolute path | the OS temp directory | where checkouts go, each in a new directory that is removed when the review ends |
| `skillCacheDir` | absolute path | this OS's cache directory | where [skills](configuration.md#skills) are cached |
| `deadlineMs` | number | 30 minutes | the review stops itself this long after it starts — after the pull request has been read |
| `signal` | `AbortSignal` | none | cancel the review; the Claude process is stopped with it |
| `onProgress` | `(event) => void` | none | where the review has got to — see [progress](#progress) |

### Settings

`settings` takes any part of a [`DeploymentConfig`](configuration.md#every-setting), at any depth, and merges it over
the built-in defaults key by key:

```ts
settings: { report: { checkRunName: 'review', failAtOrAbove: 8 }, tiers: { normal: { budgetUsd: 2 } } }
```

changes those three and keeps every other setting. Objects merge as deep as the defaults go; lists (`skills`) and
plain values replace; a value left `undefined` keeps the default, and `null` is a value (`failAtOrAbove: null` is the
gate off). A whole `DeploymentConfig` you already keep passes as it is. Deep, so that changing one name never means
restating — and freezing — every default beside it; no deeper, so that an allowed skill can still be removed by
passing the list without it. `command` and `autoReview` are read only by the App's receiver, and are ignored here.

A key that is not a setting, or a value of the wrong type, throws: a misspelt `reprot` would otherwise review with the
defaults and never say so.

`multi: true` with `settings: { allowMulti: false }` runs one reviewer, as the App does for a deployment that switched
the mode off; `record.settings.multi` says which ran.

## Results

`reviewPullRequest` **returns** every outcome rather than throwing it, so you can tell "the reviewer found nothing"
from "the reviewer did not run" — they are not the same, and a well-formed empty list is a success.

```ts
type ReviewResult = ReviewedResult | UnfinishedResult | RefusedResult | FailedResult
```

### `reviewed`

The review ran and said something — possibly that it found nothing.

| Field | What it is |
|---|---|
| `record` | the [review record](how-it-works.md): request, settings, the model's whole output, every check verdict, usage, and `costUsd` |
| `findings` | what the review **says**: after the check pass (a refuted finding is not here; the rest are at the check's severity), with duplicates said once and every path checked against the code. Posted, it is what was posted; not posted, what would have been, said as a first review is. The model's unfiltered list is `record.output.findings` |
| `posted` | what was posted — `summaryUrl`, `summaryCommentId`, `reviewId`, `comments` (each posted finding's inline comment), `counts`, and the `mode` it was published in — or `null` when not posting |
| `report` | `{ kind, conclusion, url, id }` — `kind` is `'check-run'` or `'commit-status'`; `conclusion` is what a check run concluded (`success`, `failure`, or `neutral` for a review that did not run), for a status too; `null` when the report was opened and could not be completed. `report` is `null` when not posting, with `report: 'none'`, or in `silent` mode |

### `unfinished`

The model ran and produced nothing usable, or was stopped before it could.

| Field | What it is |
|---|---|
| `record` | the record of what ran |
| `reason` | one sentence, already scanned for secrets — safe to show anyone who can see the pull request |
| `spentUsd` | what was spent for it (`record.costUsd`) |
| `retryable` | whether running it again could not pay for the model twice: nothing was spent, and it was not stopped on purpose. A retry policy reads this |
| `stopped` | `'deadline'` or `'cancelled'` when it was stopped; `null` when it stopped on its own |
| `posted`, `report` | the "This review did not complete" summary and its report, when posting |

### `refused`

`authorize` said no. Nothing was downloaded, nothing was written to GitHub, nothing was spent. `reason` says so.

### `failed`

The review did not produce one. `stage` says how far it got:

| `stage` | Meaning |
|---|---|
| `before-model` | nothing was spent: GitHub would not answer, the report could not be opened (`report: 'check-run'` with a token that cannot create one), `authorize` threw, the archive would not download, or it was cancelled before the model started |
| `model` | the model ran, and the review failed or was stopped after that |
| `withheld` | the output matched a secret pattern, so nothing of it is said anywhere |
| `publish` | the review ran and was paid for, and GitHub would not take it. `record` and `findings` carry it, so it is not lost |

It also carries `reason` (scanned, safe to show), `spentUsd` (model spend known to be gone — a lower bound when a pass
was cut off), `retryable`, `stopped`, `report`, and `cause` — the error as it was thrown, for your own logs only: it is
not scanned for secrets, and `reason` is the sentence that is safe to repeat.

### What throws

Only what is yours to fix in code or configuration, and always before anything is fetched or spent:

- a `TypeError` for a missing or wrong-typed option: a malformed `repo`, a relative `workDir`, an unknown option name
  (a misspelt `credentials` would otherwise bill the environment's credential), an unknown setting, `authorize`
  without `requestedBy`, a `deadlineMs` beyond 24.8 days (Node's timer limit, past which it would fire at once);
- an `Error` for a process no review can run in: no model credential, two of them, or `ANTHROPIC_BASE_URL` set —
  what the CLI exits `2` for;
- a `TypeError` when `authorize` answers something other than `true` or `false` — a gate that forgot to answer is not
  a yes. Nothing has been downloaded or spent when it does.

Each message, and each result's reason, by symptom: [troubleshooting](guides/troubleshooting.md#the-sdk).

## Progress

`onProgress` hears where the review has got to. Every event carries `repo` and `pr`, so one handler can follow several
reviews.

| `stage` | When | Also carries |
|---|---|---|
| `preparing` | reading the pull request and its settings | |
| `downloading` | downloading the code | |
| `reviewing` | a reviewer starts — on a multi-reviewer review, once per focus | `focus`: `'intent'`, `'impact'`, `'security'`, or `null` for one reviewer |
| `checking` | the disprove-it pass starts | `findings`: how many it checks |
| `rechecking` | the re-review pass starts, on a pull request reviewed before | `findings`: how many earlier findings it is asked about |
| `publishing` | posting the review and the summary | |
| `reporting` | finishing the check run or commit status | `report`: its kind |
| `done` | the last event of every call that returns, once the checkout is gone | `result`: the result's kind |

A review skips what it does not do: a printed one never publishes or reports. An event with a `note` is a line of
progress inside the stage the review last reached — the lines the CLI prints on stderr, such as credential files
removed from the checkout or a report that could not be completed — with `details`, the fields it was logged with:

```ts
onProgress: (e) => {
  if (e.note !== undefined) log.info(e.note, { repo: e.repo, pr: e.pr, ...e.details })
  else ui.show(`${e.repo}#${e.pr}: ${e.stage}`)
}
```

A handler that throws, or an async one that rejects, loses that event and nothing else.

## Credentials

| Credential | Pass it as | Who pays | Use it for |
|---|---|---|---|
| **API key** | `{ apiKey }`, or `ANTHROPIC_API_KEY` in the environment | per-token API prices | **everything** — and the only credential for a shared service, or a product that reviews for other people |
| **Subscription token** (`claude setup-token`) | `{ oauthToken }`, or `CLAUDE_CODE_OAUTH_TOKEN` | the subscription's allowance | **your own** use: your scripts, your own CI. Never shared across people, never stored by a product |
| **`claude login`** | `'claude-login'` | that account | your own machine only. Never the default |

Anthropic's terms say OAuth is *"designed to support ordinary use of Claude Code"*, and that *"Anthropic does not
permit third-party developers to … route requests through Free, Pro, or Max plan credentials on behalf of their users
… developers may not collect, store, or intermediate Claude.ai credentials or session tokens"*
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). So the SDK takes an **API key as the
normal path**, and **passes a subscription token straight to the Claude process without storing, logging or reusing
it** — and a service you build on the SDK should never collect your users' subscription tokens to pass in.

What the SDK does with whichever credential it is given:

- It travels with **that review only**: the Claude process gets that credential and no other — any credential
  variable in your process's environment is removed from the child's. It is never written to `process.env`, where
  two concurrent reviews would race on it.
- It is wrapped as a `SecretValue`, so `String()`, `JSON.stringify` and `console.log` print `[redacted]`, and it is
  in no progress event and no result. Nothing keeps it after the call returns.
- Left out, the credential comes from the environment: **exactly one** of `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN`. Both, or neither, throws — a review is always billed to an account you can name.
- `ANTHROPIC_BASE_URL` set in your process refuses every review, **even with a credential passed explicitly** and
  even though the Claude process would never see the variable: the reviewed code goes to Anthropic and nowhere else.

`record.costUsd` is model spend **at per-token API prices**, as the Claude Code CLI reports it. On a subscription token
the same figure is drawn from the subscription's allowance rather than billed. What the tiers have cost when measured:
[tiers](configuration.md#tiers).

## Reporting on the commit

When posting, `report: 'auto'` reports with a **check run** when the token can create one — an App's installation
token, or GitHub Actions' `GITHUB_TOKEN` with `checks: write` — and a **commit status** when it cannot, as with a
person's token or a bot account's. It decides with one `GET /user`: a user token is answered with its user, an
installation token with 403 — seen with a GitHub Actions workflow's `GITHUB_TOKEN` on 2026-10-15, which reported with
a check run. If a check run is refused anyway, the report falls back to a status.

| The token can… | App installation token | A person's or bot account's token |
|---|---|---|
| read the pull request and the code | yes | `Contents: Read`, `Pull requests: Read` |
| post the review, comments and summary | yes | `Pull requests: Write` |
| create a check run | yes | **no** — GitHub lets only Apps create them |
| set a commit status | only with the `statuses` permission, which the App does not ask for | `Commit statuses: Write` (needs push access) |

A commit status is a **soft gate**: a branch rule cannot pin it to this reviewer, so anyone with push access can set
one with the same name. For a gate that holds, report with a check run from an App or from Actions. A review that did
not run reports `success` with a description saying it is not a verdict (statuses have no `neutral`); one you
cancelled reports `error`, so it does not block a merge.

## Examples

### 1. Review a pull request and print the findings

```ts
import { reviewPullRequest } from '@review-agent/sdk'

// The model credential comes from the environment: exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
const result = await reviewPullRequest({
  repo: 'acme/widgets', pr: 128,
  github: { token: process.env.GITHUB_TOKEN! },          // Contents: Read, Pull requests: Read
})

switch (result.kind) {
  case 'reviewed':
    for (const f of result.findings) console.log(`[${f.severity}/10 ${f.category}] ${f.file}:${f.line} ${f.title}`)
    if (result.findings.length === 0) console.log('no findings')
    console.log(`$${result.record.costUsd.toFixed(2)} of model spend at per-token API prices`)
    break
  case 'unfinished':
  case 'failed':
    console.error(`the review did not complete: ${result.reason}`)
    process.exitCode = 1
}
```

### 2. Post as a bot account

```ts
const result = await reviewPullRequest({
  repo: 'acme/widgets', pr: 128,
  github: { token: process.env.REVIEW_BOT_TOKEN! },      // Contents: Read, Pull requests: Write, Commit statuses: Write
  credential: { apiKey: process.env.ANTHROPIC_API_KEY! },
  post: true,                                            // a person's or bot's token: reported with a commit status
})
if (result.kind === 'reviewed') console.log(result.posted?.summaryUrl)
if (result.kind === 'failed' && result.stage === 'publish') {
  // Paid for, and GitHub would not take it: show it rather than lose it.
  console.log(result.findings)
}
```

The review appears under the bot's name, and its summary opens with a line saying it is an automated review and that
it was run through the SDK.

### 3. A service on a VPS, with the App's installation token

A requested review, for someone who can push, posted as the App and reported with a check run. The installation token
is minted per review with `@review-agent/app` — a separate install, which brings `@trigger.dev/sdk` with it; minting
the token another way works the same.

```ts
import { appIdentityFromEnv, installationToken } from '@review-agent/app'
import { pushAccessOf, reviewPullRequest } from '@review-agent/sdk'

// Read once at start-up: REVIEW_AGENT_APP_CLIENT_ID and REVIEW_AGENT_APP_PRIVATE_KEY.
const identity = appIdentityFromEnv(process.env)

export async function reviewOnRequest(a: {
  installationId: number; owner: string; repo: string; pr: number; requestedBy: string
}) {
  // One token per review, scoped to the one repository, and dead within the hour: never cached.
  const { token } = await installationToken({ identity, installationId: a.installationId, repositories: [a.repo] })
  return reviewPullRequest({
    repo: `${a.owner}/${a.repo}`, pr: a.pr,
    github: { token },
    credential: { apiKey: process.env.ANTHROPIC_API_KEY! },   // a service reviews for other people: an API key
    post: true,                                               // 'auto': a check run, for an installation token
    requestedBy: a.requestedBy,
    authorize: pushAccessOf,                                  // the App's own gate: only someone who can push spends
    workDir: '/var/lib/review-agent/checkouts',
    skillCacheDir: '/var/lib/review-agent/skills',
  })
}
```

Answer GitHub's webhook first and review afterwards, from a queue: GitHub waits 10 seconds for a delivery, and a
review takes minutes.

### 4. A batch, a few at a time

```ts
import { Octokit } from '@octokit/core'
import { reviewPullRequest, type ReviewResult } from '@review-agent/sdk'

const token = process.env.GITHUB_TOKEN!
const open = await new Octokit({ auth: token }).request('GET /repos/{owner}/{repo}/pulls', {
  owner: 'acme', repo: 'widgets', state: 'open', per_page: 100,
})

const prs = open.data.map((p) => p.number)
const results = new Map<number, ReviewResult>()
let next = 0
// Two at a time: each review is at least one Claude process, and each costs money.
await Promise.all(Array.from({ length: 2 }, async () => {
  while (next < prs.length) {
    const pr = prs[next++]
    results.set(pr, await reviewPullRequest({ repo: 'acme/widgets', pr, github: { token } }))
  }
}))

let spent = 0
for (const [pr, r] of results) {
  if (r.kind === 'reviewed' || r.kind === 'unfinished') spent += r.record.costUsd
  else if (r.kind === 'failed') spent += r.spentUsd
  console.log(`#${pr}: ${r.kind}${r.kind === 'reviewed' ? `, ${r.findings.length} findings` : ''}`)
}
console.log(`$${spent.toFixed(2)} of model spend at per-token API prices`)
```

To review one pull request at several tiers instead, loop over `['basic', 'normal', 'thorough']` and pass each as
`tier`. One review is a sample: the same model can find different things on two runs.

### 5. Cancelling

```ts
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())

const result = await reviewPullRequest({
  repo: 'acme/widgets', pr: 128, github: { token: process.env.GITHUB_TOKEN! },
  signal: controller.signal,
  deadlineMs: 10 * 60 * 1000,      // and stop by itself after ten minutes
})
if (result.kind === 'failed' && result.stopped !== null) {
  console.log(`stopped (${result.stopped}) after $${result.spentUsd.toFixed(2)} at per-token API prices`)
}
```

The Claude process is stopped with the review, its checkout is removed, and a commit status it had set to pending says
`error`. A signal that has already aborted makes no request at all. Cancelled while the pull request is being read, the
review stops as soon as that read returns.

## Concurrency and lifetime

- Reviews in one process run concurrently and share nothing but the skill cache: each builds its own GitHub client,
  carries its own credential, and gets its own checkout.
- Each checkout is removed when its review ends — finished, failed, refused, cancelled — before `done` is sent.
- `deadlineMs` stops one review; `signal` stops whatever you attach it to.

## What it never does

- **Store anything.** No state between calls, no cache of tokens or credentials, no record store. The record is
  returned to you; keeping it is yours to decide.
- **Start a server.** No webhook endpoint, no queue, no retries — a host that wants them builds them around the call.
- **Post unless asked.** Without `post: true` nothing at all is written to GitHub, and nothing asks who the token is.
- **Touch your environment.** It reads `process.env` — for the default credential, `ANTHROPIC_BASE_URL`,
  `REVIEW_AGENT_CLAUDE_BIN`, and what Claude Code needs to start (`PATH`, `HOME` and the rest of
  [its allow-list](security.md#what-the-model-can-do)) — and never writes to it.
- **Run the reviewed code**, approve, or request changes. Its reviews are comments.

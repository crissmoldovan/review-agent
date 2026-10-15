# Deploying the reviewer as a GitHub App

This is the mode that reviews every pull request in your repositories and posts the results. It has three parts,
and you host all of them:

```
            signed webhook                       trigger a run
  GitHub ───────────────────▶  your receiver  ───────────────────▶  the runner: trigger.dev task
    ▲                          verify · decide · dispatch            `review-agent-review`
    │                          holds: webhook secret,                mints a token for one repo,
    │                                 a trigger-only key             downloads the code, runs Claude
    │                                                                Code read-only, posts the review
    └────────────────────────────────────────────────────────────────────────┘
                     review, inline comments, check run (as your App)
```

| Part | What it is | What it holds |
|---|---|---|
| **The GitHub App** | registered from this repository's manifest; installed on the repositories to review | its private key (given to the runner only) |
| **The receiver** | a small HTTPS endpoint you write, using `@review-agent/app/receiver` | the webhook secret and a trigger-only key — **no App key, no model credential** |
| **The runner** | the tasks in `packages/app`, deployed to your own [trigger.dev](https://trigger.dev) project | the App's client id and private key, and one model credential |

The split is deliberate: the half on the internet can start a review and nothing else, and the code being reviewed
never leaves your App, your runner and Anthropic. See [security](security.md).

## What you need

- A GitHub account or organisation to own the App, with admin rights on the repositories to review.
- A [trigger.dev](https://trigger.dev) account and an empty project (the runner is built for trigger.dev v4, SDK
  `4.5.16`).
- Somewhere to host the receiver: any server or platform that can answer an HTTPS POST from Node.js 22 — a Next.js
  route on Vercel ([step by step](guides/vercel.md)), an Express or Hono server, a serverless function.
- An Anthropic credential: an **API key**, or a Claude **subscription token** from `claude setup-token`.
- Node.js 22, pnpm 11 and git, to deploy the runner from this repository.

## 1. Register the App

Follow [the GitHub App guide](github-app.md): register it (`review-agent init`), generate a private key, delete the
registration-time key and client secret, and set a webhook secret. Don't install it yet.

## 2. Create the trigger.dev project and set its variables

Create a project in trigger.dev and note its ref (`proj_…`, under **Project settings**). In its **Production**
environment, under **Environment Variables**, set:

| Variable | Required | Value |
|---|---|---|
| `REVIEW_AGENT_APP_CLIENT_ID` | yes | the App's client id (`Iv23li…`) — not the numeric App ID |
| `REVIEW_AGENT_APP_PRIVATE_KEY` | yes | the whole `.pem` you generated, `-----BEGIN` to `-----END`. Flattened line breaks are repaired |
| `ANTHROPIC_API_KEY` | **yes** | the model credential: an Anthropic API key, billed at per-token API prices. The runner also accepts `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription token) instead, but Anthropic's terms limit subscription tokens to a person's own use, so a deployment reviewing an organisation's pull requests uses an API key ([security](security.md), spec 0.2.0 §2.3). Exactly one may be set: neither, or both, and every review is refused before it starts |
| `REVIEW_AGENT_SWEEP_TARGETS` | no | the repositories the [hourly sweep](#the-hourly-sweep) looks after |
| `REVIEW_AGENT_RECORD_URL` | no | where to send each finished review's [signed record](#the-review-record-callback) |
| `REVIEW_AGENT_RECORD_SECRET_ENV` | no | the **name** of the variable holding the record's signing secret; default `REVIEW_AGENT_RECORD_SECRET` |
| `REVIEW_AGENT_RECORD_SECRET` (or the name above) | with a record URL | the secret the record is signed with |
| `REVIEW_AGENT_SKILLS_TOKEN` | no | a GitHub token for downloading private [skills](configuration.md#skills) |

**Do not set `ANTHROPIC_BASE_URL`** in this project: the runner refuses to run while it is set. Leave
`REVIEW_AGENT_CLAUDE_BIN` alone too — the deploy sets it to the Claude Code binary it installs.

The App's private key should live in this project and in one offline copy you keep, and nowhere else.

## 3. Write the receiver

The receiver does three things, in this order, and answers GitHub straight away:

1. **Verify the signature over the raw bytes**, before parsing anything. A body that has been through `JSON.parse`
   and back no longer hashes to what GitHub signed.
2. **Decide** what the delivery means: a review, or something to ignore. Pure, no network.
3. **Dispatch** a review to the runner, with an idempotency key, and return.

Install the library in your receiver's project:

```sh
npm install @review-agent/app @review-agent/core
```

A complete receiver as a Next.js App Router route, `app/api/github/webhook/route.ts`:

```ts
import { defaultDeploymentConfig } from '@review-agent/core'
import { decideDelivery, dispatchReview, sdkTriggerPort, verifyDelivery } from '@review-agent/app/receiver'

export const runtime = 'nodejs' // node:crypto is needed to check the signature

// Only `command`, `autoReview` and `allowMulti` are read here. If you change the command word or `allowMulti`,
// change it in the runner too.
const deployment = defaultDeploymentConfig()

export async function POST(request: Request): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer()) // raw bytes, before any parse
  const verified = verifyDelivery({
    rawBody,
    headers: request.headers,
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? '', // an empty secret is refused, never "no check"
  })
  if (!verified.ok) return new Response('bad signature', { status: 401 }) // log verified.why, don't return it

  const decision = decideDelivery({
    delivery: {
      event: request.headers.get('x-github-event') ?? '',
      payload: JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
    },
    deployment,
  })
  if (decision.kind === 'ignore') return new Response(null, { status: 204 }) // most deliveries end here

  try {
    await dispatchReview({
      request: decision.request,
      installationId: decision.installationId,
      trigger: sdkTriggerPort, // uses TRIGGER_SECRET_KEY
      // what a /review comment asked for and was refused travels to the summary
      ...(decision.refused !== undefined && { refused: decision.refused }),
    })
  } catch {
    // Not 2xx, so the failed delivery shows up in the App's settings and can be redelivered.
    return new Response('the review could not be queued', { status: 500 })
  }
  return new Response('queued', { status: 202 })
}
```

The receiver's environment:

| Variable | Value |
|---|---|
| `GITHUB_WEBHOOK_SECRET` (or any name you choose) | the webhook secret you set on the App |
| `TRIGGER_SECRET_KEY` | an API key from your trigger.dev project's **Production** environment (**API keys → New API key**), with **Trigger only** access, restricted to the task `review-agent-review` |

Nothing else. **Never give the receiver the App's private key or a model credential**: if the internet-facing half
is compromised, the worst it can do is start reviews.

Notes:

- The library reads no environment variable on the receiver's side except through the trigger.dev SDK
  (`TRIGGER_SECRET_KEY`). If you need a different client — another project, a key from a secret store — pass your
  own `TriggerPort` instead of `sdkTriggerPort`. See [the library reference](library.md#the-receiver).
- `verifyDelivery` refuses the legacy SHA-1 signature, a missing or duplicated header, and an empty secret.
  `verifySignature` does the same check when you already have the header's value.
- The raw delivery is never forwarded: only the fields a review needs go to the runner.
- In another framework, the shape is the same: read the body as bytes, verify, parse, decide, dispatch, answer.

## 4. Optional: change the runner's settings

The runner reviews with the [built-in defaults](configuration.md#every-setting): tier `basic`, `inline+summary`,
inline comments from severity 5, check run named `review-agent`, no gate. To change any of them — a gate, another
check-run name, a quieter mode, deployment-wide instructions, skills — edit `runnerDeployment` in
`packages/app/src/tasks/review-job.ts` before you deploy:

```ts
export const runnerDeployment = (): DeploymentConfig => {
  const defaults = defaultDeploymentConfig()
  return {
    ...defaults,
    report: { ...defaults.report, checkRunName: 'acme/ai-review', failAtOrAbove: 9 },
    instructions: 'We are a payments company. Treat any change to money arithmetic as high severity.',
  }
}
```

This is a source edit in this release; keep it in your own branch or fork and re-apply it when you upgrade. If you
change `command`, change the receiver's `deployment` to match.

## 5. Deploy the runner

```sh
git clone https://github.com/crissmoldovan/review-agent.git
cd review-agent
pnpm install
cd packages/app
npx trigger.dev@4.5.16 login                                   # once
TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxxxxxxxxxx npx trigger.dev@4.5.16 deploy --env prod
```

The deploy builds an image that includes Claude Code `2.1.258` (pinned) and registers four tasks:

| Task | When it runs | What it does |
|---|---|---|
| `review-agent-review` | when the receiver triggers it | one review, end to end |
| `review-agent-focus` | when a [multi-reviewer review](#multi-reviewer-reviews) starts it — one run per focus | one focused reviewer, on a machine of its own; it posts nothing, and hands what it found back to the review that started it |
| `review-agent-sweep-stale-check-runs` | every hour, on the hour (UTC) | closes abandoned check runs — see [the sweep](#the-hourly-sweep) |
| `probe-claude` | only when you start it by hand | reports whether the Claude binary runs in the image and which credential **names** are present (never values) |

`npx trigger.dev@4.5.16 deploy --dry-run` builds the bundle locally without deploying, if you want to check first.

To confirm the runner can reach Claude, start `probe-claude` from the trigger.dev dashboard's **Test** page and read
its output.

## 6. Connect the webhook

On the App's settings page, check that **Webhook URL** is your receiver's address and **Webhook secret** matches
`GITHUB_WEBHOOK_SECRET`. Under **Advanced → Recent Deliveries** you can watch deliveries arrive and redeliver one.
A `204` means the delivery was understood and needed nothing; `401` means the secret does not match.

## 7. Install it and try it

1. Install the App on **one** repository (**Install App → Only select repositories**).
2. Open a small pull request there, or comment `/review` on an existing one.
3. Watch the run in trigger.dev (**Runs**). A review takes a few minutes.
4. On the pull request you should see a **review-agent** check run, then the summary comment and any inline
   comments. What they mean: [using it on pull requests](pull-requests.md).

Then install it on more repositories, telling the people who work there first.

## How a run behaves

| Limit | Value | What happens |
|---|---|---|
| Machine | `small-2x` | 1 vCPU and 1 GB, shared by the runner and the `claude` process |
| Review deadline | 30 minutes | the review stops itself, and concludes its check run `neutral` |
| `maxDuration` | 45 minutes | trigger.dev's backstop; the deadline above should always fire first |
| Attempts | 3 | trigger.dev retries a crashed or evicted attempt; a retried attempt first closes the check run the previous attempt left open |
| New runs for a failure that cost nothing | up to 2 more | a GitHub error before the model started, or a crash at $0, starts a fresh run |
| Idempotency | per commit, per request | one automatic review per commit; every `/review` comment is its own request; pressing one check run's Re-run twice starts one review |

A review that dies **after** the model has spent can therefore be paid for up to three times. A review that fails
after spending is otherwise never repeated automatically.

### Multi-reviewer reviews

A `/review --multi` ([the multi-reviewer mode](configuration.md#the-multi-reviewer-mode)) runs three focused reviewers.
One review was measured at roughly 300 to 400 MiB of memory — 293.8 MiB in this image on a one-file pull request
(2026-09-15), 388 MiB on macOS — so three side by side do not fit the runner's 1 GB machine. The runner starts **one
`review-agent-focus` child task per focus** instead, all three at once (`batchTriggerAndWait`), each on its own
`small-2x` machine, and waits:

| | |
|---|---|
| The review while it waits | checkpointed by trigger.dev, which documents that a waiting run holds no concurrency slot and is not billed for the wait (not measured here) |
| Each focus | mints its own token for the one repository, downloads the commit the review is of, runs one reviewer with the tier's whole budget, deletes its checkout, and hands back what it found. It resolves its settings from the same deployment, settings file and request as the review — a focus payload carries ids and what was asked, never settings |
| After all three answer | the review downloads the commit itself, runs **one** check pass over everything the focuses found, and posts one review, as a single reviewer's would be |
| A focus that fails | before its reviewer starts — GitHub, the download — trigger.dev retries it (3 attempts, the project's). Once its reviewer has run, it is never run again. A focus that fails every attempt is named in the summary as not finished, and the review goes on without it; only when none of the three answered is the review unfinished |
| A focus's own deadline | 20 minutes — inside the review's 30, so the review has time left to check and post what its focuses found |
| Idempotency | each child is keyed on the review's run, its focus and the commit: a retried attempt of the review gets back the children it already started, and does not pay for a focus that already answered |
| Cost | roughly three reviews plus one check pass, as model spend at per-token API prices (not measured on this release), plus three child runs' compute on trigger.dev (its usage price; not measured either) |

If someone pushes while the focuses are queued, a focus refuses to review the new commit — its run says *the pull
request moved on* — because the review it belongs to is of the old one.

## The review record callback

The product stores nothing. If you want a record of every review — costs, findings, verdicts, which comment each
finding became — set `REVIEW_AGENT_RECORD_URL` (it must be `https://`) and a secret, and the runner POSTs each
**finished** review there once, after it is published:

- header `x-review-agent-signature-256: sha256=<hex>`, an HMAC-SHA256 of the raw body under your secret — the same
  shape as a GitHub signature, so you check it with the function you already use:

  ```ts
  verifySignature({ rawBody, signature: request.headers.get('x-review-agent-signature-256'), secret })
  ```

- body: an envelope, with the record nested inside it:

  ```jsonc
  {
    "version": 1,                         // the envelope's version
    "result": {
      "kind": "reviewed",
      "headSha": "…",                      // the commit reviewed
      "record": { "recordVersion": 1, "engineVersion": "0.2.0", "…": "…" },   // see How it works
      "reviewId": 77,                      // the GitHub review, or null
      "summaryCommentId": 903,             // the summary comment, or null
      "counts": {
        "inline": 2, "summaryOnly": 1, "droppedInline": 0, "suppressed": 1, "notInCheckout": 0,
        "retracted": 0, "reinstated": 0, "retractionsWithheld": 0
      },
      "verdict": "<!-- review-agent-verdict: {…} -->",
      "checkRun": { "id": 4242, "conclusion": "success" },                  // or null
      "comments": [                         // this run's inline comments, [] when there are none
        { "findingId": "3f2a9c0d1b7e", "file": "src/a.ts", "line": 10, "commentId": 5001 }
      ]
    }
  }
  ```

`comments` is how a reply finds its finding: a reply to an inline comment carries only the id of the comment it
answers. `findingId` is `findingId(finding)` from `@review-agent/github` — an address for one finding in one run, not
an identity that survives the model rewording it.

The callback is sent once, with a 10-second timeout and no redirects. If it fails, it is logged and not retried; the
review is unaffected. It is not sent for a review that produced nothing, was refused, or was skipped. A review cut
short by its budget, with partial findings, does send one. The record carries no webhook delivery id and no
trigger.dev run id — the product never sees the first, and the second is on trigger.dev's side.

The secret's variable may not be one of the runner's own credentials, and the record is scanned for secrets before
it is sent.

## The hourly sweep

If a run is killed in a way that runs no cleanup, its check run can be left `in_progress`, which blocks a merge that
requires it. The next review of the same commit closes it; the sweep also closes it without waiting for one.

Set `REVIEW_AGENT_SWEEP_TARGETS` to the repositories to watch, per [installation id](github-app.md#the-installation-id):

```json
[{ "installationId": 12345678, "repositories": ["acme/api", "acme/web"] }]
```

Every hour, for each repository, it lists the open pull requests and closes as `neutral` (**Review timed out**) any
check run of this reviewer still `in_progress` an hour after it started. Unset, it does nothing. A malformed value
makes the sweep run fail visibly rather than sweep nothing.

## Running the review without trigger.dev

`@review-agent/app/runner` exports `runReviewJob`: the review the `review-agent-review` task runs — the App token for
one repository, the release-only skip, the push-access gate, the check run — in your own process, from your own job
system. It never loads `@trigger.dev/sdk`.

```ts
import { appIdentityFromEnv } from '@review-agent/app'
import { DoNotRetry, runReviewJob } from '@review-agent/app/runner'

// `decision` is what decideDelivery returned for a delivery, with kind 'review'.
try {
  const result = await runReviewJob({
    identity: appIdentityFromEnv(process.env),   // REVIEW_AGENT_APP_CLIENT_ID and REVIEW_AGENT_APP_PRIVATE_KEY
    installationId: decision.installationId,
    request: decision.request,
    focusConcurrency: 1,                         // optional; see below
  })
  console.log(result.kind)                       // 'reviewed', 'skipped' or 'refused'
} catch (e) {
  if (e instanceof DoNotRetry) { /* the model may have been paid: never run it again */ }
  else { /* nothing was spent (or RetryThis: a crash at $0): your queue may try again */ }
}
```

The process needs the same variables as the trigger.dev project: exactly one model credential, the App's client id
and key, and optionally the record callback's. What trigger.dev did for you is yours to do: nothing starts another
run for a free failure, and a check run a killed process left open is closed only by the next review of that commit —
or by `closeStaleCheckRuns` from `@review-agent/github`, on a schedule of your own. A multi-reviewer review runs its three focuses **in this process**, side by side —
`focusConcurrency` at a time, 3 when left out. Each is a Claude process of roughly 300 to 400 MiB, so on a machine
with about 1 GB say `1`.

## Upgrading

1. Update your clone, re-apply any change to `runnerDeployment`, and deploy the runner again (step 5).
2. Update `@review-agent/app` and `@review-agent/core` in the receiver to the same version.
3. Read the [changelog](../CHANGELOG.md) for anything that changes the record or the receiver.

**To 0.2.0:** redeploy the runner, and that is all. Nothing is reconfigured — the same variables, task ids, payload,
check-run name, record callback (`version: 1`, with fields added) and receiver — and the new `review-agent-focus` task
registers itself with the deploy. A receiver's `TRIGGER_SECRET_KEY` needs nothing new: only the runner triggers the
focus task, with its own credentials.

## When something goes wrong

Every message the reviewer prints that you can act on, whichever way in: [troubleshooting](guides/troubleshooting.md).

| Symptom | Likely cause |
|---|---|
| Deliveries answered `401` | the receiver's secret does not match the App's webhook secret |
| Deliveries answered `204` and no run starts | the event is not a trigger: a push, a reopen, a draft, a comment that does not start with the command word |
| Deliveries answered `500` | the receiver could not trigger: check `TRIGGER_SECRET_KEY` belongs to the Production environment of the project the runner is deployed to, and may trigger `review-agent-review` |
| The run fails at once: `no model credential`, or `2 model credentials are set` | set exactly one of `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` |
| The run fails: `ANTHROPIC_BASE_URL is set` | remove that variable from the project |
| The run fails: `the App private key is not a usable PEM private key` | paste the whole `.pem` again, header and footer included |
| `GitHub refused an installation token …` | the client id and private key belong to a different App from the one installed, or the key was deleted on GitHub |
| A `neutral` **Review refused** check | the person who asked has no push access |
| A check run stuck `in_progress` | the run was killed; it closes after an hour (next review or sweep) |
| A multi-reviewer summary says a focus `✗ (did not finish)`, and a `review-agent-focus` run failed | that focus failed every attempt before its reviewer answered; its run page says why. The review went on without it |
| A `review-agent-focus` run failed with `the pull request moved on` | someone pushed while the focuses were queued; the review it belonged to was of the earlier commit |

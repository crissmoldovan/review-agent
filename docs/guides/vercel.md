# Review every pull request with the webhook on Vercel

At the end of this guide every pull request that opens in the repositories you choose is reviewed by **your own GitHub
App**. GitHub's webhook arrives at a route in a Next.js project on **Vercel**, which checks the signature, decides
whether the delivery is a review, and hands it to the **runner on trigger.dev**, which does the review and posts it as
the App: a review with inline comments, a summary comment and a check run named `review-agent` (use case UC-8 in
[the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)).

```
            signed webhook                         trigger a run
  GitHub ───────────────────▶  Vercel: Next.js route  ─────────────────▶  trigger.dev: the runner
    ▲                          verify · decide · dispatch                  mints a token for one repository,
    │                          holds: the webhook secret,                  downloads the code, runs Claude Code
    │                                 a trigger-only key                   read-only, posts the review
    └───────────────────────────────────────────────────────────────────────────┘
                       review, inline comments, check run (as your App)
```

This is the [App deployment](../deploying.md) with its receiver on Vercel; the runner is the same. The half on the
internet holds no App key and no model credential, so the worst a compromised route can do is start reviews.

*Not captured yet: no Vercel deployment was made for the 0.2.0 release, and this guide has not been run end to end.*

## Why the review does not run in a Vercel Function

The route answers GitHub and does no review work. The review runs elsewhere because:

- **GitHub waits about 10 seconds** for an answer to a webhook delivery, and a review takes minutes — 2–7 measured for
  `basic` and `normal` — so the review must run after the answer, somewhere else
  ([spec 0.2.0 §7](../specs/0.2.0-ways-in.md#7-running-it-yourself--the-vps--container-recipe-uc-7)).
- **How long a Function may run.** Hobby stops a Function at 300 seconds; Pro and Enterprise at 800 seconds, or 1,800
  in a beta ([Vercel's limits](https://vercel.com/docs/functions/limitations), checked 2026-10-15). The review's own
  deadline is 30 minutes.
- **Size.** A Function's bundle may be 250 MB uncompressed, or up to 5 GB with Vercel's large-functions beta; Claude
  Code's native binary alone is about 215 MB
  ([spec 0.2.0 §12.2](../specs/0.2.0-ways-in.md#122-spikes--each-settles-an-unverified-fact-before-code-depends-on-it), S2).
- **Whether a Function can start the Claude binary and finish a review at all is UNVERIFIED** — spike S3, not yet run.
- **Memory.** One review was measured at roughly 300–400 MiB at its peak, and Vercel may run several invocations on
  one instance ([spec 0.2.0 §9.2](../specs/0.2.0-ways-in.md#92-per-environment)).
- **Keys.** A review needs the App's private key and a model credential. Running it beside the route would put both on
  the half that faces the internet.

So the route hands each review to a runner: **trigger.dev** (recommended, and what this guide sets up), or a
**Vercel Sandbox** (below; not yet tested by this project).

## What you need

- [ ] A **Vercel** account, and a Next.js project on it with the App Router — your own, or a new one from
      `npx create-next-app@latest`.
- [ ] A **[trigger.dev](https://trigger.dev)** account and an empty project. The runner is built for trigger.dev v4,
      SDK `4.5.16`.
- [ ] A **GitHub organisation or account** to own the App, and admin rights on the repositories to review.
- [ ] An **Anthropic API key**. The runner reviews other people's pull requests, so it takes an API key
      ([spec 0.2.0 §2.3](../specs/0.2.0-ways-in.md#23-model-credentials)).
- [ ] **On your own machine:** Node.js 22 or newer, pnpm 11 and git, to deploy the runner from this repository; a
      browser, to register the App. Optional: the [Vercel CLI](https://vercel.com/docs/cli), `npm install --global
      vercel`.

Commands run on your own machine. Each is the same in a POSIX shell and in PowerShell unless both are shown.

## 1. Register the App

Your route will be at `https://<your-project>.vercel.app/api/github/webhook`, or the same path on your own production
domain. Use a **production** domain: Vercel's *Standard Protection*, the scope Vercel recommends, puts every other URL
of a deployment behind a Vercel login, which GitHub cannot pass
([Deployment Protection](https://vercel.com/docs/deployment-protection), checked 2026-10-15).

```sh
npx @review-agent/cli@0.2.1 init --name "Acme Reviewer" --url https://example.com \
  --webhook-url https://reviewer-acme.vercel.app/api/github/webhook --org acme
```

```powershell
npx @review-agent/cli@0.2.1 init --name "Acme Reviewer" --url https://example.com `
  --webhook-url https://reviewer-acme.vercel.app/api/github/webhook --org acme
```

Open the `http://127.0.0.1:<port>` address it prints, press the button, and confirm on GitHub. Leave out `--org` to
register the App under your own account. Then, on the App's settings page — each step is in
[after registering](../github-app.md#after-registering):

1. **Generate a private key.** The `.pem` goes to trigger.dev in step 2, and nowhere else — not to Vercel.
2. **Delete the private key and the client secret** GitHub created with the registration.
3. **Set a webhook secret** — a long random value, such as the output of `openssl rand -hex 32`. Keep it for step 4.
4. **Note the client id** (`Iv23li…`). It is not a secret.

Do not install the App yet.

*Not captured yet: no Vercel deployment was made for the 0.2.0 release.*

**If you see this instead**

| Symptom | Fix |
|---|---|
| `init` exits `1` after an hour | the registration was not confirmed in time; run it again |
| GitHub says the name is taken | App names are unique across GitHub; choose another `--name` |

## 2. Deploy the runner on trigger.dev

Create a project in trigger.dev and note its ref (`proj_…`, under **Project settings**). In its **Production**
environment, under **Environment Variables**, set:

| Variable | Required | Value |
|---|---|---|
| `REVIEW_AGENT_APP_CLIENT_ID` | yes | the App's client id (`Iv23li…`) — not the numeric App ID |
| `REVIEW_AGENT_APP_PRIVATE_KEY` | yes | the whole `.pem`, `-----BEGIN` to `-----END`. Flattened line breaks are repaired |
| `ANTHROPIC_API_KEY` | yes | the Anthropic API key. Exactly one model credential: none, or two, and every review is refused before it starts |
| `REVIEW_AGENT_SWEEP_TARGETS`, `REVIEW_AGENT_RECORD_URL`, `REVIEW_AGENT_RECORD_SECRET`, `REVIEW_AGENT_SKILLS_TOKEN` | no | the [hourly sweep](../deploying.md#the-hourly-sweep), the [record callback](../deploying.md#the-review-record-callback) and private [skills](../configuration.md#skills) |

Do not set `ANTHROPIC_BASE_URL`: the runner refuses to run while it is set. Then deploy the runner from this
repository:

```sh
git clone https://github.com/crissmoldovan/review-agent.git
cd review-agent
pnpm install
cd packages/app
npx trigger.dev@4.5.16 login
TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxxxxxxxxxx npx trigger.dev@4.5.16 deploy --env prod
```

In PowerShell, set the project ref first, then deploy:

```powershell
$env:TRIGGER_PROJECT_REF = "proj_xxxxxxxxxxxxxxxxxxxx"
npx trigger.dev@4.5.16 deploy --env prod
```

The deploy builds an image with Claude Code `2.1.258` pinned and registers the tasks `review-agent-review`,
`review-agent-focus`, `review-agent-sweep-stale-check-runs` and `probe-claude`. To check the runner can reach Claude,
start `probe-claude` from the dashboard's **Test** page. Details: [deploy the runner](../deploying.md#5-deploy-the-runner).

Last, the key the route will trigger with: in the same **Production** environment, **API keys → New API key**, with
**Trigger only** access, restricted to the task `review-agent-review`. Keep it for step 4.

## 3. Add the route to the Next.js project

In the Next.js project:

```sh
npm install @review-agent/app@0.2.1 @review-agent/core@0.2.1 @trigger.dev/sdk
```

Then the route, at `app/api/github/webhook/route.ts` (or `src/app/api/github/webhook/route.ts` if the project keeps its
code under `src/`). It is the receiver from [deploying](../deploying.md#3-write-the-receiver), with two log lines added
so Vercel's logs say why a delivery was refused or could not be queued:

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
  if (!verified.ok) {
    console.warn('delivery refused:', verified.why) // a fixed word, such as missing-header or mismatch; never a secret
    return new Response('bad signature', { status: 401 })
  }

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
  } catch (e) {
    console.error('the review could not be queued:', e instanceof Error ? e.message : String(e))
    // Not 2xx, so the failed delivery shows up in the App's settings and can be redelivered.
    return new Response('the review could not be queued', { status: 500 })
  }
  return new Response('queued', { status: 202 })
}
```

- `runtime = 'nodejs'`: the signature is checked with `node:crypto`, which the Edge runtime does not have.
- The body is read as **raw bytes** and verified before anything parses it: a body that has been through `JSON.parse`
  and back no longer hashes to what GitHub signed.
- It needs no `maxDuration`: it verifies, decides, makes one call to trigger.dev, and answers.

## 4. Give the route its two variables

On Vercel: the project's **Settings → Environment Variables**, for the **Production** environment:

| Variable | Value |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | the webhook secret from step 1 |
| `TRIGGER_SECRET_KEY` | the trigger-only key from step 2 |

Or with the Vercel CLI, from the project's directory, which asks for each value rather than taking it on the command
line:

```sh
vercel env add GITHUB_WEBHOOK_SECRET production
vercel env add TRIGGER_SECRET_KEY production
```

**Nothing else.** Never give the Vercel project the App's private key, a model credential or `ANTHROPIC_BASE_URL`.

## 5. Deploy the route, and check it

Deploy to production the way the project already does — a push to its production branch — or:

```sh
vercel deploy --prod
```

Then, from your own machine, send it an unsigned request. Your route itself should refuse it:

```sh
curl -i -X POST https://reviewer-acme.vercel.app/api/github/webhook
```

```powershell
curl.exe -i -X POST https://reviewer-acme.vercel.app/api/github/webhook
```

The answer is `401` with the body `bad signature`, and the project's logs on Vercel show
`delivery refused: missing-header`.

*Not captured yet: no Vercel deployment was made for the 0.2.0 release.*

**If you see this instead**

| Symptom | Fix |
|---|---|
| a Vercel login page, or a `401` whose body is HTML | Deployment Protection answered, not your route: use the project's production domain (step 1), or change the project's **Settings → Deployment Protection** |
| `404` | the route is not at `app/api/github/webhook/route.ts` (or under `src/`), or the deployment is not the one with it |
| `405` | the request was not a `POST`; the route answers only `POST` |
| `401` `bad signature`, and the log says `empty-secret` | `GITHUB_WEBHOOK_SECRET` is not set for Production; set it, and deploy again so the deployment picks it up |

## 6. Connect the webhook

On the App's settings page, check that **Webhook URL** is the route's production address, **Active** is ticked, and
**Webhook secret** is the value you gave Vercel. Under **Advanced → Recent Deliveries**, open the `ping` GitHub sent
when the App was registered and press **Redeliver**. The route answers `204`: the delivery was understood and needed
nothing.

*Not captured yet: no Vercel deployment was made for the 0.2.0 release.*

| Symptom | Fix |
|---|---|
| `401`, and the log says `mismatch` | the App's webhook secret and `GITHUB_WEBHOOK_SECRET` differ. Set them to the same value, and redeploy |
| `500` on a later delivery, and the log says `the review could not be queued: …` | the route could not trigger the runner: `TRIGGER_SECRET_KEY` must be a key of the **Production** environment of the project the runner is deployed to, allowed to trigger `review-agent-review`. The message after the colon is trigger.dev's |

## 7. Install the App and try it

1. Install the App on **one** repository: the App's page → **Install App** → **Only select repositories**. Tell the
   people who work there first, so nobody meets a bot on their own pull request unannounced.
2. Open a small pull request there, or comment `/review` on an open one.
3. Watch the run in trigger.dev, under **Runs**. A review takes a few minutes.
4. On the pull request: a `review-agent` check run, then the summary comment and any inline comments. What they mean:
   [using it on pull requests](../pull-requests.md).

*Not captured yet: no Vercel deployment was made for the 0.2.0 release.*

Then install it on more repositories.

## The runner in a Vercel Sandbox instead — not yet tested by this project

A [Vercel Sandbox](https://vercel.com/kb/guide/using-vercel-sandbox-claude-agent-sdk) is an isolated Linux machine your
code starts on demand; Vercel's guide installs Claude Code in one. Its timeout defaults to 5 minutes and may be set to
at most 45 minutes on Hobby and 24 hours on Pro and Enterprise (that guide, checked 2026-10-15), so a review fits.
**No example ships for it, and this project has not run a review in one.** What it would take, from how the other
runners are built:

- **Something between the route and the sandbox.** The route must still answer GitHub within seconds and hold no keys,
  so it hands the review to a queue, and a separate consumer starts the sandbox.
- **The consumer holds the App's key and the API key** — never the route. It mints an installation token for the one
  repository, as the runner does, and passes the sandbox only that token and the API key, for one review.
- **In the sandbox:** Node.js 22, Claude Code installed with its install script allowed (or with Anthropic's
  installer), and the review done with [`reviewPullRequest`](../sdk.md) and `post: true`, gated with
  `authorize: pushAccessOf` for a requested review — as [`examples/server`](../../examples/server/README.md) does.
  The App's release-only skip and the hourly sweep are then yours to add.

Until that is tested, run the review on trigger.dev, or on [your own server](self-hosting.md).

## Environment variables, per side

| Where | Variable | What it is |
|---|---|---|
| **Vercel**: the route | `GITHUB_WEBHOOK_SECRET` | the App's webhook secret |
| | `TRIGGER_SECRET_KEY` | a trigger.dev Production key, **Trigger only**, restricted to `review-agent-review` |
| **trigger.dev**: the runner | `REVIEW_AGENT_APP_CLIENT_ID`, `REVIEW_AGENT_APP_PRIVATE_KEY` | the App's identity |
| | `ANTHROPIC_API_KEY` | the model credential, and the only one |
| | `REVIEW_AGENT_SWEEP_TARGETS`, `REVIEW_AGENT_RECORD_URL`, `REVIEW_AGENT_RECORD_SECRET_ENV`, `REVIEW_AGENT_RECORD_SECRET`, `REVIEW_AGENT_SKILLS_TOKEN` | optional: the sweep, the record callback, private skills ([deploying](../deploying.md#2-create-the-triggerdev-project-and-set-its-variables)) |
| **Neither** | `ANTHROPIC_BASE_URL` | refused everywhere: the reviewed code goes to Anthropic and nowhere else |

## When something goes wrong

What happens after the route has answered `202` is the runner's: [deploying — when something goes
wrong](../deploying.md#when-something-goes-wrong), and [troubleshooting](troubleshooting.md) by symptom.

| Symptom | Cause |
|---|---|
| deliveries answered `204` and no run starts | the event is not a trigger: a push, a reopen, a draft, a comment that does not start with `/review` |
| a `neutral` check run titled **Review refused** | the person who commented `/review` has no push access; nothing was spent |
| the run fails at once: `no model credential: …`, or `2 model credentials are set (…)` | set exactly one model credential in the trigger.dev project, not on Vercel |
| `GitHub refused an installation token for installation …` | the client id and the key belong to different Apps, or the key was deleted on GitHub |

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices** | **measured** with `claude-opus-5`: $0.88–1.06 for a `basic` review of a real production pull request, plus $0.07–0.58 for its check pass; $0.16–0.29 for a one-file pull request, check pass included. Hard ceiling $5.00 per `basic` review ([what it costs](../../README.md#what-it-costs)) |
| The runner | trigger.dev, at **its usage price** | one `small-2x` machine (1 vCPU, 1 GB) for the length of each review; a `--multi` review runs three more child runs. **Not measured** |
| The route | Vercel, at **its price** for your plan | one short Function invocation per delivery. **Not measured** |

## Next steps

- [Using it on pull requests](../pull-requests.md): `/review`, `/dispute`, `/defer` and re-reviews.
- [Choose a tier](choosing-a-tier.md) for the reviews people ask for.
- [Change the runner's settings](../deploying.md#4-optional-change-the-runners-settings): a gate, another check-run
  name, deployment-wide instructions.
- Require the `review-agent` check run in a branch rule, pinned to your App, to make the gate block merges.

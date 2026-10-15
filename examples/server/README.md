# review-agent on your own server

A small, production-shaped Node.js 22 service that reviews every pull request in your repositories **as your own
GitHub App**, on a machine you run — a VPS or a container host — with no trigger.dev. It is the reviewer's webhook
receiver, an in-process queue and the SDK, in one process:

```
            signed webhook            HTTPS
  GitHub ──────────────────▶  Caddy  ──────▶  this server (one Node.js process)
    ▲                                         POST /api/github/webhook
    │                                           verify the signature over the raw bytes
    │                                           decide: a review, or nothing (204)
    │                                           queue it, answer 202 — inside GitHub's 10 seconds
    │                                         worker (one review at a time by default)
    │                                           mint an installation token for the one repository
    │                                           reviewPullRequest(): download, review, check, post
    └──────────────────────────────────────── review, inline comments, summary, check run — as your App
```

It posts exactly what the [App deployment](../../docs/deploying.md) posts, from the same review session: an
automatic review when a pull request opens or leaves draft, a review on `/review` from anyone with push access, the
**Re-run** button on the check run, and the release-only rule (a pull request that changes only lock files, version
files and changelogs gets no automatic review). It is shipped as an example rather than a command (spec 0.2.0 §7,
decision §14.10): copy it, read it, and make it yours.

The step-by-step guide, with HTTPS and troubleshooting: [Run your own server](../../docs/guides/self-hosting.md).

## How it differs from the App deployment

| | [App deployment](../../docs/deploying.md) | This server |
|---|---|---|
| Where reviews run | trigger.dev | this process |
| What faces the internet | a receiver holding only the webhook secret and a trigger-only key | **this process, holding every secret**: the webhook secret, the App's private key and the API key |
| Queue, retries | trigger.dev's: durable, retried | in memory: lost on restart, never retried by itself |
| A request refused for lack of push access | a **Review refused** check run | a log line |
| The hourly sweep, the record callback | yes | no |

The second row is the trade: one process is simpler to run, and it means the process GitHub talks to holds the keys.
Keep it behind HTTPS, keep the App's key in a file only the service user can read, and keep the host patched.

## The files

| File | What it does |
|---|---|
| [`src/server.ts`](src/server.ts) | start-up: reads the configuration, checks Claude Code is there, listens, and winds down on `SIGTERM` |
| [`src/http.ts`](src/http.ts) | two routes — `POST /api/github/webhook` and `GET /healthz` — and the raw request body, capped at GitHub's 25 MB |
| [`src/webhook.ts`](src/webhook.ts) | one delivery: `verifyDelivery`, `decideDelivery`, the idempotency key, the queue, the answer |
| [`src/queue.ts`](src/queue.ts) | the queue: bounded, deduplicated by key, a fixed number of reviews at once |
| [`src/worker.ts`](src/worker.ts) | one review: the installation token, the release-only rule, `reviewPullRequest`, what to log |
| [`src/config.ts`](src/config.ts) | the environment variables below, checked before anything listens |
| [`src/settings.ts`](src/settings.ts) | **this deployment's settings** — tier, check-run name, gate, instructions, skills. Edit it |
| [`src/log.ts`](src/log.ts) | JSON log lines, with every secret it holds and every secret-shaped string kept out |
| [`Dockerfile`](Dockerfile) | Debian, Node.js 22, a non-root user, Claude Code `2.1.258` pinned and its binary checked at build time |

## Environment variables

| Variable | Required | Value |
|---|---|---|
| `REVIEW_AGENT_APP_CLIENT_ID` | yes | the App's **client id** (`Iv23li…`, on its **General** page) — not the numeric App ID. Not a secret |
| `REVIEW_AGENT_APP_PRIVATE_KEY_FILE` | one of these two | the path to the App's `.pem`, **recommended**: a file only the service user can read. The server warns at start-up if others can read it |
| `REVIEW_AGENT_APP_PRIVATE_KEY` | | the `.pem` itself, for a secret store that hands values over as variables. Flattened line breaks are repaired |
| `GITHUB_WEBHOOK_SECRET` | yes | the webhook secret set on the App's settings page |
| `ANTHROPIC_API_KEY` | yes | the **one** model credential: an Anthropic API key, billed at per-token API prices. `CLAUDE_CODE_OAUTH_TOKEN` must not be set — a server that reviews other people's pull requests takes an API key ([spec 0.2.0 §2.3](../../docs/specs/0.2.0-ways-in.md#23-model-credentials)) |
| `ANTHROPIC_BASE_URL` | must be **unset** | the reviewer refuses to run while it is set: the reviewed code goes to Anthropic and nowhere else |
| `REVIEW_AGENT_CONCURRENCY` | no, default `1` | how many reviews run at once. Each is at least one Claude Code process of a few hundred MiB |
| `REVIEW_AGENT_QUEUE_LIMIT` | no, default `20` | how many reviews may **wait**; one more is answered `503` |
| `REVIEW_AGENT_DRAIN_SECONDS` | no, default `0` | after `SIGTERM`, how long a running review may go on before it is cancelled. Give `docker stop` longer than this |
| `REVIEW_AGENT_DATA_DIR` | no | where checkouts and the skill cache go, each `0700`. The image sets `/var/lib/review-agent`; outside it, a per-user directory under the OS temp directory |
| `PORT` | no, default `8080` | the port to listen on |
| `REVIEW_AGENT_CLAUDE_BIN` | set by the image | the absolute path to Claude Code |

Nothing is logged with a value in it: the server keeps its own secrets, and anything shaped like a GitHub token, an
Anthropic key or a private key, out of every log line.

## Use it

1. **Copy this folder** out of the repository, and in `package.json` replace each `workspace:*` with the version you
   are deploying — all four the same, for example `"@review-agent/sdk": "0.2.0"`. Then, once:

   ```sh
   npx --yes npm@11 install   # writes package-lock.json, which the image installs exactly
   npm test                   # the unit tests: no network, no model, nothing spent
   ```

   npm 11 or newer, because the npm that ships with Node.js 22 (10.9) cannot resolve this example's test runner,
   vitest 4.1: it stops with `Cannot read properties of null (reading 'edgesOut')` (seen 2026-10-15). On Node.js 24,
   plain `npm install` is npm 11. The image's own `npm ci` installs from the lockfile and is not affected.

   In this repository the ranges stay `workspace:*`, so CI builds, type-checks and tests the example against the
   packages in the same commit.

2. **Register the App**, pointing its webhook at the address the server will have:

   ```sh
   npx @review-agent/cli init --name "Acme Reviewer" --url https://example.com \
     --webhook-url https://reviewer.example.com/api/github/webhook --org acme
   ```

   Then, on the App's settings page: generate a private key, delete the registration-time key and client secret, set
   a webhook secret, and note the client id — [after registering](../../docs/github-app.md#after-registering).

3. **Build and run the image** behind HTTPS, with the key in a file only the service user (uid `10001`) can read:

   ```sh
   docker build --tag review-agent-server .
   docker run --detach --name review-agent --restart unless-stopped \
     --publish 127.0.0.1:8080:8080 \
     --env-file /etc/review-agent/env \
     --env REVIEW_AGENT_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem \
     --volume /etc/review-agent/app.pem:/run/secrets/app.pem:ro \
     --stop-timeout 30 \
     review-agent-server
   ```

   `/etc/review-agent/env` holds the client id, the webhook secret and the API key, one `NAME=value` per line, mode
   `0600`. Put [Caddy](https://caddyserver.com) or another HTTPS proxy in front of `127.0.0.1:8080`. Every step, with
   the commands to create those files: [the guide](../../docs/guides/self-hosting.md).

4. **Install the App** on one repository and open a pull request. `docker logs --follow review-agent` shows the
   delivery arrive, the review queued, each stage, and the result.

The image runs as user `review-agent` (uid `10001`), starts Node.js under `tini`, reports health on `/healthz`, and
fails its own build if Claude Code's binary is npm's ~500-byte placeholder rather than the real one, or does not
answer `--version`.

## Limits

- **One process, one machine.** Reviews run at most `REVIEW_AGENT_CONCURRENCY` at a time; nothing spreads them
  across machines. Memory sets the ceiling: one review measured roughly 300–400 MiB at its peak on the App's runner
  (spec 0.2.0 §9.2), and a `--multi` review runs its three focused reviewers one after another here.
- **The queue lives in memory.** A restart drops what was waiting — each dropped review is named in the log — and
  GitHub does not send a delivery again by itself once it was answered `202`: redeliver it from the App's
  **Advanced → Recent Deliveries**, or comment `/review`. What was remembered to stop a redelivery being reviewed
  twice is lost too.
- **No retries.** A review that failed before anything was spent is forgotten, so a redelivery runs it; nothing runs
  it again by itself. A review that failed after the model was paid is remembered for 24 hours and not repeated.
- **A killed process can leave a check run `in_progress`** — `SIGKILL`, or the kernel's out-of-memory killer, runs no
  clean-up. A required check then blocks the merge until a later review of the same commit closes it, which happens
  once it is an hour old; there is no hourly sweep here. `docker stop` is not a kill: the running review is cancelled
  and its check run concluded.
- **Not posted, only logged:** a request refused for lack of push access, and the flags a `/review` comment asked for
  that this deployment does not allow (the App puts both on the pull request).
- **Re-run repeats with this deployment's settings.** The App carries a request's tier and flags on its check run, so
  its **Re-run** repeats them; the SDK's check run carries none, so here a Re-run of a `/review --tier normal` review
  runs at the default tier.
- **The record is not kept.** Each review's cost and findings count are logged; nothing is stored or sent anywhere.
- **github.com only.** The installation token is minted at `api.github.com`.

## Costs

Model spend at **per-token API prices**, billed to the API key: measured with `claude-opus-5`, $0.88–1.06 for a `basic`
review of a real production pull request and $0.16–0.29 for a one-file one, check pass included in the latter
([what it costs](../../README.md#what-it-costs)). Each review's figure is in its `review finished` log line, as
`costUsd`. The machine is your hosting provider's price.

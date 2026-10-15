# Run your own server (VPS / Docker)

At the end of this guide, every pull request that opens in the repositories you choose is reviewed by **your own
GitHub App**, from a server you run: one Docker container behind HTTPS, with no trigger.dev and no other service in
between (use case UC-7 in [the 0.2.0 spec](../specs/0.2.0-ways-in.md#1-use-cases)). It reviews when a pull request
opens or leaves draft, when someone with push access comments `/review`, and when the check run's **Re-run** button is
pressed, and posts as the App: a review with inline comments, a summary comment and a check run named `review-agent`.

*Not captured yet: it needs a GitHub App registered with `review-agent init` and this example's server running where
GitHub can reach it; the 0.2.0 captures (2026-10-15) include no such run.*

The server is [`examples/server`](../../examples/server/README.md): the webhook receiver, an in-process queue and the
SDK in one Node.js process. Read [how it differs from the App deployment](../../examples/server/README.md#how-it-differs-from-the-app-deployment)
and [its limits](../../examples/server/README.md#limits) before you rely on it — above all, the process GitHub talks to
holds every secret, and its queue lives in memory.

**Where commands run.** Step 1 runs on your own machine, so it is given for a POSIX shell and for PowerShell. Every
other step runs on the server, in its Linux shell.

## What you need

- [ ] **A Linux server** — Debian or Ubuntu, x64 or arm64 — with SSH access, a public address, and ports 80 and 443
      open (Caddy needs both to obtain and serve the HTTPS certificate). Memory: the App's own runner reviews in
      1 GB, and one review measured roughly 300–400 MiB at its peak
      ([spec 0.2.0 §9.2](../specs/0.2.0-ways-in.md#92-per-environment)). Allow about 400 MiB more for each further
      review you let run at once — an estimate from that one measurement, not itself measured.
- [ ] **[Docker Engine](https://docs.docker.com/engine/install/)** and **[Caddy](https://caddyserver.com/docs/install)**
      installed on it, following their own instructions for your distribution.
- [ ] **A host name** for it, such as `reviewer.example.com`, whose DNS record points at the server.
- [ ] **A GitHub organisation or account** to own the App, and admin rights on the repositories to review.
- [ ] **An Anthropic API key.** The server takes an API key only: it reviews other people's pull requests, and a
      subscription token is for its owner's own use ([spec 0.2.0 §2.3](../specs/0.2.0-ways-in.md#23-model-credentials)).
- [ ] **On your own machine:** Node.js 22 or newer and a browser, to register the App.

## 1. Register the App (on your machine)

Register a GitHub App whose webhook points at the address the server will have. The page this opens shows the
permissions and events the App asks for: [the GitHub App](../github-app.md#permissions-and-events).

```sh
npx @review-agent/cli@0.2.1 init --name "Acme Reviewer" --url https://example.com \
  --webhook-url https://reviewer.example.com/api/github/webhook --org acme
```

```powershell
npx @review-agent/cli@0.2.1 init --name "Acme Reviewer" --url https://example.com `
  --webhook-url https://reviewer.example.com/api/github/webhook --org acme
```

Open the `http://127.0.0.1:<port>` address it prints, press the button, and confirm on GitHub. Leave out `--org` to
register the App under your own account.

*Not captured yet, for the same reason: the 0.2.0 captures include no App served from this example.*

Then, on the App's settings page (**General**) — each step is in [after registering](../github-app.md#after-registering):

1. **Generate a private key.** GitHub downloads a `.pem` file: it goes to the server in step 3, and nowhere else.
2. **Delete the private key and the client secret** GitHub created with the registration.
3. **Set a webhook secret** — a long random value, for example from `openssl rand -hex 32`. Keep it for step 3.
4. **Note the client id** (`Iv23li…`). It is not a secret.

Do not install the App yet.

**If you see this instead**

| Symptom | Fix |
|---|---|
| `init` exits `1` after an hour | the registration was not confirmed in time; run it again |
| GitHub says the name is taken | App names are unique across GitHub; choose another `--name` |

## 2. Build the image (on the server)

Fetch the example at the version you are deploying, and make it yours. In the repository its dependencies are
`workspace:*`, which only the repository understands: replace each with that same version.

```sh
git clone --depth 1 --branch v0.2.0 https://github.com/crissmoldovan/review-agent.git /tmp/review-agent
cp -r /tmp/review-agent/examples/server ~/review-agent-server
cd ~/review-agent-server
sed -i 's/"workspace:\*"/"0.2.0"/' package.json
```

Write the lockfile the image installs from. This runs in the same Node.js image the build uses, so the server needs
no Node.js of its own. It asks for npm 11 because the npm that image ships (10.9) cannot resolve the example's test
runner, vitest 4.1 — it stops with `Cannot read properties of null (reading 'edgesOut')` (seen 2026-10-15); the
image's own `npm ci` installs from the lockfile and is not affected:

```sh
docker run --rm --volume "$PWD":/app --workdir /app node:22-bookworm-slim \
  npx --yes npm@11 install --package-lock-only --no-audit --no-fund
docker build --tag review-agent-server .
```

The build fails — on purpose — if Claude Code's binary is npm's ~500-byte placeholder rather than the real one, or
if it does not answer `--version` as the user the server runs as. A good build's last step prints the version, as in
this line from a test build of the image (2026-10-15, arm64):

```text
#24 0.198 2.1.258 (Claude Code)
```

**If you see this instead**

| Symptom | Fix |
|---|---|
| `npm error … No matching version found for @review-agent/…` | that version is not on npm; check the version you put in `package.json` |
| `COPY failed: … package-lock.json: not found` | the lockfile step above did not run, or ran in another directory |
| the `test "$(wc -c < …claude.exe)" -gt 1048576` step fails | Claude Code's install script could not place the native binary for this machine: check the server is x64 or arm64, and that the build can reach the npm registry |

## 3. Put the secrets in place (on the server)

The App's key goes in a file that only the container's user — uid `10001` — can read
([spec 0.2.0 §7](../specs/0.2.0-ways-in.md#7-running-it-yourself--the-vps--container-recipe-uc-7)). Copy the `.pem`
from step 1 to the server (with `scp`, for example), then:

```sh
sudo install --directory --mode 0755 /etc/review-agent
sudo install --mode 0400 --owner 10001 --group 10001 ./<app-slug>.<date>.private-key.pem /etc/review-agent/app.pem
rm ./<app-slug>.<date>.private-key.pem
```

The other three values go in an environment file only root can read. Create it empty, then edit it, so no value is
ever typed on a command line or kept in your shell's history:

```sh
sudo install --mode 0600 /dev/null /etc/review-agent/env
sudoedit /etc/review-agent/env
```

```ini
REVIEW_AGENT_APP_CLIENT_ID=Iv23li…
GITHUB_WEBHOOK_SECRET=<the webhook secret from step 1>
ANTHROPIC_API_KEY=<your Anthropic API key>
```

One `NAME=value` per line, with no quotes: Docker passes the text after `=` as it is. Every variable the server reads
is in [its README](../../examples/server/README.md#environment-variables). Anyone who can run `docker` on this server
can read these values with `docker inspect` — membership of the `docker` group is as good as root, so keep it to the
people who already have that.

## 4. Start it (on the server)

```sh
docker run --detach --name review-agent --restart unless-stopped \
  --publish 127.0.0.1:8080:8080 \
  --env-file /etc/review-agent/env \
  --env REVIEW_AGENT_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem \
  --volume /etc/review-agent/app.pem:/run/secrets/app.pem:ro \
  --stop-timeout 30 \
  review-agent-server
```

- `--publish 127.0.0.1:8080:8080` makes it reachable from this server only: the internet reaches it through Caddy.
- `--stop-timeout 30` gives a running review time to be cancelled cleanly on `docker stop` — its Claude Code process
  stopped, its checkout removed, its check run concluded rather than left `in_progress`.

Check it started, and is healthy:

```sh
docker logs review-agent
curl -fsS http://127.0.0.1:8080/healthz
```

The log's first line names the port, the Claude Code it found and its data directory. These are the lines from a test
run of the image (2026-10-15, with test values):

```text
{"time":"2026-10-15T03:23:47.412Z","level":"info","msg":"listening","port":8080,"webhook":"/api/github/webhook","health":"/healthz","concurrency":1,"queueLimit":20,"claudeBin":"/opt/claude-code/node_modules/.bin/claude","dataDir":"/var/lib/review-agent"}
```

```text
{"status":"ok","waiting":0,"running":0,"remembered":0}
```

**If you see this instead**

| Symptom | Fix |
|---|---|
| the container stops at once; the log says `cannot start: the configuration is incomplete` | the same line's `error.message` names the variable to fix — a missing value, two model credentials, a key that is not a PEM, `ANTHROPIC_BASE_URL` set |
| `REVIEW_AGENT_APP_PRIVATE_KEY_FILE names a file this process cannot read (EACCES)` | the key file is not owned by uid `10001`: repeat the `install --owner 10001` line in step 3 |
| a warning that the key file can be read by others | `sudo chmod 0400 /etc/review-agent/app.pem` |
| `CLAUDE_CODE_OAUTH_TOKEN is set` | this server takes an API key only; remove that line from the environment file |
| `cannot start: Claude Code was not found` | the image was not built from this Dockerfile, or `REVIEW_AGENT_CLAUDE_BIN` was overridden; build again (step 2) |

## 5. Put HTTPS in front (on the server)

GitHub delivers webhooks over HTTPS. Caddy obtains and renews the certificate for your host name by itself. Let it
pass on the webhook path and nothing else — `/healthz` stays reachable from the server only. In `/etc/caddy/Caddyfile`:

```caddyfile
reviewer.example.com {
	handle /api/github/webhook {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		respond 404
	}
}
```

```sh
sudo systemctl reload caddy
```

From your own machine, an unsigned request should be refused by the server itself — proof the path reaches it:

```sh
curl -i -X POST https://reviewer.example.com/api/github/webhook
```

```powershell
curl.exe -i -X POST https://reviewer.example.com/api/github/webhook
```

The answer is `401` with the body `bad signature`, and the server logs `delivery refused: bad signature` with why —
here `missing-header`.

**If you see this instead**

| Symptom | Fix |
|---|---|
| a certificate error, or no answer | the DNS record does not point at this server yet, or ports 80 and 443 are closed; Caddy's log (`journalctl -u caddy`) says which |
| `502 Bad Gateway` | the container is not running, or not published on `127.0.0.1:8080`: `docker ps`, and step 4 |
| `404` | the path is not exactly `/api/github/webhook` in the App's settings or in the Caddyfile |

## 6. Connect the webhook

On the App's settings page, check that **Webhook URL** is `https://reviewer.example.com/api/github/webhook`, **Active**
is ticked, and **Webhook secret** is the value in `/etc/review-agent/env`. Under **Advanced → Recent Deliveries**,
open the `ping` GitHub sent when the App was registered — it failed then, with no server to receive it — and press
**Redeliver**. (If the list is empty, come back after installing the App in step 7, and redeliver the `installation`
delivery instead: it is answered the same way.) The server answers `204`, and logs:

```text
{"time":"…","level":"info","msg":"delivery ignored","deliveryId":"…","event":"ping","why":"ping is not an event this App acts on"}
```

**If you see this instead**

| Symptom | Fix |
|---|---|
| `401` | the App's webhook secret and `GITHUB_WEBHOOK_SECRET` differ. Set them to the same value, then `docker restart review-agent` |
| a timeout, or `502` | step 5 |

## 7. Install the App and try it

1. Install the App on **one** repository: the App's page → **Install App** → **Only select repositories**. Tell the
   people who work there first, so nobody meets a bot on their own pull request unannounced.
2. Open a small pull request there, or comment `/review` on an open one.
3. Follow the server's log. A delivery is queued, each stage of the review is logged, and the last line says what was
   found, what it cost and where it was posted:

   ```sh
   docker logs --follow review-agent
   ```

*Not captured yet, for the same reason: the 0.2.0 captures include no App served from this example.*

*Not captured yet, for the same reason: the 0.2.0 captures include no App served from this example.*

Then install it on more repositories.

## When something goes wrong

The server logs one JSON object per line, and every line about a review carries its `key`, `repo`, `pr` and the
`deliveryId` you can find under the App's **Recent Deliveries**.

| Symptom | Cause, and the fix |
|---|---|
| Deliveries answered `204`, no review | the event is not a trigger: a push, a reopen, a draft, a comment that does not start with `/review`. The `delivery ignored` line's `why` says which |
| `202`, then `review failed before it started: GitHub did not answer` | the installation token could not be minted, or the pull request's files could not be listed; the line's `error.message` says which. `GitHub refused an installation token … HTTP 401` — the client id and the key do not belong to the same App, or the key was deleted on GitHub; another status — GitHub's own message follows it, most often because the App is not installed on that repository; `fetch failed` — the server cannot reach `api.github.com`. Nothing was spent, so redelivering it from **Recent Deliveries** runs it |
| `review refused` | the person who commented `/review` has no push access; nothing was spent. The App deployment posts this as a check run; this server only logs it |
| `review skipped: every changed file is a release file` | by design: lock files, version files and changelogs only. Comment `/review` to review it anyway |
| `review did not finish` or `review failed`, with `reason` | the review produced nothing usable, or failed: `reason` says why and `spentUsd` what it cost — and for a failure, `stage` how far it got. Its check run concludes `neutral`, which blocks nothing. Comment `/review` to try again |
| `503` on a delivery: `the review queue is full` | more reviews were asked for than `REVIEW_AGENT_QUEUE_LIMIT` can hold. Redeliver it from **Recent Deliveries** once the queue has drained, or raise the limit or `REVIEW_AGENT_CONCURRENCY` |
| `a queued review was dropped by the shutdown; redeliver it` | the server was stopped or restarted with reviews waiting. Redeliver each from **Recent Deliveries** (match the `deliveryId`), or comment `/review` |
| A check run stuck **in progress** | the container was killed — out of memory, or `docker kill` — before it could conclude the run. The next review of the same commit closes it once it is an hour old. `docker inspect review-agent --format '{{.State.OOMKilled}}'` says whether memory was the cause; lower `REVIEW_AGENT_CONCURRENCY` or give the server more |
| `docker ps` shows the container `unhealthy` | `/healthz` is not answering: `docker logs review-agent` for why |

## Upgrading

1. On the server, fetch the new version of the example (step 2, with the new tag), compare it with your copy — keep
   your changes to `src/settings.ts` — and set the new version in `package.json`.
2. Write the lockfile and build the image again (step 2).
3. Replace the container: `docker stop review-agent && docker rm review-agent`, then step 4.

Reviews waiting in the queue are dropped by the stop and named in the log; a running one is cancelled. Read the
[changelog](../../CHANGELOG.md) first.

## What it costs

| What | Who charges | How much |
|---|---|---|
| The model | Anthropic, to the API key — **per-token API prices** | **measured** with `claude-opus-5`: $0.88–1.06 for a `basic` review of a real production pull request; $0.16–0.29 for a one-file pull request, check pass included. Hard ceiling $5.00 per `basic` review ([what it costs](../../README.md#what-it-costs)). Each review's figure is in its `review finished` log line, as `costUsd`, and in its summary comment |
| The server | your hosting provider, at **its price** | one machine, as sized above |

## Next steps

- Change the settings — tier, check-run name, [the gate](../configuration.md#the-gate), deployment-wide instructions,
  skills — in `src/settings.ts`, then build and restart. Every setting: [configuration](../configuration.md).
- Require the `review-agent` check run in a branch rule, pinned to your App, to make the gate block merges.
- [Use it on pull requests](../pull-requests.md): `/review`, `/dispute`, `/defer` and re-reviews.
- To keep the receiver free of keys, with durable retries and the hourly sweep: [deploy the App with
  trigger.dev](../deploying.md).

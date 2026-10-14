# The GitHub App

An [App deployment](deploying.md) reviews pull requests as **your own GitHub App**. Each deployment registers its
own: the reviewer is open source, but the App, its keys and its installations belong to whoever runs it.

## Permissions and events

| Repository permission | Access | Why |
|---|---|---|
| Checks | **Read & write** | the check run, its conclusion and its **Re-run** button |
| Pull requests | **Read & write** | read the pull request; post the review, inline comments and edits to them |
| Contents | **Read** | download the repository at the pull request's head commit, and read `.review-agent/review.md` |
| Metadata | **Read** | required by GitHub for every App |
| Issues | **Read** | GitHub delivers pull request conversation comments as issue comments; without it a `/review` comment never arrives |

| Event | Why |
|---|---|
| `pull_request` | automatic reviews on open and on ready-for-review |
| `issue_comment` | `/review` comments |
| `check_run` | the **Re-run** button |

**Never grant Contents: write.** The reviewer reads the code it reviews; it has no business changing it, and the
permission is what enforces that — not the prompt.

A deployment that wants to record replies to findings **as they are written** may also subscribe to
`pull_request_review_comment` and handle it in its own receiver; the reviewer itself reads replies at the next
re-review and does not need it.

## Registering it with `review-agent init`

The easy way is the manifest flow, which sets the permissions and events above for you:

```sh
npx @review-agent/cli init \
  --name "Acme Reviewer" \
  --url https://acme.example \
  --webhook-url https://reviewer.acme.example/api/github/webhook \
  --org acme
```

- `--org` registers it under an organisation. Leave it out to register under your own account.
- `--webhook-url` is your [receiver](deploying.md#3-write-the-receiver). If it does not exist yet, use the URL it
  will have; GitHub will retry failed deliveries for a while, and you can redeliver them from the App's settings.
- `--webhook-inactive` registers an App that receives no deliveries, for driving the runner in process.

Open the printed `http://127.0.0.1:<port>` address, press the button, confirm on GitHub, and you are sent back.
The command prints the App id, slug and **client id**. It saves nothing and prints no secret. Full details are in
[the CLI reference](cli.md#review-agent-init).

The App is registered **private**, so it can be installed only on the account that owns it — the organisation you
passed to `--org`, or your own account.

## Registering it by hand

You can also create the App in GitHub's settings (**Settings → Developer settings → GitHub Apps → New GitHub App**,
or the organisation's equivalent):

- **Webhook**: active, with your receiver's URL and a secret you generate (see below).
- **Permissions** and **events**: exactly the tables above.
- **Where can this GitHub App be installed?**: only on this account.

## After registering

Do these on the App's settings page (**General**):

1. **Generate a private key** (**Private keys → Generate a private key**). GitHub downloads a `.pem` file. It goes
   into the runner's `REVIEW_AGENT_APP_PRIVATE_KEY` and nowhere else.
2. **Delete the private key and the client secret** that GitHub created during a manifest registration, so no unused
   credential is left on the App. (`init` discarded them; they still exist on GitHub until you delete them.)
3. **Set a webhook secret**: generate a long random value, for example `openssl rand -hex 32`, and enter it under
   **Webhook secret**. Give the same value to your receiver.
4. **Note the client id** (`Iv23li…`, under **About**). It goes into the runner's `REVIEW_AGENT_APP_CLIENT_ID`. It is
   the client id, **not** the numeric App ID, and it is not a secret.
5. **Install the App** (**Install App**) on the repositories it should review. Choose **Only select repositories**
   to start with one.

Tell the people who work in those repositories before you install it, so nobody meets a bot on their own pull
request unannounced.

## The installation id

The optional [hourly sweep](deploying.md#the-hourly-sweep) needs the **installation id**. After installing, open the
installation's settings: the number at the end of the URL is the id.

```
https://github.com/organizations/acme/settings/installations/12345678
                                                             ^^^^^^^^
```

## How the runner authenticates

For each review, the runner signs a JWT with the private key (issuer: the client id, valid for a few minutes),
exchanges it for an **installation token scoped to the one repository being reviewed**, and uses that for
every GitHub call of the review. The token never reaches the model's process. The receiver holds no App credential
at all: it only checks webhook signatures. See [security](security.md).

The private key may be pasted with its line breaks flattened, or with literal `\n` sequences, as many secret stores
do; the runner restores them.

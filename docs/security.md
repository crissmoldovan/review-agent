# Security model

The code under review is written by whoever opened the pull request. The reviewer treats it as **data, never as
instructions**, and is built so that the controls are things the model cannot argue with: tokens, permissions,
process boundaries and fixed argument lists — not the prompt.

## Where the code goes

The reviewed code goes to **your runner and to Anthropic, and nowhere else**.

- The model credential must be an **Anthropic API key** or a **Claude subscription token**. Those are the only two
  kinds.
- If `ANTHROPIC_BASE_URL` is set, every review is **refused**: a gateway would send the code somewhere the deployment
  could not see. `ANTHROPIC_AUTH_TOKEN` is never passed to the model's process.
- The runner refuses to start with **no** credential or with **both**, so it is always clear which account paid.
- The product stores nothing and phones home to nothing. The only outbound call it makes beyond GitHub and Anthropic
  is the [record callback](deploying.md#the-review-record-callback), to a URL the deployment sets, signed with a secret
  the deployment holds.

## What the model can do

| Control | What it prevents |
|---|---|
| tools limited to **Read, Grep, Glob** | no shell, no writing files, no network |
| `--restricted` and `--strict-mcp-config` | the reviewed repository's `.claude/settings.json` (which can define hooks — commands) and any MCP servers are not loaded |
| an environment of `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and the model credential only | the model cannot read the GitHub token, the App key or anything else from its own environment |
| the prompt on standard input; nothing the model wrote is put into a command line or a URL | no injection through arguments |
| Claude Code is started by an **absolute path**, found only in absolute `PATH` directories and never inside the checkout; a relative `REVIEW_AGENT_CLAUDE_BIN` or one inside the checkout is refused | a pull request cannot plant its own `claude` (or `claude.exe`) and have it run with the model credential — Windows otherwise looks in the working directory first |
| every finding's path checked against the checkout | a model-written string never addresses anything unchecked |
| a hard spending ceiling per pass (`--max-budget-usd`) | a runaway review stops |

## What the reviewed repository can do

| It can | It cannot |
|---|---|
| add review guidance in `.review-agent/review.md` | change the safety rules, which come from this product and are applied first |
| make the review quieter, or raise its inline threshold | make it louder, change the model or the budget, or touch the gate |
| choose among the skills the deployment allows | add a skill: skills come from the deployment only, read-only, and one planted in the repository is not loaded |

`.review-agent/review.md` is read from the pull request's **base** branch, so a pull request cannot rewrite the rules
it is judged by.

## The checkout

- Downloaded as an **archive**, never cloned: there is no `.git`, no remote URL and no token in it. An archive that
  contains a `.git` directory is refused.
- **Credential-shaped files are deleted before the model starts** — `.env` and `.env.*` (but not `.env.example` and
  the like), `.npmrc`, `.netrc`, `.git-credentials`, `.pypirc`, `.yarnrc`, `.pgpass`, `.htpasswd`, `id_rsa` and other
  SSH keys, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `.docker/config.json`, `.aws/credentials`,
  `.kube/config` — and listed on the record.
- Each review gets a fresh directory.

## What is posted

- Everything the model wrote is **scanned for secrets** before it is posted or sent: GitHub tokens, Anthropic keys,
  npm tokens, AWS access keys, Slack tokens and private-key headers. A match **withholds** the whole review rather
  than redacting it; only the kind and location of the match are reported.
- The reviewer posts **comments** and a **check run**. It never approves, never requests changes, never pushes.

## GitHub permissions

- The App asks for **Checks: write, Pull requests: write, Contents: read, Metadata: read, Issues: read** — never
  Contents: write. See [the GitHub App](github-app.md#permissions-and-events).
- For each review the runner mints an **installation token scoped to the one repository** under review.
- The App's private key lives **only in the runner**. The internet-facing receiver holds the webhook secret and a
  trigger-only key, so the worst a compromised receiver can do is start reviews.
- Webhooks are verified with **HMAC-SHA256 over the raw request bytes**, compared in constant time; the legacy SHA-1
  signature and duplicated signature headers are refused, and an empty secret is never treated as "no check".
- `review-agent init` **discards** the private key, client secret and webhook secret GitHub returns at registration,
  and tells you to delete them on GitHub; you generate your own.

## Who can spend money

- A requested review — a `/review` comment or the **Re-run** button — first checks that the requester has **push
  access** to the repository. Without it, nothing runs and nothing is spent, and the refusal is a visible `neutral`
  check run rather than a comment, so nobody can make the bot write on a pull request by commenting.
- A request may lower the budget, never raise it, and cannot pick the multi-reviewer tier.
- The reviewer ignores comments from bots and comments carrying its own marker, so it cannot trigger itself.

## Reporting a vulnerability

Please report security issues privately, through GitHub's **Report a vulnerability** on this repository's
**Security** tab, rather than in a public issue.

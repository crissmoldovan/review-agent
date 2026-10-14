# Security policy

## Reporting a vulnerability

Please report it **privately**, through GitHub's
[Report a vulnerability](https://github.com/crissmoldovan/review-agent/security/advisories/new) form on this
repository's **Security** tab — not in a public issue or pull request.

Include what an attacker controls (for example: the contents of a pull request under review, a webhook delivery,
a repository's `.review-agent/review.md`), what they gain, and the version you tested. You will get a reply on the
report.

## Supported versions

Fixes go into the latest release only. All four packages — `@review-agent/core`, `@review-agent/github`,
`@review-agent/app` and `@review-agent/cli` — are released together at one version; use the latest.

## What is in scope

The reviewer reads code written by whoever opened the pull request, so the most important class of problem is
anything that lets **the code under review** do more than be read:

- run a program, a hook, a plugin or a skill;
- read the model credential, a GitHub token, the App's private key or any other secret;
- send the reviewed code, or anything else, anywhere other than Anthropic and GitHub;
- make the reviewer post or edit something it should not, or spend money without someone with push access asking;
- slip a secret into what the reviewer posts.

Also in scope: the webhook receiver library's signature checking, the record callback's signing, and the App's
permissions. The design rules these protect are in [docs/security.md](docs/security.md).

## Published advisories

- [GHSA-m34m-4c65-cqf6](https://github.com/crissmoldovan/review-agent/security/advisories/GHSA-m34m-4c65-cqf6) —
  Windows: a reviewed pull request could supply its own `claude.exe` and receive the model credential. Fixed in
  0.1.2.

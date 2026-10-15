# @review-agent/cli

The `review-agent` command: review a GitHub pull request with an AI reviewer that only reads, and print what it
found — or, with `--post`, post it to the pull request as whoever the GitHub token belongs to.

```sh
npm install --global @review-agent/cli

export GITHUB_TOKEN=…            # or GH_TOKEN, or a logged-in `gh`
export ANTHROPIC_API_KEY=…       # or CLAUDE_CODE_OAUTH_TOKEN, or neither if `claude` is logged in

review-agent doctor              # is this machine ready?
review-agent review --repo owner/name --pr 123           # prints the review
review-agent review --repo owner/name --pr 123 --post    # posts it, after asking
```

Needs Node.js 22+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed as `claude`.

`review-agent init` registers a GitHub App for running the reviewer on every pull request.

- [The CLI reference](https://github.com/crissmoldovan/review-agent/blob/main/docs/cli.md) — every flag, exit code and environment variable
- [The project](https://github.com/crissmoldovan/review-agent) — what it is, the GitHub App mode, configuration and security

Apache-2.0.

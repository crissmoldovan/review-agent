# @review-agent/cli

The `review-agent` command: review a GitHub pull request with an AI reviewer that only reads, and print what it
found. It never posts to GitHub.

```sh
npm install --global @review-agent/cli

export GITHUB_TOKEN=…            # Contents: Read and Pull requests: Read on the repository
export ANTHROPIC_API_KEY=…       # or CLAUDE_CODE_OAUTH_TOKEN, or neither if `claude` is logged in

review-agent review --repo owner/name --pr 123
```

Needs Node.js 22+ and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed as `claude`.

`review-agent init` registers a GitHub App for running the reviewer on every pull request.

- [The CLI reference](https://github.com/crissmoldovan/review-agent/blob/main/docs/cli.md) — every flag, exit code and environment variable
- [The project](https://github.com/crissmoldovan/review-agent) — what it is, the GitHub App mode, configuration and security

Apache-2.0.

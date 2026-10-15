# @review-agent/sdk

Embed [review-agent](https://github.com/crissmoldovan/review-agent), an AI pull-request reviewer you run inside your
own environment, in your own Node.js service or script: one call reviews a pull request and returns what it found —
the same review the GitHub App and the CLI run.

```ts
import { reviewPullRequest } from '@review-agent/sdk'

const result = await reviewPullRequest({
  repo: 'acme/widgets',
  pr: 128,
  github: { token: process.env.GITHUB_TOKEN! },
  credential: { apiKey: process.env.ANTHROPIC_API_KEY! },
})
if (result.kind === 'reviewed') console.log(result.findings)
```

Posts nothing unless asked (`post: true`). Needs Node.js 22+ and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed. It starts no server and stores nothing.

- [The SDK guide](https://github.com/crissmoldovan/review-agent/blob/main/docs/sdk.md) — every option, every result,
  credentials, and examples
- [The library reference](https://github.com/crissmoldovan/review-agent/blob/main/docs/library.md) — every export

Apache-2.0.

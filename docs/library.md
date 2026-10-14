# Library reference

The reviewer is published as four npm packages, all under Apache-2.0, all requiring Node.js 22 or newer, all
released together at the same version.

| Package | What it is | Depends on |
|---|---|---|
| [`@review-agent/core`](#review-agentcore) | the engine: settings, prompts, running Claude Code, findings, the check and re-check passes, the record, the secret scan | nothing GitHub-specific |
| [`@review-agent/github`](#review-agentgithub) | GitHub: read a pull request, download the code, decide what to post, post it, keep the re-review marker | `core` |
| [`@review-agent/app`](#review-agentapp) | the GitHub App: manifest, credentials, and the [receiver](#the-receiver) (`@review-agent/app/receiver`) | `core`, `github` |
| `@review-agent/cli` | the `review-agent` command — see [the CLI](cli.md) | all three |

Each package ships compiled JavaScript with type declarations (`dist/`), and no source maps. The packages pin each
other exactly: `@review-agent/github@0.1.3` requires `@review-agent/core@0.1.3`.

The trigger.dev tasks are **not** in the published packages; they are deployed from this repository
([deploying](deploying.md#5-deploy-the-runner)).

## The receiver

```ts
import {
  verifyDelivery, verifySignature, decideDelivery, dispatchReview, sdkTriggerPort,
} from '@review-agent/app/receiver'
```

This entry point is safe to import in an internet-facing process: a test fails the build if anything it imports can
reach the App's private-key code.

### `verifyDelivery({ rawBody, headers, secret }) → VerifyResult`

Checks GitHub's `x-hub-signature-256` over the raw body. `headers` is a fetch `Headers` or a Node header object.
Returns `{ ok: true }` or `{ ok: false, why }`, where `why` is one of `empty-secret`, `missing-header`,
`duplicate-header`, `malformed-header`, `legacy-sha1-refused`, `mismatch`. Log `why`; don't send it back.

### `verifySignature({ rawBody, signature, secret }) → VerifyResult`

The same check when you already have the header's value — and the check for the
[record callback](deploying.md#the-review-record-callback)'s `x-review-agent-signature-256`. `rawBody` must be a
`Uint8Array`; anything else throws, because a parsed-and-re-serialised body is not what was signed.
`SIGNATURE_HEADER` and `LEGACY_SIGNATURE_HEADER` name the two GitHub headers.

### `decideDelivery({ delivery: { event, payload }, deployment }) → Decision`

Pure, no network. `event` is the `x-github-event` header; `payload` the parsed body; `deployment` a
`DeploymentConfig`, of which only `command` and `autoReview` are read. Returns:

- `{ kind: 'review', request, installationId, refused? }` — `refused` lists, in words, what a comment asked for and
  was not given;
- `{ kind: 'ignore', why }` — a short reason, for your log.

The rules are in [using it on pull requests](pull-requests.md#when-it-reviews). Helpers it uses are exported too:
`parseCommandFlags`, `refuseUnbuilt`, `encodeRequestRefinement` / `decodeRequestRefinement` (the settings a
check run's Re-run button carries), `isReleaseOnly`, `isAutomatic`, `skipAsReleaseOnly`, `HEAD_SHA_UNRESOLVED`,
`THOROUGH_REFUSED`, `MULTI_REFUSED`.

### `dispatchReview({ request, installationId, refused?, trigger }) → { runId, idempotencyKey }`

Builds the task payload (only the fields a review needs, at most 128 KiB), its idempotency key and its tags, and
calls `trigger`. It throws if the trigger fails — answer GitHub with a 5xx so the delivery can be redelivered.

- **Idempotency key**: `auto:<owner/name>#<pr>@<sha>` for an automatic review, `req:<owner/name>#<pr>:<requestId>`
  for a request. `idempotencyKeyFor(request)` computes it.
- **Tags**: `repo:<owner/name>`, `pr:<owner/name>#<n>`, `sha:<12 chars>`, and `trigger:auto` or `trigger:requested`.
  `tagsFor(request)` computes them.
- **Task id**: `REVIEW_TASK_ID`, `'review-agent-review'`.

### `TriggerPort` and `sdkTriggerPort`

```ts
type TriggerPort = (a: {
  taskId: string; payload: ReviewTaskPayload; idempotencyKey: string; tags: string[]
}) => Promise<{ id: string }>
```

`sdkTriggerPort` triggers through `@trigger.dev/sdk`, which reads `TRIGGER_SECRET_KEY` from the environment. To use a
different client — another trigger.dev project, a key from a secret store, extra options such as a TTL — write your
own `TriggerPort`; it is one function.

`ReviewTaskPayload` is `{ request, installationId, refused?, retry? }`. `retry` is set only by the runner.

## `@review-agent/app`

The package root adds the App's identity and registration, which **must not** be imported by the receiver:

| Export | What it does |
|---|---|
| `appIdentityFromEnv(env)` | reads `REVIEW_AGENT_APP_CLIENT_ID` and `REVIEW_AGENT_APP_PRIVATE_KEY`; throws naming a missing variable, never printing a value |
| `appJwt({ identity, now? })` | the App JWT (RS256, issued by the client id) |
| `installationToken({ identity, installationId, repositories, permissions?, now?, transport? })` | a token for an installation, scoped to 1–500 named repositories, optionally narrowed in permissions |
| `normalisePrivateKeyPem(pem)` | repairs a private key whose line breaks were flattened or escaped |
| `APP_IDENTITY_VARS`, `GITHUB_API_VERSION`, `REVIEW_TOKEN_PERMISSIONS`, `MAX_SCOPED_REPOSITORIES` | constants |
| `buildManifest(input)`, `APP_PERMISSIONS`, `APP_EVENTS` | the App manifest `init` registers |
| `convertManifest(…)`, `readConversion(…)`, `ManifestConversionError` | exchange the manifest flow's code for the App, keeping only non-secret fields |
| `secret(value)`, `REDACTED` | a wrapper whose `toString` and `toJSON` print `[redacted]` |

## `@review-agent/github`

| Area | Main exports |
|---|---|
| Running a review | `runReview({ octokit, owner, repo, number, deployment, ask, previousFindings?, signal?, deps })` — read the pull request, download, review, check, re-check; **posts nothing** |
| Posting it | `publishReview(…)` — the summary, inline comments, edits to earlier comments and the marker |
| Reading GitHub | `fetchPullRequest`, `downloadArchive` (with `sanitiseCheckout` and `isCredentialPath`), `fetchRepoConfig` / `parseRepoConfig` / `REPO_CONFIG_PATH`, `fetchThreadReplies` |
| Deciding what to say | `anchorFindings`, `selectForPosting` |
| The check run | `createCheckRun`, `completeCheckRun`, `closeCheckRunIfInProgress`, `closeStaleCheckRuns`, `conclusionFor`, `checkRunOutput`, `annotationsFor`, `RERUN_ACTION` |
| The marker | `encodeMarker`, `decodeMarker`, `findSummaryComment`, `upsertSummaryComment`, `recheckQuestions`, `nextMarkerState`, `applyOutcomes` |
| Findings and replies | `findingId(finding)` — a 12-hex-character address for one finding in one run (a hash of file, category and title); `declaredOutcome(body)` — `'disputed'`, `'deferred'` or `null` for a reply |
| Comment bodies | `summaryBody`, `inlineBody`, `reviewBody`, `retractionNote`, `reinstatementNote` |
| Writing | `postReview`, `retractInlineComment`, `reinstateInlineComment` |

## `@review-agent/core`

| Area | Main exports |
|---|---|
| Settings | `DeploymentConfig`, `defaultDeploymentConfig()`, `RepoConfig`, `ReviewRequest`, `resolveSettings(…)`, `ResolvedSettings`, `Tier`, `Effort`, `ReportMode`, `SkillSource`, `writesSummaryComment(mode)`, `skillSourceId` |
| Budgets | `budgetFor(tierSettings, requestBudgetUsd?)`, `BudgetPolicy`, `roundUsd` |
| The engine | `runEngine(input)`, `buildArgv(…)`, `EngineResult`, `EngineFailure`, `Usage`, `gatewayBaseUrlRefusal(env)` |
| Prompts | `reviewSystemPrompt`, `checkPassSystemPrompt`, `recheckPassSystemPrompt`, `buildPrompt`, `REVIEW_INSTRUCTIONS_VERSION`, `REVIEW_INSTRUCTIONS_DIGEST`, `REVIEW_LENSES` |
| Findings | `Finding`, `ReviewOutput`, `parseReviewOutput`, `reviewJsonSchema`, `ParseError` |
| The passes | `runCheckPass`, `CheckVerdict`; `runRecheckPass`, `RecheckJudgement`, `PreviousFinding` |
| The record | `buildReviewRecord`, `ReviewRecord`, `RECORD_VERSION`, `ENGINE_VERSION` |
| Secrets | `scanForSecrets`, `assertNoSecrets`, `SecretLeak` |
| Skills | `materialiseSkills`, `SkillError` |

## Versioning

The packages are `0.x`: until `1.0.0`, a minor version may change any interface, and the [changelog](../CHANGELOG.md)
says what changed. The record and the callback envelope carry their own version numbers (`recordVersion`, `version`)
so a consumer can refuse a shape it does not understand.

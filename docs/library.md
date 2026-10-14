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
`DeploymentConfig`, of which only `command`, `autoReview` and `allowMulti` are read. Returns:

- `{ kind: 'review', request, installationId, refused? }` — `refused` lists, in words, what a comment asked for and
  was not given;
- `{ kind: 'ignore', why }` — a short reason, for your log.

The rules are in [using it on pull requests](pull-requests.md#when-it-reviews). Helpers it uses are exported too:
`parseCommandFlags`, `encodeRequestRefinement` / `decodeRequestRefinement` (the settings a check run's Re-run button
carries), `isReleaseOnly`, `isAutomatic`, `skipAsReleaseOnly`, `HEAD_SHA_UNRESOLVED`; and, re-exported from
`@review-agent/github` where they live since 0.2.0, `refuseUnbuilt`, `MULTI_REFUSED` and `MULTI_REFUSED_AUTOMATIC`.
`THOROUGH_REFUSED` is still exported but deprecated: nothing refuses `--tier thorough` since 0.2.0.

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
| `APP_IDENTITY_VARS`, `GITHUB_API_VERSION`, `REVIEW_TOKEN_PERMISSIONS`, `MAX_SCOPED_REPOSITORIES` | constants (`GITHUB_API_VERSION` is `@review-agent/github`'s, re-exported) |
| `buildManifest(input)`, `APP_PERMISSIONS`, `APP_EVENTS` | the App manifest `init` registers |
| `convertManifest(…)`, `readConversion(…)`, `ManifestConversionError` | exchange the manifest flow's code for the App, keeping only non-secret fields |
| `secret(value)`, `REDACTED` | a wrapper whose `toString` and `toJSON` print `[redacted]` |

## `@review-agent/github`

| Area | Main exports |
|---|---|
| The review session | `prepareReview(…)` and `runReviewSession(…)` — a whole review, the same whichever way in asked for it; see [the review session](#the-review-session). `SessionResult` (`reviewed` \| `unfinished` \| `failed`), `PreparedReview`, `SessionDeps`, `DEFAULT_SESSION_DEADLINE_MS`; the rules it shares with the App's runner: `mayRetry(record)`, `failureSentence(record)`, `saidSafely(text)`, `postedCommentsOf(published)` |
| Reporting on the commit | `reporterFor({ octokit, want, identity?, onStarted? })` — `'auto'` \| `'check-run'` \| `'commit-status'` \| `'none'`; `checkRunReporter`, `commitStatusReporter`, `noReporter`; `tokenIdentityOf(octokit)`; `statusFor(…)`, `MAX_STATUS_DESCRIPTION_CHARS` |
| Clients and gates | `octokitFor({ token, baseUrl?, fetch? })` — a client with the API version pinned, `baseUrl` for GitHub Enterprise Server; `GITHUB_API_VERSION`; `pushAccessOf({ octokit, owner, repo, username })`; `refuseUnbuilt(request, { allowMulti?, automatic? })` — drops and names a `multi` the deployment switched off (`MULTI_REFUSED`) or an automatic review carried (`MULTI_REFUSED_AUTOMATIC`) |
| Running a review | `runReview({ octokit, owner, repo, number, deployment, ask, previousFindings?, signal?, runtime?, deps })` — read the pull request, download, review, check, re-check; **posts nothing**. `runtime` is the [credential and binary](#passing-a-credential) every model pass of this review runs with. `defaultRunReviewDeps({ note, workDir?, skillCacheDir?, concurrency? })` — its real collaborators, as the CLI and the App's runner wire them; `concurrency` is how many focused reviewers of a [multi-reviewer review](configuration.md#the-multi-reviewer-mode) run at once (3; the App's runner says 1) |
| Posting it | `publishReview({ …, via, selfLogin?, ignoreRepliesFrom? })` — the summary, inline comments, edits to earlier comments and the marker. `via` is how the review ran, which the first line of every body says |
| Reading GitHub | `fetchPullRequest`, `downloadArchive` (with `sanitiseCheckout`, `isCredentialPath` and `pathCollisions`; it also returns the entries it could not write), `fetchRepoConfig` / `parseRepoConfig` / `REPO_CONFIG_PATH`, `fetchThreadReplies` |
| Deciding what to say | `anchorFindings`, `selectForPosting`, `duplicatesIn(check)` — the findings a multi-reviewer review's check pass marked as repeating an earlier one |
| The check run | `createCheckRun`, `completeCheckRun`, `closeCheckRunIfInProgress`, `closeStaleCheckRuns`, `conclusionFor`, `checkRunOutput`, `annotationsFor`, `RERUN_ACTION` |
| The marker | `encodeMarker`, `decodeMarker`, `findSummaryComment`, `upsertSummaryComment`, `recheckQuestions`, `nextMarkerState`, `applyOutcomes` |
| Findings and replies | `findingId(finding)` — a 12-hex-character address for one finding in one run (a hash of file, category and title); `declaredOutcome(body)` — `'disputed'`, `'deferred'` or `null` for a reply |
| Comment bodies | `summaryBody`, `inlineBody`, `reviewBody`, `retractionNote`, `reinstatementNote`, `automatedReviewLine`, `focusLine`, `ReviewVia`, `PRODUCT_URL` |
| Writing | `postReview`, `retractInlineComment`, `reinstateInlineComment` |

## `@review-agent/core`

| Area | Main exports |
|---|---|
| Settings | `DeploymentConfig`, `defaultDeploymentConfig()`, `RepoConfig`, `ReviewRequest`, `resolveSettings(…)`, `ResolvedSettings`, `Tier`, `Effort`, `ReportMode`, `SkillSource`, `writesSummaryComment(mode)`, `skillSourceId` |
| Budgets | `budgetFor(tierSettings, requestBudgetUsd?)`, `BudgetPolicy`, `roundUsd` |
| The engine | `runEngine(input)`, `buildArgv(…)`, `EngineInput`, `EngineResult`, `EngineFailure`, `Usage` |
| Credentials | `modelCredentialFromEnv(env, { allowLogin })`, `ModelCredential`, `ClaudeRuntime`, `SecretValue`, `MODEL_CREDENTIAL_VARS`, `gatewayBaseUrlRefusal(env)` |
| Prompts | `reviewSystemPrompt`, `checkPassSystemPrompt({ markDuplicates? })`, `CHECK_DUPLICATES_TEXT`, `recheckPassSystemPrompt`, `buildPrompt`, `REVIEW_INSTRUCTIONS_VERSION`, `REVIEW_INSTRUCTIONS_DIGEST`, `REVIEW_LENSES` |
| Findings | `Finding`, `ReviewOutput`, `parseReviewOutput`, `reviewJsonSchema`, `ParseError` |
| The passes | `runCheckPass({ findings, input, focuses? })`, `CheckVerdict`; `runRecheckPass({ …, ceilingUsd? })`, `RecheckJudgement`, `PreviousFinding` |
| Several reviewers | `runFocusedReviews({ input, run, concurrency, onFailure? })` — one engine run per focus; `combineFocusRuns(runs)` — their answers as one result; `focusRecords(runs)`; `FocusRun`, `FocusRecord`, `DEFAULT_FOCUS_CONCURRENCY`. See [the multi-reviewer mode](configuration.md#the-multi-reviewer-mode) |
| The record | `buildReviewRecord`, `ReviewRecord`, `UnwrittenEntry`, `RECORD_VERSION`, `ENGINE_VERSION` |
| Secrets | `scanForSecrets`, `assertNoSecrets`, `SecretLeak` |
| Skills | `materialiseSkills`, `defaultSkillCacheDir()`, `SkillError` |

### Passing a credential

By default the Claude process takes its model credential from this process's environment: exactly one of
`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. A service that runs reviews for several accounts passes one with
each review instead, and that review's Claude process then sees that credential and no other:

```ts
import { modelCredentialFromEnv, SecretValue, type ClaudeRuntime } from '@review-agent/core'

const runtime: ClaudeRuntime = {
  credential: { kind: 'api-key', value: new SecretValue(apiKeyForThisReview) },
  bin: '/opt/claude-code/bin/claude',   // optional: absolute, and never inside the checkout
  passEnv: ['HTTPS_PROXY', 'NO_PROXY'],  // optional: more variables, by name
}
// Or the environment's rule, as the runner applies it: exactly one credential, no ANTHROPIC_BASE_URL.
const fromEnv: ClaudeRuntime = { credential: modelCredentialFromEnv(process.env, { allowLogin: false }) }
```

A `SecretValue` prints `[redacted]` through `String()`, `JSON.stringify` and `console.log`; `reveal()` is the only way
to read it. `passEnv` refuses any `ANTHROPIC_*` name, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, any
`REVIEW_AGENT_*` name, `GITHUB_TOKEN`, `GH_TOKEN` and `TRIGGER_SECRET_KEY`. `ANTHROPIC_BASE_URL` set in this process
refuses every review, credential or not.

### The review session

`prepareReview` reads the pull request and the repository's settings file and resolves the settings; nothing is
spent. `runReviewSession` does the rest — opens the report, reads the previous review's marker, runs the review under
its deadline, publishes it, finishes the report, and deletes the checkout:

```ts
import {
  defaultRunReviewDeps, octokitFor, prepareReview, reporterFor, runReviewSession, tokenIdentityOf,
} from '@review-agent/github'
import { defaultDeploymentConfig } from '@review-agent/core'

const octokit = octokitFor({ token: process.env.GITHUB_TOKEN! })
const prepared = await prepareReview({
  octokit, owner: 'acme', repo: 'widgets', number: 16, deployment: defaultDeploymentConfig(), ask: {},
})
if (prepared.kind === 'failed') throw new Error(prepared.reason)

const identity = await tokenIdentityOf(octokit)          // one GET /user
const result = await runReviewSession({
  prepared,
  post: true,                                            // false: review and return, write nothing
  reporter: await reporterFor({ octokit, want: 'auto', identity }),
  via: { kind: 'sdk' },
  ...(identity.kind === 'user' && { selfLogin: identity.login }),
  deps: { runReviewDeps: defaultRunReviewDeps({ note: (s) => console.error(s) }) },
})
```

Every outcome is returned, never thrown: `reviewed`, `unfinished` (the model ran and produced nothing usable) or
`failed`, with the `stage` it stopped at (`before-model`, `model`, `withheld`, `publish`), what is known to have been
spent, and `retryable` — whether running it again could not pay for the model twice. Only a programmer's error throws.

- **Reporting.** `'auto'` reports with a check run when the token can create one (an App's installation token, or
  Actions' `GITHUB_TOKEN`) and a commit status when it cannot (a person's token), decided with one `GET /user` and
  never from the environment: a user token gets its user, an installation token is refused with 403 (**UNVERIFIED**
  against GitHub so far). If the check run is refused anyway, it falls back to a status.
  A commit status is a **soft gate**: a branch rule cannot pin it to this reviewer, so anyone with push access can set
  one with the same name. A review that did not run reports `success` with a description saying it is not a verdict
  (statuses have no `neutral`); a review its runner stopped reports `error`.
- **`check-only` without a check run** puts the findings in the summary comment, since nothing else could carry them.
- **Replies.** Only `ignoreRepliesFrom` — an App's own bot login — is ignored when reading `/dispute` and `/defer`, so a
  person who posted the review can answer it. `selfLogin` makes the session prefer the summary comment that login
  posted; when GitHub refuses the edit of another's, it posts its own.
- **The checkout** is deleted when the session ends, unless `keepCheckout` is set.

## Versioning

The packages are `0.x`: until `1.0.0`, a minor version may change any interface, and the [changelog](../CHANGELOG.md)
says what changed. The record and the callback envelope carry their own version numbers (`recordVersion`, `version`)
so a consumer can refuse a shape it does not understand.

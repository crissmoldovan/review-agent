import { readFileSync } from 'node:fs'
import type { BuildExtension } from '@trigger.dev/build/extensions'
import { additionalPackages } from '@trigger.dev/build/extensions/core'
import { defineConfig } from '@trigger.dev/sdk'

/** The pinned CLI. One constant, because three places name it: the package installed into the
 *  image, the postinstall run over it, and the version the probe is scored against (criterion 2). */
const CLAUDE_CODE_VERSION = '2.1.258'

/** Where npm puts that package inside the image. `WORKDIR /app` in every stage of trigger.dev
 *  4.5.16's Node Containerfile (dist/esm/deploy/buildImage.js, generateNodeContainerfile), so
 *  these relative paths are relative to /app in the build stage the layer's commands run in. */
const CLAUDE_PACKAGE_DIR = 'node_modules/@anthropic-ai/claude-code'

// ---------------------------------------------------------------------------------------------
// THE PROJECT REF, AND WHY A `throw` ALONE CANNOT SURVIVE A DEPLOY
// ---------------------------------------------------------------------------------------------
// Still not hard-coded, and still not optional. The ref identifies one trigger.dev project, and
// this product is open source: another adopter deploys this same code into their own project
// (design §6). It is not a secret — the dashboard shows it on the project page — it is simply
// per-deployment.
//
// What version 20260914.1 proved, at a cost of one build: THIS FILE IS IMPORTED THREE TIMES, IN
// THREE DIFFERENT ENVIRONMENTS, and only two of them have TRIGGER_PROJECT_REF in `process.env`.
//
//   1. Locally, by `deploy`. process.env is the developer's shell, so the variable is there. This
//      is why every dry run passed and why nothing caught it before a real deploy.
//   2. IN THE IMAGE, AT INDEXING TIME — and here it is absent. The Containerfile's indexer stage
//      does receive the ref (ARG/ENV TRIGGER_PROJECT_REF, buildImage.js:679-710) and the index
//      CONTROLLER reads it (entryPoints/managed-index-controller.js:22). But the controller then
//      FORKS the index worker — the process that imports this file — with an environment it builds
//      from scratch:
//          fork(indexWorkerPath, { env: { ...$env, OTEL_IMPORT_HOOK_INCLUDES,
//            OTEL_IMPORT_HOOK_EXCLUDES, TRIGGER_BUILD_MANIFEST_PATH, NODE_OPTIONS,
//            TRIGGER_INDEXING: "1" } })                     (indexing/indexWorkerManifest.js:9-21)
//      `fork` with an explicit `env` REPLACES the environment: the container's own variables are
//      not inherited. `$env` is `cliApiClient.getEnvironmentVariables(projectRef)` — the PROJECT's
//      own environment variables, fetched from the API (controller :40). So the index worker sees
//      the project's variables plus those five fixed keys, and nothing else.
//   3. At run time, where it would always have been fine: the task process is started with
//      `{ ...taskRunEnv, TRIGGER_PROJECT_REF: execution.project.ref }`
//      (entryPoints/managed/execution.js:429) — the ref is explicitly put back.
//
// So a hard `throw` on a variable the CLI never puts in the project fails indexing on EVERY deploy,
// and no dry run can catch it, because a dry run never builds the image. The repair is not to drop
// the guard but to give it sources that exist in case 2, in the order they become authoritative:
//
//   (a) the environment — case 1 and case 3, unchanged;
//   (b) THE PROJECT'S OWN VARIABLES, published by the build extension below through a layer's
//       `deploy.env`. This is case 2's `$env`, and it is Criss's chosen fix (2026-09-14). It works
//       on the FIRST corrected deploy rather than the second because the CLI syncs env vars BEFORE
//       it initialises the deployment, with the reason in its own comment — "Sync BEFORE init: init
//       enqueues the build synchronously, so a post-init sync races a fast build"
//       (dist/esm/commands/deploy.js:1034-1050, immediately before initializeDeployment at :1111);
//   (c) the BUILD MANIFEST, which is the belt for (b). `TRIGGER_BUILD_MANIFEST_PATH` is one of the
//       five keys the fork above ALWAYS passes, and `BuildManifest.config.project` is a required
//       string (@trigger.dev/core 4.5.16, dist/esm/v3/schemas/build.d.ts) written from the ref that
//       case 1 resolved. It is the only source that can be PROVEN locally — see the build log's
//       indexing rehearsal — because nothing here can prove what the server does with (b) until a
//       deploy is spent. It reads a file the indexer is handed; it never reaches the network.
//
// Only when all three are empty does the guard throw, which is now what it always claimed to be: a
// deployment misconfiguration, not a deploy-time trap.
const refFromEnvironment = (): string | undefined => {
  // REVIEW_AGENT_TRIGGER_PROJECT_REF is the same value under a name trigger.dev does not reserve.
  // The vendor's own syncEnvVars extension strips every `TRIGGER_`-prefixed key before syncing
  // (@trigger.dev/build 4.5.16, dist/esm/extensions/core/syncEnvVars.js, UNSYNCABLE_ENV_VARS_PREFIXES
  // = ["TRIGGER_"]). The path this config uses — a layer's `deploy.env` — does NOT go through that
  // helper and so is not stripped client-side, but whether the SERVER accepts a variable named
  // TRIGGER_PROJECT_REF is not knowable from this machine. The extension below therefore publishes
  // BOTH names and this reader accepts either, so the deploy cannot be lost to that one unknown.
  //
  // MEASURED, 2026-09-14, by deployment 20260914.2 — THE HEDGE WAS THE RIGHT CALL. A names-only
  // `env list` of Production afterwards shows REVIEW_AGENT_TRIGGER_PROJECT_REF present and
  // TRIGGER_PROJECT_REF ABSENT: the SERVER declines the reserved prefix too, exactly as the
  // vendor's own client-side helper does. Both names are kept — the alias because it is the one
  // that lands, and the reserved name because an adopter may set it in their own shell, which is
  // source (a) and reaches this reader by a different route entirely.
  const fromEnv = process.env.TRIGGER_PROJECT_REF ?? process.env.REVIEW_AGENT_TRIGGER_PROJECT_REF
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

const refFromBuildManifest = (): string | undefined => {
  const manifestPath = process.env.TRIGGER_BUILD_MANIFEST_PATH
  if (manifestPath === undefined || manifestPath === '') return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const ref = (parsed as { config?: { project?: unknown } }).config?.project
    return typeof ref === 'string' && ref !== '' ? ref : undefined
  } catch {
    // A missing, unreadable or unparseable manifest is not this file's business to report: fall
    // through to the guard below, which says the one thing a deployer can act on.
    return undefined
  }
}

const project = refFromEnvironment() ?? refFromBuildManifest()
if (project === undefined) {
  throw new Error(
    'TRIGGER_PROJECT_REF is not set. It is the `proj_…` reference of the trigger.dev project this ' +
    'deployment belongs to, shown on the project page in the dashboard.',
  )
}

// ---------------------------------------------------------------------------------------------
// EXTENSION 1 — publish the ref to the project, so indexing can read it back
// ---------------------------------------------------------------------------------------------
/** Puts the resolved ref into the layer's `deploy.env`, which the CLI syncs into the project's
 *  environment variables before the build is enqueued — source (b) above. The value comes from
 *  `context.config.project`, i.e. the ref THIS deploy resolved, so there is no second source of
 *  truth and an adopter's own ref follows them automatically.
 *
 *  `onBuildComplete`, not `onBuildStart`, and that is not a style choice: layers are only ever
 *  drained into the manifest inside the onBuildComplete loop, and only for extensions that
 *  implement that hook (`applyContextLayersToManifest` is called nowhere else — trigger.dev 4.5.16,
 *  dist/esm/build/extensions.js:12-29, 88-94). An extension with only `onBuildStart` — which is all
 *  `additionalPackages` has — depends on some OTHER extension having onBuildComplete to be applied
 *  at all. Implementing it here makes this layer self-sufficient.
 *
 *  `override: true` matches the vendor's own syncEnvVars default. The merge still only queues a
 *  variable whose value actually differs (extensions.js:110-121), so a repeat deploy syncs nothing. */
const publishProjectRef = (): BuildExtension => ({
  name: 'reviewAgentPublishProjectRef',
  onBuildComplete(context) {
    if (context.target !== 'deploy') return
    context.addLayer({
      id: 'review-agent-project-ref',
      deploy: {
        env: {
          TRIGGER_PROJECT_REF: context.config.project,
          REVIEW_AGENT_TRIGGER_PROJECT_REF: context.config.project,
        },
        override: true,
      },
    })
  },
})

// ---------------------------------------------------------------------------------------------
// EXTENSION 2 — run the postinstall npm refused to run, so `claude` is a binary and not a stub
// ---------------------------------------------------------------------------------------------
/** `additionalPackages` below installs @anthropic-ai/claude-code, and version 20260914.1's build
 *  log shows npm 11 SKIPPING its install script:
 *      npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
 *      npm warn allow-scripts   @anthropic-ai/claude-code@2.1.258 (postinstall: node install.cjs)
 *  The generated package.json's `trustedDependencies` array does not help: that is a pnpm/bun
 *  field and npm ignores it. Without the postinstall, `bin/claude.exe` — the file the package's
 *  `bin` map points at — stays the ~500-byte placeholder shipped in the tarball, which prints
 *  `Error: claude native binary not installed.` and exits 1. The real ~215 MB binary arrives in a
 *  platform-specific optionalDependency, and install.cjs is what puts it in place.
 *
 *  WHY A LAYER COMMAND, AND NOT `image.instructions` OR A DIRECT PLATFORM-PACKAGE INSTALL:
 *    * A layer's `commands` become `RUN` lines in the BUILD stage, emitted after `COPY package.json`
 *      + `npm i` and before the final stage takes the whole tree with
 *      `COPY --from=build --chown=node:node /app/node_modules ./node_modules`
 *      (buildImage.js:504 for the mapping, template at :638-740). So a command that writes into
 *      /app/node_modules DOES reach the runtime image. The plan's claim that layer commands
 *      "cannot install anything that must exist at runtime" is true of system packages and wrong
 *      about node_modules; this is the correction.
 *    * install.cjs detects the platform ITSELF, inside the very container whose node_modules ship
 *      (process.platform + os.arch(), plus a musl check via process.report). Naming
 *      `@anthropic-ai/claude-code-linux-x64` here instead would require knowing the image's
 *      architecture, which nothing in this repository has measured — the Containerfile's
 *      TARGETPLATFORM is decided by the build server. This mechanism never has to name it.
 *    * `image.instructions` is more invasive than it looks: supplying any of them switches the
 *      build stage from the prebuilt `node:24-bookworm-build` image to `FROM base` plus an apt
 *      install of the whole toolchain (buildImage.js:519-530). Not needed for a file copy.
 *
 *  WHY THE SIZE ASSERTION IS PART OF THE COMMAND: install.cjs EXITS 0 WHEN IT FAILS. Every one of
 *  its three "cannot place the binary" paths prints to stderr and `return`s — unsupported platform,
 *  platform not on this release channel, and native package not resolvable (install.cjs:145-204) —
 *  and only a copy that throws sets `process.exitCode = 1`. So running it is not self-checking: a
 *  green build could ship the stub again, which is exactly the silent nothing-happened that cost
 *  version 20260914.1. `ls -l` puts the size in the build log either way; the `test` turns a stub
 *  into a failed build instead of a deployed image that cannot review anything. The threshold is
 *  1 MiB against a stub of ~500 bytes and a binary of ~215 MB (215,473,560 bytes for linux-x64,
 *  215,015,330 for linux-arm64, read from the registry), so it cannot be a borderline call. */
const installClaudeNativeBinary = (): BuildExtension => ({
  name: 'reviewAgentClaudeNativeBinary',
  onBuildComplete(context) {
    if (context.target !== 'deploy') return
    context.addLayer({
      id: 'review-agent-claude-native-binary',
      commands: [
        `node ${CLAUDE_PACKAGE_DIR}/install.cjs` +
        ` && ls -l ${CLAUDE_PACKAGE_DIR}/bin/claude.exe` +
        ` && test "$(wc -c < ${CLAUDE_PACKAGE_DIR}/bin/claude.exe)" -gt 1048576`,
      ],
    })
  },
})

// ---------------------------------------------------------------------------------------------
// EXTENSION 3 — tell the engine where the binary is, from the deploy and not from the dashboard
// ---------------------------------------------------------------------------------------------
/** MEASURED, not predicted. Deployment 20260914.2's probe run (2026-09-14) returned `resolvedPath: "/app/node_modules/.bin/claude"` — character for character
 *  the string Step 2 expected — with `version: "2.1.258 (Claude Code)"` and `exitCode: 0`.
 *
 *  It also returned `commandV: null` and `path:
 *  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`, which is the whole reason this
 *  extension exists rather than being tidy-up: there is no `ENV PATH` anywhere in the generated
 *  Containerfile and the base image does not put `node_modules/.bin` on PATH, so a bare `claude`
 *  is NOT resolvable in the deployed image. resolveClaudeBinary() in packages/core/src/cli-process.ts
 *  takes REVIEW_AGENT_CLAUDE_BIN (absolute) first, else searches absolute PATH directories, and that
 *  search would find nothing here. */
export const CLAUDE_BIN_PATH = '/app/node_modules/.bin/claude'

/** Sets that one variable, by the deploy, because a value typed into the dashboard is a deployment
 *  step nobody can review, repeat or revert with the code — and because the path belongs to the CLI
 *  version pinned a few lines below it. A filesystem path is not secret, so `env` and never
 *  `secretEnv`: a secret value could never be read back and the flag is irreversible.
 *
 *  `override: true` for the reason the vendor's own syncEnvVars defaults to it: the CLI queues a key
 *  only when the layer overrides or the build has no value for it yet (extensions.js:105-121), and
 *  the build starts from the project's existing variables. The merge still skips a value that has
 *  not changed, so a repeat deploy syncs nothing — correct, not a failure.
 *
 *  `onBuildComplete` for the reason the two extensions above use it: layers are drained into the
 *  manifest only in that loop and only for extensions implementing that hook (extensions.js:12-29,
 *  88-94).
 *
 *  DEPLOYED AND PROVEN, 2026-09-15, by version 20260915.1. The two probe runs side by side are
 *  criterion 6: the probe run on 20260914.2 returned `claudeBinEnv: null`, and the one on 20260915.1
 *  returns
 *  `claudeBinEnv: "/app/node_modules/.bin/claude"` with `claudeBinEnvRun: { version:
 *  "2.1.258 (Claude Code)", exitCode: 0, stderr: "" }` — the engine's own path, run and exiting 0.
 *  A names-only `env list` of Production shows REVIEW_AGENT_CLAUDE_BIN present, 15 variables where
 *  there were 14. `commandV` is STILL null on that run, which is the point: nothing about PATH
 *  changed, so the variable is the only reason the deployed product can find its CLI. */
const claudeBinEnv = (path: string): BuildExtension => ({
  name: 'reviewAgentClaudeBinEnv',
  onBuildComplete(context) {
    if (context.target !== 'deploy') return
    context.addLayer({
      id: 'review-agent-claude-bin-env',
      deploy: { env: { REVIEW_AGENT_CLAUDE_BIN: path }, override: true },
    })
  },
})

/** The `maxDuration` backstop, exported by name so Task 13's ordering test can assert
 *  DEFAULT_DEADLINE_MS < MAX_DURATION_SECONDS * 1000 < STALE_AFTER_MS without reading it back off
 *  `defineConfig`'s return value. The plan called that return type unverified; it is now read:
 *  `defineConfig(config: TriggerConfig): TriggerConfig` (@trigger.dev/sdk 4.5.16,
 *  dist/esm/v3/config.d.ts:3), so the default export WOULD carry a usable `maxDuration: number`.
 *  The named export stays anyway, because it keeps Task 13's test off a module whose import has the
 *  side effect of throwing when every source of the project ref is empty (see the guard above) — a
 *  test that reads the default export could not run without one of them. Why 2700: see below. */
export const MAX_DURATION_SECONDS = 2700

/** THREE attempts per run, project-wide — Criss, 2026-09-18, reversing his answer 13 of 2026-09-14
 *  after the cost below was put to him again and he confirmed it. The prior value was 1 and the
 *  reasoning for it still holds, so it is recorded here rather than deleted:
 *
 *    trigger.dev retries a crash, a SIGTERM, an eviction or a stall by itself (shouldRetryError,
 *    Step 5), and none of those throws anything the review task's `DoNotRetry` could stop. So a
 *    review that died AFTER the model had spent is now paid for up to three times. At the `basic`
 *    ceiling of $1.25 a wedged review's worst case moves from $1.25 to $3.75, at per-token API
 *    prices on the deployment's account.
 *
 *  What this does NOT buy, because it was never missing: the failures worth repeating spent
 *  nothing, and Task 13 already starts a NEW run for those on purpose (Task 13 Step 45e); a failed
 *  run clears its idempotency key (verified facts, "Idempotency"), so the same request can run
 *  again. `mayRetry` (src/tasks/review-run.ts) and `DoNotRetry` still classify what the task
 *  THROWS; this constant only governs what trigger.dev repeats on its own.
 *
 *  A task may override this with its own `retry`, which takes precedence over the project default
 *  (trigger.dev docs, tasks/overview, read 2026-09-18) — so a task that must not be repeated after
 *  spending can still pin itself to one without moving this.
 *
 *  Exported by name, like MAX_DURATION_SECONDS, so Task 13 Step 45g can lock it without reading
 *  defineConfig's unverified return type. */
export const MAX_ATTEMPTS = 3

export default defineConfig({
  project,
  // NOT optional here, and the plan did not predict it. The CLI discovers tasks only in directories
  // NAMED `trigger` ("We automatically detect directories named `trigger` to be task directories",
  // @trigger.dev/core 4.5.16, dist/esm/v3/config.d.ts:38-45) and this package keeps them in
  // `src/tasks`, so without this line the dry run fails outright with
  //   Error: No trigger files found
  // and an empty "Dirs config" / "Search patterns" — which is what it did on the first attempt
  // (docs/spikes/claude-in-image.md, Step 7). There is no CLI flag for it: `deploy --help` has none,
  // so it has to be the config. Renaming the directory to `trigger` would work too and is worse —
  // `src/tasks` is what Tasks 8–11 and Task 13 already refer to.
  dirs: ['./src/tasks'],
  // `small-2x` — 1 vCPU, 1 GB for the WHOLE machine — kept, and now with a measurement beside it
  // rather than design §6's preference. The reviewer spawns the `claude` CLI as a CHILD process
  // inside that 1 GB, and trigger.dev's OOM kill (`TASK_PROCESS_OOM_KILLED`) explicitly covers a
  // child process exceeding the machine limit, so the number that matters is the sum over the
  // process tree, not the reviewer's own heap.
  //
  // MEASURED 2026-09-14 (Task 12 Step 14, spikes/memory/sample-rss.sh, sampling the whole tree
  // every 0.5 s): **peak 397,216 KB = 388 MiB** for one `basic` review of a one-file pull request with
  // `--skip-check`, on this macOS development machine. That is **38% of the 1 GB limit**, with
  // ~636 MiB of headroom, and well under the ~700 MB at which Step 16 said to move to `medium-1x`.
  // The shape: 15 MiB for the node CLI alone, ~90 MiB through checkout, then a step to ~350 MiB
  // the moment the `claude` child starts — the child is roughly three-quarters of the total — and
  // a slow climb to 388 MiB. Full series and caveats: docs/spikes/claude-in-image.md.
  //
  // WHAT THE IMAGE ITSELF ADDED (deployment 20260914.2's probe run):
  // `cgroupPeakBytes` 130,142,208 = 124 MiB and `rssBytes` 106,147,840 = 101 MiB, for a task that
  // spawns `claude --version` twice and does nothing else. Two consequences. (1) cgroup v2's
  // memory.peak IS readable in this sandbox — the probe was written to tolerate null — so the
  // in-image measurement Task 15 Step 17 owes can actually be taken. (2) The in-image FLOOR is
  // 124 MiB before any review work, against 15 MiB for the node CLI alone on macOS, so 388 MiB is a
  // floor for the hosted number and not an estimate of it. Still nowhere near 1 GB; preset unchanged.
  //
  // THE REVIEW TASK'S OWN FLOOR IN THE IMAGE (2026-09-15, Task 15 Step 16, the first hosted review
  // run, on version 20260915.2): `cgroupPeakBytes` 135,254,016 = 129.0 MiB,
  // `rssBytes` 117,112,832, NOT `TASK_PROCESS_OOM_KILLED`. That run FAILED 6.2 s in on a private key
  // that would not decode, so it is the floor of `review-agent-review` itself — worker, SDK, this
  // task's module graph, its first statements — and NOT the cost of a review: no checkout, no
  // `claude` child, no engine. Worth having anyway, for two reasons. (1) It is only ~2 MiB above the
  // probe's 127 MiB, so this product's own imports are cheap and the ~127 MiB is the sandbox. (2) The
  // `memory` span (Task 13 Step 56) emits and reads non-null from the REVIEW task, not just the
  // probe — the third non-null reading in a row — so criterion 5 is takeable by the first run that
  // reaches the engine. Criterion 5 IS STILL OPEN; `small-2x` is still a hypothesis.
  // ^ TRUE WHEN WRITTEN, SUPERSEDED HOURS LATER BY THE NEXT PARAGRAPH. Kept as the record of the
  //   floor, which the comparison below still uses.
  //
  // CRITERION 5, CLOSED — AND THIS PRESET IS NOW A MEASUREMENT IN THE IMAGE (2026-09-15, Task 15
  // Step 17, the second hosted review run, on version 20260915.3). That run reviewed
  // crissmoldovan/review-agent-proving-ground #1, spawned `claude` TWICE (review then check pass),
  // posted, and COMPLETED: `cgroupPeakBytes` 308,072,448 = **293.8 MiB**, `rssBytes` 118,751,232 =
  // 113.2 MiB, NOT `TASK_PROCESS_OOM_KILLED`. That is **28.7% of this machine's 1 GiB, with 730.2 MiB
  // free** — far below the ~700 MB threshold named at the foot of this comment. `small-2x` STAYS,
  // and it now rests on an in-image measurement rather than on a macOS one.
  //
  // It came in LOWER than the 388 MiB prediction while doing MORE work, and the reason is the
  // instrument, not the image: summing RSS across a process tree counts pages shared between parent
  // and child once PER PROCESS, while a cgroup peak counts each page once for the group. So 388 MiB
  // over-reports. The spike's own `129 + (388 - 15) ~= 500 MiB` extrapolation was 206 MiB HIGH, for
  // exactly that reason. Full reading: docs/spikes/claude-in-image.md, "Criterion 5, CLOSED", and
  // docs/measurements/e2e-app-first-post.md.
  //
  // What this number does NOT settle, stated so nobody reads it as more than it is:
  //   * ~~It is macOS, not the deployed Linux image. The in-image peak is owed by Task 15 Step 17~~
  //     — PAID 2026-09-15, above. What survives: BOTH figures are one-file, one-hunk pull requests,
  //     the smallest shape measured here, so 293.8 MiB is a small review's peak and not a bound on
  //     all reviews. The ~700 MB rule below stands for when a large one is finally measured.
  //   * That pull request is the SMALLEST ever measured here — 1 file, +31 lines, 3 turns. Design §8
  //     measured PRs of 11 files / +449 lines, and a 12,478-line one. Memory follows the transcript
  //     the CLI holds, so a large review will sit higher than this.
  //   * The sampled peak was the LAST sample taken: the curve was still rising when the process
  //     exited, so 388 MiB is a sampled maximum, not a proven true maximum.
  // If Task 15's in-image number lands above ~700 MB, or the run is OOM-killed, move to
  // `medium-1x` (1 vCPU, 2 GB) — which keeps the ONE-vCPU argument `maxDuration` below depends on.
  // ANSWERED 2026-09-15: it landed at 293.8 MiB and was not OOM-killed, so no move. The rule is kept
  // rather than deleted because it is the rule for the NEXT measurement — the large pull request
  // neither figure covers.
  machine: 'small-2x',
  // A BACKSTOP, not the timeout that matters — and not optional. The CLI refuses to load a config
  // without it: trigger.dev 4.5.16, dist/esm/config.js:232-233, throws
  //   The "maxDuration" trigger.config option is now required, and must be at least 5 seconds.
  // and @trigger.dev/core 4.5.16 types it as a required `maxDuration: number`
  // (dist/esm/v3/config.d.ts:148), documented as "The maximum duration in compute-time seconds
  // that a task run is allowed to run" and "Setting this value will effect all tasks in the
  // project". So: seconds, minimum 5, project-wide.
  //
  // Why 2700 (45 minutes) and not something near a real review: measured reviews take 55s to
  // 4m40s of WALL CLOCK (design §8), and the machine
  // has ONE vCPU — `small-2x`, and `medium-1x` if Step 16 moves (the Machines table in
  // docs/plans/2026-09-14-verified-api-facts.md) — so compute time cannot accrue faster than one
  // second per wall-clock second and the slowest review ever observed cannot spend more than ~280
  // of these seconds. 2700 is about nine times that. The bound is deliberately the pessimistic
  // one: the documented exclusions from maxDuration are `wait.for`, `triggerAndWait` and
  // `batchTriggerAndWait` and nothing else, so time spent awaiting the model's child process must
  // be assumed to count in full.
  //
  // Why not lower: Task 13's own 30-minute (1800s) wall-clock deadline must always fire FIRST. It
  // is the stop that completes the check run, aborts the model's child process and reports a
  // failure a human can read; when `maxDuration` fires instead, `cleanup`, `onSuccess` and
  // `onFailure` are NOT called and a check run opened at the start of the review sits
  // `in_progress` for ever. This backstop only earns its keep in the one case the deadline cannot
  // cover — an event loop wedged so badly that its own timer never fires.
  //
  // Why not higher: an installation token lives one hour, and packages/github/src/check-run.ts's
  // STALE_AFTER_MS (also one hour) is the point at which the next review adopts an abandoned check
  // run. A backstop past that would let a wedged run keep spending after it could no longer post
  // anything. And there is no opting out to compare against: @trigger.dev/core 4.5.16 types
  // `maxDuration` as a required `number` (dist/esm/v3/config.d.ts:148) and its `timeout` export
  // carries no `None` — the TimeoutAPI class declares only signal, abortAfterTimeout,
  // setGlobalManager, disable, reset and registerListener (dist/esm/v3/timeout/api.d.ts). The only
  // question the installed package leaves open is which number.
  maxDuration: MAX_DURATION_SECONDS,
  retries: {
    enabledInDev: false,
    // THREE attempts (Criss, 2026-09-18, reversing answer 13; MAX_ATTEMPTS above carries the cost).
    // `mayRetry` in src/tasks/review-run.ts (Task 13) can only classify an error the task THROWS,
    // and @trigger.dev/core 4.5.16's shouldRetryError (dist/esm/v3/errors.js:285) also retries a
    // crash, a SIGTERM, an eviction or a stall, where nothing is thrown — so those now repeat here,
    // including after the model has spent. A failure that spent nothing is still run again by
    // Task 13 starting a new run, as before. The backoff fields are the CLI's and are now live:
    // 1s, then 2s, randomized. No task sets a `retry` of its own, though a task's setting would
    // override this one (Task 13 Step 54 and Task 13b lock that).
    default: { maxAttempts: MAX_ATTEMPTS, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2, randomize: true },
  },
  build: {
    extensions: [
      // The one line this whole spike exists to prove. The version is pinned because an omitted
      // version "may use a cached or older resolution", and because the engine's behaviour was
      // measured against a specific CLI (docs/spikes/wrap-up.md was run on 2.1.258).
      //
      // This installs the package and NOTHING ELSE: version 20260914.1's build log shows it working
      // exactly as intended — `COPY package.json`, `npm i`, `added 7 packages in 3s`, the pin
      // resolved by name. Seven is the whole story: @anthropic-ai/claude-code, ONE platform-specific
      // optionalDependency, and import-in-the-middle with its four dependencies. So the ~215 MB
      // native binary was already downloaded into that image; only the postinstall that puts it in
      // place was skipped, which is what the extension above runs.
      additionalPackages({ packages: [`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`] }),
      // Both repairs to version 20260914.1, in the same deploy, because either alone buys a failed
      // one: the guard above cannot survive indexing without the ref in the project's own variables,
      // and a `claude` that is still the 500-byte stub fails criterion 1 on the probe's first call.
      publishProjectRef(),
      installClaudeNativeBinary(),
      // Step 13, written against the path the probe MEASURED and now DEPLOYED. Version 20260914.2
      // deliberately went out without it, so that criterion 6 would have its "before" half — and it
      // does: its probe run reports `claudeBinEnv: null`. Version 20260915.1, the one further deploy
      // Criss approved (2026-09-15), carried this line and supplied the "after" half: its probe run
      // reports the path, and running it exits 0.
      claudeBinEnv(CLAUDE_BIN_PATH),
    ],
  },
})

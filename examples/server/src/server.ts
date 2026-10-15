// review-agent on your own server (spec 0.2.0 §7, UC-7): the webhook receiver, an in-process queue and
// the SDK, in one Node.js process. GitHub → POST /api/github/webhook → verify, decide, queue, answer →
// a worker reviews with an installation token and posts as the App. What it is, how to run it and its
// limits: README.md beside this folder's package.json.
import { chmodSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { resolveClaudeBinary } from '@review-agent/core'
import { configFromEnv, secretsOf, type ServerConfig } from './config'
import { HEALTH_PATH, requestListener, WEBHOOK_PATH } from './http'
import { describeJob, type ReviewJob } from './job'
import { createLogger } from './log'
import { ReviewQueue } from './queue'
import { deploymentSettings } from './settings'
import { handleWebhook } from './webhook'
import { reviewJob } from './worker'

/** After the running reviews are cancelled, how long to wait for them to stop their Claude process and
 *  remove their checkout before exiting anyway. Inside Docker's default 10-second stop timeout. */
const CANCEL_WAIT_MS = 8_000

let config: ServerConfig | null = null
// Until the configuration is read there is nothing secret to keep out; after, everything it holds.
const log = createLogger({ secrets: () => (config === null ? [] : secretsOf(config)) })

const privateDir = (path: string): string => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  // mkdir's mode is filtered by the umask, and leaves an existing directory as it was.
  chmodSync(path, 0o700)
  return path
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref() })

function main(): void {
  try {
    config = configFromEnv(process.env)
  } catch (e) {
    // Our own messages, which name variables and never a value; scrubbed again by the logger regardless.
    log.error('cannot start: the configuration is incomplete', { error: e })
    process.exitCode = 1
    return
  }
  const c = config
  for (const warning of c.warnings) log.warn(warning)

  const workDir = privateDir(join(c.dataDir, 'checkouts'))
  const skillCacheDir = privateDir(join(c.dataDir, 'skills'))

  // Found now, by the rule every review uses, so a missing Claude Code — or npm's placeholder for it —
  // stops the server at start-up rather than failing every review after GitHub has been told "queued".
  let claudeBin: string
  try {
    claudeBin = resolveClaudeBinary({ env: process.env, avoidDir: workDir })
  } catch (e) {
    log.error('cannot start: Claude Code was not found', { error: e })
    process.exitCode = 1
    return
  }

  const deployment = deploymentSettings()
  const queue = new ReviewQueue<ReviewJob>({
    concurrency: c.concurrency,
    limit: c.queueLimit,
    run: (job, signal) => reviewJob(job, signal, {
      identity: c.identity, apiKey: c.apiKey, deployment, workDir, skillCacheDir, log,
    }),
    onCrash: (job, error) => { log.error('review crashed', { ...describeJob(job), error }) },
  })

  let stopping = false
  const server = createServer(requestListener({
    webhook: (a) => handleWebhook(a, { secret: c.webhookSecret, deployment, enqueue: (job) => queue.enqueue(job), log }),
    health: () => (stopping ? null : queue.stats()),
    log,
  }))
  // A slow client cannot hold a connection open for long; GitHub sends a delivery in one go.
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000

  server.listen(c.port, () => {
    log.info('listening', {
      port: c.port, webhook: WEBHOOK_PATH, health: HEALTH_PATH, concurrency: c.concurrency, queueLimit: c.queueLimit,
      claudeBin, dataDir: c.dataDir,
    })
  })

  // SIGTERM is `docker stop`; SIGINT is Ctrl-C. The first stops taking work and winds down; a second
  // exits at once.
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      log.warn('stopping now, without waiting for the running review', { signal })
      process.exit(1)
    }
    stopping = true
    log.info('stopping: no new deliveries are taken', { signal, ...queue.stats(), drainMs: c.drainMs })
    // Never started, so nothing was spent on them. GitHub was told 202, and will not send them again by
    // itself: each is named so it can be redelivered from the App's settings, or asked for again.
    for (const job of queue.close()) log.warn('a queued review was dropped by the shutdown; redeliver it', describeJob(job))
    server.close()
    server.closeIdleConnections()
    if (c.drainMs > 0) await Promise.race([queue.idle(), sleep(c.drainMs)])
    // Cancelled with the review's own signal: the SDK stops the Claude process, removes the checkout and
    // concludes the check run, so nothing is left `in_progress` on the pull request.
    queue.abort('the server is stopping')
    await Promise.race([queue.idle(), sleep(CANCEL_WAIT_MS)])
    log.info('stopped', queue.stats())
    process.exit(0)
  }
  process.on('SIGTERM', (s) => { void stop(s) })
  process.on('SIGINT', (s) => { void stop(s) })
}

main()

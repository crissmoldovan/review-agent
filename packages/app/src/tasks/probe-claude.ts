import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { task } from '@trigger.dev/sdk'

const run = promisify(execFile)

export type CredentialPresence = { anthropicApiKey: boolean; oauthToken: boolean; authToken: boolean }

export type ClaudeProbe = {
  resolvedPath: string | null
  commandV: string | null
  version: string
  exitCode: number | null
  stderr: string
  path: string
  cwd: string
  credentialsAtImport: CredentialPresence
  credentialsInRun: CredentialPresence
  claudeBinEnv: string | null
  claudeBinEnvRun: { version: string; exitCode: number | null; stderr: string } | null
  cgroupPeakBytes: number | null
  rssBytes: number
}

// BOOLEANS ONLY — never the values. A credential that reaches a log has leaked (design §4.3), and
// a task's return value is stored and displayed by trigger.dev like any other log.
const presence = (env: Record<string, string | undefined>): CredentialPresence => ({
  anthropicApiKey: (env.ANTHROPIC_API_KEY ?? '') !== '',
  oauthToken: (env.CLAUDE_CODE_OAUTH_TOKEN ?? '') !== '',
  // Not a credential this product accepts (decision 10). Reported only so a stray gateway token set
  // in the project is visible here rather than discovered later.
  authToken: (env.ANTHROPIC_AUTH_TOKEN ?? '') !== '',
})

// Read at MODULE scope on purpose, and this is half of what the probe is for. The docs say
// environment variables "are fetched and injected before a run begins", which does not say whether
// they are there when the worker imports this file. Task 13 does not rely on the answer — it
// checks credentials inside `run` either way (Task 13 Step 58) — but it is recorded for whoever asks.
// ANTHROPIC_API_KEY is KNOWN to be set in this project's Production environment (added by Criss,
// 2026-09-14, confirmed by a names-only `trigger.dev env list`), so a false here does not mean
// "no credential" — it means module scope is too early. Comparing this with credentialsInRun below
// is what answers criterion 4 without anyone ever reading the value.
const credentialsAtImport = presence(process.env)

const text = async (argv: string[]): Promise<{ out: string; err: string; code: number | null }> => {
  try {
    const r = await run(argv[0] ?? '', argv.slice(1), { timeout: 30_000 })
    return { out: r.stdout.trim(), err: r.stderr.trim(), code: 0 }
  } catch (e) {
    // NARROWED, not cast. Node puts three different things in `code` here and only one of them is
    // an exit status: a spawn failure sets the STRING 'ENOENT' (which is precisely the outcome
    // this probe exists to detect — no `claude` on PATH at all), the 30s `timeout` above kills the
    // child and leaves code null with signal 'SIGTERM', and a real non-zero exit is a number. A
    // cast would let 'ENOENT' sit in a field typed `number | null` and be scored against criterion
    // 1 as if it were an exit code, so anything non-numeric goes into the error string instead,
    // where the write-up can tell the three apart.
    const x = e as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; message?: unknown }
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    const code = typeof x.code === 'number' ? x.code : null
    const why = [
      str(x.stderr) === '' ? str(x.message) : str(x.stderr),
      typeof x.code === 'string' ? `code=${x.code}` : '',
      typeof x.signal === 'string' ? `signal=${x.signal}` : '',
    ].filter((part) => part !== '')
    return { out: str(x.stdout), err: why.join(' '), code }
  }
}

// cgroup v2 exposes the peak of a cgroup's memory. NOT VERIFIED to exist in trigger.dev's sandbox —
// that is exactly why the probe reads it and reports null rather than assuming either way.
const cgroupPeak = async (): Promise<number | null> => {
  for (const p of ['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory.max_usage_in_bytes']) {
    try {
      const n = Number.parseInt((await readFile(p, 'utf8')).trim(), 10)
      if (Number.isFinite(n)) return n
    } catch { /* not this kernel's layout, or not readable: report null */ }
  }
  return null
}

export const probeClaude = task({
  id: 'probe-claude',
  run: async (): Promise<ClaudeProbe> => {
    // `command -v` rather than `which`: it is a shell builtin and exists wherever /bin/sh does.
    const found = await text(['/bin/sh', '-c', 'command -v claude'])
    const commandV = found.out === '' ? null : found.out
    // The path that does NOT depend on PATH luck. If this resolves and `command -v` does not, the
    // answer is still yes — set REVIEW_AGENT_CLAUDE_BIN to this and the engine is satisfied.
    const guess = `${process.cwd()}/node_modules/.bin/claude`
    const exists = await text(['/bin/sh', '-c', `test -x ${guess} && echo ${guess}`])
    // Read at CALL time, exactly the way the engine reads it: claudeBinary() in
    // packages/core/src/cli-process.ts is `process.env.REVIEW_AGENT_CLAUDE_BIN ?? 'claude'`. Null
    // on the first deployed run (nothing sets it yet) and the resolved path after Step 13's deploy
    // — the difference between those two runs is the whole proof that a layer's deploy.env works.
    // A filesystem path is not a credential; returning this one is safe, returning a key never is.
    const binEnv = process.env.REVIEW_AGENT_CLAUDE_BIN
    const claudeBinEnv = binEnv === undefined || binEnv === '' ? null : binEnv
    const binEnvRun = claudeBinEnv === null ? null : await text([claudeBinEnv, '--version'])
    // Same precedence as claudeBinary(): the variable wins when it is set, so from Step 13 onward
    // this field says what the engine itself would run.
    const resolvedPath = claudeBinEnv ?? commandV ?? (exists.out === '' ? null : exists.out)
    const version = resolvedPath === null ? { out: '', err: 'claude not found', code: null as number | null }
                                          : await text([resolvedPath, '--version'])
    return {
      resolvedPath, commandV,
      version: version.out, exitCode: version.code, stderr: version.err,
      path: process.env.PATH ?? '', cwd: process.cwd(),
      credentialsAtImport,
      credentialsInRun: presence(process.env),
      claudeBinEnv,
      claudeBinEnvRun: binEnvRun === null
        ? null
        : { version: binEnvRun.out, exitCode: binEnvRun.code, stderr: binEnvRun.err },
      cgroupPeakBytes: await cgroupPeak(),
      rssBytes: process.memoryUsage.rss(),
    }
  },
})

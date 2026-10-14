#!/usr/bin/env node
// Stands in for the Claude Code CLI in unit tests. Prints a recorded result document and exits.
// Hand-written: this is a test double, not a recording, which is why it does not live in
// fixtures/. Controlled entirely by env vars so one test can point one spawn at one fixture:
//   FAKE_CLAUDE_FIXTURE  path to the JSON to print on stdout
//   FAKE_CLAUDE_EXIT     exit code (default 0; the real CLI exits 1 on a failure subtype)
//   FAKE_CLAUDE_STDERR   text to print on stderr
//   FAKE_CLAUDE_RECORD   path to write {argv, stdin, cwd, env, systemPromptFile} to, so tests can
//                        assert on what the engine actually sent — this is how the stdin-prompt
//                        and the environment-scrubbing rules get checked. `systemPromptFile` is
//                        {path, text, mode, dirMode} when argv has --append-system-prompt-file, read
//                        here because the engine deletes the file once the run is over; else null.
//   FAKE_CLAUDE_SLEEP_MS hold the process open this long (for the abort test)
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const chunks = []
for await (const c of process.stdin) chunks.push(c)

if (process.env.FAKE_CLAUDE_RECORD) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--append-system-prompt-file')
  const file = at === -1 ? undefined : argv[at + 1]
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
    argv,
    stdin: Buffer.concat(chunks).toString('utf8'),
    cwd: process.cwd(),
    env: process.env,
    systemPromptFile: file === undefined ? null : {
      path: file,
      text: readFileSync(file, 'utf8'),
      mode: statSync(file).mode & 0o777,
      dirMode: statSync(dirname(file)).mode & 0o777,
    },
  }))
}

const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0)
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))

if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR)
if (process.env.FAKE_CLAUDE_FIXTURE) {
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_FIXTURE, 'utf8'))
}
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0))

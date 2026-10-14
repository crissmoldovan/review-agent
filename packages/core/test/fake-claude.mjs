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
//
// Two more, for a review that starts several processes at once (the multi-reviewer mode, spec 0.2.0
// §8.3), where every spawn reads the same environment in the same tick and one variable cannot point
// each at its own fixture:
//   FAKE_CLAUDE_FIXTURE_BY_PROMPT  JSON {"<text>": "<fixture path>" | null}. The first key found in
//                        this spawn's system prompt picks its fixture — "Your focus: security", say,
//                        or "verification pass" for the check pass. `null` prints nothing and exits 1:
//                        a process that crashed. No key found: FAKE_CLAUDE_FIXTURE, as before.
//   FAKE_CLAUDE_RECORD_DIR  a directory each spawn writes its own record into, as
//                        `<startedAt>-<pid>.json` (renamed into place whole, so a `.json` there is
//                        never half written), with `startedAt` (ms) and `systemPrompt` (the text, from
//                        argv or the file) added — so a test sees every spawn, not the last.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const startedAt = Date.now()
const chunks = []
for await (const c of process.stdin) chunks.push(c)

const argv = process.argv.slice(2)
const fileAt = argv.indexOf('--append-system-prompt-file')
const promptFile = fileAt === -1 ? undefined : argv[fileAt + 1]
const textAt = argv.indexOf('--append-system-prompt')
const systemPrompt = promptFile !== undefined
  ? readFileSync(promptFile, 'utf8')
  : textAt === -1 ? '' : argv[textAt + 1] ?? ''

const recordOf = () => ({
  argv,
  stdin: Buffer.concat(chunks).toString('utf8'),
  cwd: process.cwd(),
  env: process.env,
  systemPromptFile: promptFile === undefined ? null : {
    path: promptFile,
    text: readFileSync(promptFile, 'utf8'),
    mode: statSync(promptFile).mode & 0o777,
    dirMode: statSync(dirname(promptFile)).mode & 0o777,
  },
})

if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(recordOf()))
}
if (process.env.FAKE_CLAUDE_RECORD_DIR) {
  // Written aside and renamed into place: a test that is waiting for records to appear — to stop the
  // review once every process has started — must never read one half written.
  const name = join(process.env.FAKE_CLAUDE_RECORD_DIR, `${startedAt}-${process.pid}`)
  writeFileSync(`${name}.tmp`, JSON.stringify({ ...recordOf(), startedAt, systemPrompt }))
  renameSync(`${name}.tmp`, `${name}.json`)
}

const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0)
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))

let fixture = process.env.FAKE_CLAUDE_FIXTURE
if (process.env.FAKE_CLAUDE_FIXTURE_BY_PROMPT) {
  const byPrompt = JSON.parse(process.env.FAKE_CLAUDE_FIXTURE_BY_PROMPT)
  const key = Object.keys(byPrompt).find((k) => systemPrompt.includes(k))
  if (key !== undefined) {
    if (byPrompt[key] === null) process.exit(1)
    fixture = byPrompt[key]
  }
}

if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR)
if (fixture) process.stdout.write(readFileSync(fixture, 'utf8'))
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0))

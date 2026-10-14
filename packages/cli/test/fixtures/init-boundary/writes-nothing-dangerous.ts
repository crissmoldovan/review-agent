// The negative control, and the only fixture here that is NOT a violation: a module shaped like the
// real init half — a node built-in that cannot write, a helper of its own, the one package the init
// half is allowed to name, and an injected sink it prints through. Without it, a rule that flagged
// everything would look exactly as convincing as a rule that works.
//
// It carries the second control too, in this comment: `console.log(app.pem.reveal())`,
// `process.stdout.write(...)` and `import { writeFileSync } from 'node:fs'` are prose here, and a
// rule that read raw text would fail this file — and would fail `init-command.ts`, whose comments
// explain why a secret is never printed. Comments are blanked before anything is searched.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { type ConvertedApp, buildManifest } from '@review-agent/app'
import { sameOrigin } from './helper-that-writes-nothing'

export const announce = (app: ConvertedApp, out: (s: string) => void): void => {
  out(`registered ${app.slug} under request ${randomUUID()}`)
}

export const listen = (): ReturnType<typeof createServer> => createServer()

export const fromTheSamePlace = (a: string, b: string): boolean => sameOrigin(a, b)

export const manifest = buildManifest({
  name: 'a fixture', url: 'https://example.com',
  webhookUrl: 'https://example.com/api/github/webhook', redirectUrl: 'http://127.0.0.1:1/callback',
})

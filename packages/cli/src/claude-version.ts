import { execFile } from 'node:child_process'
import { MODEL_CREDENTIAL_VARS } from '@review-agent/core'

/** How long `claude --version` gets before doctor says it did not answer. It prints a line and exits;
 *  a binary that takes longer is the wrong binary or a broken one, and doctor must not hang on it. */
export const CLAUDE_VERSION_TIMEOUT_MS = 10_000

/** This environment without anything that is a credential or says where the model is: `--version`
 *  needs none of them (spec 0.2.0 §5.1, "no credential needed"), and a binary doctor has not vetted yet
 *  is handed none. */
export const withoutCredentials = (env: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of Object.keys(out)) {
    if ((MODEL_CREDENTIAL_VARS as readonly string[]).includes(k) || k.startsWith('ANTHROPIC_') ||
        k === 'GITHUB_TOKEN' || k === 'GH_TOKEN' || k.startsWith('REVIEW_AGENT_')) delete out[k]
  }
  return out
}

/** The first line `<bin> --version` prints. Started as a review starts it — a JavaScript entry point
 *  with this Node, anything else directly, never through a shell — and time-boxed. Rejects with this
 *  module's own words; the binary's stderr is not quoted. */
export const claudeVersionOf = (bin: string, env: Record<string, string | undefined>): Promise<string> =>
  new Promise((resolve, reject) => {
    const viaNode = /\.(c|m)?js$/i.test(bin)
    execFile(viaNode ? process.execPath : bin, viaNode ? [bin, '--version'] : ['--version'], {
      encoding: 'utf8', timeout: CLAUDE_VERSION_TIMEOUT_MS, windowsHide: true, env: withoutCredentials(env),
    }, (error, stdout) => {
      if (error === null) {
        const line = stdout.trim().split(/\r?\n/)[0] ?? ''
        if (line === '') reject(new Error('it printed nothing'))
        else resolve(line)
        return
      }
      const e = error as { killed?: boolean; code?: unknown }
      reject(new Error(e.killed === true
        ? `it did not answer within ${CLAUDE_VERSION_TIMEOUT_MS / 1000} seconds`
        : `it failed (${String(e.code)})`))
    })
  })

import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Octokit } from '@octokit/core'
import { extract } from 'tar'

// ── CREDENTIAL FILES ARE REMOVED, NOT JUDGED ─────────────────────────────────────────────────────
// Criss, 2026-09-13. The first version refused any tree containing `.npmrc`, which refused every
// repository that installs private packages the standard way. The second judged such files by their
// contents — and three rounds of security review each found a new way past it, every one proven
// against real npm, which sent the hidden token to a server: a case-variant name (`.NPMRC`), a bare
// CR hiding a token behind a comment line, `${VAR?}` in a KEY that npm expands away, and a private
// key whose PEM header was escaped so no scanner saw it.
//
// Predicting everything npm does with a file was the defect. The reviewer does not need these files
// to review code, and a change to one is still in the diff. So they are deleted from the working copy
// before the model starts, and the review record names them. Nothing in a file that is not there can
// reach the model, whatever it contains, and no tool's parsing needs predicting.
//
// The list is deliberately broad and is not a claim to be exhaustive: the secret scan on the review's
// OUTPUT (core/secrets.ts) remains the backstop for a secret in a file nobody would call a credential.

/** Matched case-insensitively on the file's own name. */
const CREDENTIAL_NAMES = new Set([
  '.npmrc', '.netrc', '_netrc', '.git-credentials', '.pypirc', '.yarnrc', '.yarnrc.yml', 'pip.conf',
  '.dockercfg', '.pgpass', '.htpasswd',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
])
/** Key and certificate stores, by extension. */
const CREDENTIAL_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.jks', '.keystore']
/** Files that are credentials only at a known place. Matched on the end of the relative path. */
const CREDENTIAL_PATHS = ['.docker/config.json', '.aws/credentials', '.kube/config']
/** `.env` and `.env.<anything>` are credentials; these suffixes mark a template that exists so a real
 *  value is never committed, and a reviewer needs to see it. */
const ENV_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist']
/** A document ABOUT environment variables (`docs/.env.md`) is not one. */
const ENV_DOCUMENT_SUFFIXES = ['.md', '.mdx', '.txt', '.rst']

export function isCredentialPath(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/').toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (CREDENTIAL_NAMES.has(name)) return true
  if (CREDENTIAL_EXTENSIONS.some((ext) => name.endsWith(ext) && name.length > ext.length)) return true
  if (CREDENTIAL_PATHS.some((p) => path === p || path.endsWith(`/${p}`))) return true
  if (name === '.env') return true
  if (name.startsWith('.env.')) {
    return ![...ENV_TEMPLATE_SUFFIXES, ...ENV_DOCUMENT_SUFFIXES].some((s) => name.endsWith(s))
  }
  return false
}

export type SanitisedCheckout = {
  /** A `.git` directory in an archive is an anomaly — an archive never contains one — so it is
   *  reported and the download refused, rather than tidied away. */
  gitDirs: string[]
  /** Removed before the model could read them, in walk order. */
  removed: string[]
}

export function safeEntry(path: string): boolean {
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) return false
  if (path.split(/[\\/]/).includes('..')) return false
  return true
}

export async function sanitiseCheckout(dir: string): Promise<SanitisedCheckout> {
  const gitDirs: string[] = []
  const removed: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))   // a stable, reviewable order
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relative(dir, full)
      if (entry.isDirectory()) {
        if (entry.name === '.git') { gitDirs.push(rel); continue }   // do not descend
        await walk(full)
      } else if (isCredentialPath(rel)) {
        // `unlink` on a symlink removes the LINK, never its target, and it reads nothing — so a link
        // pointing out of the checkout is neither followed nor harmed.
        await unlink(full)
        removed.push(rel)
      }
    }
  }
  await walk(dir)
  return { gitDirs, removed }
}

export async function downloadArchive(a: {
  octokit: Octokit; owner: string; repo: string; ref: string; destDir: string
}): Promise<{ dir: string; removed: string[] }> {
  const { octokit, owner, repo, ref, destDir } = a
  // Octokit throws only at status >= 400, so the documented 302 arrives as a normal response.
  const res = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
    owner, repo, ref, request: { redirect: 'manual' },
  })
  const location = (res.headers as Record<string, unknown>).location
  let source: Readable
  if (typeof location === 'string' && location.length > 0) {
    // The URL is already signed and expires in about five minutes: fetch it promptly, and send no
    // credential to it — codeload.github.com is a different host (design §4.1).
    const signed = await fetch(location)
    if (!signed.ok || signed.body === null) throw new Error(`tarball: ${signed.status} fetching the signed archive`)
    source = Readable.fromWeb(signed.body as unknown as WebReadableStream<Uint8Array>)
  } else if (res.data instanceof ArrayBuffer) {
    source = Readable.from(Buffer.from(res.data))
  } else {
    throw new Error(`tarball: expected a 302 redirect or archive bytes, got status ${res.status}`)
  }

  await mkdir(destDir, { recursive: true })
  await pipeline(source, extract({ cwd: destDir, strip: 1, filter: safeEntry }))

  const { gitDirs, removed } = await sanitiseCheckout(destDir)
  if (gitDirs.length > 0) {
    throw new Error(`archive carried a .git directory, which an archive never should: ${gitDirs.join(', ')}`)
  }
  return { dir: destDir, removed }
}

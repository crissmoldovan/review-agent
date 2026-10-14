import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import * as tar from 'tar'
import { skillSourceId, type SkillSource } from './config'

export type MaterialisedSkill = { id: string; path: string }

export class SkillError extends Error {
  readonly id: string
  constructor(id: string, message: string) {
    super(`skill ${id}: ${message}`)
    this.name = 'SkillError'
    this.id = id
  }
}

const materialiseDir = (source: Extract<SkillSource, { kind: 'dir' }>, id: string): string => {
  if (!isAbsolute(source.path)) throw new SkillError(id, 'path must be absolute')
  if (!existsSync(source.path)) throw new SkillError(id, 'no such directory')
  // realpath before statting: a symlink to a directory stats as a directory, and the whole point
  // is to find out where it really goes.
  const real = realpathSync(source.path)
  if (!statSync(real).isDirectory()) throw new SkillError(id, 'not a directory')
  return real
}

export type SkillFetch = (a: { repo: string; ref: string }) => Promise<NodeJS.ReadableStream>

const GITHUB_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** The only host built in. `repo` is `owner/name`; the tarball is what `git clone --depth 1` would
 *  give and needs no git binary on the box — the same reason Task 9 downloads the PR as a tarball.
 *  REVIEW_AGENT_SKILLS_TOKEN is read here, in the parent process, and is deliberately NOT on
 *  childEnv's allow-list (Task 6): the reviewer must never see the credential that fetched its
 *  own skills. */
const githubFetch: SkillFetch = async ({ repo, ref }) => {
  if (!GITHUB_REPO.test(repo)) {
    throw new Error(
      `skill source repo must be "owner/name" for the built-in GitHub fetcher; got ${repo}. ` +
        'Pass deps.fetch to materialiseSkills for another host.',
    )
  }
  const token = process.env.REVIEW_AGENT_SKILLS_TOKEN
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${ref}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  if (!res.ok || res.body === null) throw new Error(`${res.status} fetching ${repo}@${ref}`)
  return Readable.fromWeb(res.body)
}

/** Cached by repo@ref, never by the full id: a sub-path selects inside one checkout, so two
 *  sources at the same ref share one download. The hash keeps two repos whose names slugify the
 *  same apart; the readable prefix keeps the cache directory greppable by a human. */
const cacheEntry = (cacheDir: string, repo: string, ref: string): string => {
  const key = `${repo}@${ref}`
  const slug = key.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)
  return join(
    resolve(cacheDir),
    `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
  )
}

/** Design §4.7: "mounted read-only for the run". Applied to the staging tree before it is renamed
 *  into the cache, so nothing ever observes a writable cache entry. Note for whoever runs this in
 *  a container: root ignores these bits. They are a guard against our own code and against a
 *  skill's own postinstall-shaped mistakes, not a sandbox. */
const freeze = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) freeze(p)
    else chmodSync(p, 0o444)
  }
  chmodSync(dir, 0o555)
}

/** `freeze` undone, so a staging directory can be deleted (spec 0.2.0 §9.3 P13). A frozen directory
 *  is `0555`, and removing what is in a directory needs write permission on it: without this, a run
 *  that lost the race below failed its review on EACCES and left a directory nobody but root could
 *  remove. Symlinks are left alone — `chmod` follows them, and their target is not ours to change. */
const thaw = (dir: string): void => {
  chmodSync(dir, 0o700)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) thaw(p)
    else if (!entry.isSymbolicLink()) chmodSync(p, 0o600)
  }
}

/** Who may have written what this run is about to trust (spec 0.2.0 §9.3 P13). `uid` null means no
 *  check: on Windows a uid means nothing, and ownership is the ACL's business. */
type Ownership = { uid: number | null; ownerOf: (path: string) => number }

const defaultOwnership = (): Ownership => ({
  uid: process.platform === 'win32' ? null : (process.getuid?.() ?? null),
  ownerOf: (p) => lstatSync(p).uid,
})

const materialiseGit = async (
  source: Extract<SkillSource, { kind: 'git' }>,
  id: string,
  cacheDir: string,
  fetchArchive: SkillFetch,
  ownership: Ownership,
): Promise<string> => {
  const entry = cacheEntry(cacheDir, source.repo, source.ref)

  if (!existsSync(entry)) {
    const staging = join(resolve(cacheDir), `.staging-${randomUUID()}`)
    mkdirSync(staging, { recursive: true })
    try {
      // node-tar refuses absolute paths and `..` entries by default; strip drops codeload's single
      // top-level `<name>-<ref>/` wrapper.
      await pipeline(
        await fetchArchive({ repo: source.repo, ref: source.ref }),
        tar.x({ cwd: staging, strip: 1 }),
      )
      freeze(staging)
      renameSync(staging, entry)
    } catch (e) {
      // Best effort, and never the error that is reported: a staging directory left behind costs
      // disk, while losing the reason the fetch failed costs the person reading the log everything.
      try { thaw(staging) } catch { /* it may never have been frozen, or never written */ }
      rmSync(staging, { recursive: true, force: true })
      // Another run got there first between the check and the rename: its copy is as good as ours.
      if (!existsSync(entry)) throw new SkillError(id, `could not materialise: ${String(e)}`)
    }
  }

  // Whoever made it, this run or another one: it is mounted into a review only if this user owns it.
  // A cache under a shared temp directory can hold an entry another account planted, named exactly
  // as this one would be — and a skill is instructions the reviewer follows.
  if (ownership.uid !== null && ownership.ownerOf(entry) !== ownership.uid) {
    throw new SkillError(id, `the cached copy at ${entry} belongs to another user; refusing to use it. Remove it, or use a skill cache directory only you can write`)
  }

  if (source.path === undefined) return entry
  const sub = resolve(entry, source.path)
  const rel = relative(entry, sub)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SkillError(id, `sub-path escapes the skill source: ${source.path}`)
  }
  if (!existsSync(sub)) throw new SkillError(id, `sub-path not in the source: ${source.path}`)
  return sub
}

/** Where skills are cached when nobody says otherwise: this OS's own place for a user's caches (spec
 *  0.2.0 §9.3 P13) — `%LOCALAPPDATA%\review-agent\skills` on Windows, `~/Library/Caches/review-agent/
 *  skills` on macOS, and `$XDG_CACHE_HOME/review-agent/skills` or `~/.cache/review-agent/skills`
 *  elsewhere. Each is the user's own, so nobody else can plant an entry in it. A relative
 *  `XDG_CACHE_HOME` or `LOCALAPPDATA` is ignored, as the XDG specification says it must be: a cache
 *  relative to wherever the process happens to start is not a cache. */
export const defaultSkillCacheDir = (a: {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  homedir?: string
} = {}): string => {
  const platform = a.platform ?? process.platform
  const env = a.env ?? process.env
  const home = a.homedir ?? homedir()
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? ''
    return win32.join(win32.isAbsolute(local) ? local : win32.join(home, 'AppData', 'Local'), 'review-agent', 'skills')
  }
  if (platform === 'darwin') return posix.join(home, 'Library', 'Caches', 'review-agent', 'skills')
  const xdg = env.XDG_CACHE_HOME ?? ''
  return posix.join(posix.isAbsolute(xdg) ? xdg : posix.join(home, '.cache'), 'review-agent', 'skills')
}

export const materialiseSkills = async (
  sources: SkillSource[],
  cacheDir: string,
  /** `ownership` is a seam for tests, which cannot make a file another user owns without being root. */
  deps: { fetch?: SkillFetch; ownership?: { uid: number | null; ownerOf: (path: string) => number } } = {},
): Promise<MaterialisedSkill[]> => {
  // Nothing to fetch, nothing to make (spec 0.2.0 §9.3 P13): a review with no skills — the CLI's
  // every review — creates no directory anywhere and is not refused over a cache it would not use.
  if (sources.length === 0) return []
  if (!isAbsolute(cacheDir)) throw new Error(`skill cache dir must be absolute: ${cacheDir}`)
  // 0700: what is cached here is instructions the reviewer follows, so only this user may write
  // them. The mode applies to every directory this call creates, not to one that already exists.
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  // Resolved once and used from here on, so a symlink swapped after the check below cannot move
  // where the entries are read from.
  const root = realpathSync(cacheDir)
  const ownership = deps.ownership ?? defaultOwnership()
  // An entry this user owns is only as trustworthy as the directory it sits in: a directory someone
  // else owns lets them rename one of OUR entries over another's name, and every entry would pass.
  if (ownership.uid !== null && ownership.ownerOf(root) !== ownership.uid) {
    throw new Error(`skill cache dir ${root} belongs to another user, so nothing in it can be trusted; use a directory of your own (REVIEW_AGENT_SKILL_CACHE)`)
  }
  const fetchArchive = deps.fetch ?? githubFetch
  const out: MaterialisedSkill[] = []
  for (const source of sources) {
    const id = skillSourceId(source)
    out.push({
      id,
      path:
        source.kind === 'dir'
          ? materialiseDir(source, id)
          : await materialiseGit(source, id, root, fetchArchive, ownership),
    })
  }
  return out
}

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
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

const materialiseGit = async (
  source: Extract<SkillSource, { kind: 'git' }>,
  id: string,
  cacheDir: string,
  fetchArchive: SkillFetch,
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
      rmSync(staging, { recursive: true, force: true })
      // Another run got there first between the check and the rename: its copy is as good as ours.
      if (!existsSync(entry)) throw new SkillError(id, `could not materialise: ${String(e)}`)
    }
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

export const materialiseSkills = async (
  sources: SkillSource[],
  cacheDir: string,
  deps: { fetch?: SkillFetch } = {},
): Promise<MaterialisedSkill[]> => {
  if (!isAbsolute(cacheDir)) throw new Error(`skill cache dir must be absolute: ${cacheDir}`)
  mkdirSync(cacheDir, { recursive: true })
  const fetchArchive = deps.fetch ?? githubFetch
  const out: MaterialisedSkill[] = []
  for (const source of sources) {
    const id = skillSourceId(source)
    out.push({
      id,
      path:
        source.kind === 'dir'
          ? materialiseDir(source, id)
          : await materialiseGit(source, id, cacheDir, fetchArchive),
    })
  }
  return out
}

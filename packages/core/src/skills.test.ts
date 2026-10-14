import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'
import { materialiseSkills, SkillError } from './skills'
import { buildArgv } from './engine'
import { inputFixture } from '../test/helpers/engine-input'

let root: string
let cacheDir: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'skills-')))
  cacheDir = join(root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
})

describe('materialiseSkills — directory sources', () => {
  it('returns the real path and the source id, in order', async () => {
    const a = join(root, 'security-pass')
    const b = join(root, 'coverage-pass')
    mkdirSync(a)
    mkdirSync(b)
    const out = await materialiseSkills(
      [
        { kind: 'dir', path: a },
        { kind: 'dir', path: b },
      ],
      cacheDir,
    )
    expect(out).toEqual([
      { id: a, path: a },
      { id: b, path: b },
    ])
  })

  // The rule of design §4.7, mechanically: a deployment that points at /opt/skills/x is entitled
  // to assume /opt/skills/x is what gets mounted. If it is a symlink into the checkout, the PR
  // author writes the reviewer's instructions. buildArgv compares paths lexically, so the
  // resolution has to happen here or it happens nowhere.
  it('resolves a symlink to its real path, so buildArgv can see where it really points', async () => {
    const checkout = join(root, 'checkout')
    mkdirSync(join(checkout, '.claude', 'skills', 'evil'), { recursive: true })
    const link = join(root, 'looks-innocent')
    symlinkSync(join(checkout, '.claude', 'skills', 'evil'), link)
    const [only] = await materialiseSkills([{ kind: 'dir', path: link }], cacheDir)
    expect(only.path).toBe(realpathSync(join(checkout, '.claude', 'skills', 'evil')))
    expect(only.id).toBe(link) // the id is what the deployment configured, not where it landed
  })

  it('refuses a source that is not there, naming it', async () => {
    await expect(
      materialiseSkills([{ kind: 'dir', path: join(root, 'nope') }], cacheDir),
    ).rejects.toThrow(SkillError)
  })

  it('refuses a relative path', async () => {
    await expect(
      materialiseSkills([{ kind: 'dir', path: 'skills/x' }], cacheDir),
    ).rejects.toThrow(/absolute/)
  })
})

const gitSource = { kind: 'git', repo: 'crissmoldovan/review-skills', ref: 'v0.3.0' } as const

/** Writes the tarball codeload.github.com serves for a repo at a ref: everything under one
 *  top-level `<name>-<ref>/` directory, which is why extraction strips one component. */
const recordArchive = async (): Promise<string> => {
  const stage = join(root, 'stage', 'review-skills-v0.3.0')
  mkdirSync(join(stage, '.claude-plugin'), { recursive: true })
  mkdirSync(join(stage, 'test-coverage', '.claude-plugin'), { recursive: true })
  writeFileSync(join(stage, '.claude-plugin', 'plugin.json'), '{"name":"review-skills"}')
  writeFileSync(
    join(stage, 'test-coverage', '.claude-plugin', 'plugin.json'),
    '{"name":"test-coverage"}',
  )
  const tgz = join(root, 'review-skills-v0.3.0.tar.gz')
  await tar.c({ gzip: true, cwd: join(root, 'stage'), file: tgz }, ['review-skills-v0.3.0'])
  return tgz
}

describe('materialiseSkills — git sources', () => {
  it('downloads once, strips the top-level directory, and returns the cache path', async () => {
    const tgz = await recordArchive()
    const calls: { repo: string; ref: string }[] = []
    const fetch = async (a: { repo: string; ref: string }) => {
      calls.push(a)
      return createReadStream(tgz)
    }

    const [only] = await materialiseSkills([gitSource], cacheDir, { fetch })

    expect(calls).toEqual([{ repo: 'crissmoldovan/review-skills', ref: 'v0.3.0' }])
    expect(only.id).toBe('crissmoldovan/review-skills@v0.3.0')
    expect(only.path.startsWith(resolve(cacheDir))).toBe(true)
    expect(readFileSync(join(only.path, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
      '{"name":"review-skills"}',
    )
  })

  it('returns the sub-path when the source names one', async () => {
    const tgz = await recordArchive()
    const fetch = async () => createReadStream(tgz)
    const [only] = await materialiseSkills([{ ...gitSource, path: 'test-coverage' }], cacheDir, {
      fetch,
    })
    expect(only.id).toBe('crissmoldovan/review-skills@v0.3.0#test-coverage')
    expect(readFileSync(join(only.path, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
      '{"name":"test-coverage"}',
    )
  })

  it('does not download a second time for the same repo@ref', async () => {
    const tgz = await recordArchive()
    let calls = 0
    const fetch = async () => {
      calls += 1
      return createReadStream(tgz)
    }
    const first = await materialiseSkills([gitSource], cacheDir, { fetch })
    const second = await materialiseSkills(
      [gitSource, { ...gitSource, path: 'test-coverage' }],
      cacheDir,
      {
        // Counts as well as throws: materialiseGit swallows a fetch failure when the entry is
        // already there (another run may have won the race), so a fetch that only threw would be
        // invisible to this test and the cache check could be deleted without it noticing.
        fetch: async () => {
          calls += 1
          throw new Error('a cache hit must not fetch')
        },
      },
    )
    expect(calls).toBe(1)
    expect(second[0].path).toBe(first[0].path)
    expect(second[1].path).toBe(join(first[0].path, 'test-coverage'))
  })

  // Design §4.7: "mounted read-only for the run".
  it('leaves the cache entry read-only', async () => {
    const tgz = await recordArchive()
    const [only] = await materialiseSkills([gitSource], cacheDir, {
      fetch: async () => createReadStream(tgz),
    })
    expect(statSync(only.path).mode & 0o222).toBe(0)
    expect(statSync(join(only.path, '.claude-plugin', 'plugin.json')).mode & 0o222).toBe(0)
  })

  it('refuses a sub-path that climbs out of the source', async () => {
    const tgz = await recordArchive()
    await expect(
      materialiseSkills([{ ...gitSource, path: '../../etc' }], cacheDir, {
        fetch: async () => createReadStream(tgz),
      }),
    ).rejects.toThrow(/escapes the skill source/)
  })
})

describe('materialiseSkills feeds buildArgv', () => {
  it('mounts every materialised path, git and dir alike, with --plugin-dir', async () => {
    const tgz = await recordArchive()
    const local = join(root, 'security-pass')
    mkdirSync(local)
    const skills = await materialiseSkills([{ kind: 'dir', path: local }, gitSource], cacheDir, {
      fetch: async () => createReadStream(tgz),
    })
    const argv = buildArgv(
      inputFixture({
        checkoutDir: join(root, 'checkout'),
        skillDirs: skills.map((s) => s.path),
      }),
    )
    expect(argv.slice(-4)).toEqual([
      '--plugin-dir',
      skills[0].path,
      '--plugin-dir',
      skills[1].path,
    ])
    // And the ids, which is what the review record stores (core/record.ts, Task 12b).
    expect(skills.map((s) => s.id)).toEqual([local, 'crissmoldovan/review-skills@v0.3.0'])
  })

  it('cannot mount a skill that is really inside the checkout', async () => {
    const checkout = join(root, 'checkout')
    mkdirSync(join(checkout, '.claude', 'skills', 'evil'), { recursive: true })
    const link = join(root, 'looks-innocent')
    symlinkSync(join(checkout, '.claude', 'skills', 'evil'), link)
    const skills = await materialiseSkills([{ kind: 'dir', path: link }], cacheDir)
    expect(() =>
      buildArgv(inputFixture({ checkoutDir: checkout, skillDirs: skills.map((s) => s.path) })),
    ).toThrow(/inside the checkout/)
  })
})

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  defaultSkillCacheDir, materialiseSkills, runCheckPass, runEngine, runRecheckPass,
} from '@review-agent/core'
import { describe, expect, it } from 'vitest'
import { downloadArchive } from './archive'
import { defaultRunReviewDeps } from './deps'
import { fetchPullRequest } from './pr'
import { fetchRepoConfig } from './repo-config'

describe('defaultRunReviewDeps (spec 0.2.0 §3.1)', () => {
  it('wires the real collaborators: GitHub, the archive, the skills and the three passes', () => {
    const d = defaultRunReviewDeps({ note: () => undefined })
    expect(d.fetchPullRequest).toBe(fetchPullRequest)
    expect(d.fetchRepoConfig).toBe(fetchRepoConfig)
    expect(d.downloadArchive).toBe(downloadArchive)
    expect(d.materialiseSkills).toBe(materialiseSkills)
    expect(d.runEngine).toBe(runEngine)
    expect(d.runCheckPass).toBe(runCheckPass)
    expect(d.runRecheckPass).toBe(runRecheckPass)
  })

  it('gives each review a new checkout of its own, under the system temp directory by default', async () => {
    const d = defaultRunReviewDeps({ note: () => undefined })
    const first = await d.makeCheckoutDir()
    const second = await d.makeCheckoutDir()
    try {
      expect(first).not.toBe(second)
      expect(dirname(first)).toBe(tmpdir())
      expect(existsSync(first) && existsSync(second)).toBe(true)
    } finally {
      await rm(first, { recursive: true, force: true })
      await rm(second, { recursive: true, force: true })
    }
  })

  it('puts checkouts under the work directory it is given', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'ra-workdir-'))
    try {
      const dir = await defaultRunReviewDeps({ note: () => undefined, workDir }).makeCheckoutDir()
      expect(dirname(dir)).toBe(workDir)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('caches skills in this OS’s own cache directory unless it is given one', () => {
    expect(defaultRunReviewDeps({ note: () => undefined }).skillCacheDir()).toBe(defaultSkillCacheDir())
    const named = join(tmpdir(), 'ra-skills-named')
    expect(defaultRunReviewDeps({ note: () => undefined, skillCacheDir: named }).skillCacheDir()).toBe(named)
  })

  it('refuses a relative directory, rather than resolving it against wherever the process started', () => {
    expect(() => defaultRunReviewDeps({ note: () => undefined, workDir: 'checkouts' })).toThrow(TypeError)
    expect(() => defaultRunReviewDeps({ note: () => undefined, skillCacheDir: 'skills' })).toThrow(TypeError)
  })

  // Spec 0.2.0 §8.3 point 4: on a laptop, CI or a VPS, the focuses of a multi-reviewer review run side
  // by side; a host short of memory says how many.
  it('runs every focused reviewer at once unless it is told how many may run', () => {
    expect(defaultRunReviewDeps({ note: () => undefined }).concurrency).toBe(3)
    expect(defaultRunReviewDeps({ note: () => undefined, concurrency: 1 }).concurrency).toBe(1)
  })

  it('refuses a concurrency that is not a whole number of at least one', () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => defaultRunReviewDeps({ note: () => undefined, concurrency })).toThrow(TypeError)
    }
  })

  it('says progress where it is told to', () => {
    const said: string[] = []
    defaultRunReviewDeps({ note: (s) => { said.push(s) } }).note('downloading')
    expect(said).toEqual(['downloading'])
  })
})

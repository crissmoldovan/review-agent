import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  defaultSkillCacheDir, materialiseSkills, runCheckPass, runEngine, runRecheckPass,
} from '@review-agent/core'
import { downloadArchive } from './archive'
import { fetchPullRequest } from './pr'
import { fetchRepoConfig } from './repo-config'
import type { RunReviewDeps } from './run-review'

/** The real collaborators of `runReview`: GitHub, the engine and its three passes, and where the
 *  downloaded code and the skills go. Until 0.2.0 the CLI and the App's runner each wrote this list
 *  out for themselves (spec 0.2.0 §3.1); now both start from here and change only what is theirs.
 *
 *  - `note`: progress somebody is waiting on — the CLI's stderr, the runner's logger.
 *  - `workDir`: where checkouts go, each in a new directory of its own; the system temp directory
 *    when left out. Two reviews can share a machine, and a checkout that leaked into another
 *    review's tree would be the reviewed code reviewing itself.
 *  - `skillCacheDir`: where skills are cached; this OS's own cache directory when left out (spec
 *    0.2.0 §9.3 P13).
 *
 *  Both directories must be absolute. A relative one is a programmer's error, refused here rather
 *  than resolved against whatever directory the process happened to start in. */
export const defaultRunReviewDeps = (a: {
  note: (s: string) => void
  workDir?: string
  skillCacheDir?: string
}): RunReviewDeps => {
  if (a.workDir !== undefined && !isAbsolute(a.workDir)) {
    throw new TypeError(`workDir must be an absolute path: ${a.workDir}`)
  }
  if (a.skillCacheDir !== undefined && !isAbsolute(a.skillCacheDir)) {
    throw new TypeError(`skillCacheDir must be an absolute path: ${a.skillCacheDir}`)
  }
  const workDir = a.workDir
  const skillCacheDir = a.skillCacheDir
  return {
    fetchPullRequest, fetchRepoConfig, downloadArchive, materialiseSkills, runEngine, runCheckPass,
    runRecheckPass,
    makeCheckoutDir: () => mkdtemp(join(workDir ?? tmpdir(), 'review-agent-')),
    // Lazily: the default reads the home directory, which a review with no skills never needs.
    skillCacheDir: () => skillCacheDir ?? defaultSkillCacheDir(),
    now: () => new Date(),
    note: a.note,
  }
}

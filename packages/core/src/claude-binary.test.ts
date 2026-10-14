import { chmodSync, existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveClaudeBinary } from './cli-process'
import { runEngine } from './engine'
import { fixturePath } from '../test/fixture'
import { inputFixture } from '../test/helpers/engine-input'

/** A filesystem where exactly these paths are executable files. */
const only = (...paths: string[]) => (p: string): boolean => paths.includes(p)
const identity = (p: string): string => p

/** The first lines of the placeholder `@anthropic-ai/claude-code` ships as `bin/claude.exe` until its
 *  install script replaces it (2.1.300, read 2026-10-14: 500 bytes, a shell script). */
const NPM_STUB = 'echo "Error: claude native binary not installed." >&2\necho "" >&2\n' +
  'echo "Either postinstall did not run (--ignore-scripts, some pnpm configs)" >&2\nexit 1\n'
/** A filesystem whose small files are these, by path; every other file is too large to read. */
const smallFiles = (files: Record<string, string>) => (p: string, maxBytes: number): string | null => {
  const text = files[p]
  return text !== undefined && Buffer.byteLength(text) <= maxBytes ? text : null
}

describe('resolveClaudeBinary — never a bare name, never inside the code under review', () => {
  describe('Windows: the OS would search the working directory before PATH', () => {
    const checkout = 'C:\\Users\\dev\\AppData\\Local\\Temp\\review-agent-abc'

    it('returns claude.exe from an absolute PATH directory as an absolute path', () => {
      const bin = resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity,
        env: { Path: 'C:\\Windows\\system32;C:\\Users\\dev\\.local\\bin' },
        isExecutableFile: only('C:\\Users\\dev\\.local\\bin\\claude.exe', `${checkout}\\claude.exe`),
      })
      // The planted one at the checkout root exists too. Handing `spawn` an absolute path is what
      // keeps Windows from looking in the working directory at all.
      expect(bin).toBe('C:\\Users\\dev\\.local\\bin\\claude.exe')
    })

    it('skips the empty, relative and in-checkout PATH entries that would reach a planted claude.exe', () => {
      expect(() => resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity,
        env: { PATH: `;.;src;${checkout};${checkout}\\tools` },
        isExecutableFile: only(`${checkout}\\claude.exe`, `${checkout}\\tools\\claude.exe`, 'src\\claude.exe'),
      })).toThrow(/Claude Code was not found/)
    })

    it('does not accept an npm .cmd shim, and says how to install the real binary', () => {
      expect(() => resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity,
        env: { Path: 'C:\\Users\\dev\\AppData\\Roaming\\npm' },
        isExecutableFile: only('C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd'),
      })).toThrow(/install\.ps1|WinGet|REVIEW_AGENT_CLAUDE_BIN/)
    })

    // Spec 0.2.0 §9.3 P2. npm puts only shims on PATH; the binary it installed sits in the package,
    // beside them. The shim itself is still never run — it needs a shell.
    it('finds the native binary inside the npm package next to a claude.cmd shim', () => {
      const npm = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
      const bin = resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity, readSmallFile: smallFiles({}),
        env: { Path: npm },
        isExecutableFile: only(`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`),
      })
      expect(bin).toBe(`${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`)
    })

    it('finds it from a project’s node_modules\\.bin, where a local install puts the shim', () => {
      const project = 'D:\\work\\service'
      const bin = resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity, readSmallFile: smallFiles({}),
        env: { Path: `${project}\\node_modules\\.bin` },
        isExecutableFile: only(
          `${project}\\node_modules\\.bin\\claude.cmd`,
          `${project}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
        ),
      })
      expect(bin).toBe(`${project}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`)
    })

    it('does not look inside a package that has no shim beside it', () => {
      // Without the shim this is not an npm bin directory, and a package directory under it is not
      // something anybody put on PATH to be run.
      const dir = 'C:\\tools'
      expect(() => resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity, readSmallFile: smallFiles({}),
        env: { Path: dir },
        isExecutableFile: only(`${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`),
      })).toThrow(/Claude Code was not found/)
    })

    it('reports npm\'s placeholder by name, and says what to do, when that is all there is', () => {
      const npm = 'C:\\Users\\dev\\AppData\\Roaming\\npm'
      const placeholder = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
      expect(() => resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity,
        env: { Path: npm }, isExecutableFile: only(`${npm}\\claude.cmd`, placeholder),
        readSmallFile: smallFiles({ [placeholder]: NPM_STUB }),
      })).toThrow(/^Claude Code's native binary is not installed — npm skipped its install script\. .*install script allowed.*install\.ps1/)
    })

    it('reads PATH whatever its case, as Windows spells it Path', () => {
      const bin = resolveClaudeBinary({
        platform: 'win32', avoidDir: checkout, realpath: identity,
        env: { pAtH: 'D:\\tools' }, isExecutableFile: only('D:\\tools\\claude.exe'),
      })
      expect(bin).toBe('D:\\tools\\claude.exe')
    })
  })

  describe('POSIX', () => {
    const checkout = '/tmp/review-agent-abc'

    it('skips "", "." and relative PATH entries, which mean the working directory', () => {
      const bin = resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity,
        env: { PATH: `::.:bin:/usr/local/bin` },
        isExecutableFile: only('claude', './claude', 'bin/claude', '/usr/local/bin/claude'),
      })
      expect(bin).toBe('/usr/local/bin/claude')
    })

    it('skips a PATH directory that is, or is inside, the checkout', () => {
      const bin = resolveClaudeBinary({
        platform: 'darwin', avoidDir: checkout, realpath: identity,
        env: { PATH: `${checkout}:${checkout}/node_modules/.bin:/opt/homebrew/bin` },
        isExecutableFile: only(`${checkout}/claude`, `${checkout}/node_modules/.bin/claude`, '/opt/homebrew/bin/claude'),
      })
      expect(bin).toBe('/opt/homebrew/bin/claude')
    })

    it('does not mistake a sibling directory whose name starts like the checkout for the checkout', () => {
      const bin = resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity,
        env: { PATH: `${checkout}-tools` }, isExecutableFile: only(`${checkout}-tools/claude`),
      })
      expect(bin).toBe(`${checkout}-tools/claude`)
    })

    // Spec 0.2.0 §9.3 P2, §9.4: npm 12 no longer runs a dependency's install script by default, and
    // Claude Code's npm package is a 500-byte placeholder until its script runs.
    it('passes over npm\'s placeholder for a real binary later on PATH', () => {
      const bin = resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity,
        env: { PATH: '/usr/local/bin:/home/dev/.local/bin' },
        isExecutableFile: only('/usr/local/bin/claude', '/home/dev/.local/bin/claude'),
        readSmallFile: smallFiles({ '/usr/local/bin/claude': NPM_STUB }),
      })
      expect(bin).toBe('/home/dev/.local/bin/claude')
    })

    it('names npm\'s placeholder, and the fix, when it is the only candidate', () => {
      expect(() => resolveClaudeBinary({
        platform: 'darwin', avoidDir: checkout, realpath: identity,
        env: { PATH: '/opt/homebrew/bin' }, isExecutableFile: only('/opt/homebrew/bin/claude'),
        readSmallFile: smallFiles({ '/opt/homebrew/bin/claude': NPM_STUB }),
      })).toThrow(/^Claude Code's native binary is not installed — npm skipped its install script\. \/opt\/homebrew\/bin\/claude is the placeholder.*install\.sh/)
    })

    it('names it too when REVIEW_AGENT_CLAUDE_BIN points at it', () => {
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity,
        env: { REVIEW_AGENT_CLAUDE_BIN: '/app/node_modules/.bin/claude' },
        readSmallFile: smallFiles({ '/app/node_modules/.bin/claude': NPM_STUB }),
      })).toThrow(/native binary is not installed/)
    })

    it('reads at most 4 KiB of a candidate, and nothing of one larger than that', () => {
      const asked: number[] = []
      resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity,
        env: { PATH: '/usr/bin' }, isExecutableFile: only('/usr/bin/claude'),
        readSmallFile: (_p, maxBytes) => { asked.push(maxBytes); return null },
      })
      expect(asked).toEqual([4096])
    })

    it('fails, naming what to do, when nothing is found', () => {
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: checkout, realpath: identity, env: { PATH: '/usr/bin' }, isExecutableFile: only(),
      })).toThrow(/Claude Code was not found.*REVIEW_AGENT_CLAUDE_BIN/)
    })
  })

  describe('REVIEW_AGENT_CLAUDE_BIN', () => {
    it('wins over PATH when it is absolute and outside the checkout', () => {
      expect(resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity,
        env: { REVIEW_AGENT_CLAUDE_BIN: '/app/node_modules/.bin/claude', PATH: '/usr/bin' },
        isExecutableFile: only('/usr/bin/claude'),
      })).toBe('/app/node_modules/.bin/claude')
    })

    it.each([
      ['a bare name', 'claude'],
      ['a relative path', 'tools/claude'],
      ['a Windows bare name', 'claude.exe'],
    ])('refuses %s, which could resolve inside the code under review', (_n, value) => {
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity, env: { REVIEW_AGENT_CLAUDE_BIN: value },
      })).toThrow(/must be an absolute path/)
    })

    it('refuses a path inside the checkout, including through a symlink', () => {
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity,
        env: { REVIEW_AGENT_CLAUDE_BIN: '/tmp/checkout/claude' },
      })).toThrow(/inside the checkout/)
      // /usr/local/bin/claude is a symlink into the checkout: the real path decides.
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout',
        realpath: (p) => (p === '/usr/local/bin/claude' ? '/tmp/checkout/bin/claude' : p),
        env: { REVIEW_AGENT_CLAUDE_BIN: '/usr/local/bin/claude' },
      })).toThrow(/inside the checkout/)
    })

    it('gives way to runtime.bin, which is held to the same rules', () => {
      expect(resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity, bin: '/opt/claude/2.1.258/claude',
        env: { REVIEW_AGENT_CLAUDE_BIN: '/app/node_modules/.bin/claude' },
      })).toBe('/opt/claude/2.1.258/claude')
      expect(() => resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity, bin: '/tmp/checkout/claude', env: {},
      })).toThrow(/^runtime\.bin points inside the checkout/)
    })

    it('treats an empty value as unset', () => {
      expect(resolveClaudeBinary({
        platform: 'linux', avoidDir: '/tmp/checkout', realpath: identity,
        env: { REVIEW_AGENT_CLAUDE_BIN: '', PATH: '/usr/bin' }, isExecutableFile: only('/usr/bin/claude'),
      })).toBe('/usr/bin/claude')
    })
  })
})

// The real thing, on this machine: a pull request that plants an executable `claude` in its checkout,
// with PATH entries that would reach it. The planted file must never run; the real one must.
describe.skipIf(process.platform === 'win32')('a planted claude in the checkout is never run', () => {
  const fakeCli = fileURLToPath(new URL('../test/fake-claude.mjs', import.meta.url))
  const savedPath = process.env.PATH
  let checkout: string
  let marker: string

  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), 'checkout-'))
    marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'planted-ran')
    const planted = join(checkout, 'claude')
    writeFileSync(planted, `#!/bin/sh\ntouch '${marker}'\necho '{}'\n`)
    chmodSync(planted, 0o755)
    const goodDir = mkdtempSync(join(tmpdir(), 'good-bin-'))
    symlinkSync(fakeCli, join(goodDir, 'claude'))
    delete process.env.REVIEW_AGENT_CLAUDE_BIN
    process.env.PATH = `.::${checkout}:${goodDir}:${savedPath ?? ''}`
    process.env.FAKE_CLAUDE_FIXTURE = fixturePath('cli/success-opus-low.json')
  })

  afterEach(() => {
    process.env.PATH = savedPath
    delete process.env.FAKE_CLAUDE_FIXTURE
  })

  it('runs the Claude Code on PATH, not the one the pull request added', async () => {
    const r = await runEngine(inputFixture({ checkoutDir: checkout }))
    expect(existsSync(marker)).toBe(false)
    expect(r.failure).toBeNull()
  })

  it('refuses a REVIEW_AGENT_CLAUDE_BIN that points at the planted file, before running anything', async () => {
    process.env.REVIEW_AGENT_CLAUDE_BIN = join(checkout, 'claude')
    try {
      await expect(runEngine(inputFixture({ checkoutDir: checkout }))).rejects.toThrow(/inside the checkout/)
      expect(existsSync(marker)).toBe(false)
    } finally {
      delete process.env.REVIEW_AGENT_CLAUDE_BIN
    }
  })
})

// The real file, read the real way: a placeholder with the bytes npm ships, executable as npm makes it.
describe.skipIf(process.platform === 'win32')('npm\'s placeholder on disk', () => {
  it('is recognised by what it says, and a large file is never read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'npm-bin-'))
    const placeholder = join(dir, 'claude')
    writeFileSync(placeholder, `#!/bin/sh\n${NPM_STUB}`)
    chmodSync(placeholder, 0o755)
    expect(() => resolveClaudeBinary({ env: { PATH: dir }, avoidDir: '/nonexistent-checkout' }))
      .toThrow(/native binary is not installed/)

    // Larger than 4 KiB, with the same words in its first bytes: never judged, because a large file is
    // not read at all. The real binary is ~200 MB, and nothing promises it does not carry that string.
    writeFileSync(placeholder, `#!/bin/sh\n${NPM_STUB}${'#'.repeat(5000)}\n`)
    expect(resolveClaudeBinary({ env: { PATH: dir }, avoidDir: '/nonexistent-checkout' })).toBe(placeholder)
  })
})

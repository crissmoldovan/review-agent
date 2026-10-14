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

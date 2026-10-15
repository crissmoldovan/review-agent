import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLI_VERSION } from './version'

describe('the version `review-agent --version` prints', () => {
  it('is the version in this package’s manifest, which is the one npm publishes', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(CLI_VERSION).toBe(manifest.version)
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

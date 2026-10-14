import { describe, expect, it } from 'vitest'
import { readFixture } from '../test/fixture'

describe('toolchain', () => {
  it('runs TypeScript under vitest and can read a recorded engine result', () => {
    const recorded = readFixture('cli/success-opus-low.json') as { subtype: string }
    expect(recorded.subtype).toBe('success')
  })
})

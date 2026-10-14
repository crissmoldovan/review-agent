// A type-only import is erased by TypeScript and cannot write anything by itself. It fails anyway,
// on purpose: the init half has no business naming the filesystem in any form, and the distance
// between this line and one that writes a file is a single keyword.
import type { PathLike } from 'node:fs'
import type { ConvertedApp } from '@review-agent/app'

export const destination = (app: ConvertedApp): PathLike => `app-${app.id}.pem`

// `commander` is a real dependency of this package and an innocent one. The violation is not what
// it does, it is that the init half named a package the rule has never been told about: a logger,
// or `write-file-atomic`, or a crash reporter arrives in a diff looking exactly like this, and the
// capability it brings is invisible unless adding one has to be argued for.
import type { ConvertedApp } from '@review-agent/app'
import { Command } from 'commander'

export const named = (app: ConvertedApp): string => new Command().name(app.slug).name()

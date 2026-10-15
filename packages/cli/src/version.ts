// A named import, so the build inlines this one string and not the whole manifest: `dist/index.js`
// then carries its own version and reads no file at run time, which is what makes `--version` right
// from an installed package, wherever npm put it (spec 0.2.0 §5.1). In the workspace the same line
// reads `packages/cli/package.json`, so there is one number and it is the one npm publishes.
import { version } from '../package.json'

export const CLI_VERSION: string = version

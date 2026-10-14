// The CLI's contract with whatever runs it. 1 is reserved for an engine failure, which is why the
// commander wiring in index.ts overrides commander's own exit code of 1 for a bad flag.
export const EXIT_OK = 0
export const EXIT_ENGINE_FAILURE = 1
export const EXIT_BAD_USAGE = 2
export const EXIT_SECRET_LEAK = 3

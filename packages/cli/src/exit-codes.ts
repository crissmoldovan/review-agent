// The CLI's contract with whatever runs it. 1 is reserved for an engine failure, which is why the
// commander wiring in index.ts overrides commander's own exit code of 1 for a bad flag.
export const EXIT_OK = 0
export const EXIT_ENGINE_FAILURE = 1
export const EXIT_BAD_USAGE = 2
export const EXIT_SECRET_LEAK = 3
// Spec 0.2.0 §5.5: the review ran and was paid for, and GitHub would not take it. Its own code, so a
// script can tell "nothing to show" (1) from "the review is on stdout but not on the pull request" —
// the review is printed either way, so the money is not lost with the post.
export const EXIT_POST_FAILED = 4
// Not a result of the review: what a second Ctrl-C exits with, without waiting for the review to stop
// (interrupt.ts). 128 + SIGINT, which is what a shell reports for a process Ctrl-C ended.
export const EXIT_INTERRUPTED = 130

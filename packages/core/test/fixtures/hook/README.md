One `PostToolUse` hook event, in the shape the Claude Code CLI delivers it to a hook command. What it
is evidence *of* is an absence: the payload carries no cost, no token count and no usage of any kind,
which is why the spend-triggered wrap-up of design §4.4 could not be built. `engine-wrapup.test.ts`
asserts that absence against this file, so the day the CLI starts putting spend on the event and this
fixture is refreshed from it, that test fails and says to revisit.

The keys, their order and the non-identifying values (`permission_mode`, `effort`,
`hook_event_name`, `tool_name`, the shape of `tool_response`) are as the CLI emitted them. The
identifying values are placeholders: session, prompt and tool-use ids are zeros, the paths are those of
a CI runner checking out a fictional `acme/widgets`, and the file the event reports reading is a small
invented `src/retry.ts`. The JSON is pretty-printed for reading.

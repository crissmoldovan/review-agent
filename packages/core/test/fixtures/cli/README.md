# CLI result documents

`claude -p --output-format json` result documents, in the shape the CLI emits, for the engine tests
to parse. The suite never regenerates them and never calls a model.

**The review content is synthetic.** Summaries, findings, verdicts, file paths and code are invented,
about a fictional repository (`acme/widgets`); they quote no real project. The envelopes around that
content — field names and order, `subtype`, `terminal_reason`, `is_error`, usage, cost, turns and
durations — keep the values the CLI reported on the measurement runs of design §8, because the
engine's handling of those fields is what the tests check. Session ids are placeholders.

Do not "tidy" these files. The engine parses them as the CLI emits them, unknown keys and all.

| File | subtype | terminal_reason | cost | what it is |
|---|---|---|---|---|
| success-opus-low.json | success | completed | $1.2494105 | Opus 5 at low effort, 4 findings, 2 inconclusive, 18 turns. Every `suggestion` a string, no `end_line` key |
| success-null-suggestion.json | success | completed | $1.0738455 | 5 findings, **every `suggestion` is `null`**, no `end_line` key — design §4.5's regression |
| success-end-line.json | success | completed | $0.4993574 | 2 findings with `end_line` present (54, 57) and **no `suggestion` key at all** — absent vs null |
| failure-budget.json | error_max_budget_usd | budget_exhausted | $2.3241860 | the ceiling fired and the run returned nothing at all |
| failure-schema.json | error_max_structured_output_retries | structured_output_retry_exhausted | $0.254643 | 5 attempts, no valid structured output |
| failure-budget-partial.json | error_max_budget_usd | budget_exhausted | $1.2494105 | success-opus-low's output under a budget failure: no measured run produced this shape. Design §4.4 item 3 — findings survive the ceiling. It says so in its own `_fixture_note` |
| check-verdicts.json | success | completed | $0.6282085 | the check pass on 7 findings: 4 confirmed, 2 refuted, 1 uncertain, 8 turns |
| failure-not-logged-in.json | success, **`is_error: true`** | api_error | $0 | the CLI run with no login in its environment, which never reaches the model. The first line of stdout only; with `--strict-mcp-config` absent the CLI also prints a log line, which the reviewer's flags suppress. Note `subtype` says success while `is_error` says otherwise — the field to trust is `is_error` |
| recheck-judgements.json | success | completed | $0.0981234 | the re-review pass on 3 earlier findings: one `resolved`, one `still-present`, one `cannot-tell`, 4 turns. A minimal envelope, written by hand |

Costs are per-token API prices as the CLI reported them.

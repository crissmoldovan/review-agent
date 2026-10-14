// The terminal half of the rule. `console.log` reaches the same scrollback, shell history and
// `script(1)` log that the injected sinks are audited for, and reaches it without passing through
// `InitDeps` at all — which is why the test that inspects the injected sinks cannot see this.
import type { ConvertedApp } from '@review-agent/app'

export const show = (app: ConvertedApp): void => {
  console.log(app.pem.reveal())
}

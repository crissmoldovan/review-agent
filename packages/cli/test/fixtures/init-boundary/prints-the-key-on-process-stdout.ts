// The same escape one layer down: no `console`, just the stream the composition root wraps.
import type { ConvertedApp } from '@review-agent/app'

export const show = (app: ConvertedApp): void => {
  process.stdout.write(app.webhookSecret.reveal())
}

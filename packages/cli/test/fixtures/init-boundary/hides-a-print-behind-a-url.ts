// The comment-blanking half of the rule, proved from the side that matters. `//` inside a string is
// not a comment, so everything after this URL is still code — a scanner that blanked from the first
// `//` to the end of the line would lose the print that follows it and call this file clean.
import type { ConvertedApp } from '@review-agent/app'

export const show = (app: ConvertedApp): void => {
  const where = 'https://github.com/settings/apps'; console.log(where, app.pem.reveal())
}

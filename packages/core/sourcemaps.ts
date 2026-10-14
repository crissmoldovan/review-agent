/** Whether this package's published tarball carries `dist/*.map`.
 *
 *  OFF, and it stays off until Criss decides otherwise (open decision, 2026-09-14): tsup's maps
 *  embed `sourcesContent`, so a published map is this package's entire TypeScript source, whatever
 *  the GitHub repository's visibility is. Flipping this one constant changes both what tsup builds
 *  and what test/publishing.test.ts will allow in the tarball — there is no second place to edit. */
export const SHIP_SOURCEMAPS = false

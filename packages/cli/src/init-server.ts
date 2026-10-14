import { createServer } from 'node:http'
import type { AppManifest } from '@review-agent/app'

/** GitHub gives the manifest flow one hour (design §5). After that the code is worthless, so the
 *  command stops waiting rather than holding a port open for the rest of the day. */
export const MANIFEST_FLOW_MS = 60 * 60 * 1000

export type CodeListener = {
  /** The local page the operator opens: one button, which posts the manifest to GitHub. */
  formUrl: string
  /** The one-hour code, or a rejection when the hour runs out. */
  code: Promise<string>
  close: () => Promise<void>
}

const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export const listenForManifestCode = async (i: {
  registrationUrl: string
  state: string
  manifestFor: (redirectUrl: string) => AppManifest
  note: (s: string) => void
  timeoutMs?: number
}): Promise<CodeListener> => {
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (e: Error) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // The caller may be awaiting something else when the hour expires; without this, Node would
  // report the timeout rejection as unhandled and kill the process before the message is printed.
  code.catch(() => {})

  // 127.0.0.1, and a port the OS picks: the only client is the operator's own browser, sent back
  // here by GitHub's redirect. Nothing about this flow needs a port reachable from the internet.
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the local callback server did not bind a port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const manifest = i.manifestFor(`${origin}/callback`)
  const page = `<!doctype html>
<meta charset="utf-8">
<title>Register ${escapeHtml(manifest.name)}</title>
<body style="font: 16px/1.5 system-ui; max-width: 42em; margin: 4em auto">
<h1>Register ${escapeHtml(manifest.name)} on GitHub</h1>
<p>This posts the manifest below to GitHub. GitHub shows you what it is about to create, and you
confirm it there. Nothing is created by pressing this button alone.</p>
<form method="post" action="${escapeHtml(i.registrationUrl)}">
<!-- GitHub reads the manifest from a form field named \`manifest\`. That field name is NOT in the
     fetched documentation, which describes the flow in prose, so it is proven by the first real
     registration (this plan's last task) rather than assumed: if it is wrong GitHub answers with
     its own error page and nothing is silently created. -->
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit" style="font: inherit; padding: .5em 1em">Register on GitHub</button>
</form>
<pre style="background: #f6f8fa; padding: 1em; overflow-x: auto">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
</body>`

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state')
      // The registration URL carries `state`; that GitHub echoes it back on the redirect is not in
      // the fetched docs. A mismatch is refused — that is the case that matters. An absence is
      // accepted and reported, so the first real run records which of the two GitHub does.
      if (state !== null && state !== i.state) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('that callback did not come from the registration this command started')
        return
      }
      if (state === null) i.note('GitHub did not echo `state` on the redirect.')
      const received = url.searchParams.get('code')
      if (received === null || received === '') {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('that callback carried no code')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('Registered. Close this tab and go back to the terminal.')
      resolveCode(received)
      return
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nothing here')
  })

  const timer = setTimeout(() => {
    rejectCode(new Error(
      'the registration was not finished in time: GitHub gives the manifest flow one hour. ' +
      'Run `review-agent init` again.',
    ))
  }, i.timeoutMs ?? MANIFEST_FLOW_MS)
  timer.unref()

  return {
    formUrl: origin,
    code,
    close: async () => {
      clearTimeout(timer)
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    },
  }
}

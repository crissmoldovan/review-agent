import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { HeaderLookup } from '@review-agent/app/receiver'
import type { Logger } from './log'
import type { WebhookReply } from './webhook'

export const WEBHOOK_PATH = '/api/github/webhook'
export const HEALTH_PATH = '/healthz'

/** GitHub caps a webhook payload at 25 MB and drops a larger one undelivered; anything bigger than that
 *  did not come from GitHub, and is refused before it is read into memory. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024

export type HttpDeps = {
  webhook: (a: { rawBody: Uint8Array; headers: HeaderLookup }) => WebhookReply
  /** `null` while stopping, so a health check fails and nothing routes new work here. */
  health: () => Record<string, unknown> | null
  log: Logger
}

class TooLarge extends Error {}

/** The raw bytes as they arrived: the signature is over these, and nothing may parse them first. */
const readBody = (req: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop collecting; the answer below closes the connection once it is written.
        req.removeAllListeners('data')
        reject(new TooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(new Uint8Array(Buffer.concat(chunks))) })
    req.on('error', reject)
  })

const send = (res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void => {
  if (status === 204 || body === '') {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) }).end(body)
}

/** Two routes and nothing else: `POST /api/github/webhook` and `GET /healthz`. */
export const requestListener = (deps: HttpDeps): RequestListener => (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === HEALTH_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
    const health = deps.health()
    return health === null
      ? send(res, 503, JSON.stringify({ status: 'stopping' }), 'application/json')
      : send(res, 200, JSON.stringify({ status: 'ok', ...health }), 'application/json')
  }
  if (path !== WEBHOOK_PATH) return send(res, 404, 'not found')
  if (req.method !== 'POST') return send(res, 405, 'method not allowed')

  const declared = Number(req.headers['content-length'] ?? '0')
  if (declared > MAX_BODY_BYTES) return send(res, 413, 'too large')

  readBody(req).then(
    (rawBody) => {
      let reply: WebhookReply
      try {
        reply = deps.webhook({ rawBody, headers: req.headers })
      } catch (e) {
        // The handler answers every delivery itself; this is for the bug that makes it throw, which
        // would otherwise be an unhandled rejection and end the process with every queued review in it.
        deps.log.error('delivery failed: the webhook handler threw', { error: e })
        reply = { status: 500, body: 'internal error' }
      }
      send(res, reply.status, reply.body)
    },
    (e: unknown) => {
      if (e instanceof TooLarge) {
        res.writeHead(413, { connection: 'close', 'content-type': 'text/plain; charset=utf-8' })
          .end('too large', () => { req.destroy() })
        return
      }
      deps.log.warn('delivery dropped: the request body could not be read', { error: e })
      if (!res.headersSent && !res.destroyed) send(res, 400, 'bad request')
    },
  )
}

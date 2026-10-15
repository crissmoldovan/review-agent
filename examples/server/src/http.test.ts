import { createHmac } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HeaderLookup } from '@review-agent/app/receiver'
import { afterEach, describe, expect, it } from 'vitest'
import { HEALTH_PATH, MAX_BODY_BYTES, requestListener, WEBHOOK_PATH } from './http'
import { createLogger } from './log'
import type { WebhookReply } from './webhook'

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => { server?.close(() => { resolve() }) ?? resolve() })
  server = null
})

/** The listener on a real socket, with the webhook handler replaced by one that records what reached it. */
const serve = async (a: { reply?: WebhookReply; stopping?: boolean; throws?: boolean } = {}) => {
  const received: { rawBody: Uint8Array; headers: HeaderLookup }[] = []
  server = createServer(requestListener({
    webhook: (d) => {
      received.push(d)
      if (a.throws === true) throw new Error('a bug in the handler')
      return a.reply ?? { status: 202, body: 'queued' }
    },
    health: () => (a.stopping === true ? null : { waiting: 0, running: 0 }),
    log: createLogger({ secrets: () => [], write: () => {} }),
  }))
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return { url: (path: string) => `http://127.0.0.1:${port}${path}`, received }
}

describe('requestListener', () => {
  it('hands the webhook handler the exact bytes GitHub signed', async () => {
    const s = await serve()
    // Pretty-printed and non-ASCII: a parse-and-reserialise would change both.
    const body = Buffer.from(JSON.stringify({ title: 'Raise the ceiling — measured' }, null, 2), 'utf8')
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
    const res = await fetch(s.url(WEBHOOK_PATH), {
      method: 'POST', body, headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(202)
    expect(Buffer.from(s.received[0].rawBody).equals(body)).toBe(true)
    expect((s.received[0].headers as Record<string, string>)['x-hub-signature-256']).toBe(signature)
  })

  it("answers with the handler's status, and no body for a 204", async () => {
    const s = await serve({ reply: { status: 204, body: '' } })
    const res = await fetch(s.url(WEBHOOK_PATH), { method: 'POST', body: '{}' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('refuses a body larger than GitHub ever sends, without reading it or handing it on', async () => {
    const s = await serve()
    // Declared, not sent: the listener must answer from the header alone, before reading 25 MB.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(s.url(WEBHOOK_PATH), {
        method: 'POST', headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      }, (res) => {
        resolve(res.statusCode ?? 0)
        res.resume()
        req.destroy()
      })
      req.on('error', reject)
      req.write('{}')
    })
    expect(status).toBe(413)
    expect(s.received).toEqual([])
  })

  it('reports health, and fails it while stopping so nothing routes new work here', async () => {
    expect((await fetch((await serve()).url(HEALTH_PATH))).status).toBe(200)
    await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    expect((await fetch((await serve({ stopping: true })).url(HEALTH_PATH))).status).toBe(503)
  })

  it('answers 500 when the handler throws, and goes on serving', async () => {
    const s = await serve({ throws: true })
    expect((await fetch(s.url(WEBHOOK_PATH), { method: 'POST', body: '{}' })).status).toBe(500)
    expect((await fetch(s.url(HEALTH_PATH))).status).toBe(200)
  })

  it('serves nothing else', async () => {
    const s = await serve()
    expect((await fetch(s.url('/'))).status).toBe(404)
    expect((await fetch(s.url(WEBHOOK_PATH))).status).toBe(405)
    expect(s.received).toEqual([])
  })
})

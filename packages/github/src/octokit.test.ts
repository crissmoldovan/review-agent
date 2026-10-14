import { describe, expect, it } from 'vitest'
import { GITHUB_API_VERSION, octokitFor, pushAccessOf } from './octokit'

/** A fetch that records what it was asked and answers with one canned response. */
const recording = (answer: () => Response) => {
  const seen: { url: string; headers: Headers }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) })
    return answer()
  }
  return { fetch, seen }
}
const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('octokitFor', () => {
  it('pins the GitHub API version on every request, so a breaking version arrives as a diff here', async () => {
    const { fetch, seen } = recording(json({}))
    await octokitFor({ token: 'ghs_installation_FAKE', fetch }).request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'widgets' })
    expect(GITHUB_API_VERSION).toBe('2026-03-10')
    expect(seen[0]?.headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION)
    expect(seen[0]?.headers.get('authorization')).toBe('token ghs_installation_FAKE')
  })

  it('talks to github.com unless it is given a GitHub Enterprise Server address (spec 0.2.0 §4.2)', async () => {
    const dotcom = recording(json({}))
    await octokitFor({ token: 't', fetch: dotcom.fetch }).request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'widgets' })
    expect(dotcom.seen[0]?.url).toBe('https://api.github.com/repos/acme/widgets')

    const server = recording(json({}))
    await octokitFor({ token: 't', fetch: server.fetch, baseUrl: 'https://github.acme.example/api/v3' })
      .request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'widgets' })
    expect(server.seen[0]?.url).toBe('https://github.acme.example/api/v3/repos/acme/widgets')
    // The pin travels to the server too: it is a property of this product, not of github.com.
    expect(server.seen[0]?.headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION)
  })
})

describe('pushAccessOf', () => {
  const ask = (answer: () => Response, username = 'alice') =>
    pushAccessOf({ octokit: octokitFor({ token: 't', fetch: recording(answer).fetch }), owner: 'acme', repo: 'widgets', username })

  it('reads push access from GitHub’s own push boolean, and nothing weaker than write counts', async () => {
    // Criss, 2026-09-14 (decision 3). The shape was proven by hand at Step 27c.
    const reply = (push: boolean, permission: string, role_name: string) => ({
      permission, role_name,
      user: { login: 'alice', permissions: { admin: role_name === 'admin', maintain: false, push, triage: true, pull: true } },
    })
    expect(await ask(json(reply(true, 'admin', 'admin')))).toBe(true)
    expect(await ask(json(reply(true, 'write', 'maintain')))).toBe(true)
    expect(await ask(json(reply(true, 'write', 'write')))).toBe(true)
    expect(await ask(json(reply(false, 'read', 'triage')))).toBe(false)
    expect(await ask(json(reply(false, 'read', 'read')))).toBe(false)
    expect(await ask(json(reply(false, 'none', 'none')))).toBe(false)
    // One field decides, so there is one field for a deployment's own checks to agree on: a coarse
    // `permission` word is not consulted, and a response without the boolean is a refusal.
    expect(await ask(json({ permission: 'write', role_name: 'write', user: { permissions: { push: false } } }))).toBe(false)
    expect(await ask(json({ permission: 'admin', role_name: 'admin' }))).toBe(false)
    expect(await ask(json({ unexpected: true }))).toBe(false)
  })

  it('treats somebody GitHub does not know on the repository as having no push access, and lets any other error out', async () => {
    expect(await ask(json({ message: 'x' }, 404), 'not-a-collaborator')).toBe(false)
    // A 403 or a 5xx is not an answer about the person. It is thrown, before the engine, where it
    // costs $0.
    await expect(ask(json({ message: 'x' }, 403))).rejects.toMatchObject({ status: 403 })
  })
})

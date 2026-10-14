import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Octokit } from '@octokit/core'
import { create } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadArchive, isCredentialPath, safeEntry, sanitiseCheckout } from './archive'

async function tmp(): Promise<string> { return mkdtemp(join(tmpdir(), 'ra-archive-')) }

async function tarballBytes(entries: (root: string) => Promise<void>): Promise<Buffer> {
  const src = await tmp()
  const root = join(src, 'acme-widgets-4f8e2a1')
  await mkdir(root, { recursive: true })
  await entries(root)
  const chunks: Buffer[] = []
  for await (const c of create({ gzip: true, cwd: src }, ['acme-widgets-4f8e2a1'])) {
    chunks.push(Buffer.from(c as Uint8Array))
  }
  return Buffer.concat(chunks)
}

const SIGNED = 'https://codeload.github.com/acme/widgets/legacy.tar.gz/4f8e2a1?token=signed'
const redirectTo = (location: string) =>
  vi.fn(async (_route: string, _params: Record<string, unknown>) =>
    ({ status: 302, headers: { location }, data: undefined }))

afterEach(() => { vi.unstubAllGlobals() })

describe('safeEntry', () => {
  it('accepts an ordinary entry', () => {
    expect(safeEntry('widgets-4f8e2a1/.github/workflows/publish.yml')).toBe(true)
  })
  it('refuses an absolute path', () => {
    expect(safeEntry('/etc/passwd')).toBe(false)
    expect(safeEntry('C:/Windows/system32')).toBe(false)
  })
  it('refuses a path that climbs out', () => {
    expect(safeEntry('widgets-4f8e2a1/../../etc/passwd')).toBe(false)
  })
})

// Criss, 2026-09-13, after three rounds of security review each found a new way past a rule that
// JUDGED credential files: case (`.NPMRC`), a parser differential (a bare CR hiding a token behind a
// comment line), and npm's own expansion of `${VAR?}` in KEYS plus an escaped PEM header — each one
// proven against real npm, which sent the token. Trying to predict everything npm does with a file
// was the defect. The reviewer does not need these files to review code, and a change to one is
// still in the diff. So they are REMOVED from the working copy before the model starts: nothing in a
// file that is not there can reach the model, whatever trick the file contains.
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

describe('isCredentialPath', () => {
  it.each([
    '.npmrc', '.NPMRC', '.NpmRc', 'packages/app/.npmrc',
    '.netrc', '_netrc', '.git-credentials', '.pypirc', '.yarnrc', '.yarnrc.yml', 'pip.conf', '.dockercfg',
    '.pgpass', '.htpasswd',
    '.env', '.env.local', '.env.production', 'apps/web/.env.development.local',
    'id_rsa', 'id_ed25519', '.ssh/id_ecdsa',
    'server.key', 'certs/client.pem', 'keystore.p12', 'store.pfx', 'release.jks', 'app.keystore',
    '.docker/config.json', '.aws/credentials', '.kube/config',
  ])('treats %s as a credential file', (path) => {
    expect(isCredentialPath(path)).toBe(true)
  })

  // Every one of these is ordinary source a reviewer needs, or a template that exists precisely so a
  // real value is never committed. Removing them would make the review worse and protect nothing.
  it.each([
    '.env.example', '.env.sample', '.env.template', '.env.dist', 'apps/web/.env.example',
    'id_rsa.pub', 'README.md', 'src/index.ts', 'package.json', 'config.json', 'docs/.env.md',
    'npmrc', '.npmrc.md', 'key.ts', 'src/keys.ts', '.dockerignore', 'docker/config.json.example',
  ])('leaves %s alone', (path) => {
    expect(isCredentialPath(path)).toBe(false)
  })
})

describe('sanitiseCheckout', () => {
  it("removes a repository's .npmrc and leaves the code alone", async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(dir, '.npmrc'), '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n')
    expect(await sanitiseCheckout(dir)).toEqual({ gitDirs: [], removed: ['.npmrc'] })
    expect(await exists(join(dir, '.npmrc'))).toBe(false)
    expect(await readFile(join(dir, 'src/index.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('reports nothing for a clean tree', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'README.md'), '# x\n')
    expect(await sanitiseCheckout(dir)).toEqual({ gitDirs: [], removed: [] })
  })

  it('removes nested credential files, in a stable order', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'apps/web'), { recursive: true })
    await writeFile(join(dir, 'apps/web/.env.local'), 'SECRET=1\n')
    await writeFile(join(dir, 'apps/web/.env.example'), 'SECRET=\n')
    await writeFile(join(dir, '.env'), 'SECRET=1\n')
    expect((await sanitiseCheckout(dir)).removed).toEqual(['.env', 'apps/web/.env.local'])
    expect(await exists(join(dir, 'apps/web/.env.example'))).toBe(true)
  })

  // Removing a symlink must remove the LINK. Following it would delete, or read, whatever it points at
  // — which could be outside the checkout entirely.
  it('removes a symlink named like a credential file without touching its target', async () => {
    const dir = await tmp()
    const outside = await tmp()
    await writeFile(join(outside, 'real'), 'keep me\n')
    await symlink(join(outside, 'real'), join(dir, '.npmrc'))
    expect((await sanitiseCheckout(dir)).removed).toEqual(['.npmrc'])
    expect(await exists(join(dir, '.npmrc'))).toBe(false)
    expect(await readFile(join(outside, 'real'), 'utf8')).toBe('keep me\n')
  })

  it('still reports a .git directory, and does not descend into it', async () => {
    const dir = await tmp()
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git/.npmrc'), 'x\n')
    expect(await sanitiseCheckout(dir)).toEqual({ gitDirs: ['.git'], removed: [] })
  })

  // The regression suite for every bypass three security reviews found against the old rule, as
  // real files. The old rule judged each of these and was fooled; the new one does not read them.
  it.each([
    ['round 1, case', '.NPMRC', `//registry.npmjs.org/:_authToken=npm_${'a'.repeat(36)}\n`],
    ['round 2, a bare CR behind a comment', '.npmrc', '//r/:_authToken=${NODE_AUTH_TOKEN}\n#\r//registry.npmjs.org/:_authToken=AbCdEf0123456789ZzYyXxToken4Private\n'],
    ['round 3, ${VAR?} in the key', '.npmrc', '//registry.npmjs.org/:_authToken${RA_UNSET?}=AbCdEf0123456789ZzYyXxToken4Private\n'],
    ['round 3, an escaped PEM header', '.npmrc', 'key="-----BEGIN\\u0020PRIVATE KEY-----\\nMIIE\\n-----END\\u0020PRIVATE KEY-----"\n'],
    ['round 3, a committed client key', 'client.key', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n'],
  ])('%s: the file is gone before the model could read it', async (_label, name, content) => {
    const dir = await tmp()
    await writeFile(join(dir, name), content)
    const out = await sanitiseCheckout(dir)
    expect(out.removed).toEqual([name])
    expect(await exists(join(dir, name))).toBe(false)
  })
})

describe('downloadArchive', () => {
  it('follows the 302 by hand, strips the top directory, and leaves no .git', async () => {
    const bytes = await tarballBytes(async (root) => {
      await mkdir(join(root, '.github/workflows'), { recursive: true })
      await writeFile(join(root, 'README.md'), '# widgets\n')
      await writeFile(join(root, '.github/workflows/publish.yml'), 'name: publish\n')
    })
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(bytes))
    vi.stubGlobal('fetch', fetchMock)
    const request = redirectTo(SIGNED)
    const dest = await tmp()

    const out = await downloadArchive({
      octokit: { request } as unknown as Octokit,
      owner: 'acme', repo: 'widgets', ref: '4f8e2a1c9b7d6e5f3a2b1c0d9e8f7a6b5c4d3e2f', destDir: dest,
    })

    expect(out).toEqual({ dir: dest, removed: [] })
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('# widgets\n')
    expect(await sanitiseCheckout(dest)).toEqual({ gitDirs: [], removed: [] })
    // one argument only: no headers, therefore no Authorization sent to codeload
    expect(fetchMock).toHaveBeenCalledWith(SIGNED)
    expect(fetchMock.mock.calls[0]).toHaveLength(1)
    expect(request.mock.calls[0][1]).toMatchObject({ request: { redirect: 'manual' } })
  })

  it("reviews an archive that carries a repository's .npmrc: the file is removed, not the review refused", async () => {
    const bytes = await tarballBytes(async (root) => {
      await writeFile(join(root, 'README.md'), '# widgets\n')
      await writeFile(join(root, '.npmrc'), '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n')
    })
    const fetchMock = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('fetch', fetchMock)
    const dest = await tmp()
    const octokit = { request: redirectTo(SIGNED) } as unknown as Octokit
    const out = await downloadArchive({ octokit, owner: 'acme', repo: 'widgets', ref: '4f8e2a1', destDir: dest })
    expect(out).toEqual({ dir: dest, removed: ['.npmrc'] })
    expect(await exists(join(dest, '.npmrc'))).toBe(false)
    expect((await stat(join(dest, 'README.md'))).isFile()).toBe(true)
  })

  it('throws when there is no redirect and no bytes', async () => {
    const request = vi.fn(async (_route: string, _params: Record<string, unknown>) =>
      ({ status: 200, headers: {}, data: undefined }))
    await expect(downloadArchive({
      octokit: { request } as unknown as Octokit,
      owner: 'acme', repo: 'widgets', ref: '4f8e2a1', destDir: await tmp(),
    })).rejects.toThrow('expected a 302 redirect or archive bytes')
  })

  it('refuses an archive that carries a .git directory', async () => {
    const bytes = await tarballBytes(async (root) => {
      await mkdir(join(root, '.git'), { recursive: true })
      await writeFile(join(root, '.git/config'), 'url = https://x-access-token:ghs_abc@github.com/o/r\n')
    })
    vi.stubGlobal('fetch', vi.fn(async (..._args: unknown[]) => new Response(bytes)))
    await expect(downloadArchive({
      octokit: { request: redirectTo(SIGNED) } as unknown as Octokit,
      owner: 'acme', repo: 'widgets', ref: '4f8e2a1', destDir: await tmp(),
    })).rejects.toThrow('archive carried a .git directory')
  })
})

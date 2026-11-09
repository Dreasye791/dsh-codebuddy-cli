import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEBUDDY_SHIM_ENDPOINT_FILENAME,
  clearShimEndpoint,
  codebuddyShimEndpointPath,
  writeShimEndpoint,
} from '../src/shim-endpoint.ts'

/**
 * The endpoint file is what makes the shim usable by another local program
 * (a chat bot, an editor). Its contract: live under `$DSH_HOME`, carry the
 * base URL the client appends `/chat/completions` to, carry the shim-local
 * bearer, and stay unreadable to other accounts (0600).
 */
let dir: string
let previousDshHome: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-shim-endpoint-'))
  previousDshHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = dir
})

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousDshHome
  await rm(dir, { recursive: true, force: true })
})

describe('shim endpoint file', () => {
  it('lives under DSH_HOME with a dotted name', () => {
    expect(codebuddyShimEndpointPath()).toBe(join(dir, CODEBUDDY_SHIM_ENDPOINT_FILENAME))
  })

  it('publishes the origin, the OpenAI root, the bearer and the model list', async () => {
    await writeShimEndpoint({
      baseUrl: 'http://127.0.0.1:45871',
      openaiBaseUrl: 'http://127.0.0.1:45871/v1',
      token: 'shim-secret',
      models: ['deepseek-v4.1-flash', 'glm-5.3'],
    })

    const document = JSON.parse(await readFile(codebuddyShimEndpointPath(), 'utf8')) as Record<string, unknown>
    expect(document['version']).toBe(1)
    expect(document['package']).toBe('dsh-codebuddy-cli')
    expect(document['baseUrl']).toBe('http://127.0.0.1:45871')
    expect(document['openaiBaseUrl']).toBe('http://127.0.0.1:45871/v1')
    expect(document['token']).toBe('shim-secret')
    expect(document['models']).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
    expect(typeof document['pid']).toBe('number')
    expect(typeof document['writtenAt']).toBe('number')
  })

  // The bearer is a live credential for the configured account; on POSIX the
  // file must not be world-readable.
  it.skipIf(process.platform === 'win32')('is readable only by the owner', async () => {
    await writeShimEndpoint({
      baseUrl: 'http://127.0.0.1:1',
      openaiBaseUrl: 'http://127.0.0.1:1/v1',
      token: 't',
      models: [],
    })
    const info = await stat(codebuddyShimEndpointPath())
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('replaces a previous publication rather than appending', async () => {
    await writeShimEndpoint({
      baseUrl: 'http://127.0.0.1:1',
      openaiBaseUrl: 'http://127.0.0.1:1/v1',
      token: 'first',
      models: ['a'],
    })
    await writeShimEndpoint({
      baseUrl: 'http://127.0.0.1:2',
      openaiBaseUrl: 'http://127.0.0.1:2/v1',
      token: 'second',
      models: ['b'],
    })
    const document = JSON.parse(await readFile(codebuddyShimEndpointPath(), 'utf8')) as Record<string, unknown>
    expect(document['token']).toBe('second')
    expect(document['models']).toEqual(['b'])
  })

  it('clears the file and tolerates an absent one', async () => {
    await writeShimEndpoint({
      baseUrl: 'http://127.0.0.1:1',
      openaiBaseUrl: 'http://127.0.0.1:1/v1',
      token: 't',
      models: [],
    })
    await clearShimEndpoint()
    await expect(readFile(codebuddyShimEndpointPath(), 'utf8')).rejects.toThrow()
    // Disposal can run twice (plugin teardown after a failed start).
    await expect(clearShimEndpoint()).resolves.toBeUndefined()
  })
})

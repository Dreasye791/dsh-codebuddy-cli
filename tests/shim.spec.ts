import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeBuddyCredentialStore } from '../src/auth.ts'
import { CodeBuddyCatalog } from '../src/catalog.ts'
import { createCodeBuddyShim, type CodeBuddyShim } from '../src/shim.ts'
import type { CodeBuddyChatResult } from '../src/upstream.ts'
import { turnFingerprint } from '../src/upstream.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: CodeBuddyShim
  store: CodeBuddyCredentialStore
  upstreamBodies: string[]
  upstreamHeaders: (Record<string, string> | undefined)[]
  upstreamResponse: () => CodeBuddyChatResult
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startShim(
  upstreamResponse: () => CodeBuddyChatResult,
  turnIdFor?: (sessionId: string | undefined) => string | undefined,
  logger?: { warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void },
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const cli = join(dir, 'Tencent-Cloud.coding-copilot.info')
  await writeFile(cli, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new CodeBuddyCredentialStore({
    cliPath: cli,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const harness: Harness = {
    shim: undefined as unknown as CodeBuddyShim,
    store,
    upstreamBodies: [],
    upstreamHeaders: [],
    upstreamResponse,
  }
  harness.shim = createCodeBuddyShim({
    store,
    catalog: new CodeBuddyCatalog(),
    ...turnIdFor === undefined ? {} : { turnIdFor },
    ...logger === undefined ? {} : { logger },
    client: {
      async chatStream(_credential, bodyJson, _signal, extraHeaders): Promise<CodeBuddyChatResult> {
        harness.upstreamBodies.push(bodyJson)
        harness.upstreamHeaders.push(extraHeaders)
        return harness.upstreamResponse()
      },
    },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

describe('CodeBuddy shim', () => {
  it('lists the catalog on /v1/models', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    const ids = body.data.map(model => model.id)
    expect(ids).toContain('auto')
    expect(ids).toContain('deepseek-v4-pro')
    // The fallback roster tracks the live `cli` agent's 15 models.
    expect(ids.length).toBe(15)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('glm-5.3')
  })

  it('streams a successful chat completion and normalizes the body', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'auto' },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('你好')
    expect(text).toContain('[DONE]')
    expect(harness.upstreamBodies.length).toBe(1)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['stream']).toBe(true)
    expect(forwarded['tool_choice']).toBe('auto')
  })

  it('warns once per session when a session header yields no turn id', async () => {
    const warnings: string[] = []
    // The affinity headers arrive but the tracker never matched: exactly the
    // silent degradation the warning exists to surface.
    const harness = await startShim(
      () => ({
        ok: true,
        response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }),
      () => undefined,
      { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }, error: () => {} },
    )
    const send = async (): Promise<void> => {
      const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${harness.shim.token()}`,
          'x-client-request-id': 'sess-1',
        },
        body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    await send()
    await send()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no turn id')
  })

  it('stays quiet when no session header arrives', async () => {
    const warnings: string[] = []
    const harness = await startShim(
      () => ({
        ok: true,
        response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }),
      () => undefined,
      { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }, error: () => {} },
    )
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    await response.text()
    // No session header at all is a different condition (host-side), and the
    // dock/card would otherwise be noisy on every headless request.
    expect(warnings).toHaveLength(0)
  })

  it('forwards the reasoning_effort a model picker selection sends', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['reasoning_effort']).toBe('xhigh')
    expect(forwarded['stream']).toBe(true)
  })

  it('maps an upstream credit failure onto HTTP 402', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: '积分不足',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string, message: string } }
    expect(body.error.type).toBe('hard_credit')
    expect(body.error.message).toContain('积分不足')
  })

  it('answers unknown routes with 404', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/nothing`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(404)
  })

  it('binds loopback only', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    expect(harness.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // A rebinding page resolves evil.com to 127.0.0.1; the browser then sends
    // Host: evil.com:<port>. fetch() forbids overriding Host, so use raw http.
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('accepts Host with a loopback name plus port', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a browser Origin from a non-loopback site', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('origin_not_allowed')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('accepts a loopback browser Origin', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a chat POST with a non-JSON Content-Type (simple-request CSRF)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(415)
    expect(res.body).toContain('unsupported_media_type')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request without a bearer (local process without the secret)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // Everything else about this request is legitimate: loopback Host, no
    // Origin (a local process, not a browser), JSON body. Only the bearer is
    // missing — this is the shape a hostile local process would send.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.body).toContain('unauthorized')
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request with a wrong bearer', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('sends the conversation headers with a body-derived turn id when no tracker is wired', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
        session_id: 'sess-fallback',
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    await response.text()
    const headers = harness.upstreamHeaders[0]
    expect(headers?.['X-Conversation-ID']).toBe('sess-fallback')
    // The fingerprint is a 32-char digest, not the session id.
    expect(headers?.['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers?.['X-Request-ID']).toBe(headers?.['X-Conversation-Request-ID'])
    expect(headers?.['X-Agent-Intent']).toBe('craft')
  })

  it('prefers the tracker turn id over the body fingerprint', async () => {
    const harness = await startShim(
      () => ({
        ok: true,
        response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      }),
      sessionId => sessionId === 'sess-tracked' ? 'turn-from-tracker' : undefined,
    )
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
        session_id: 'sess-tracked',
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    await response.text()
    const headers = harness.upstreamHeaders[0]
    expect(headers?.['X-Conversation-ID']).toBe('sess-tracked')
    expect(headers?.['X-Conversation-Request-ID']).toBe('turn-from-tracker')
    expect(headers?.['X-Request-ID']).toBe('turn-from-tracker')
  })

  it('keeps one backend record when DSH injects a user message mid-turn', async () => {
    // The regression this pins: the fingerprint moves when a mid-turn `user`
    // message arrives, so two calls of ONE turn would carry two turn ids and
    // land in the backend as two records. With the tracker the id is stable.
    const harness = await startShim(
      () => ({
        ok: true,
        response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      }),
      () => 'stable-turn-id',
    )
    const url = `${harness.shim.baseUrl()}/v1/chat/completions`
    const base = {
      'Content-Type': 'application/json',
      authorization: `Bearer ${harness.shim.token()}`,
      session_id: 'sess-inject',
    }
    await (await fetch(url, {
      method: 'POST',
      headers: base,
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'do the task' }] }),
    })).text()
    await (await fetch(url, {
      method: 'POST',
      headers: base,
      body: JSON.stringify({
        model: 'auto',
        messages: [
          { role: 'user', content: 'do the task' },
          { role: 'assistant', content: 'working' },
          // Injected by the host mid-turn: the fingerprint changes here.
          { role: 'user', content: 'Time sampled while preparing turn 1, step 3' },
        ],
      }),
    })).text()

    expect(harness.upstreamHeaders).toHaveLength(2)
    const [first, second] = harness.upstreamHeaders
    expect(first?.['X-Conversation-Request-ID']).toBe('stable-turn-id')
    expect(second?.['X-Conversation-Request-ID']).toBe('stable-turn-id')
    // Prove the bodies really would have produced different fingerprints, so
    // the assertion above is not vacuous.
    expect(turnFingerprint(harness.upstreamBodies[0] ?? ''))
      .not.toBe(turnFingerprint(harness.upstreamBodies[1] ?? ''))
  })
})

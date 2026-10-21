import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { Api, Model } from '@earendil-works/pi-ai'
import { toPiModel } from '../src/adapter.ts'
import { FALLBACK_CODEBUDDY_MODELS } from '../src/catalog.ts'
import { sessionIdOf } from '../src/turns.ts'

/**
 * Dual-host compatibility guard for the `llm-pi-ai` resolved profile.
 *
 * The plugin is a host extension: `@deepseek-ai/dsh-llm-pi-ai` is an external
 * dependency resolved from whichever DSH is installed, while the profile object
 * this plugin hands that adapter is built here. When the two drift, the failure
 * is a runtime TypeError inside the host — not a compile error in this repo —
 * and it surfaces to the user as a model-selector row reading
 *
 *     CodeBuddy CLI 加载失败：Cannot read properties of undefined (reading 'get')
 *
 * That is what happened with DSH 0.1.5, whose `modelOf` dereferences
 * `profile.modelErrors.get(model)`. These tests pin the fields that actually
 * cross the boundary so a future `llm-pi-ai` change cannot silently reintroduce
 * a blank provider row.
 */

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = await readFile(join(here, '..', 'src', 'adapter.ts'), 'utf8')

/** Extract one balanced `{...}` object literal that follows `anchor`. */
function objectLiteralAfter(anchor: string): string {
  const start = adapterSource.indexOf(anchor)
  if (start < 0) throw new Error(`anchor not found in adapter.ts: ${anchor}`)
  const open = adapterSource.indexOf('{', start)
  let depth = 0
  for (let index = open; index < adapterSource.length; index += 1) {
    const char = adapterSource[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return adapterSource.slice(open, index + 1)
    }
  }
  throw new Error(`unbalanced object literal after: ${anchor}`)
}

describe('resolved profile carries every field both supported hosts read', () => {
  const literal = objectLiteralAfter('const profileFields =')

  it('declares modelErrors, which DSH 0.1.5+ dereferences on every model lookup', () => {
    // DSH >= 0.1.5 runs `profile.modelErrors.get(model)` in `modelOf`, reached
    // from resolveModel -> modelInfo, which is exactly the path
    // buildModelCatalog walks for the model selector. An absent map there is
    // the reported TypeError, so this field is the fix.
    expect(literal).toContain('modelErrors')
  })

  it('declares the fields DSH 0.1.2 reads, so the older host keeps working', () => {
    for (const field of [
      'provider',
      'displayName',
      'streamIdleTimeoutMs',
      'retryPolicy',
      'configuredMaxTokens',
      'piProvider',
    ]) {
      expect(literal, `missing ${field}`).toContain(field)
    }
  })

  it('supplies an empty failure map rather than a populated one', () => {
    // This adapter performs no per-model validation of its own: its catalog is
    // fetched from the shim, so reporting no failures is the honest answer and
    // leaves every model routable instead of marking them INVALID_CONFIG.
    expect(literal).toMatch(/modelErrors:\s*new Map<[^>]*>\(\)/u)
  })

  it('binds the superset through a compatibility cast, not a bare literal', () => {
    // The installed host typings declare only one profile variant, so naming
    // the other variant's field directly in a typed literal fails to compile.
    // The cast is what lets one source support both versions.
    expect(adapterSource).toContain(
      'const profile = profileFields as unknown as ResolvedPiAiProviderProfile',
    )
  })
})

describe('pi-ai host contract', () => {
  it('keeps llm-pi-ai external, so the profile must match the installed host', async () => {
    // If this package were bundled, the profile above would target the
    // vendored copy and the dual-version reasoning would not apply.
    const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
    }
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-llm-pi-ai']).toBeDefined()
    expect(adapterSource).toContain("from '@deepseek-ai/dsh-llm-pi-ai'")
  })

  it('documents the failure the modelErrors field prevents', () => {
    expect(adapterSource).toContain("reading 'get'")
  })
})

/**
 * Turn correlation depends on pi-ai actually emitting a session header.
 *
 * `turns.ts` keys its per-session turn tracker on `session_id` /
 * `x-client-request-id` / `x-session-affinity`, so if pi-ai stops sending them
 * the tracker silently never fills: every request then falls back to the body
 * fingerprint, which drifts mid-turn as soon as an injector appends another
 * `user` message. That degradation is invisible in the shim's own tests, which
 * call the request handler directly — only a real stream shows the headers.
 *
 * The assertions below drive the production descriptor through pi-ai's own
 * `stream()` with a fake fetch, so they pin the pi-ai contract rather than our
 * copy of it.
 */
describe('compat block makes pi-ai emit the session-affinity headers', () => {
  // `noUncheckedIndexedAccess` makes a literal index possibly-undefined; the
  // roster is a non-empty constant, so naming the row once is honest.
  const row = FALLBACK_CODEBUDDY_MODELS[0]
  if (row === undefined) throw new Error('catalog roster is empty')
  const descriptor = toPiModel(row, 'http://127.0.0.1:1/v1')

  it('attaches a compat block that turns session headers on', () => {
    const compat = (descriptor as unknown as { compat?: Record<string, unknown> }).compat
    expect(compat).toBeDefined()
    expect(compat?.sendSessionAffinityHeaders).toBe(true)
    // `openrouter` would send `x-session-id` only, which no `sessionIdOf`
    // branch reads, and would also add headers this upstream never expects.
    expect(compat?.sessionAffinityFormat).toBe('openai')
  })

  it('sends the headers a live stream, under the names turns.ts reads', async () => {
    const captured = await captureHeaders(descriptor, 'sess-turn-correlation')
    // Exactly the three names sessionIdOf() consults; any one is sufficient,
    // and all three arriving is what makes the tracker's lookup order moot.
    expect(captured.session_id).toBe('sess-turn-correlation')
    expect(captured['x-client-request-id']).toBe('sess-turn-correlation')
    expect(captured['x-session-affinity']).toBe('sess-turn-correlation')
    expect(sessionIdOf(captured)).toBe('sess-turn-correlation')
  })

  it('sends nothing when the host withholds a session id', async () => {
    // A host that cannot name the session must not have one invented for it:
    // a constant fallback would merge unrelated conversations into one turn.
    const captured = await captureHeaders(descriptor, undefined)
    expect(captured.session_id).toBeUndefined()
    expect(captured['x-client-request-id']).toBeUndefined()
    expect(sessionIdOf(captured)).toBeUndefined()
  })
})

/** Drive one real pi-ai stream and return the headers it put on the wire. */
async function captureHeaders(model: Model<Api>, sessionId: string | undefined): Promise<Record<string, string>> {
  const captured: Record<string, string> = {}
  // `FetchFunction` is `typeof globalThis.fetch`, so typing it that way keeps
  // `init.headers` as the SDK's `HeadersInit` instead of an opaque `unknown`.
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    // The OpenAI SDK passes a `Headers` instance; spreading it yields nothing.
    for (const [key, value] of new Headers(init?.headers).entries()) captured[key] = value
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  const events = stream(
    // toPiModel declares the wide `Model<Api>`; this stream function is the
    // openai-completions one, so narrow it at the call boundary.
    model as Model<'openai-completions'>,
    // Only `normalizeContext` may build a TranscriptContext, and `stream`
    // takes that branded type — so the probe context goes through it.
    normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }),
    {
      apiKey: 'probe-key',
      ...sessionId === undefined ? {} : { sessionId },
      fetch: fakeFetch,
    },
  )
  for await (const _event of events) {
    // drain: the request is issued before the first event is pushed
  }
  return captured
}

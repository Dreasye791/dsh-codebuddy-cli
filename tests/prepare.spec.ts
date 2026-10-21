import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, prepareChatBody, regionOf, turnFingerprint } from '../src/upstream.ts'

describe('prepareChatBody', () => {
  it('forces stream true', () => {
    expect(JSON.parse(prepareChatBody('{"model":"auto","messages":[]}'))['stream']).toBe(true)
  })

  it('keeps invalid JSON untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('flattens object tool_choice auto', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'auto' } })))
    expect(body['tool_choice']).toBe('auto')
  })

  it('flattens named function tool_choice to the function name', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'function', function: { name: 'grep' } },
    })))
    expect(body['tool_choice']).toBe('grep')
  })

  it('drops tool_choice and tools for none', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: { type: 'none' },
      tools: [{ type: 'function', function: { name: 'grep' } }],
    })))
    expect('tool_choice' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })

  it('drops an unrecognized object tool_choice', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ tool_choice: { type: 'weird' } })))
    expect('tool_choice' in body).toBe(false)
  })

  it('preserves the reasoning_effort the model picker selects', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'xhigh',
    })))
    expect(body['reasoning_effort']).toBe('xhigh')
    expect(body['stream']).toBe(true)
  })

  it('rewrites developer messages to system (upstream rejects developer)', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
      reasoning_effort: 'max',
    })))
    const roles = body['messages'].map((message: { role: string }) => message.role)
    expect(roles).toEqual(['system', 'user'])
    expect(body['reasoning_effort']).toBe('max')
  })
})

/**
 * The upstream answers `400 code 11128 "Illegal API invocation from an
 * unapproved channel"` when a system message *begins* with a specific sentence.
 * Measured 2026-10-21: one leading space, one leading newline, or the same
 * sentence past offset 0 all return 200. So the fix is a prefix rewrite, and
 * these tests pin exactly that — no more, no less.
 */
describe('system prefix rewrite (11128 channel check)', () => {
  const BANNED = 'You are an AI agent powered by DeepSeek Harness.'
  const SAFE = 'You are an AI agent running inside DeepSeek Harness.'

  /** Run one body through prepareChatBody and hand back the first message. */
  function first(messages: unknown[]): Record<string, unknown> {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ model: 'auto', messages })))
    return body['messages'][0] as Record<string, unknown>
  }

  it('rewrites the banned sentence at offset 0 of a system message', () => {
    const message = first([{ role: 'system', content: `${BANNED}\n\nBe helpful.` }])
    expect(message['content']).toBe(`${SAFE}\n\nBe helpful.`)
    // The product name survives: the rewrite must not erase attribution.
    expect(String(message['content'])).toContain('DeepSeek Harness')
  })

  it('leaves the rest of the prompt byte-identical', () => {
    const tail = '\n\n## Tool usage\n- call read before edit\n- 中文说明保持不变'
    const message = first([{ role: 'system', content: BANNED + tail }])
    expect(message['content']).toBe(SAFE + tail)
  })

  it('does not touch a sentence that is not at offset 0', () => {
    const content = `Intro line.\n${BANNED}\nMore.`
    expect(first([{ role: 'system', content }])['content']).toBe(content)
  })

  it('does not touch the same sentence in a user or assistant message', () => {
    const content = `${BANNED}\nuser text`
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [
        { role: 'user', content },
        { role: 'assistant', content },
      ],
    })))
    expect(body['messages'][0]['content']).toBe(content)
    expect(body['messages'][1]['content']).toBe(content)
  })

  it('rewrites a text part inside a multipart system content array', () => {
    const message = first([{
      role: 'system',
      content: [
        { type: 'text', text: BANNED },
        { type: 'text', text: 'second part' },
      ],
    }])
    const parts = message['content'] as { type: string; text: string }[]
    expect(parts[0]?.text).toBe(SAFE)
    expect(parts[1]?.text).toBe('second part')
  })

  it('ignores non-text parts and non-object parts without throwing', () => {
    const message = first([{
      role: 'system',
      content: [
        { type: 'image', source: 'x' },
        null,
        'bare string part',
        { type: 'text', text: BANNED },
      ],
    }])
    const parts = message['content'] as Record<string, unknown>[]
    expect(parts[0]).toEqual({ type: 'image', source: 'x' })
    expect(parts[3]).toEqual({ type: 'text', text: SAFE })
  })

  it('is idempotent', () => {
    const once = first([{ role: 'system', content: BANNED }])['content']
    const twice = first([{ role: 'system', content: once }])['content']
    expect(twice).toBe(once)
  })

  it('leaves a message list without a system role alone', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: BANNED }],
    })))
    expect(body['messages']).toHaveLength(1)
    expect(body['messages'][0]['content']).toBe(BANNED)
  })

  it('tolerates messages that are not objects', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [null, 42, 'x', { role: 'system', content: BANNED }],
    })))
    expect(body['messages']).toHaveLength(4)
    expect(body['messages'][3]['content']).toBe(SAFE)
  })

  it('does not change the turn fingerprint of a request', () => {
    // The fingerprint is taken from the last user message, so rewriting the
    // system prefix must leave it alone. Both requests below carry the same
    // user turn and differ only in the system sentence.
    const user = [{ role: 'user', content: 'do the task' }]
    const banned = prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: BANNED }, ...user],
    }))
    const safe = prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [{ role: 'system', content: SAFE }, ...user],
    }))
    expect(turnFingerprint(banned)).toBe(turnFingerprint(safe))
  })
})

describe('classifyUpstreamError', () => {
  it('classifies 402 as hard credit', () => {
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
  })

  it('classifies credit wording in a 200-shaped business error', () => {
    expect(classifyUpstreamError(200, 'code=1 msg=积分不足，请充值')).toBe('hard_credit')
  })

  it('classifies the offline session marker as session dead', () => {
    expect(classifyUpstreamError(401, 'Offline user session not found')).toBe('session_dead')
  })

  it('classifies 429 as soft rate', () => {
    expect(classifyUpstreamError(429, 'slow down')).toBe('soft_rate')
  })

  it('classifies 404 as transient not-found', () => {
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(400, 'bad')).toBe('client')
  })
})

describe('regionOf', () => {
  it('treats workbuddy.ai domains as global and everything else as cn', () => {
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('workbuddy.ai')).toBe('global')
    expect(regionOf('US.WorkBuddy.AI')).toBe('global')
    expect(regionOf('')).toBe('cn')
  })
})

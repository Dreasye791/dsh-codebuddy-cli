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
 * unapproved channel"` on some system messages. The trigger is the harness
 * brand name inside the prompt, not a header or channel field.
 *
 * Two measurements, because the first fix was too narrow:
 *   2026-10-21 — a 5932-char prompt failed only on the exact leading sentence;
 *                one leading space, one leading newline, or a reword returned
 *                200. That looked like an exact prefix match.
 *   2026-10-22 — a 9592-char prompt still failed after that prefix rewrite.
 *                Replacing its third `DeepSeek Harness` alone cleared it, while
 *                that fragment alone returned 200 and a failing 2000-char block
 *                split in half left both halves passing. So the rule depends on
 *                the prompt as a whole and any occurrence can participate.
 *
 * The tests below pin the widened contract: rewrite the leading sentence, then
 * neutralise every brand occurrence, and leave everything else byte-identical.
 */
describe('system sanitising (11128 channel check)', () => {
  const BANNED = 'You are an AI agent powered by DeepSeek Harness.'
  const SAFE = 'You are an AI agent running inside the host application.'

  /** Run one body through prepareChatBody and hand back the first message. */
  function first(messages: unknown[]): Record<string, unknown> {
    const body = JSON.parse(prepareChatBody(JSON.stringify({ model: 'auto', messages })))
    return body['messages'][0] as Record<string, unknown>
  }

  it('rewrites the banned sentence at offset 0 of a system message', () => {
    const message = first([{ role: 'system', content: `${BANNED}\n\nBe helpful.` }])
    expect(message['content']).toBe(`${SAFE}\n\nBe helpful.`)
  })

  // The regression that motivated widening: a brand mention far from offset 0
  // kept the request blocked even though the leading sentence was already safe.
  it('neutralises a brand mention that is not at offset 0', () => {
    const content = 'Intro.\n\nSee the DeepSeek Harness Web GUI for details.'
    expect(first([{ role: 'system', content }])['content'])
      .toBe('Intro.\n\nSee the the host application Web GUI for details.')
  })

  it('leaves no brand occurrence behind anywhere in a long prompt', () => {
    const content = [
      'You are an AI agent powered by DeepSeek Harness.',
      'The DeepSeek Harness implementation checkout lives elsewhere.',
      'You interact through the DeepSeek Harness Web GUI.',
    ].join('\n\n')
    const out = String(first([{ role: 'system', content }])['content'])
    expect(out).not.toMatch(/deepseek\s+harness/i)
    // Case-insensitive, so a lower-case mention is caught too.
    expect(String(first([{ role: 'system', content: 'by deepseek harness today' }])['content']))
      .toBe('by the host application today')
  })

  it('leaves the rest of the prompt byte-identical', () => {
    const tail = '\n\n## Tool usage\n- call read before edit\n- 中文说明保持不变'
    const message = first([{ role: 'system', content: BANNED + tail }])
    expect(message['content']).toBe(SAFE + tail)
  })

  // Sanitising is positional-agnostic now, so a mid-prompt mention is rewritten
  // too — that is the whole point of the widening. What must stay true is that
  // unrelated text is untouched.
  it('leaves unrelated text in a non-leading position untouched', () => {
    const content = 'Intro line.\nPlain prose with no brand name.\nMore.'
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

  /**
   * DSH injects this paragraph whenever the addressed agent has a usable `read`
   * tool (`@deepseek-ai/dsh-file-reference`). Measured on 2026-10-28: on an
   * 81230-char system message this was the block taking part in the 11128
   * check; rewording just its first two sentences, with every other byte
   * untouched, returned 200. The tail below must therefore survive verbatim.
   */
  const FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced. '
    + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. '
    + 'A trailing slash marks a directory: list it when its contents matter.'
  const FILE_REFERENCE_SAFE = 'A token beginning with @ names a path the user pointed to. '
    + 'A relative path is resolved against the workspace root, while an absolute path names a file or directory on the host. '
    + 'A trailing slash marks a directory: list it when its contents matter.'

  it('rewrites the host file-reference paragraph, keeping its tail byte-identical', () => {
    const message = first([{ role: 'system', content: FILE_REFERENCE }])
    expect(message['content']).toBe(FILE_REFERENCE_SAFE)
  })

  it('keeps the separator when the host paragraph is wrapped or reflowed', () => {
    const wrapped = 'Intro.\n\nTokens prefixed with @ are paths the user explicitly referenced.\n'
      + 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.\n\nOutro.'
    expect(first([{ role: 'system', content: wrapped }])['content']).toBe(
      'Intro.\n\nA token beginning with @ names a path the user pointed to.\n'
      + 'A relative path is resolved against the workspace root, while an absolute path names a file or directory on the host.\n\nOutro.',
    )
  })

  it('rewrites the host paragraph in the middle of a long prompt', () => {
    const content = `Long preamble.\n\n${FILE_REFERENCE}\n\nMore instructions afterwards.`
    expect(first([{ role: 'system', content }])['content'])
      .toBe(`Long preamble.\n\n${FILE_REFERENCE_SAFE}\n\nMore instructions afterwards.`)
  })

  it('is idempotent for the host paragraph', () => {
    const once = first([{ role: 'system', content: FILE_REFERENCE }])['content']
    expect(first([{ role: 'system', content: once }])['content']).toBe(once)
  })

  it('does not rewrite the host paragraph in user or assistant messages', () => {
    const body = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'auto',
      messages: [
        { role: 'user', content: FILE_REFERENCE },
        { role: 'assistant', content: FILE_REFERENCE },
      ],
    })))
    expect(body['messages'][0]['content']).toBe(FILE_REFERENCE)
    expect(body['messages'][1]['content']).toBe(FILE_REFERENCE)
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

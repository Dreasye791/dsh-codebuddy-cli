/**
 * Turn-boundary tracking for the upstream conversation headers.
 *
 * The tracker exists because a body-derived turn id is not reliable: DSH
 * injects extra `user` messages inside one turn, so the last user message
 * changes mid-turn. On this machine 14 of 64 sampled turns carried more than
 * one fingerprint. These tests pin the tracker contract the shim relies on.
 */
import { describe, expect, it } from 'vitest'
import { createTurnTracker, sessionIdOf } from '../src/turns.ts'

describe('sessionIdOf', () => {
  it('reads the first spelling pi-ai sends', () => {
    expect(sessionIdOf({ 'x-client-request-id': 'sess-1' })).toBe('sess-1')
    expect(sessionIdOf({ session_id: 'sess-2' })).toBe('sess-2')
    expect(sessionIdOf({ 'x-session-affinity': 'sess-3' })).toBe('sess-3')
  })

  it('prefers x-client-request-id when several are present', () => {
    expect(sessionIdOf({ 'x-client-request-id': 'a', session_id: 'b', 'x-session-affinity': 'c' })).toBe('a')
  })

  it('takes the first value of a repeated header', () => {
    expect(sessionIdOf({ session_id: ['first', 'second'] })).toBe('first')
  })

  it('returns undefined for absent, empty, and whitespace-only values', () => {
    expect(sessionIdOf({})).toBe(undefined)
    expect(sessionIdOf({ session_id: '' })).toBe(undefined)
    expect(sessionIdOf({ session_id: '   ' })).toBe(undefined)
    expect(sessionIdOf({ session_id: [] })).toBe(undefined)
  })

  it('trims surrounding whitespace', () => {
    expect(sessionIdOf({ session_id: '  sess-4  ' })).toBe('sess-4')
  })
})

describe('createTurnTracker', () => {
  it('returns a fresh id for every begin', () => {
    const tracker = createTurnTracker()
    const first = tracker.begin('s1')
    const second = tracker.begin('s1')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the id stable between boundaries', () => {
    const tracker = createTurnTracker()
    const id = tracker.begin('s1')
    expect(tracker.current('s1')).toBe(id)
    expect(tracker.current('s1')).toBe(id)
  })

  it('replaces the id at the next boundary', () => {
    const tracker = createTurnTracker()
    const first = tracker.begin('s1')
    const second = tracker.begin('s1')
    expect(tracker.current('s1')).toBe(second)
    expect(tracker.current('s1')).not.toBe(first)
  })

  it('keeps sessions independent', () => {
    const tracker = createTurnTracker()
    const a = tracker.begin('a')
    const b = tracker.begin('b')
    expect(a).not.toBe(b)
    expect(tracker.current('a')).toBe(a)
    expect(tracker.current('b')).toBe(b)
    // A new turn in one session must not disturb the other.
    tracker.begin('a')
    expect(tracker.current('b')).toBe(b)
  })

  it('reports undefined for an unknown or absent session', () => {
    const tracker = createTurnTracker()
    expect(tracker.current('never-seen')).toBe(undefined)
    expect(tracker.current(undefined)).toBe(undefined)
  })

  it('forgets a session', () => {
    const tracker = createTurnTracker()
    tracker.begin('s1')
    tracker.forget('s1')
    expect(tracker.current('s1')).toBe(undefined)
    // Forgetting twice is harmless.
    tracker.forget('s1')
    expect(tracker.current('s1')).toBe(undefined)
  })

  it('evicts the least recently started session, not the newest', () => {
    const tracker = createTurnTracker()
    // 1 + 300 begins through a 256-entry bound keeps only the most recent 256.
    tracker.begin('newest')
    for (let index = 0; index < 300; index += 1) tracker.begin(`s${index}`)
    expect(tracker.current('s0')).toBe(undefined)
    expect(tracker.current('s43')).toBe(undefined)
    expect(tracker.current('s44')).not.toBe(undefined)
    expect(tracker.current('s299')).not.toBe(undefined)
    // 'newest' started before the loop, so it went out first.
    expect(tracker.current('newest')).toBe(undefined)
  })

  it('keeps a refreshed session out of the eviction path', () => {
    const tracker = createTurnTracker()
    tracker.begin('hot')
    for (let index = 0; index < 200; index += 1) tracker.begin(`fill${index}`)
    // Re-beginning moves 'hot' to the back, so the next 100 sessions cannot
    // push it out even though it is the oldest by first appearance.
    tracker.begin('hot')
    for (let index = 200; index < 300; index += 1) tracker.begin(`fill${index}`)
    expect(tracker.current('hot')).not.toBe(undefined)
    expect(tracker.current('fill0')).toBe(undefined)
  })
})

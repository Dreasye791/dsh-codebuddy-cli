/**
 * Turn boundaries for the upstream conversation headers.
 *
 * The backend groups one user turn's chat calls into a single record by the
 * turn-scoped `x-conversation-request-id`. DSH never hands the plugin a turn
 * id, and deriving one from the request body is not reliable: the agent loop
 * injects extra `user` messages inside a turn (time context, progress notices,
 * native runtime memory), so "the last user message" changes mid-turn and one
 * turn then lands in the backend as several records.
 *
 * This tracker takes the boundary from the host instead. `agent/pre-step`
 * carries the loop's `step` counter, which restarts at 1 for every turn, so the
 * first step of a turn is exactly the moment to mint a fresh turn id.
 *
 * @module dsh-codebuddy-cli/turns
 */

import { randomBytes } from 'node:crypto'

/** Upper bound on remembered sessions; a long-lived host sees many. */
const MAX_SESSIONS = 256

/**
 * Pull the DSH session id out of the headers pi-ai sends to the shim.
 *
 * pi-ai emits all three spellings when session-affinity is on; any of them
 * identifies the same DSH session.
 */
export function sessionIdOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['x-client-request-id'] ?? headers['session_id'] ?? headers['x-session-affinity']
  const first = Array.isArray(raw) ? raw[0] : raw
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined
}

/** Remembers the current turn id per DSH session. */
export interface TurnTracker {
  /**
   * Start a new turn for `sessionId` and return its id.
   *
   * Called from the loop's first step; every later step of the same turn keeps
   * the id minted here.
   */
  begin(sessionId: string): string
  /** The current turn id for `sessionId`, or undefined when no turn is open. */
  current(sessionId: string | undefined): string | undefined
  /** Forget a session (its loop ended). */
  forget(sessionId: string): void
}

/**
 * Create a tracker.
 *
 * Insertion order doubles as recency: re-setting an existing key moves it to
 * the back of the Map, so eviction drops the least recently started turn.
 */
export function createTurnTracker(): TurnTracker {
  const turns = new Map<string, string>()
  const mint = (): string => randomBytes(16).toString('hex')
  return {
    begin(sessionId: string): string {
      const id = mint()
      turns.delete(sessionId)
      turns.set(sessionId, id)
      while (turns.size > MAX_SESSIONS) {
        const oldest = turns.keys().next()
        if (oldest.done === true) break
        turns.delete(oldest.value)
      }
      return id
    },
    current(sessionId: string | undefined): string | undefined {
      if (sessionId === undefined) return undefined
      return turns.get(sessionId)
    },
    forget(sessionId: string): void {
      turns.delete(sessionId)
    },
  }
}
